// display/app.js
// เหลือกราฟเดียว + โชว์ตัวเลขชัดเจนบนกราฟ + เวลาปัจจุบัน + responsive redraw
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
  };

  el.yr   && (el.yr.textContent   = new Date().getFullYear());
  el.dev  && (el.dev.textContent  = DEVICE_ID);
  el.poll && (el.poll.textContent = (POLL_MS / 1000).toFixed(0) + "s");

  // Theme
  const LS_KEY = "esp32-theme";
  const setTheme = (m) => { document.documentElement.classList.toggle("light", m === "light"); localStorage.setItem(LS_KEY, m); };
  setTheme(localStorage.getItem(LS_KEY) || "dark");
  el.themeToggle?.addEventListener("click", () => setTheme((localStorage.getItem(LS_KEY)||"dark")==="dark"?"light":"dark"));

  // Helpers
  async function fetchJSON(url){ const r=await fetch(url,{cache:"no-store"}); if(!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`); return r.json(); }
  function setStatus(on){ el.status?.classList.toggle("online", !!on); el.status?.classList.toggle("offline", !on); const lb=el.status?.querySelector(".label"); if(lb) lb.textContent = on ? "Connected" : "Disconnected"; }
  function fmtTime(iso){ if(!iso) return "—"; const d=new Date(iso), diff=(Date.now()-d)/1000; if(diff<60) return "just now"; if(diff<3600) return `${Math.floor(diff/60)} min ago`; return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`; }
  function dewPointC(tC,rh){ if(!isFinite(tC)||!isFinite(rh)||rh<=0) return NaN; const a=17.62,b=243.12,g=(a*tC)/(b+tC)+Math.log(rh/100); return (b*g)/(a-g); }
  function updateGauges(t,h){ const p=Math.max(0,Math.min(100,(Number(t)/50)*100)); el.tempRing?.style.setProperty("--p", p.toFixed(2)); el.temp&&(el.temp.textContent=isFinite(t)?Number(t).toFixed(1):"--.-"); el.hum&&(el.hum.textContent=isFinite(h)?Math.round(Number(h)):"--"); el.humBar&&(el.humBar.style.width=`${Math.max(0,Math.min(100,Number(h)||0)).toFixed(0)}%`); const dp=dewPointC(Number(t),Number(h)); el.dew&&(el.dew.textContent=isFinite(dp)?dp.toFixed(1):"--.-"); }

  // Parsers
  function pickArray(j){ if(Array.isArray(j)) return j; return j?.data||j?.items||j?.rows||j?.docs||j?.result||j?.history||[]; }
  function parseReading(o){ const t=Number(o.temperature??o.temp??o.t??o.value?.temperature); const h=Number(o.humidity??o.hum??o.h??o.value?.humidity); const ts=o.updated_at??o.created_at??o.ts??o.time??o.at; return { t, h, at: ts?new Date(ts):new Date() }; }

  // Endpoints
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

  // ===== Canvas utils (responsive + DPR) =====
  const state = { timeline: [] };
  function fitCanvas(canvas){
    if(!canvas) return {w:0,h:0,ctx:null};
    const ratio = Number(canvas.dataset.ratio)||3.2;
    const cw = Math.max(100, Math.floor(canvas.clientWidth || canvas.parentElement?.clientWidth || 300));
    const ch = Math.max(80, Math.floor(cw/ratio));
    const dpr = Math.min(2, window.devicePixelRatio||1);
    canvas.width = Math.floor(cw*dpr);
    canvas.height= Math.floor(ch*dpr);
    canvas.style.height = `${ch}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr,0,0,dpr,0,0);
    return {w:cw,h:ch,ctx};
  }

  // badge helper
  function badge(ctx, x, y, text, stroke, fillBg){
    ctx.font = "bold 13px system-ui, -apple-system, Segoe UI, Roboto";
    const padX=10, padY=6;
    const w = ctx.measureText(text).width + padX*2;
    const h = 22;
    ctx.beginPath();
    const r=8;
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y, x+w,y+h, r);
    ctx.arcTo(x+w,y+h, x,y+h, r);
    ctx.arcTo(x,y+h, x,y, r);
    ctx.arcTo(x,y, x+w,y, r);
    ctx.closePath();
    ctx.fillStyle = fillBg;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, x+padX, y+15);
  }

  // ===== Main chart (ตัวเดียว) =====
  function drawTimeline(canvas, series){
    const {w:W,h:H,ctx} = fitCanvas(canvas);
    if(!ctx) return;
    ctx.clearRect(0,0,W,H);

    if(series.length<2){
      ctx.globalAlpha=.6; ctx.fillStyle="#fff"; ctx.fillText("No history",14,22); ctx.globalAlpha=1; return;
    }

    // grid
    ctx.globalAlpha=.12; ctx.strokeStyle="#fff";
    for(let i=1;i<=5;i++){ const y=(H/6)*i; ctx.beginPath(); ctx.moveTo(40,y); ctx.lineTo(W-10,y); ctx.stroke(); }
    ctx.globalAlpha=1;

    const padL=40, padR=10, padT=10, padB=34;
    const X=(i,N)=> padL + (W-padL-padR)*(i/Math.max(1,N-1));
    const range=vals=>{ const mn=Math.min(...vals), mx=Math.max(...vals); return {mn,mx,span:(mx-mn)||1}; };

    const tvals=series.map(s=>s.t), hvals=series.map(s=>s.h), dvals=series.map(s=>s.d);
    const Rt=range(tvals), Rh=range(hvals), Rd=range(dvals);
    const mapY=(v,r)=> padT + (H-padT-padB)*(1-(v-r.mn)/r.span);

    // temp area
    ctx.beginPath();
    series.forEach((s,i)=>{ const x=X(i,series.length), y=mapY(s.t,Rt); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
    ctx.lineTo(W-padR,H-padB); ctx.lineTo(padL,H-padB); ctx.closePath();
    ctx.fillStyle="rgba(96,165,250,.18)"; ctx.fill();

    // temp line
    ctx.lineWidth=2.4; ctx.strokeStyle="rgba(96,165,250,.95)";
    ctx.beginPath(); series.forEach((s,i)=>{ const x=X(i,series.length), y=mapY(s.t,Rt); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }); ctx.stroke();

    // hum line
    ctx.lineWidth=2.2; ctx.strokeStyle="rgba(52,211,153,.95)";
    ctx.beginPath(); series.forEach((s,i)=>{ const x=X(i,series.length), y=mapY(s.h,Rh); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }); ctx.stroke();

    // dew line
    ctx.lineWidth=2.0; ctx.strokeStyle="rgba(250,204,21,.95)";
    ctx.beginPath(); series.forEach((s,i)=>{ const x=X(i,series.length), y=mapY(s.d,Rd); i?ctx.lineTo(x,y):ctx.moveTo(x,y); }); ctx.stroke();

    // x-ticks + now
    ctx.fillStyle="rgba(255,255,255,.65)"; ctx.font="12px system-ui";
    const step=Math.max(1,Math.ceil(series.length/6));
    for(let i=0;i<series.length;i+=step){
      const x=X(i,series.length), d=series[i].at;
      ctx.fillText(d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}), x-16, H-8);
    }
    // เส้น Now ที่ปลายขวา
    const xi = X(series.length-1, series.length);
    ctx.strokeStyle="rgba(255,255,255,.35)"; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(xi, padT); ctx.lineTo(xi, H-padB); ctx.stroke(); ctx.setLineDash([]);

    // badges ตัวเลขล่าสุด (มุมซ้ายบน)
    const last = series[series.length-1];
    badge(ctx, 48, 14, `Temp  ${Number(last.t).toFixed(1)}°C`, "rgba(96,165,250,.9)", "rgba(96,165,250,.18)");
    badge(ctx, 48, 40, `Hum   ${Math.round(last.h)}%RH`,       "rgba(52,211,153,.9)", "rgba(52,211,153,.18)");
    if(isFinite(last.d)) badge(ctx, 48, 66, `Dew   ${Number(last.d).toFixed(1)}°C`, "rgba(250,204,21,.95)", "rgba(250,204,21,.18)");

    // badge เวลาปัจจุบัน (มุมขวาบน)
    const now = new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"});
    const tmpCanvas = document.createElement("canvas"); // ใช้วัดความกว้างอย่างคร่าว ๆ
    const tmpCtx = tmpCanvas.getContext("2d"); tmpCtx.font="bold 13px system-ui";
    const badgeW = Math.max(120, tmpCtx.measureText(`Now ${now}`).width + 24);
    badge(ctx, W - badgeW - 14, 14, `Now ${now}`, "rgba(255,255,255,.6)", "rgba(255,255,255,.12)");
  }

  // Loaders
  function toSeries(arr){ const rows=arr.map(parseReading).filter(s=>isFinite(s.t)&&isFinite(s.h)).sort((a,b)=>a.at-b.at); rows.forEach(r=>r.d=dewPointC(r.t,r.h)); return rows; }
  async function loadHistory(limit=50){
    try{
      const j = await fetchJSON(`${URL_HISTORY(limit)}&_=${Date.now()}`);
      const rows = toSeries(pickArray(j));
      state.timeline = rows;
      drawTimeline(el.timeline, rows);
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
      // อัปเดตเวลา "Now" บนกราฟทุกครั้งที่รีเฟรช
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

  // redraw on resize/orientation
  const ro = new ResizeObserver(()=>{ if(state.timeline.length) drawTimeline(el.timeline, state.timeline); });
  if(el.timeline) ro.observe(el.timeline.parentElement || el.timeline);
  window.addEventListener("orientationchange", ()=> setTimeout(()=>{ if(state.timeline.length) drawTimeline(el.timeline, state.timeline); }, 250));

  // boot
  refresh(); loadHistory(50);
  setInterval(refresh, Math.max(3000, POLL_MS));
  setInterval(()=> loadHistory(50), 20000);
})();
