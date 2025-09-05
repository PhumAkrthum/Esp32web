// แยกกราฟ 3 ใบ • ย้าย "Now" ไปที่หัวกราฟ • ตัด badge/สามเหลี่ยมในกราฟ
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

    // charts + header labels
    chartT: document.getElementById("chartT"),
    chartH: document.getElementById("chartH"),
    chartD: document.getElementById("chartD"),
    lastT: document.getElementById("lastT"),
    lastH: document.getElementById("lastH"),
    lastD: document.getElementById("lastD"),
    nowT:  document.getElementById("nowT"),
    nowH:  document.getElementById("nowH"),
    nowD:  document.getElementById("nowD"),

    // comfort
    hiText:    document.getElementById("hiText"),
    hiPointer: document.getElementById("hiPointer"),
    feelsLike: document.getElementById("feelsLike"),
    factDew:   document.getElementById("factDew"),
    comfortZone: document.getElementById("comfortZone"),

    // misc
    themeToggle: document.getElementById("themeToggle"),
    yr: document.getElementById("yr"),
    empty: document.getElementById("emptyHint"),
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
  function heatIndexC(tC, rh){
    const Tf = 1.8*tC + 32;
    const HI = -42.379 + 2.04901523*Tf + 10.14333127*rh
      - 0.22475541*Tf*rh - 6.83783e-3*Tf*Tf - 5.481717e-2*rh*rh
      + 1.22874e-3*Tf*Tf*rh + 8.5282e-4*Tf*rh*rh - 1.99e-6*Tf*Tf*rh*rh;
    return (HI-32)/1.8;
  }
  function comfortText(dp){
    if(!isFinite(dp)) return "—";
    if(dp < 10)  return "Dry / Cool";
    if(dp < 16)  return "Comfortable";
    if(dp < 18)  return "Slightly Humid";
    if(dp < 21)  return "Humid";
    if(dp < 24)  return "Very Humid";
    if(dp < 27)  return "Oppressive";
    return "Extreme Humidity";
  }
  function updateGauges(t,h){
    const p=Math.max(0,Math.min(100,(Number(t)/50)*100));
    el.tempRing?.style.setProperty("--p", p.toFixed(2));
    el.temp&&(el.temp.textContent=isFinite(t)?Number(t).toFixed(1):"--.-");
    el.hum&&(el.hum.textContent=isFinite(h)?Math.round(Number(h)):"--");
    el.humBar&&(el.humBar.style.width=`${Math.max(0,Math.min(100,Number(h)||0)).toFixed(0)}%`);
    const dp=dewPointC(Number(t),Number(h));
    el.dew&&(el.dew.textContent=isFinite(dp)?dp.toFixed(1):"--.-");
    // comfort card
    const hi = heatIndexC(Number(t), Number(h));
    if (el.feelsLike) el.feelsLike.textContent = isFinite(hi) ? `${hi.toFixed(1)} °C` : "—";
    if (el.factDew)   el.factDew.textContent   = isFinite(dp) ? `${dp.toFixed(1)} °C` : "—";
    if (el.comfortZone) el.comfortZone.textContent = comfortText(dp);
    if (el.hiText) el.hiText.textContent = isFinite(hi) ? (hi < 26 ? "Comfort" : hi < 32 ? "Warm" : hi < 40 ? "Hot" : "Very Hot") : "—";
    // pointer 0–45°C scale
    const pos = Math.max(0, Math.min(100, (isFinite(hi) ? hi : 0) / 45 * 100));
    if (el.hiPointer) el.hiPointer.style.left = `${pos}%`;
  }

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
  function fitCanvas(canvas){
    if(!canvas) return {w:0,h:0,ctx:null};
    const ratio = Number(canvas.dataset.ratio)||5;
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

  function drawChart(canvas, rows, key, color){
    const {w:W,h:H,ctx} = fitCanvas(canvas);
    if(!ctx){ return; }
    ctx.clearRect(0,0,W,H);
    if(rows.length<2){
      ctx.globalAlpha=.7; ctx.fillStyle="#fff"; ctx.fillText("No history",14,22); ctx.globalAlpha=1; return;
    }

    const padL=46, padR=16, padT=10, padB=30;
    const X=(i,N)=> padL + (W-padL-padR)*(i/Math.max(1,N-1));
    const yVals = rows.map(r=>r[key]).filter(Number.isFinite);
    const mn=Math.min(...yVals), mx=Math.max(...yVals), span=(mx-mn)||1;
    const mapY = v => padT + (H-padT-padB) * (1 - (v - mn)/span);

    // axes + grid
    ctx.strokeStyle="rgba(255,255,255,.28)";
    ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H-padB); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, H-padB); ctx.lineTo(W-padR, H-padB); ctx.stroke();

    ctx.fillStyle="rgba(255,255,255,.8)"; ctx.font="12px system-ui";
    const ySteps=5;
    for(let i=0;i<=ySteps;i++){
      const v = mn + span*(i/ySteps);
      const y = mapY(v);
      ctx.globalAlpha=.18; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W-padR, y); ctx.stroke(); ctx.globalAlpha=1;
      ctx.fillText((key==='h'?Math.round(v):v.toFixed(0)).toString(), 6, y+4);
    }

    const stepX=Math.max(1,Math.ceil(rows.length/6));
    for(let i=0;i<rows.length;i+=stepX){
      const x = X(i,rows.length), d=rows[i].at;
      const label=d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
      const tw=ctx.measureText(label).width;
      ctx.fillText(label, x - tw/2, H-10);
      ctx.globalAlpha=.16; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H-padB); ctx.stroke(); ctx.globalAlpha=1;
    }

    // area for temp (เบา ๆ)
    if(key==='t'){
      ctx.beginPath(); rows.forEach((s,i)=>{ const x=X(i,rows.length), y=mapY(s[key]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
      ctx.lineTo(W-padR,H-padB); ctx.lineTo(padL,H-padB); ctx.closePath();
      ctx.fillStyle="rgba(96,165,250,.18)"; ctx.fill();
    }

    // line
    ctx.lineWidth=2.6;
    ctx.strokeStyle=color;
    ctx.beginPath();
    rows.forEach((s,i)=>{ const x=X(i,rows.length), y=mapY(s[key]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
    ctx.stroke();
  }

  function toSeries(arr){
    const rows=arr.map(parseReading).filter(s=>isFinite(s.t)&&isFinite(s.h)).sort((a,b)=>a.at-b.at);
    rows.forEach(r=>r.d=dewPointC(r.t, r.h));
    return rows;
  }

  const state = { rows: [] };

  async function loadHistory(limit=50){
    try{
      const j = await fetchJSON(`${URL_HISTORY(limit)}&_=${Date.now()}`);
      const rows = toSeries(pickArray(j));
      state.rows = rows;

      if(rows.length){
        const last = rows[rows.length-1];
        el.lastT && (el.lastT.textContent = `${last.t.toFixed(1)}°C`);
        el.lastH && (el.lastH.textContent = `${Math.round(last.h)}%`);
        el.lastD && (el.lastD.textContent = `${last.d.toFixed(1)}°C`);
      }

      drawChart(el.chartT, rows, 't', 'rgba(96,165,250,1)');
      drawChart(el.chartH, rows, 'h', 'rgba(52,211,153,1)');
      drawChart(el.chartD, rows, 'd', 'rgba(250,204,21,1)');
    }catch(e){
      console.warn("history error", e);
      state.rows = [];
      drawChart(el.chartT, [], 't', 'rgba(96,165,250,1)');
      drawChart(el.chartH, [], 'h', 'rgba(52,211,153,1)');
      drawChart(el.chartD, [], 'd', 'rgba(250,204,21,1)');
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

      // วาดใหม่ (ปรับสเกลตามขนาด)
      if(state.rows.length){
        drawChart(el.chartT, state.rows, 't', 'rgba(96,165,250,1)');
        drawChart(el.chartH, state.rows, 'h', 'rgba(52,211,153,1)');
        drawChart(el.chartD, state.rows, 'd', 'rgba(250,204,21,1)');
      }
    }catch(e){
      console.warn("refresh error:", e);
      setStatus(false);
      el.card?.classList.add("hidden");
      el.empty && (el.empty.style.display="block");
    }
  }

  // อัปเดตนาฬิกา "Now" ที่หัวกราฟทุกวินาที
  function tickClock(){
    const now = new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"});
    if (el.nowT) el.nowT.textContent = `Now ${now}`;
    if (el.nowH) el.nowH.textContent = `Now ${now}`;
    if (el.nowD) el.nowD.textContent = `Now ${now}`;
  }
  setInterval(tickClock, 1000);
  tickClock();

  // range buttons
  document.querySelectorAll(".range").forEach(btn=>{
    btn.addEventListener("click", ()=> loadHistory(Number(btn.dataset.limit||50)));
  });

  // redraw on resize/orientation
  const ro = new ResizeObserver(()=>{ if(state.rows.length){ drawChart(el.chartT, state.rows, 't', 'rgba(96,165,250,1)'); drawChart(el.chartH, state.rows, 'h', 'rgba(52,211,153,1)'); drawChart(el.chartD, state.rows, 'd', 'rgba(250,204,21,1)'); }});
  [el.chartT, el.chartH, el.chartD].forEach(c=> c && ro.observe(c.parentElement || c));
  window.addEventListener("orientationchange", ()=> setTimeout(()=>{ if(state.rows.length){ drawChart(el.chartT, state.rows, 't', 'rgba(96,165,250,1)'); drawChart(el.chartH, state.rows, 'h', 'rgba(52,211,153,1)'); drawChart(el.chartD, state.rows, 'd', 'rgba(250,204,21,1)'); }}, 250));

  // boot
  refresh(); loadHistory(50);
  setInterval(refresh, Math.max(3000, POLL_MS));
  setInterval(()=> loadHistory(50), 20000);
})();
