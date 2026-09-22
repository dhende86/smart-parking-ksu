import { useState, useEffect, useRef } from "react";

const API = "http://localhost:8000";

const ALL_IDS = [
  "11","10","9","8","7","6","5","4","3","2","1",
  "22","21","20","19","18","17","16","15","14","13","12",
  "23","24","25","26","27","28","29","30","31","32","33","34",
  "44","43","42","41","40","39","38","37","36","35",
];

function allOpen() {
  const s = {};
  ALL_IDS.forEach(id => { s[id] = "open"; });
  return s;
}

const ROWS = [
  { label:"A", ids:["11","10","9","8","7","6","5","4","3","2","1"] },
  { label:"B", ids:["22","21","20","19","18","17","16","15","14","13","12"] },
  { label:"C", ids:["23","24","25","26","27","28","29","30","31","32","33","34"] },
  { label:"D", ids:["44","43","42","41","40","39","38","37","36","35"] },
];

const SW=52, SH=22, GAP=5, LANE=28, TOP=26, LH=22;
const rowX=[0,SW+LANE,SW+LANE+SW,SW+LANE+SW+SW+LANE];
const maxR=Math.max(...ROWS.map(r=>r.ids.length));
const svgH=TOP+LH+maxR*(SH+GAP)-GAP+16;
const svgW=rowX[3]+SW;
const sY=TOP+LH;

