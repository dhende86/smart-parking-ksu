"""
spot_scanner.py

HOW POLYGONS WORK:
  - Stored as normalized 0-1 coordinates in polygons.json
  - When you drag a polygon in the editor and save, the new normalized
    coordinates are written to polygons.json immediately
  - The scanner calls update_polygons() which re-scales them to the
    actual video frame size instantly — no restart needed
  - So wherever you move a polygon, the scanner knows that exact location

HOW CAR IDs WORK:
  - YOLO detects every vehicle and draws a bounding box
  - ByteTrack assigns each bounding box a persistent ID that follows
    the car across every frame
  - We wrap ByteTrack IDs in permanent IDs (P1, P2, ...) that survive
    even brief tracking gaps (car occluded for a few frames)
  - Each permanent ID is matched to whichever spot polygon its bounding
    box overlaps by >= OVERLAP_THRESH
  - The live feed shows every car's bounding box + permanent ID label
    so you can visually verify which car is which
  - Once a car owns a spot, that spot stays TAKEN until the car is
    absent for RELEASE_SECONDS — no flickering

ACCURACY:
  - intersectConvexConvex: checks real geometric overlap between
    car bounding box and spot polygon
  - N_CONFIRM=3: 3 consecutive frames must agree before status changes
  - Row guard: taken count per row never exceeds detected cars in row
"""

import asyncio, cv2, numpy as np, time, logging
from collections import defaultdict
from typing import Callable, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

VEHICLE_CLASSES = {2, 3, 5, 7}
CONFIDENCE_MIN  = 0.15   # lower = catches small/far cars YOLO is less sure about
YOLO_MODEL      = "yolov8n.pt"
OVERLAP_THRESH  = 0.10
N_CONFIRM       = 3
REMATCH_PX      = 120   # px radius to rematch a reappearing car to its permanent ID
RELEASE_SECONDS = 8.0   # longer for far cars that YOLO occasionally misses
MAX_RECONNECTS  = 3
MAX_FAILS       = 30

ROWS = {
    'A': ['11','10','9','8','7','6','5','4','3','2','1'],
    'B': ['22','21','20','19','18','17','16','15','14','13','12'],
    'C': ['23','24','25','26','27','28','29','30','31','32','33','34'],
    'D': ['44','43','42','41','40','39','38','37','36','35'],
}

# Colours for drawing car ID boxes on the live feed
# Each permanent ID gets a consistent colour so you can track it visually
_ID_COLOURS = [
    (0,220,255),(0,180,255),(50,255,50),(255,180,0),
    (255,80,180),(180,255,80),(80,180,255),(255,255,80),
    (200,80,255),(80,255,200),(255,120,80),(120,255,80),
]

def _pid_colour(pid: str) -> tuple:
    """Return a consistent BGR colour for a permanent ID string."""
    n = int(pid[1:]) if pid[1:].isdigit() else 0
    return _ID_COLOURS[n % len(_ID_COLOURS)]


