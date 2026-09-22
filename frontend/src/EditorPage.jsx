/**
 * EditorPage — draw and adjust parking spot polygons.
 * http://localhost:5173/editor
 *
 * How it works:
 *  1. Upload your raw camera image (no polygons on it)
 *  2. Click "Auto-detect" — backend finds parking lines and draws rough polygons
 *  3. Click any polygon to select it (turns cyan)
 *  4. Drag the white corner handles to fix alignment
 *  5. Click "Save" — writes to polygons.json AND live-reloads the scanner
 */

import { useState, useEffect, useRef } from "react";

const API = "http://localhost:8000";

export default function EditorPage() {
  const [imgSrc,   setImgSrc]   = useState(null);
  const [imgW,     setImgW]     = useState(928);
  const [imgH,     setImgH]     = useState(580);
  const [spots,    setSpots]    = useState([]);
  const [selected, setSelected] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [msg,      setMsg]      = useState({ text: "", ok: true });
  const [busy,     setBusy]     = useState("");
  const [streamUrl,setStreamUrl] = useState("");
  const canvasRef = useRef(null);
  const imgElRef  = useRef(null);

  useEffect(() => { loadAll(); }, []);
  useEffect(() => { redraw(); }, [imgSrc, spots, selected]);

  async function loadAll() {
    try {
      const [pr, ir] = await Promise.allSettled([
        fetch(`${API}/polygons`),
        fetch(`${API}/polygons/reference-image`),
      ]);
      if (pr.status === "fulfilled") {
        const d = await pr.value.json();
        setSpots(d.spots || []);
      }
      if (ir.status === "fulfilled" && ir.value.ok) {
        const d = await ir.value.json();
        setImgSrc(d.image); setImgW(d.width); setImgH(d.height);
        imgElRef.current = null;  // force redraw with new image
      }
    } catch(_) {}
  }

  // Reload reference image every 5s so after scanner starts,
  // the editor auto-shows the correct video frame
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${API}/polygons/reference-image`);
        if (!r.ok) return;
        const d = await r.json();
        setImgW(w => {
          if (w !== d.width || true) {
            setImgSrc(d.image);
            setImgH(d.height);
            imgElRef.current = null;
          }
          return d.width;
        });
      } catch(_) {}
    }, 5000);
    return () => clearInterval(t);
  }, []);

  // ── coordinate helpers ────────────────────────────────────────────────────

  function toCanvas(ix, iy) {
    // Convert normalized 0-1 coords → canvas pixels
    // If coords are legacy pixel coords (>1), fall back to imgW/imgH scaling
    const c = canvasRef.current;
    if (!c) return [ix, iy];
    if (ix <= 1.0 && iy <= 1.0) {
      // Normalized coords
      return [ix * c.width, iy * c.height];
    }
    // Legacy pixel coords
    return [ix * c.width / imgW, iy * c.height / imgH];
  }
  function toImage(cx, cy) {
    // Save as normalized 0-1 coordinates (6 decimal places)
    // This makes polygons work at ANY resolution — editor, scanner, live feed
    const c = canvasRef.current;
    if (!c) return [cx / c.width, cy / c.height];
    return [
      Math.round((cx / c.width)  * 1000000) / 1000000,
      Math.round((cy / c.height) * 1000000) / 1000000,
    ];
  }
  function canvasXY(e) {
    const c = canvasRef.current, rect = c.getBoundingClientRect();
    return [
      (e.clientX - rect.left) * c.width  / rect.width,
      (e.clientY - rect.top)  * c.height / rect.height,
    ];
  }

  // ── drawing ────────────────────────────────────────────────────────────────

  function redraw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const paint = () => {
      if (imgElRef.current) {
        ctx.globalAlpha = 0.88;
        ctx.drawImage(imgElRef.current, 0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#555";
        ctx.font = "15px system-ui";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Upload a reference image to begin", canvas.width/2, canvas.height/2);
      }
      paintSpots(ctx);
    };

    if (imgSrc && (!imgElRef.current || imgElRef.current._src !== imgSrc)) {
      const img = new Image();
      img.onload = () => { imgElRef.current = img; imgElRef.current._src = imgSrc; paint(); };
      img.src = imgSrc;
    } else {
      paint();
    }
  }

  function paintSpots(ctx) {
    spots.forEach(spot => {
      const isSel = spot.id === selected;
      const pts   = spot.pts.map(([x, y]) => toCanvas(x, y));
      if (pts.length < 2) return;

      ctx.beginPath();
      pts.forEach(([cx, cy], i) => i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy));
      ctx.closePath();
      ctx.fillStyle   = isSel ? "rgba(0,210,255,0.20)" : "rgba(255,208,0,0.12)";
      ctx.fill();
      ctx.strokeStyle = isSel ? "#00d2ff" : "#ffd000";
      ctx.lineWidth   = isSel ? 2.5 : 1.5;
      ctx.stroke();

      const lcx = pts.reduce((s, [x]) => s + x, 0) / pts.length;
      const lcy = pts.reduce((s, [, y]) => s + y, 0) / pts.length;
      ctx.font         = `bold ${isSel ? 12 : 10}px system-ui`;
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle    = isSel ? "#00d2ff" : "#ffd000";
      ctx.fillText(spot.id, lcx, lcy);

      pts.forEach(([cx, cy]) => {
        ctx.beginPath();
        ctx.arc(cx, cy, isSel ? 6 : 3, 0, Math.PI * 2);
        ctx.fillStyle = isSel ? "#fff" : "rgba(255,255,255,0.4)";
        ctx.fill();
        if (isSel) {
          ctx.strokeStyle = "#00d2ff";
          ctx.lineWidth   = 1.5;
          ctx.stroke();
        }
      });
    });
  }

  // ── mouse ──────────────────────────────────────────────────────────────────

  function onMouseDown(e) {
    const [mx, my] = canvasXY(e);

    if (selected) {
      const spot = spots.find(s => s.id === selected);
      if (spot) {
        for (let i = 0; i < spot.pts.length; i++) {
          const [cx, cy] = toCanvas(...spot.pts[i]);
          if (Math.hypot(mx - cx, my - cy) <= 10) {
            setDragging({ spotId: selected, ptIdx: i });
            return;
          }
        }
      }
    }

    for (const spot of [...spots].reverse()) {
      const pts = spot.pts.map(([x, y]) => toCanvas(x, y));
      if (ptInPoly(mx, my, pts)) { setSelected(spot.id); return; }
    }
    setSelected(null);
  }

  function onMouseMove(e) {
    if (!dragging) return;
    const [mx, my] = canvasXY(e);
    const [ix, iy] = toImage(mx, my);
    setSpots(prev => prev.map(s =>
      s.id !== dragging.spotId ? s :
      { ...s, pts: s.pts.map((pt, i) => i === dragging.ptIdx ? [ix, iy] : pt) }
    ));
  }

  function onMouseUp() { setDragging(null); }

  function ptInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi))
        inside = !inside;
    }
    return inside;
  }

  // ── actions ────────────────────────────────────────────────────────────────

  async function uploadImage(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy("uploading"); setMsg({ text: "", ok: true });
    const form = new FormData();
    form.append("file", file);
    try {
      const r = await fetch(`${API}/polygons/upload-image`, { method: "POST", body: form });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "Upload failed");
      setImgSrc(d.image); setImgW(d.width); setImgH(d.height);
      imgElRef.current = null;
      setMsg({ text: "Image uploaded — ready for polygon drawing", ok: true });
    } catch(err) { setMsg({ text: err.message, ok: false }); }
    setBusy(""); e.target.value = "";
  }

  async function grabFrame() {
    if (!streamUrl.trim()) return;
    setBusy("grabbing"); setMsg({ text: "Grabbing frame from stream...", ok: true });
    try {
      const r = await fetch(`${API}/polygons/grab-frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: streamUrl.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "Failed");
      setImgSrc(d.image); setImgW(d.width); setImgH(d.height);
      imgElRef.current = null;
      setMsg({ text: `✓ ${d.message}`, ok: true });
    } catch(err) { setMsg({ text: err.message, ok: false }); }
    setBusy("");
  }

  async function autoDetect() {
    setBusy("detecting"); setMsg({ text: "Scanning image for parking lines...", ok: true });
    try {
      const r = await fetch(`${API}/polygons/auto-detect`, { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "Detection failed");
      setSpots(d.spots); setSelected(null);
      setMsg({ text: `Detected ${d.count} spot${d.count !== 1 ? "s" : ""} — adjust corners then save`, ok: true });
    } catch(err) { setMsg({ text: err.message, ok: false }); }
    setBusy("");
  }

  function wipeAll() {
    if (!window.confirm("Clear all polygons? You can re-draw or auto-detect after.")) return;
    setSpots([]); setSelected(null);
    setMsg({ text: "Cleared — auto-detect or adjust, then save", ok: true });
  }

  async function savePolygons() {
    setBusy("saving"); setMsg({ text: "", ok: true });
    try {
      const r = await fetch(`${API}/polygons`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spots }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "Save failed");
      setMsg({ text: `✓ ${d.message}`, ok: true });
    } catch(err) { setMsg({ text: `✗ ${err.message}`, ok: false }); }
    setBusy("");
  }

  function deleteSelected() {
    if (!selected) return;
    setSpots(prev => prev.filter(s => s.id !== selected));
    setSelected(null);
  }

  const isBusy = busy !== "";

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "1.5rem 1rem 3rem",
                  fontFamily: "system-ui,sans-serif" }}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}`}</style>

      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between",
                    alignItems:"center", marginBottom:"1.25rem" }}>
        <div>
          <h1 style={{ fontSize:20, fontWeight:500, color:"#111", margin:0 }}>
            Polygon editor
          </h1>
          <p style={{ fontSize:12, color:"#888", margin:"3px 0 0" }}>
            {spots.length} spot{spots.length !== 1 ? "s" : ""} defined
            {selected
              ? ` · Spot ${selected} selected — drag white handles to adjust`
              : " · Click a spot to select it"}
          </p>
        </div>
        <a href="/" style={{ fontSize:12, color:"#888", textDecoration:"none",
                             padding:"6px 12px", border:"0.5px solid #ddd", borderRadius:6 }}>
          ← Back to map
        </a>
      </div>

      {/* Toolbar */}
      <div style={{ display:"flex", gap:8, marginBottom:"0.75rem",
                    flexWrap:"wrap", alignItems:"center" }}>

        <label style={{ padding:"7px 14px", border:"0.5px solid #ddd", borderRadius:6,
                        fontSize:13, cursor: isBusy ? "default" : "pointer",
                        background:"#fff", color:"#111", opacity: isBusy ? 0.5 : 1 }}>
          {busy === "uploading" ? "Uploading…" : "Upload image"}
          <input type="file" accept=".jpg,.jpeg,.png" style={{ display:"none" }}
            onChange={uploadImage} disabled={isBusy}/>
        </label>

        {/* Grab frame from stream */}
        <div style={{ display:"flex", gap:6, alignItems:"center",
                      border:"0.5px solid #ddd", borderRadius:6,
                      padding:"3px 6px 3px 10px", background:"#fff" }}>
          <input type="text" value={streamUrl}
            onChange={e => setStreamUrl(e.target.value)}
            placeholder="Paste stream URL → grab frame"
            style={{ width:260, border:"none", outline:"none",
                     fontSize:12, color:"#111", background:"transparent" }}/>
          <button onClick={grabFrame} disabled={isBusy || !streamUrl.trim()}
            style={{ padding:"4px 10px", border:"none", borderRadius:4,
                     fontSize:12, fontWeight:500,
                     cursor: isBusy || !streamUrl.trim() ? "default" : "pointer",
                     background: !streamUrl.trim() || isBusy ? "#ddd" : "#185FA5",
                     color: "#fff" }}>
            {busy === "grabbing" ? "Grabbing…" : "Grab frame"}
          </button>
        </div>

        <button onClick={autoDetect} disabled={isBusy || !imgSrc}
          style={{ padding:"7px 14px", borderRadius:6, fontSize:13, fontWeight:500,
                   border:"0.5px solid #378ADD",
                   cursor: isBusy || !imgSrc ? "default" : "pointer",
                   background: isBusy || !imgSrc ? "#f0f0ee" : "#E6F1FB",
                   color: isBusy || !imgSrc ? "#aaa" : "#185FA5" }}>
          {busy === "detecting" ? "Detecting…" : "Auto-detect spots"}
        </button>

        <button onClick={savePolygons} disabled={isBusy || spots.length === 0}
          style={{ padding:"7px 16px", border:"none", borderRadius:6,
                   fontSize:13, fontWeight:500,
                   cursor: isBusy || spots.length === 0 ? "default" : "pointer",
                   background: spots.length === 0 || isBusy ? "#ddd" : "#111",
                   color:"#fff" }}>
          {busy === "saving" ? "Saving…" : "Save polygons"}
        </button>

        {selected && (
          <button onClick={deleteSelected}
            style={{ padding:"7px 14px", border:"0.5px solid #F09595", borderRadius:6,
                     fontSize:13, cursor:"pointer", background:"#fff", color:"#993C1D" }}>
            Delete spot {selected}
          </button>
        )}

        <button onClick={wipeAll} disabled={isBusy}
          style={{ padding:"7px 14px", border:"0.5px solid #F09595", borderRadius:6,
                   fontSize:13, cursor:"pointer", background:"#FCEBEB", color:"#993C1D",
                   marginLeft:"auto" }}>
          Wipe all
        </button>
      </div>

      {/* Message */}
      {msg.text && (
        <div style={{ padding:"8px 12px", borderRadius:6, marginBottom:"0.75rem",
                      fontSize:12, background: msg.ok ? "#EAF3DE" : "#FCEBEB",
                      color: msg.ok ? "#3B6D11" : "#993C1D",
                      border: `0.5px solid ${msg.ok ? "#97C459" : "#F09595"}` }}>
          {msg.text}
        </div>
      )}

      {/* Instructions */}
      <div style={{ background:"#EAF3DE", borderRadius:8, padding:"10px 14px",
                    fontSize:12, color:"#3B6D11", marginBottom:"0.75rem",
                    border:"0.5px solid #97C459" }}>
        <strong>How to align polygons perfectly with the camera:</strong><br/>
        <span style={{display:"block",marginTop:4}}>
          <strong>Step 1.</strong> Paste your stream URL below and click <strong>Grab frame</strong> — this captures the exact video frame so polygons line up perfectly.<br/>
          <strong>Step 2.</strong> Click <strong>Auto-detect spots</strong> to get starting polygons, OR they will already be shown if previously saved.<br/>
          <strong>Step 3.</strong> Click a spot (turns cyan) → drag white corner handles to align with the painted parking lines you see in the image.<br/>
          <strong>Step 4.</strong> Click <strong>Save polygons</strong> — the scanner updates instantly with the new positions.
        </span>
      </div>

      {/* Canvas */}
      <div style={{ border:"0.5px solid rgba(0,0,0,0.12)", borderRadius:12,
                    overflow:"hidden", background:"#111", position:"relative" }}>
        <canvas ref={canvasRef} width={imgW} height={imgH}
          style={{ display:"block", width:"100%",
                   cursor: dragging ? "grabbing" : selected ? "crosshair" : "default" }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        />
        <div style={{ position:"absolute", bottom:8, right:10, fontSize:10,
                      color:"rgba(255,255,255,0.3)" }}>
          {imgW}×{imgH} · {spots.length} polygons
        </div>
      </div>

      {/* Spot chips */}
      {spots.length > 0 && (
        <div style={{ marginTop:"1rem" }}>
          <div style={{ fontSize:12, color:"#999", marginBottom:6 }}>
            All spots — click to select on canvas
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:5 }}>
            {spots.map(s => (
              <button key={s.id} onClick={() => setSelected(s.id)}
                style={{ padding:"3px 9px", fontSize:11, borderRadius:4, cursor:"pointer",
                         background: s.id === selected ? "#00d2ff" : "#f0f0ee",
                         color:      s.id === selected ? "#fff" : "#555",
                         border:     s.id === selected ? "1px solid #00d2ff" : "0.5px solid #ddd",
                         fontWeight: s.id === selected ? 500 : 400 }}>
                {s.id}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