export default function App() {
  const [status,    setStatus]    = useState(allOpen());
  const [lastUpd,   setLastUpd]   = useState(null);
  const [connected, setConnected] = useState(false);
  const [feedLost,  setFeedLost]  = useState(false);
  const [backendUp, setBackendUp] = useState(null);
  const [scanState, setScanState] = useState("idle");
  const [url,       setUrl]       = useState("");
  const [scanMsg,   setScanMsg]   = useState("");
  const [showFeed,  setShowFeed]  = useState(true);
  const esRef = useRef(null);

  useEffect(() => { checkBackend(); }, []);

  async function checkBackend() {
    try {
      const r = await fetch(`${API}/health`, {signal: AbortSignal.timeout(4000)});
      if (r.ok) { setBackendUp(true); fetchStatus(); connectSSE(); }
      else { setBackendUp(false); setTimeout(checkBackend, 3000); }
    } catch { setBackendUp(false); setTimeout(checkBackend, 3000); }
  }

  async function fetchStatus() {
    try {
      const r = await fetch(`${API}/status`);
      const d = await r.json();
      if (Object.keys(d).length > 0) {
        setStatus({...allOpen(),...d}); setLastUpd(new Date());
      }
    } catch(_){}
  }

  function connectSSE() {
    if (esRef.current) esRef.current.close();
    const es = new EventSource(`${API}/stream`);
    esRef.current = es;
    es.onopen  = () => setConnected(true);
    es.onerror = () => { setConnected(false); setTimeout(connectSSE, 5000); };
    es.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "status_update") {
          setStatus(prev => ({...prev,...msg.statuses}));
          setLastUpd(new Date());
          setFeedLost(msg.feed === "lost");
          if (msg.feed === "lost") setScanState("lost");
        }
      } catch(_){}
    };
  }

  async function startScan() {
    if (!url.trim()) return;
    setScanState("starting"); setScanMsg("");
    try {
      const r = await fetch(`${API}/stream/start`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({url: url.trim()}),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail||"Failed");
      setScanState("live"); setScanMsg(d.message);
      setShowFeed(true);
    } catch(e) {
      setScanState("error");
      setScanMsg(e.message==="Failed to fetch"
        ? "Cannot reach backend — run: cd backend && python run.py"
        : e.message);
    }
  }

  async function stopScan() {
    try { await fetch(`${API}/stream/stop`,{method:"POST"}); } catch(_){}
    setScanState("idle"); setScanMsg("");
  }

  useEffect(() => {
    const t = setInterval(async () => {
      if (scanState !== "live") return;
      try {
        const r = await fetch(`${API}/stream/status`);
        const d = await r.json();
        if (!d.running && scanState === "live") {
          setScanState(d.feed==="lost" ? "lost" : "finished");
          setScanMsg(d.feed==="lost"
            ? "Feed lost — camera offline or stream ended unexpectedly."
            : "Video finished — showing last known status.");
        }
      } catch(_){}
    }, 1000);
    return () => clearInterval(t);
  }, [scanState]);

  const taken = ALL_IDS.filter(id => status[id]==="taken").length;
  const open  = ALL_IDS.length - taken;
  const pct   = Math.round(open/ALL_IDS.length*100);
  const ts    = lastUpd
    ? lastUpd.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})
    : "—";

  const isLive = scanState === "live";

  return (
    <div style={{maxWidth:520,margin:"0 auto",padding:"1.5rem 1rem 2rem",fontFamily:"system-ui,sans-serif"}}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.2}}`}</style>

      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"1.5rem"}}>
        <div>
          <h1 style={{fontSize:22,fontWeight:500,color:"#111",margin:0}}>Campus Parking</h1>
          <p style={{fontSize:12,color:"#888",margin:"3px 0 0"}}>North Lot</p>
        </div>
        <div style={{
          display:"flex",alignItems:"center",gap:5,padding:"4px 11px",
          borderRadius:99,background:connected?"#EAF3DE":"#f0f0ee",
          border:`0.5px solid ${connected?"#97C459":"#ccc"}`,
        }}>
          <span style={{width:6,height:6,borderRadius:"50%",
            background:connected?"#639922":"#bbb",
            animation:connected?"pulse 1.5s infinite":"none"}}/>
          <span style={{fontSize:11,fontWeight:500,color:connected?"#3B6D11":"#888"}}>
            {connected?"Live":backendUp===false?"Backend offline":"Connecting"}
          </span>
        </div>
      </div>

      {backendUp===false && (
        <div style={{background:"#FCEBEB",border:"0.5px solid #F09595",borderRadius:8,
          padding:"0.75rem 1rem",marginBottom:"1.25rem",fontSize:13,color:"#791F1F"}}>
          <strong>Backend not running.</strong>
          <code style={{display:"block",marginTop:4,padding:"3px 7px",
            background:"rgba(0,0,0,0.06)",borderRadius:4,fontSize:12}}>
            cd backend &amp;&amp; python run.py
          </code>
          <button onClick={checkBackend} style={{marginTop:8,padding:"4px 12px",fontSize:12,
            border:"0.5px solid #F09595",background:"#fff",color:"#791F1F",
            borderRadius:6,cursor:"pointer"}}>Retry</button>
        </div>
      )}

      {feedLost && (
        <div style={{background:"#FCEBEB",border:"0.5px solid #F09595",borderRadius:8,
          padding:"0.75rem 1rem",marginBottom:"1.25rem",fontSize:13,color:"#791F1F"}}>
          ⚠ <strong>Feed lost</strong> — camera may be offline.
        </div>
      )}

      {/* Stats */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",
        gap:10,marginBottom:"1.25rem"}}>
        {[["Open",open,"#3B6D11"],["Taken",taken,"#993C1D"],
          ["Available",`${pct}%`,"#111"],["Updated",ts,"#888"]].map(([label,val,color])=>(
          <div key={label} style={{background:"#f5f5f3",borderRadius:8,padding:"0.75rem 0.9rem"}}>
            <div style={{fontSize:11,color:"#999",marginBottom:4}}>{label}</div>
            <div style={{fontSize:label==="Updated"?12:22,fontWeight:500,
              color,lineHeight:1}}>{val}</div>
          </div>
        ))}
      </div>

      {/* Parking map */}
      <div style={{background:"#fff",border:"0.5px solid rgba(0,0,0,0.1)",
        borderRadius:12,padding:"1rem",marginBottom:"1rem"}}>
        <svg viewBox={`0 0 ${svgW} ${svgH}`}
          style={{display:"block",width:"100%",height:"auto"}}>
          <rect width={svgW} height={svgH} fill="#f7f7f5" rx="6"/>
          <rect x={0} y={0} width={svgW} height={TOP} fill="#ebebea"/>
          <rect x={rowX[1]-LANE} y={0} width={LANE} height={svgH} fill="#ebebea"/>
          <rect x={rowX[3]-LANE} y={0} width={LANE} height={svgH} fill="#ebebea"/>
          <text x={svgW/2} y={TOP/2+4} textAnchor="middle" fontSize="10" fill="#bbb" fontFamily="system-ui">→</text>
          <text x={rowX[1]-LANE/2} y={sY+(maxR*(SH+GAP))/2} textAnchor="middle" fontSize="10" fill="#bbb" fontFamily="system-ui">↑</text>
          <text x={rowX[3]-LANE/2} y={sY+(maxR*(SH+GAP))/2} textAnchor="middle" fontSize="10" fill="#bbb" fontFamily="system-ui">↓</text>
          {ROWS.map((row,ri)=>(
            <text key={row.label} x={rowX[ri]+SW/2} y={TOP+LH-5}
              textAnchor="middle" fontSize="10" fontWeight="500"
              fill="#aaa" fontFamily="system-ui">Row {row.label}</text>
          ))}
          {ROWS.map((row,ri)=>
            row.ids.map((id,i)=>{
              const taken=status[id]==="taken";
              const x=rowX[ri], y=sY+i*(SH+GAP);
              return (
                <g key={id}>
                  <rect x={x} y={y} width={SW} height={SH} rx="3"
                    fill={taken?"#2c2c2c":"#ffffff"}
                    stroke={taken?"#111":"#d0d0d0"} strokeWidth="0.75"/>
                  <text x={x+SW/2} y={y+SH/2+4} textAnchor="middle"
                    fontSize="9" fontWeight="500" fontFamily="system-ui"
                    fill={taken?"#888":"#aaa"} style={{pointerEvents:"none"}}>
                    {id}
                  </text>
                </g>
              );
            })
          )}
        </svg>
      </div>

      {/* Live camera feed */}
      <div style={{background:"#fff",border:"0.5px solid rgba(0,0,0,0.1)",
        borderRadius:12,padding:"1rem",marginBottom:"1rem"}}>
        <div style={{display:"flex",justifyContent:"space-between",
          alignItems:"center",marginBottom:"0.75rem"}}>
          <div>
            <div style={{fontSize:14,fontWeight:500,color:"#111"}}>Camera feed</div>
            <div style={{fontSize:12,color:"#888",marginTop:2}}>
              Live view — green = open spot · blue = taken spot · yellow = car ID
            </div>
          </div>
          <button
            onClick={()=>setShowFeed(f=>!f)}
            style={{fontSize:12,padding:"4px 12px",border:"0.5px solid #ddd",
              borderRadius:6,background:"#fff",color:"#666",cursor:"pointer"}}>
            {showFeed?"Hide":"Show"}
          </button>
        </div>

        {showFeed && (
          <div style={{position:"relative",background:"#111",borderRadius:8,
            overflow:"hidden",minHeight:120}}>
            {isLive ? (
              <img
                src={`${API}/feed`}
                style={{width:"100%",display:"block",borderRadius:8}}
                alt="Live camera feed"
              />
            ) : (
              <div style={{display:"flex",alignItems:"center",justifyContent:"center",
                height:120,color:"#444",fontSize:13}}>
                Start the scanner to see live feed
              </div>
            )}
            {isLive && (
              <div style={{position:"absolute",top:8,left:8,
                background:"rgba(0,0,0,0.55)",borderRadius:4,
                padding:"3px 8px",fontSize:11,color:"#7ec850",
                display:"flex",alignItems:"center",gap:5}}>
                <span style={{width:6,height:6,borderRadius:"50%",
                  background:"#639922",display:"inline-block",
                  animation:"pulse 1.2s infinite"}}/>
                LIVE
              </div>
            )}
          </div>
        )}
      </div>

      {/* Scanner controls */}
      <div style={{background:"#fff",border:"0.5px solid rgba(0,0,0,0.1)",
        borderRadius:12,padding:"1rem 1.25rem"}}>
        <div style={{fontSize:14,fontWeight:500,color:"#111",marginBottom:2}}>
          Live scanner
        </div>
        <div style={{fontSize:12,color:"#888",marginBottom:"0.85rem"}}>
          Paste your YouTube URL or RTSP camera URL.
          Each detected car gets a persistent ID — spots only change when cars
          actually arrive or leave.
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <input type="text" value={url} onChange={e=>setUrl(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&!isLive&&startScan()}
            placeholder="https://youtu.be/...  or  rtsp://camera-ip/stream"
            disabled={isLive||scanState==="starting"}
            style={{flex:1,minWidth:200,height:36,
              border:"0.5px solid rgba(0,0,0,0.15)",borderRadius:6,
              padding:"0 10px",fontSize:13,color:"#111",
              background:isLive?"#f9f9f9":"#fff"}}/>
          {!isLive ? (
            <button onClick={startScan}
              disabled={!url.trim()||scanState==="starting"}
              style={{height:36,padding:"0 16px",fontSize:13,border:"none",
                borderRadius:6,
                background:!url.trim()||scanState==="starting"?"#ddd":"#111",
                color:"#fff",
                cursor:!url.trim()||scanState==="starting"?"default":"pointer"}}>
              {scanState==="starting"?"Starting…":"Start"}
            </button>
          ) : (
            <button onClick={stopScan} style={{height:36,padding:"0 16px",
              fontSize:13,border:"0.5px solid #F09595",borderRadius:6,
              background:"#fff",color:"#993C1D",cursor:"pointer"}}>Stop</button>
          )}
        </div>

        {isLive && (
          <div style={{display:"flex",alignItems:"center",gap:7,marginTop:"0.65rem",
            padding:"6px 10px",borderRadius:6,background:"#EAF3DE",
            border:"0.5px solid #97C459"}}>
            <span style={{width:8,height:8,borderRadius:"50%",background:"#639922",
              display:"inline-block",animation:"pulse 1.2s infinite"}}/>
            <span style={{fontSize:12,color:"#3B6D11",fontWeight:500}}>
              Scanning — tracking car IDs in real time
            </span>
          </div>
        )}

        {(scanState==="finished"||scanState==="lost"||scanState==="error")&&scanMsg&&(
          <div style={{marginTop:"0.65rem",padding:"6px 10px",borderRadius:6,fontSize:12,
            background:scanState==="finished"?"#f0f0ee":"#FCEBEB",
            border:`0.5px solid ${scanState==="finished"?"#ccc":"#F09595"}`,
            color:scanState==="finished"?"#666":"#993C1D"}}>
            {scanMsg}
          </div>
        )}

        <p style={{fontSize:11,color:"#bbb",marginTop:"0.5rem"}}>
          YouTube · RTSP · local video · <a href="/debug" style={{color:"#bbb"}}>debug console</a> · <a href="/editor" style={{color:"#bbb"}}>edit polygons</a>
        </p>
      </div>
    </div>
  );
}
