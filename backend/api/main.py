import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import asyncio, json, time, logging, threading
from typing import Dict, List, Optional
from collections import deque
import cv2, numpy as np

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="KSU Parking")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

DATA_DIR      = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
os.makedirs(DATA_DIR, exist_ok=True)
POLYGONS_FILE = os.path.join(DATA_DIR, "polygons.json")
STATUS_FILE   = os.path.join(DATA_DIR, "status.json")
REF_IMAGE     = os.path.join(DATA_DIR, "reference.jpg")
POLY_REF_W, POLY_REF_H = 928, 580

sse_q:   List[asyncio.Queue] = []
debug_q: List[asyncio.Queue] = []
scanner  = None
dbg_log: deque = deque(maxlen=500)
feed_ok  = True

_frame_lock   = threading.Lock()
_latest_frame = None


def set_latest_frame(annotated_frame):
    """Receive pre-annotated frame from scanner and store as JPEG."""
    global _latest_frame
    _, buf = cv2.imencode(".jpg", annotated_frame,
                          [cv2.IMWRITE_JPEG_QUALITY, 75])
    with _frame_lock:
        _latest_frame = buf.tobytes()


def _load(path, default):
    try:    return json.load(open(path))
    except: return default

def _save(path, data):
    json.dump(data, open(path, "w"), indent=2)

def _broadcast(data: dict):
    msg = json.dumps(data)
    for q in sse_q: q.put_nowait(msg)

def dbg(msg: str):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    logger.info(msg)
    dbg_log.append(line)
    for q in debug_q: q.put_nowait(line)


class Spot(BaseModel):
    id: str
    pts: List[List[float]]

class StreamPayload(BaseModel):
    url: str


def _resolve_url(url: str) -> str:
    if "youtube.com" in url or "youtu.be" in url:
        dbg("Resolving YouTube URL via yt-dlp...")
        try:
            import yt_dlp
            opts = {"quiet": True, "format": "best[ext=mp4]/best[height<=720]/best"}
            with yt_dlp.YoutubeDL(opts) as ydl:
                info   = ydl.extract_info(url, download=False)
                stream = info.get("url") or (info.get("formats") or [{}])[-1].get("url", "")
                if not stream:
                    raise RuntimeError("yt-dlp returned no URL")
                dbg("YouTube URL resolved OK")
                return stream
        except ImportError:
            raise RuntimeError("yt-dlp not installed — run: pip install yt-dlp")
        except Exception as e:
            raise RuntimeError(f"yt-dlp error: {e}")
    return url


# ── health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "feed": "ok" if feed_ok else "lost"}


# ── live MJPEG feed ────────────────────────────────────────────────────────────

@app.get("/feed")
async def video_feed():
    """
    MJPEG stream. Shown in <img src="http://localhost:8000/feed">.
    Sends a blank frame immediately so the img tag loads right away,
    then streams live annotated frames as the scanner runs.
    """
    async def gen():
        # Send blank frame first so browser img tag shows immediately
        blank = np.zeros((360, 640, 3), dtype=np.uint8)
        cv2.putText(blank, "Waiting for scanner...", (140, 180),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (80, 80, 80), 2)
        _, buf = cv2.imencode(".jpg", blank)
        yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
               + buf.tobytes() + b"\r\n")
        while True:
            with _frame_lock:
                frame = _latest_frame
            if frame:
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
                       + frame + b"\r\n")
            await asyncio.sleep(0.05)   # ~20fps

    return StreamingResponse(
        gen(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )


# ── debug log stream ───────────────────────────────────────────────────────────

@app.get("/debug/stream")
async def debug_stream():
    q: asyncio.Queue = asyncio.Queue()
    debug_q.append(q)
    history = list(dbg_log)
    async def gen():
        try:
            for line in history: yield f"data: {json.dumps(line)}\n\n"
            yield f"data: {json.dumps('--- live ---')}\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=30)
                    yield f"data: {json.dumps(msg)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            if q in debug_q: debug_q.remove(q)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no"})


# ── scanner control ────────────────────────────────────────────────────────────

@app.post("/stream/start")
async def stream_start(payload: StreamPayload):
    global scanner, feed_ok
    dbg(f"Stream start: {payload.url}")
    try:
        resolved = _resolve_url(payload.url)
    except RuntimeError as e:
        raise HTTPException(400, str(e))

    saved = _load(POLYGONS_FILE, {"spots": []})
    spots = [Spot(**s) for s in saved.get("spots", [])]
    if not spots:
        raise HTTPException(400, "No polygons defined — open the editor first")

    def on_update(data: dict):
        global feed_ok
        lost    = data.pop("__feed_lost__", False)
        feed_ok = not lost
        _save(STATUS_FILE, data)
        _broadcast({"type": "status_update", "statuses": dict(data),
                    "feed": "lost" if lost else "ok"})

    if scanner and getattr(scanner, "_running", False):
        scanner._running = False
        await asyncio.sleep(0.3)

    from scanner.spot_scanner import SpotScanner
    scanner = SpotScanner(spots=spots, source=resolved,
                          on_update=on_update, debug_fn=dbg,
                          frame_callback=set_latest_frame)
    feed_ok = True
    asyncio.create_task(scanner.run())
    dbg(f"Scanner started — {len(spots)} spots")
    return {"message": "Scanner started"}