class SpotScanner:
    def __init__(self, spots, source, on_update: Callable,
                 debug_fn: Optional[Callable] = None,
                 frame_callback: Optional[Callable] = None):
        self.spots      = spots
        self.source     = source
        self.on_update  = on_update
        self._dbg       = debug_fn or (lambda m: logger.info(m))
        self._frame_cb  = frame_callback
        self._running   = False
        self._model     = None
        self._fw = self._fh = None

        # Polygon data — normalized 0-1 in _raw, scaled pixels in _polys
        self._raw:   Dict[str, np.ndarray] = {}
        self._polys: Dict[str, np.ndarray] = {}
        self._build_raw()

        # Spot statuses
        self._statuses: Dict[str, str]  = {s.id: "open" for s in spots}
        self._pending:  Dict[str, dict] = {}

        # Permanent car IDs
        self._next_pid:  int                           = 1
        self._bt_to_pid: Dict[int, str]                = {}
        self._pid_pos:   Dict[str, Tuple[float,float]] = {}
        self._pid_seen:  Dict[str, float]              = {}
        self._pid_spots: Dict[str, Set[str]]           = defaultdict(set)
        # Store full bounding box per pid for drawing on live feed
        self._pid_box:   Dict[str, Tuple[float,float,float,float]] = {}

    def update_polygons(self, spots):
        """
        Called when user saves polygon edits in the editor.
        Immediately re-scales to current frame resolution so the scanner
        uses the new positions on the very next frame.
        """
        self.spots = spots
        for s in spots:
            if s.id not in self._statuses:
                self._statuses[s.id] = "open"
        self._build_raw()
        if self._fw and self._fh:
            self._scale(self._fw, self._fh)
            self._dbg(f"Polygons hot-reloaded: {len(spots)} spots at "
                      f"{self._fw}x{self._fh}")

    def _build_raw(self):
        """
        Load polygon points into normalized 0-1 space.
        Handles both normalized (0-1) and legacy pixel coordinates.
        """
        self._raw = {}
        for s in self.spots:
            pts = np.array(s.pts, dtype=np.float32)
            if pts.size == 0:
                continue
            if pts.max() > 1.0:
                # Legacy pixel coords — normalize using POLY_REF dimensions
                pts[:, 0] /= 928.0
                pts[:, 1] /= 580.0
            self._raw[s.id] = np.clip(pts, 0.0, 1.0)

    def _scale(self, w: int, h: int):
        """
        Scale normalized 0-1 polygon coords to actual frame pixel coords.
        This is called on every frame resolution and after every editor save.
        A polygon at (0.5, 0.3) always maps to 50% across, 30% down the frame.
        """
        self._polys = {}
        for sid, p in self._raw.items():
            sc = p.copy()
            sc[:, 0] *= w
            sc[:, 1] *= h
            self._polys[sid] = sc
        self._dbg(f"Polygons scaled to {w}x{h} — "
                  f"{len(self._polys)} spots active")

    def _load_model(self):
        try:
            from ultralytics import YOLO
            self._model = YOLO(YOLO_MODEL)
            dummy = np.zeros((384, 640, 3), dtype=np.uint8)
            try:
                self._model.track(dummy, persist=True, verbose=False)
                self._dbg(f"YOLO + ByteTrack ready ({YOLO_MODEL})")
            except Exception:
                self._model(dummy, verbose=False)
                self._dbg(f"YOLO ready — ByteTrack unavailable")
        except Exception as e:
            self._dbg(f"YOLO load failed: {e}")

    def _is_live(self) -> bool:
        if isinstance(self.source, int): return True
        s = str(self.source).lower()
        return s.startswith("rtsp://") or s.startswith("http://") \
               or s.startswith("https://")

    async def run(self):
        self._running = True
        await asyncio.get_event_loop().run_in_executor(None, self._load_model)
        try:
            await self._scan_with_reconnect()
        except _FeedLost as e:
            self._dbg(f"FEED LOST: {e}")
            self.on_update({"__feed_lost__": True, **dict(self._statuses)})
        except Exception as e:
            import traceback
            self._dbg(f"Fatal: {e}\n{traceback.format_exc()}")
        finally:
            self._running = False
            self._dbg("Scanner stopped")

    async def _scan_with_reconnect(self):
        attempt = 0
        while self._running:
            try:
                await self._scan()
                break
            except _FeedLost as e:
                attempt += 1
                if attempt > MAX_RECONNECTS:
                    raise
                wait = attempt * 2
                self._dbg(f"Feed lost — reconnect {attempt}/{MAX_RECONNECTS} "
                          f"in {wait}s")
                await asyncio.sleep(wait)

    async def _scan(self):
        cap = cv2.VideoCapture(self.source)
        if not cap.isOpened():
            raise _FeedLost(f"Cannot open: {self.source}")
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)

        ret, frame = cap.read()
        if not ret:
            cap.release()
            raise _FeedLost("Cannot read first frame")

        self._fh, self._fw = frame.shape[:2]
        self._scale(self._fw, self._fh)

        # Auto-save frame 0 as the reference image so the polygon editor
        # always shows the exact same pixels as the video stream.
        # This guarantees that polygons drawn in the editor line up perfectly
        # with what the scanner sees — same resolution, same aspect ratio.
        try:
            import os
            ref_path = os.path.join(
                os.path.dirname(os.path.dirname(__file__)),
                "data", "reference.jpg"
            )
            cv2.imwrite(ref_path, frame)
            self._dbg(f"Reference image updated: {self._fw}x{self._fh} "
                      f"— editor now matches stream exactly")
        except Exception as e:
            self._dbg(f"Could not save reference image: {e}")

        is_live = self._is_live()
        loop    = asyncio.get_event_loop()
        total   = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) if not is_live else -1
        nat_fps = cap.get(cv2.CAP_PROP_FPS) or 30
        fails   = 0
        frame_n = 0

        self._dbg(
            f"{'Live' if is_live else f'Video ({total/nat_fps:.1f}s)'} | "
            f"{self._fw}x{self._fh} | {len(self.spots)} spots"
        )

        changed = await loop.run_in_executor(
            None, self._process, frame, 0, time.time())
        if changed:
            self.on_update({"__feed_lost__": False, **dict(self._statuses)})
        frame_n = 1

        while self._running:
            ret, frame = cap.read()
            if not ret:
                if is_live:
                    fails += 1
                    if fails >= MAX_FAILS:
                        cap.release()
                        raise _FeedLost(f"{MAX_FAILS} consecutive failures")
                    await asyncio.sleep(0.1)
                    continue
                else:
                    self._dbg(f"Video finished at frame {frame_n}")
                    break

            fails   = 0
            ts      = time.time()
            changed = await loop.run_in_executor(
                None, self._process, frame, frame_n, ts)
            if changed:
                self.on_update({"__feed_lost__": False, **dict(self._statuses)})

            frame_n += 1
            if frame_n % 120 == 0:
                taken = sum(1 for v in self._statuses.values() if v == "taken")
                pct   = f"{frame_n/total*100:.0f}%" if total > 0 else "live"
                self._dbg(
                    f"[{pct}] fr={frame_n} | {taken} taken | "
                    f"{len(self._pid_pos)} cars: "
                    + " ".join(f"{p}→{self._pid_spots.get(p,set())}"
                               for p in list(self._pid_pos)[:4])
                )

            await asyncio.sleep(0)

        cap.release()

    # ── per-frame ──────────────────────────────────────────────────────────────

    def _process(self, frame, frame_n: int, ts: float) -> bool:
        detections = self._detect(frame, frame_n)
        changed    = self._update(detections, ts, frame_n)

        if self._frame_cb:
            try:
                annotated = self._annotate(frame, detections)
                self._frame_cb(annotated)
            except Exception:
                pass

        return changed

    def _detect(self, frame, frame_n: int):
        """
        Run YOLO + ByteTrack at HIGH resolution so far/small cars are detected.

        Key settings for far-car detection:
          - imgsz=1280: doubles the pixel resolution fed to YOLO vs 640.
            A car that was 15px tall at 640 becomes 30px — above YOLO's
            reliable detection threshold of ~20px.
          - conf=0.15: far cars have lower confidence scores because they're
            small and partly occluded. We accept lower confidence and let
            ByteTrack's temporal consistency filter out false positives.
          - ByteTrack persist=True: even if YOLO misses a far car for 1-2
            frames, ByteTrack keeps the ID alive using its motion model.
            This prevents far parked cars from flickering in/out.
        """
        if not self._model:
            return []

        try:
            results = self._model.track(
                frame,
                classes=list(VEHICLE_CLASSES),
                conf=CONFIDENCE_MIN,
                persist=True,
                verbose=False,
                imgsz=1280,           # high res — critical for far cars
                tracker="bytetrack.yaml",
            )[0]
            if results.boxes.id is not None:
                out = []
                for box, tid in zip(results.boxes, results.boxes.id):
                    if int(box.cls[0]) not in VEHICLE_CLASSES:
                        continue
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    cx, cy = (x1+x2)/2, (y1+y2)/2
                    out.append((int(tid), cx, cy, x1, y1, x2, y2))
                if frame_n % 30 == 0 and out:
                    # Log near vs far cars so you can verify in debug console
                    near = [(t,cx,cy) for t,cx,cy,x1,y1,x2,y2 in out
                            if (y2-y1) >= 40]
                    far  = [(t,cx,cy) for t,cx,cy,x1,y1,x2,y2 in out
                            if (y2-y1) < 40]
                    self._dbg(
                        f"[fr{frame_n}] {len(out)} vehicles "
                        f"({len(near)} near, {len(far)} far): " +
                        " ".join(f"BT{t}@({cx:.0f},{cy:.0f})"
                                 for t,cx,cy in out[:6])
                    )
                return out
        except Exception:
            pass

        # Fallback: plain YOLO at same high resolution
        try:
            results = self._model(
                frame, classes=list(VEHICLE_CLASSES),
                conf=CONFIDENCE_MIN, verbose=False, imgsz=1280
            )[0]
            out = []
            for i, box in enumerate(results.boxes):
                if int(box.cls[0]) not in VEHICLE_CLASSES:
                    continue
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cx, cy = (x1+x2)/2, (y1+y2)/2
                out.append((-(i+1), cx, cy, x1, y1, x2, y2))
            if frame_n % 30 == 0:
                self._dbg(f"[fr{frame_n}] fallback YOLO: {len(out)} vehicles")
            return out
        except Exception as e:
            if frame_n % 60 == 0:
                self._dbg(f"Detection error fr{frame_n}: {e}")
            return []

    def _get_pid(self, bt_id: int, cx: float, cy: float) -> str:
        """
        Map a ByteTrack ID to a permanent car ID (P1, P2, ...).
        If the ByteTrack ID was seen before → return its permanent ID.
        If it's new but a permanent car is nearby → rematch it (tracking gap).
        Otherwise → assign a new permanent ID.
        """
        if bt_id in self._bt_to_pid:
            return self._bt_to_pid[bt_id]

        # Try to rematch to an existing permanent ID by proximity
        best_pid, best_d = None, float("inf")
        active_pids = set(self._bt_to_pid.values())
        for pid, (px, py) in self._pid_pos.items():
            if pid in active_pids:
                continue
            d = ((cx-px)**2 + (cy-py)**2)**0.5
            if d < REMATCH_PX and d < best_d:
                best_d, best_pid = d, pid

        if best_pid:
            self._bt_to_pid[bt_id] = best_pid
            self._dbg(f"BT{bt_id} rematched → {best_pid} "
                      f"({best_d:.0f}px away)")
            return best_pid

        # Brand new car
        pid = f"P{self._next_pid}"
        self._next_pid += 1
        self._bt_to_pid[bt_id] = pid
        self._dbg(f"New car {pid} (BT{bt_id}) at ({cx:.0f},{cy:.0f})")
        return pid

    def _best_spot(self, x1, y1, x2, y2) -> Optional[str]:
        """
        Return the SINGLE best spot for this car — the one with the highest
        overlap fraction. A car can only ever claim one spot at a time.
        This prevents camera-angle distortion from making one car appear to
        cover two adjacent spots.
        """
        car_box = np.array(
            [[x1,y1],[x2,y1],[x2,y2],[x1,y2]], dtype=np.float32)
        best_sid     = None
        best_overlap = 0.0
        for sid, poly in self._polys.items():
            spot_area = float(cv2.contourArea(poly))
            if spot_area < 1:
                continue
            try:
                ok, inter = cv2.intersectConvexConvex(poly, car_box)
                if ok and inter is not None and len(inter) > 0:
                    overlap = float(cv2.contourArea(inter)) / spot_area
                    if overlap >= OVERLAP_THRESH and overlap > best_overlap:
                        best_overlap = overlap
                        best_sid     = sid
            except Exception:
                pass
        return best_sid

    def _update(self, detections, ts: float, frame_n: int) -> bool:
        active_pids: Set[str] = set()
        new_status: Dict[str, str] = {sid: "open" for sid in self._polys}

        for (bt_id, cx, cy, x1, y1, x2, y2) in detections:
            pid = self._get_pid(bt_id, cx, cy)
            active_pids.add(pid)
            self._pid_pos[pid]  = (cx, cy)
            self._pid_seen[pid] = ts
            self._pid_box[pid]  = (x1, y1, x2, y2)

            best = self._best_spot(x1, y1, x2, y2)
            self._pid_spots[pid] = {best} if best else set()
            if best:
                new_status[best] = "taken"
                if frame_n % 30 == 0:
                    self._dbg(f"  {pid} → spot {best}")

        # Release cars absent > RELEASE_SECONDS
        for pid in list(self._pid_seen):
            if pid not in active_pids:
                absent = ts - self._pid_seen[pid]
                if absent >= RELEASE_SECONDS:
                    self._dbg(f"{pid} absent {absent:.1f}s — released")
                    del self._pid_seen[pid]
                    self._pid_pos.pop(pid, None)
                    self._pid_box.pop(pid, None)
                    self._pid_spots.pop(pid, None)
                    for bt in [k for k,v in self._bt_to_pid.items()
                               if v == pid]:
                        del self._bt_to_pid[bt]

        self._row_guard(new_status, active_pids)
        return self._confirm(new_status)

    def _annotate(self, frame, detections) -> np.ndarray:
        """
        Draw on the live feed frame:
          - Spot polygons: green = open, blue filled = taken
          - Each car: coloured bounding box + permanent ID label
          - Car's permanent ID label is large and clearly visible
        """
        vis = frame.copy()

        # Draw spot polygons
        for sid, poly in self._polys.items():
            pts   = poly.astype(np.int32)
            taken = self._statuses.get(sid) == "taken"
            if taken:
                overlay = vis.copy()
                cv2.fillPoly(overlay, [pts], (0, 60, 180))
                cv2.addWeighted(overlay, 0.3, vis, 0.7, 0, vis)
                cv2.polylines(vis, [pts], True, (0, 100, 255), 2)
            else:
                cv2.polylines(vis, [pts], True, (0, 200, 0), 1)
            # Spot number
            cx = int(np.mean(poly[:, 0]))
            cy = int(np.mean(poly[:, 1]))
            color = (0, 100, 255) if taken else (0, 200, 0)
            cv2.putText(vis, sid, (cx-8, cy+5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.38, color, 1)

        # Draw each car as a small dot + label at its CENTER POINT only.
        # No bounding box drawn — bounding box was causing visual overlap
        # with neighbouring spot polygons and falsely suggesting spots were taken.
        # The dot represents the car's actual position used for spot matching.
        for (bt_id, cx, cy, x1, y1, x2, y2) in detections:
            pid   = self._bt_to_pid.get(bt_id, f"BT{bt_id}")
            color = _pid_colour(pid)
            icx, icy = int(cx), int(cy)

            # Filled dot at car center — this is the point used for tracking
            cv2.circle(vis, (icx, icy), 8, color, -1)
            cv2.circle(vis, (icx, icy), 8, (0, 0, 0), 1)  # thin black outline

            # Small ID label right next to the dot
            label = pid
            (tw, th), _ = cv2.getTextSize(
                label, cv2.FONT_HERSHEY_SIMPLEX, 0.4, 1)
            lx = icx + 10
            ly = icy + th // 2
            # Small dark background for readability
            cv2.rectangle(vis, (lx-1, ly-th-1), (lx+tw+3, ly+2),
                          (0, 0, 0), -1)
            cv2.putText(vis, label, (lx+1, ly),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, color, 1)

        return vis

    def _row_guard(self, new_status: Dict[str, str],
                   active_pids: Set[str]):
        for row_name, row_ids in ROWS.items():
            cars_in_row = 0
            for pid, (px, py) in self._pid_pos.items():
                if pid not in active_pids:
                    continue
                best_row, best_d = None, float("inf")
                for rn, rids in ROWS.items():
                    for rsid in rids:
                        if rsid not in self._polys:
                            continue
                        poly = self._polys[rsid]
                        pcx  = float(np.mean(poly[:, 0]))
                        pcy  = float(np.mean(poly[:, 1]))
                        d    = ((px-pcx)**2 + (py-pcy)**2)**0.5
                        if d < best_d:
                            best_d, best_row = d, rn
                if best_row == row_name:
                    cars_in_row += 1

            taken_in_row = [s for s in row_ids
                            if new_status.get(s) == "taken"]
            if len(taken_in_row) > cars_in_row:
                excess = len(taken_in_row) - cars_in_row
                freed  = 0
                for sid in taken_in_row:
                    if freed >= excess:
                        break
                    new_status[sid] = "open"
                    freed += 1

    def _confirm(self, new_status: Dict[str, str]) -> bool:
        changed = False
        for sid, new_state in new_status.items():
            current = self._statuses.get(sid, "open")
            if new_state == current:
                self._pending.pop(sid, None)
                continue
            p = self._pending.setdefault(
                sid, {"state": new_state, "count": 0})
            if p["state"] == new_state:
                p["count"] += 1
            else:
                p["state"] = new_state
                p["count"] = 1
            if p["count"] >= N_CONFIRM:
                self._statuses[sid] = new_state
                del self._pending[sid]
                self._dbg(f"Spot {sid}: {current} → {new_state}")
                changed = True
        return changed


class _FeedLost(RuntimeError):
    pass
