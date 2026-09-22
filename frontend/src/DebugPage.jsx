import { useState, useEffect, useRef } from "react";
const API = "http://localhost:8000";

function color(line) {
  if (line.includes("FEED LOST")||line.includes("Fatal")||line.includes("error")) return "#f08080";
  if (line.includes("→ taken")||line.includes("= taken")) return "#fac775";
  if (line.includes("→ open") ||line.includes("= open"))  return "#7ec850";
  if (line.includes("vehicle")||line.includes("Car at"))  return "#9FE1CB";
  if (line.includes("Polygon")||line.includes("scaled"))  return "#AFA9EC";
  return "#c8c8c8";
}

export default function DebugPage() {
  const [logs, setLogs]       = useState([]);
  const [conn, setConn]       = useState(false);
  const [filter, setFilter]   = useState("");
  const [paused, setPaused]   = useState(false);
  const bottomRef = useRef();
  const esRef     = useRef();
  const pausedRef = useRef(false);

  useEffect(() => { connect(); return () => esRef.current?.close(); }, []);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { if (!paused) bottomRef.current?.scrollIntoView({behavior:"smooth"}); }, [logs,paused]);

  function connect() {
    const es = new EventSource(`${API}/debug/stream`);
    esRef.current = es;
    es.onopen    = () => setConn(true);
    es.onerror   = () => { setConn(false); setTimeout(connect, 3000); };
    es.onmessage = e => {
      if (pausedRef.current) return;
      try { setLogs(p => [...p.slice(-600), JSON.parse(e.data)]); } catch(_) {}
    };
  }

  const visible = filter ? logs.filter(l=>l.toLowerCase().includes(filter.toLowerCase())) : logs;

  return (
    <div style={{background:"#0d0d0d",minHeight:"100vh",fontFamily:"monospace",fontSize:12}}>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 14px",
        background:"#111",borderBottom:"1px solid #222",flexWrap:"wrap"}}>
        <span style={{color:"#fff",fontWeight:"bold",fontSize:13}}>KSU Parking — Debug</span>
        <span style={{padding:"2px 8px",borderRadius:99,fontSize:10,
          background:conn?"#1a2e0e":"#2a1010",
          color:conn?"#7ec850":"#f08080",
          border:`1px solid ${conn?"#3B6D11":"#A32D2D"}`}}>
          {conn?"● connected":"○ disconnected"}
        </span>
        <span style={{fontSize:10,color:"#444"}}>
          Student view: <strong style={{color:"#666"}}>http://localhost:5173</strong>
        </span>
        <input type="text" placeholder="Filter…" value={filter}
          onChange={e=>setFilter(e.target.value)}
          style={{flex:1,minWidth:120,background:"#1a1a1a",border:"1px solid #333",
            borderRadius:4,padding:"4px 8px",color:"#ccc",fontSize:11}}/>
        <button onClick={()=>setPaused(p=>!p)} style={{padding:"4px 10px",
          background:paused?"#2a1a00":"#1a1a1a",
          border:`1px solid ${paused?"#854F0B":"#333"}`,
          color:paused?"#EF9F27":"#aaa",borderRadius:4,cursor:"pointer",fontSize:11}}>
          {paused?"▶ resume":"⏸ pause"}
        </button>
        <button onClick={()=>setLogs([])} style={{padding:"4px 10px",background:"#1a1a1a",
          border:"1px solid #333",color:"#aaa",borderRadius:4,cursor:"pointer",fontSize:11}}>
          clear
        </button>
        <span style={{fontSize:10,color:"#444"}}>{logs.length} lines</span>
      </div>
      <div style={{padding:"10px 14px"}}>
        {visible.length===0 && (
          <div style={{color:"#333",paddingTop:"2rem",textAlign:"center"}}>
            {conn?"Waiting for backend activity…":"Connecting…"}
          </div>
        )}
        {visible.map((line,i) => (
          <div key={i} style={{color:color(line),lineHeight:1.65,
            whiteSpace:"pre-wrap",wordBreak:"break-all"}}>{line}</div>
        ))}
        <div ref={bottomRef}/>
      </div>
    </div>
  );
}
