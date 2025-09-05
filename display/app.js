// app.js (ปรับให้ทำงานกับ backend ที่ deploy แล้ว + UI ใหม่)
// รองรับทั้ง window.CONFIG (ของคุณ) และ window.DHT_CONFIG (ของผม)
(function(){
  const CFG = window.CONFIG || window.DHT_CONFIG || {};
  const API_BASE = CFG.API_BASE || "";
  const DEVICE_ID = CFG.DEVICE_ID || "esp32-1";
  const POLL_MS = (CFG.POLL_MS|0) || 5000;
  const THRESH_SEC = CFG.ONLINE_THRESHOLD_SEC ?? CFG.THRESHOLD_SEC ?? CFG.STATUS_THRESHOLD_SEC ?? 30;

  // ===== selectors =====
  const el = {
    status: document.getElementById('status'),
    temp: document.getElementById('temp'),
    hum: document.getElementById('hum'),
    dew: document.getElementById('dew'),
    last: document.getElementById('last'),
    dev: document.getElementById('dev'),
    poll: document.getElementById('poll'),
    tempRing: document.getElementById('tempRing'),
    humBar: document.getElementById('humBar'),
    card: document.getElementById('card'),
    chart: document.getElementById('chart'),
    themeToggle: document.getElementById('themeToggle'),
    yr: document.getElementById('yr'),
    empty: document.getElementById('emptyHint')
  };

  // ===== init small infos =====
  if (el.yr) el.yr.textContent = new Date().getFullYear();
  if (el.dev) el.dev.textContent = DEVICE_ID;
  if (el.poll) el.poll.textContent = (POLL_MS/1000).toFixed(0) + "s";

  // ===== theme toggle =====
  const LS_KEY = "esp32-theme";
  const setTheme = (m) => {
    if(m === 'light'){ document.documentElement.classList.add('light'); }
    else { document.documentElement.classList.remove('light'); }
    localStorage.setItem(LS_KEY, m);
  };
  setTheme(localStorage.getItem(LS_KEY) || 'dark');
  if (el.themeToggle) {
    el.themeToggle.addEventListener('click', ()=>{
      const cur = localStorage.getItem(LS_KEY) || 'dark';
      setTheme(cur === 'dark' ? 'light' : 'dark');
    });
  }

  // ===== helpers =====
  async function fetchJSON(url){
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
    return r.json();
  }

  function setStatus(online){
    if (!el.status) return;
    el.status.classList.toggle('online', !!online);
    el.status.classList.toggle('offline', !online);
    const label = el.status.querySelector('.label');
    if (label) label.textContent = online ? 'Connected' : 'Disconnected';
  }

  function fmtTime(iso){
    if(!iso) return '—';
    const d = new Date(iso);
    const now = Date.now();
    const diff = Math.max(0, (now - d.getTime())/1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff/60)} min ago`;
    const hh = d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const dd = d.toLocaleDateString();
    return `${dd} ${hh}`;
  }

  // Magnus formula (approx)
  function dewPointC(tC, rh){
    if (!isFinite(tC) || !isFinite(rh) || rh<=0) return NaN;
    const a = 17.62, b = 243.12;
    const gamma = (a*tC)/(b+tC) + Math.log(rh/100);
    return (b*gamma)/(a-gamma);
  }

  function updateGauges(t, h){
    // เกจอุณหภูมิสเกล 0–50°C (ปรับได้)
    const p = Math.max(0, Math.min(100, (Number(t)/50)*100));
    if (el.tempRing) el.tempRing.style.setProperty('--p', p.toFixed(2));
    if (el.temp) el.temp.textContent = isFinite(t) ? Number(t).toFixed(1) : '--.-';
    if (el.hum) el.hum.textContent = isFinite(h) ? Math.round(Number(h)) : '--';
    if (el.humBar) el.humBar.style.width = `${Math.max(0, Math.min(100, Number(h)||0)).toFixed(0)}%`;

    const dp = dewPointC(Number(t), Number(h));
    if (el.dew) el.dew.textContent = isFinite(dp) ? dp.toFixed(1) : '--.-';
  }

  function showCard(latest){
    if (!el.card) return;
    if (!latest){
      el.card.classList.add('hidden');
      if (el.empty) el.empty.style.display = 'block';
      return;
    }
    const t = latest.temperature ?? latest.temp ?? latest.t;
    const h = latest.humidity    ?? latest.hum  ?? latest.h;
    const ts = latest.updated_at ?? latest.created_at ?? latest.ts ?? latest.time;

    updateGauges(Number(t), Number(h));
    if (el.last) el.last.textContent = fmtTime(ts);
    el.card.classList.remove('hidden');
    if (el.empty) el.empty.style.display = 'none';
  }

  // ===== API endpoints (ตามที่ backend คุณใช้อยู่) =====
  const URL_STATUS = `${API_BASE}/api/status/${encodeURIComponent(DEVICE_ID)}?threshold_sec=${THRESH_SEC}`;
  const URL_LATESTS = [
    `${API_BASE}/api/readings/latest?device_id=${encodeURIComponent(DEVICE_ID)}`,
    // สำรอง (ถ้ามี)
    `${API_BASE}/api/last/${encodeURIComponent(DEVICE_ID)}`,
    `${API_BASE}/api/readings?device_id=${encodeURIComponent(DEVICE_ID)}&limit=1&sort=-created_at`,
  ];
  const URL_HISTORY = `${API_BASE}/api/readings?device_id=${encodeURIComponent(DEVICE_ID)}&limit=50`;

  async function getLatest(){
    for (const base of URL_LATESTS){
      const url = `${base}${base.includes('?') ? '&' : '?'}_=${Date.now()}`; // bust cache
      try{
        const j = await fetchJSON(url);
        if (Array.isArray(j))         return j[0] ?? null;
        if (j && j.data)              return j.data;
        if (j && (j.temperature!=null || j.humidity!=null)) return j;
      }catch(_){ /* ลองตัวถัดไป */ }
    }
    return null;
  }

  async function refresh(){
    try{
      const [status, latest] = await Promise.all([
        fetchJSON(`${URL_STATUS}&_=${Date.now()}`),
        getLatest()
      ]);
      const isOnline = !!(status.is_online ?? status.online ?? status.ok ?? true);
      setStatus(isOnline);
      showCard(isOnline ? latest : null);
    }catch(e){
      console.warn('refresh error:', e);
      setStatus(false);
      showCard(null);
    }
  }

  // ===== sparkline (vanilla Canvas) =====
  function drawSparkline(canvas, series){
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0,0,W,H);

    // grid
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = '#fff';
    for(let i=1;i<6;i++){
      const y = (H/6)*i;
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const pad = 10;
    const N = series.length;
    const xAt = (i)=> pad + (W-2*pad) * (i/Math.max(1, N-1));

    function norm(vals){
      const vmin = Math.min(...vals), vmax = Math.max(...vals);
      const span = (vmax-vmin) || 1;
      return { map:(v)=> pad + (H-2*pad) * (1 - (v - vmin)/span) };
    }

    // Temp
    const tvals = series.map(s=>s.t);
    const nt = norm(tvals);
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = 'rgba(96,165,250,0.95)';
    ctx.beginPath();
    series.forEach((s,i)=>{
      const x = xAt(i), y = nt.map(s.t);
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();

    // Hum
    const hvals = series.map(s=>s.h);
    const nh = norm(hvals);
    ctx.strokeStyle = 'rgba(52,211,153,0.95)';
    ctx.beginPath();
    series.forEach((s,i)=>{
      const x = xAt(i), y = nh.map(s.h);
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    });
    ctx.stroke();
  }

  async function loadHistory(){
    try{
      const j = await fetchJSON(`${URL_HISTORY}&_=${Date.now()}`);
      const arr = Array.isArray(j) ? j : (j.data || []);
      const series = arr
        .map(it => ({
          t: Number(it.temperature ?? it.t ?? it.value?.temperature),
          h: Number(it.humidity    ?? it.h ?? it.value?.humidity),
          at: new Date(it.created_at || it.updated_at || it.at || Date.now())
        }))
        .filter(s => isFinite(s.t) && isFinite(s.h));
      if (series.length){
        // เผื่อ API ส่งล่าสุดก่อน → เรียงจากเก่าไปใหม่
        const sorted = series.slice().sort((a,b)=> a.at - b.at);
        drawSparkline(el.chart, sorted);
      }
    }catch(e){
      console.warn('history error:', e);
    }
  }

  // ===== boot =====
  refresh(); loadHistory();
  setInterval(refresh, Math.max(3000, POLL_MS));
  setInterval(loadHistory, 20000);
})();