@app.post("/stream/stop")
async def stream_stop():
    global scanner, feed_ok
    if scanner:
        scanner._running = False
        scanner = None
    feed_ok = True
    dbg("Scanner stopped")
    return {"message": "Stopped"}


@app.get("/stream/status")
def stream_status():
    return {
        "running": scanner is not None and getattr(scanner, "_running", False),
        "feed":    "ok" if feed_ok else "lost",
    }


# ── polygons ───────────────────────────────────────────────────────────────────

@app.get("/polygons")
def get_polygons():
    return _load(POLYGONS_FILE, {"spots": []})


@app.put("/polygons")
async def save_polygons(request: Request):
    """
    Save polygon edits from the editor.
    Writes to polygons.json AND hot-reloads the running scanner instantly.
    No restart needed.
    """
    payload    = await request.json()
    spots_data = payload.get("spots", [])
    _save(POLYGONS_FILE, {"spots": spots_data})
    dbg(f"Polygons saved: {len(spots_data)} spots → polygons.json")

    if scanner and getattr(scanner, "_running", False):
        try:
            new_spots = [Spot(**s) for s in spots_data]
            scanner.update_polygons(new_spots)
            dbg("Running scanner hot-reloaded with new polygons")
        except Exception as e:
            dbg(f"Hot-reload error: {e}")

    return {"message": f"Saved {len(spots_data)} polygons — scanner updated"}


@app.post("/polygons/upload-image")
async def upload_reference_image(file: UploadFile = File(...)):
    """Upload a reference image for drawing polygons in the editor."""
    import base64
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in {".jpg", ".jpeg", ".png"}:
        raise HTTPException(400, "Only .jpg or .png accepted")
    contents = await file.read()
    frame = cv2.imdecode(np.frombuffer(contents, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(400, "Cannot read image")
    cv2.imwrite(REF_IMAGE, frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
    dbg(f"Reference image saved: {frame.shape[1]}x{frame.shape[0]}")
    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return {
        "image":  f"data:image/jpeg;base64,{base64.b64encode(buf).decode()}",
        "width":  frame.shape[1],
        "height": frame.shape[0],
    }


@app.get("/polygons/reference-image")
def get_reference_image():
    """Return stored reference image as base64 for the editor canvas."""
    import base64
    if not os.path.exists(REF_IMAGE):
        raise HTTPException(404, "No reference image yet — upload one in the editor")
    frame = cv2.imread(REF_IMAGE)
    if frame is None:
        raise HTTPException(500, "Cannot read reference image")
    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return {
        "image":  f"data:image/jpeg;base64,{base64.b64encode(buf).decode()}",
        "width":  frame.shape[1],
        "height": frame.shape[0],
    }


@app.post("/polygons/auto-detect")
async def auto_detect_polygons():
    """
    Auto-detect parking spot polygons from yellow/white painted lines
    in the reference image. Returns rough polygons the user can adjust.
    """
    if not os.path.exists(REF_IMAGE):
        raise HTTPException(404, "Upload a reference image first")
    frame = cv2.imread(REF_IMAGE)
    if frame is None:
        raise HTTPException(500, "Cannot read reference image")

    fh, fw = frame.shape[:2]
    dbg(f"Auto-detecting spots in {fw}x{fh}...")
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

    # Yellow parking lines
    mask = cv2.inRange(hsv, np.array([15, 60, 80]), np.array([40, 255, 255]))
    # White lines
    mask |= cv2.inRange(hsv, np.array([0, 0, 160]), np.array([180, 50, 255]))

    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mask = cv2.dilate(mask, kernel, iterations=2)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=3)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    spots = []
    min_a, max_a = fw * fh * 0.005, fw * fh * 0.15

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if not (min_a < area < max_a):
            continue
        peri   = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.04 * peri, True)
        if not (3 <= len(approx) <= 6):
            continue
        x, y, rw, rh = cv2.boundingRect(approx)
        aspect = max(rw, rh) / max(min(rw, rh), 1)
        if not (1.2 <= aspect <= 8.0):
            continue
        spots.append({"id": str(len(spots)+1),
                      "pts": approx.reshape(-1, 2).tolist()})

    spots.sort(key=lambda s: (
        sum(p[1] for p in s["pts"]) / len(s["pts"]),
        sum(p[0] for p in s["pts"]) / len(s["pts"])
    ))
    for i, s in enumerate(spots, 1):
        s["id"] = str(i)

    dbg(f"Auto-detected {len(spots)} spots")
    return {"spots": spots, "count": len(spots)}


@app.post("/polygons/wipe")
def wipe_polygons():
    """Wipe all polygons from polygons.json."""
    _save(POLYGONS_FILE, {"spots": []})
    dbg("All polygons wiped")
    return {"message": "All polygons cleared"}


# ── status + SSE ──────────────────────────────────────────────────────────────

@app.get("/status")
def get_status():
    return _load(STATUS_FILE, {})


@app.get("/stream")
async def sse():
    q: asyncio.Queue = asyncio.Queue()
    sse_q.append(q)
    async def gen():
        try:
            yield 'data: {"type":"connected"}\n\n'
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=30)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            if q in sse_q: sse_q.remove(q)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control":"no-cache","X-Accel-Buffering":"no"})


@app.on_event("startup")
async def startup():
    dbg("Backend ready — http://localhost:8000")
