// display/app.js
// กราฟเดียว + ตัวเลขแกน X/Y + Δt ต่อช่วง + ปุ่ม toggle series ที่กดได้ + การ์ดสถิติ
(function () {
  const CFG = window.CONFIG || window.DHT_CONFIG || {};
  const API_BASE   = CFG.API_BASE || "";
  const DEVICE_ID  = CFG.DEVICE_ID || "esp32-1";
  const POLL_MS    = (CFG.POLL_MS | 0) || 5000;
  const THRESH_SEC = CFG.ONLINE_THRESHOLD_SEC ?? CFG.THRESHOLD_SEC ?? CFG.STATUS_THRESHOLD_SEC ?? 30;

  const el = {
    status: document.getElementById("status"),
    temp: document.getElementById("temp"),
    hum: document.getElementById("hum"),
    dew: document.getElementById("dew"),
    last: document.getElementById("last"),
    dev: document.getElementById("dev"),
    poll: document.getElementById("poll"),
    tempRing: document.getElementById("tempRing"),
    humBar: document.getElementById("humBar"),
    card: document.getElementById("card"),
    timeline: document.getElementById("timeline"),
    themeToggle: document.getElementById("themeToggle"),
    yr: document.getElementById("yr"),
    empty: document.getElementById("emptyHint"),
    // stats
    avgDt: document.getElementById("avgDt"),
    minT: document.getElementById("minT"),
    maxT: document.getElementById("maxT"),
    minH: document.getElementById("minH"),
    maxH: document.getElementById("maxH"),
  };

  el.yr   && (el.yr.textContent   = new Date().getFullYear());
  el.dev  && (el.dev.textContent  = DEVICE_ID);
  el.poll && (el.poll.textContent = (POLL_MS / 1000).toFixed(0) + "s");

  // theme
  const LS_KEY = "esp32-theme";
  const setTheme = (m) => { document.documentElement.classList.toggle("light", m === "light"); localStorage.setItem(LS_KEY, m); };
  setTheme(localStorage.getItem(LS_KEY) || "dark");
  el.themeToggle?.addEventListener("click", () => setTheme((localStorage.getItem(LS_KEY)||"dark")==="dark"?"light":"dark"));

  // helpers
  async function fetchJSON(url){ const r=await fetch(url,{cache:"no-store"}); if(!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`); return r.json(); }
  function setStatus(on){ el.status?.classList.toggle("online", !!on); el.status?.classList.toggle("offline", !on); const lb=el.status?.querySelector(".label"); if(lb) lb.textContent = on ? "Connected" : "Disconnected"; }
  function fmtTime(iso){ if(!iso) return "—"; const d=new Date(iso), diff=(Date.now()-d)/1000; if(diff<60) return "just now"; if(diff<3600) return `${Math.floor(diff/60)} min ago`; return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`; }
  function dewPointC(tC,rh){ if(!isFinite(tC)||!isFinite(rh)||rh<=0) return NaN; const a=17.62,b=243.12,g=(a*tC)/(b+tC)+Math.log(rh/100); return (b*g)/(a-g); }
  function updateGauges(t,h){ const p=Math.max(0,Math.min(100,(Number(t)/50)*100)); el.tempRing?.style.setProperty("--p", p.toFixed(2)); el.temp&&(el.temp.textContent=isFinite(t)?Number(t).toFixed(1):"--.-"); el.hum&&(el.hum.textContent=isFinite(h)?Math.round(Number(h)):"--"); el.humBar&&(el.humBar.style.width=`${Math.max(0,Math.min(100,Number(h)||0)).toFixed(0)}%`); const dp=dewPointC(Number(t),Number(h)); el.dew&&(el.dew.textContent=isFinite(dp)?dp.toFixed(1):"--.-"); }

  // parse
  function pickArray(j){ if(Array.isArray(j)) return j; return j?.data||j?.items||j?.rows||j?.docs||j?.result||j?.history||[]; }
  function parseReading(o){ const t=Number(o.temperature??o.temp??o.t??o.value?.temperature); const h=Number(o.humidity??o.hum??o.h??o.value?.humidity); const ts=o.updated_at??o.created_at??o.ts??o.time??o.at; return { t, h, at: ts?new Date(ts):new Date() }; }

  // endpoints
  const URL_STATUS = `${API_BASE}/api/status/${encodeURIComponent(DEVICE_ID)}?threshold_sec=${THRESH_SEC}`;
  const URL_LATESTS = [
    `${API_BASE}/api/readings/latest?device_id=${encodeURIComponent(DEVICE_ID)}`,
    `${API_BASE}/api/last/${encodeURIComponent(DEVICE_ID)}`,
    `${API_BASE}/api/readings?device_id=${encodeURIComponent(DEVICE_ID)}&limit=1&sort=-created_at`,
  ];
  const URL_HISTORY = (limit=50)=>`${API_BASE}/api/readings?device_id=${encodeURIComponent(DEVICE_ID)}&limit=${limit}&sort=-created_at`;

  async function getLatest(){
    for(const base of URL_LATESTS){
      const url = `${base}${base.includes("?")?"&":"?"}_=${Date.now()}`;
      try{
        const j = await fetchJSON(url);
        if(Array.isArray(j)) return j[0]??null;
        if(j?.data)  return Array.isArray(j.data)?j.data[0]:j.data;
        if(j?.items) return Array.isArray(j.items)?j.items[0]:j.items;
        if(j?.temperature!=null || j?.humidity!=null) return j;
      }catch{}
    }
    return null;
  }

  // canvas utils
  const state = { timeline: [], show: {t:true,h:true,d:true} };
  function fitCanvas(canvas){
    if(!canvas) return {w:0,h:0,ctx:null};
    const ratio = Number(canvas.dataset.ratio)||3.2;
    const cw = Math.max(100, Math.floor(canvas.clientWidth || canvas.parentElement?.clientWidth || 300));
    const ch = Math.max(120, Math.floor(cw/ratio));
    const dpr = Math.min(2, window.devicePixelRatio||1);
    canvas.width = Math.floor(cw*dpr);
    canvas.height= Math.floor(ch*dpr);
    canvas.style.height = `${ch}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr,0,0,dpr,0,0);
    return {w:cw,h:ch,ctx};
  }

  // badges
  function badge(ctx, x, y, text, stroke, fillBg, opts={}){
    ctx.save();
    ctx.font = (opts.small?'600 11px':'bold 13px') + ' system-ui, -apple-system, Segoe UI, Roboto';
    const padX=opts.small?8:10, padY=opts.small?4:6, r=opts.small?7:8, h=opts.small?20:22;
    const w = ctx.measureText(text).width + padX*2;
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y, x+w,y+h, r);
    ctx.arcTo(x+w,y+h, x,y+h, r);
    ctx.arcTo(x,y+h, x,y, r);
    ctx.arcTo(x,y, x+w,y, r);
    ctx.closePath();
    ctx.fillStyle = fillBg; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.fillText(text, x+padX, y+(opts.small?14:15));
    ctx.restore();
  }

  // draw
  function drawTimeline(canvas, series){
    const {w:W,h:H,ctx} = fitCanvas(canvas);
    if(!ctx) return;
    ctx.clearRect(0,0,W,H);
    if(series.length<2){
      ctx.globalAlpha=.7; ctx.fillStyle="#fff"; ctx.fillText("No history",14,22); ctx.globalAlpha=1; return;
    }

    const padL=48, padR=46, padT=12, padB=38;
    const X=(i,N)=> padL + (W-padL-padR)*(i/Math.max(1,N-1));

    // ranges
    const tvals=series.map(s=>s.t), hvals=series.map(s=>s.h), dvals=series.map(s=>s.d);
    const minT=Math.min(...tvals, ...dvals), maxT=Math.max(...tvals, ...dvals);
    const minH=Math.min(...hvals), maxH=Math.max(...hvals);
    const Rt={mn:minT, mx:maxT, span:(maxT-minT)||1};
    const Rh={mn:minH, mx:maxH, span:(maxH-minH)||1};
    const mapYT=v => padT + (H-padT-padB)*(1-(v-Rt.mn)/Rt.span);
    const mapYH=v => padT + (H-padT-padB)*(1-(v-Rh.mn)/Rh.span);

    // grid + axes
    ctx.strokeStyle="rgba(255,255,255,.25)";
    ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H-padB); ctx.stroke(); // y-left
    ctx.beginPath(); ctx.moveTo(W-padR, padT); ctx.lineTo(W-padR, H-padB); ctx.stroke(); // y-right
    ctx.beginPath(); ctx.moveTo(padL, H-padB); ctx.lineTo(W-padR, H-padB); ctx.stroke(); // x

    // y ticks left (Temp/Dew)
    ctx.fillStyle="rgba(255,255,255,.75)"; ctx.font="12px system-ui";
    const ySteps=5;
    for(let i=0;i<=ySteps;i++){
      const v = Rt.mn + (Rt.span)*(i/ySteps);
      const y = mapYT(v);
      ctx.globalAlpha=.18; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W-padR, y); ctx.stroke(); ctx.globalAlpha=1;
      ctx.fillText(v.toFixed(0), 6, y+4);
    }
    // y ticks right (Hum)
    for(let i=0;i<=ySteps;i++){
      const v = Rh.mn + (Rh.span)*(i/ySteps);
      const y = mapYH(v);
      const text = Math.round(v).toString();
      const tw = ctx.measureText(text).width;
      ctx.fillText(text, W - padR + 6, y+4);
    }

    // x ticks (time)
    const stepX=Math.max(1,Math.ceil(series.length/6));
    for(let i=0;i<series.length;i+=stepX){
      const x = X(i,series.length), d=series[i].at;
      const label=d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
      const tw=ctx.measureText(label).width;
      ctx.fillText(label, x - tw/2, H-12);
      ctx.globalAlpha=.18; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H-padB); ctx.stroke(); ctx.globalAlpha=1;
    }

    // temp area + line
    if(state.show.t){
      ctx.beginPath(); series.forEach((s,i)=>{ const x=X(i,series.length), y=mapYT(s.t); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
      ctx.lineTo(W-padR,H-padB); ctx.lineTo(padL,H-padB); ctx.closePath();
      ctx.fillStyle="rgba(96,165,250,.20)"; ctx.fill();

      ctx.lineWidth=2.6; ctx.strokeStyle="rgba(96,165,250,1)";
      ctx.beginPath(); series.forEach((s,i)=>{ const x=X(i,series.length), y=mapYT(s.t); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }); ctx.stroke();
    }
    // humidity line
    if(state.show.h){
      ctx.lineWidth=2.4; ctx.strokeStyle="rgba(52,211,153,1)";
      ctx.beginPath(); series.forEach((s,i)=>{ const x=X(i,series.length), y=mapYH(s.h); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }); ctx.stroke();
    }
    // dew line
    if(state.show.d){
      ctx.lineWidth=2.0; ctx.strokeStyle="rgba(250,204,21,1)";
      ctx.beginPath(); series.forEach((s,i)=>{ const x=X(i,series.length), y=mapYT(s.d); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }); ctx.stroke();
    }

    // badges: ตัวเลขล่าสุด (ซ้ายบน)
    const last = series[series.length-1];
    badge(ctx, padL+6, 8, `Temp ${Number(last.t).toFixed(1)}°C`, "rgba(96,165,250,.95)", "rgba(96,165,250,.22)");
    badge(ctx, padL+6, 34, `Hum ${Math.round(last.h)}%RH`, "rgba(52,211,153,.95)", "rgba(52,211,153,.22)");
    if(isFinite(last.d)) badge(ctx, padL+6, 60, `Dew ${Number(last.d).toFixed(1)}°C`, "rgba(250,204,21,.95)", "rgba(250,204,21,.22)");

    // badge Now (ขวาบน)
    const now = new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"});
    const tm = document.createElement("canvas").getContext("2d");
    tm.font="bold 13px system-ui";
    const wNow = Math.max(120, tm.measureText(`Now ${now}`).width + 24);
    badge(ctx, W - wNow - 14, 8, `Now ${now}`, "rgba(255,255,255,.6)", "rgba(255,255,255,.14)");

    // Δt labels (กลาง segment) — จำกัดไม่เกิน 10 ป้ายเพื่อความชัด
    const totalSegments = series.length-1;
    const showEvery = Math.ceil(totalSegments / 10);
    for(let i=1;i<series.length;i+=showEvery){
      const prev = series[i-1], cur = series[i];
      const midX = (X(i-1,series.length)+X(i,series.length))/2;
      const dt = Math.max(0, Math.round((cur.at - prev.at)/1000));
      badge(ctx, midX-20, padT+4, `Δt ${dt}s`, "rgba(255,255,255,.45)", "rgba(255,255,255,.12)", {small:true});
      // เส้นจุดเล็กบอกตำแหน่ง
      ctx.fillStyle="rgba(255,255,255,.5)";
      ctx.fillRect(midX-0.5, padT+24, 1, 6);
    }
  }

  function toSeries(arr){
    const rows=arr.map(parseReading).filter(s=>isFinite(s.t)&&isFinite(s.h)).sort((a,b)=>a.at-b.at);
    rows.forEach(r=>r.d=dewPointC(r.t,r.h));
    return rows;
  }

  // load
  async function loadHistory(limit=50){
    try{
      const j = await fetchJSON(`${URL_HISTORY(limit)}&_=${Date.now()}`);
      const rows = toSeries(pickArray(j));
      state.timeline = rows;
      drawTimeline(el.timeline, rows);

      // อัปเดตสถิติ
      if(rows.length>1){
        const dts = rows.slice(1).map((r,i)=> (r.at - rows[i].at)/1000);
        const avg = dts.reduce((a,b)=>a+b,0)/dts.length;
        const tvals = rows.map(r=>r.t), hvals = rows.map(r=>r.h);
        el.avgDt && (el.avgDt.textContent = `${avg.toFixed(1)}s`);
        el.minT && (el.minT.textContent = Math.min(...tvals).toFixed(1));
        el.maxT && (el.maxT.textContent = Math.max(...tvals).toFixed(1));
        el.minH && (el.minH.textContent = Math.min(...hvals).toFixed(0));
        el.maxH && (el.maxH.textContent = Math.max(...hvals).toFixed(0));
      }
    }catch(e){
      console.warn("history error", e);
      state.timeline = [];
      drawTimeline(el.timeline, []);
    }
  }

  async function refresh(){
    try{
      const [status, latest] = await Promise.all([
        fetchJSON(`${URL_STATUS}&_=${Date.now()}`),
        getLatest()
      ]);
      const isOnline = (typeof status?.online === "boolean")
        ? status.online
        : (typeof status?.is_online === "boolean" ? status.is_online : false);

      setStatus(isOnline);
      if(isOnline && latest){
        const t=Number(latest.temperature ?? latest.temp ?? latest.t);
        const h=Number(latest.humidity    ?? latest.hum  ?? latest.h);
        const ts=latest.updated_at ?? latest.created_at ?? latest.ts ?? latest.time;
        updateGauges(t,h);
        el.last && (el.last.textContent = fmtTime(ts));
        el.card?.classList.remove("hidden");
        el.empty && (el.empty.style.display="none");
      }else{
        el.card?.classList.add("hidden");
        el.empty && (el.empty.style.display="block");
      }
      // ปรับเวลาปัจจุบันบนกราฟ
      if(state.timeline.length) drawTimeline(el.timeline, state.timeline);
    }catch(e){
      console.warn("refresh error:", e);
      setStatus(false);
      el.card?.classList.add("hidden");
      el.empty && (el.empty.style.display="block");
    }
  }

  // range buttons
  document.querySelectorAll(".range").forEach(btn=>{
    btn.addEventListener("click", ()=> loadHistory(Number(btn.dataset.limit||50)));
  });

  // toggle series buttons
  document.querySelectorAll(".toggle").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      btn.classList.toggle("active");
      const k = btn.dataset.series; // t/h/d
      state.show[k] = btn.classList.contains("active");
      if(state.timeline.length) drawTimeline(el.timeline, state.timeline);
    });
  });

  // redraw on resize / orientation
  const ro = new ResizeObserver(()=>{ if(state.timeline.length) drawTimeline(el.timeline, state.timeline); });
  if(el.timeline) ro.observe(el.timeline.parentElement || el.timeline);
  window.addEventListener("orientationchange", ()=> setTimeout(()=>{ if(state.timeline.length) drawTimeline(el.timeline, state.timeline); }, 250));

  // boot
  refresh(); loadHistory(50);
  setInterval(refresh, Math.max(3000, POLL_MS));
  setInterval(()=> loadHistory(50), 20000);
})();
