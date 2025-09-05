// display/app.js
// รองรับ window.CONFIG (ของคุณ) หรือ window.DHT_CONFIG (ของผม)
(function () {
  const CFG = window.CONFIG || window.DHT_CONFIG || {};
  const API_BASE   = CFG.API_BASE || "";
  const DEVICE_ID  = CFG.DEVICE_ID || "esp32-1";
  const POLL_MS    = (CFG.POLL_MS | 0) || 5000;
  const THRESH_SEC = CFG.ONLINE_THRESHOLD_SEC ?? CFG.THRESHOLD_SEC ?? CFG.STATUS_THRESHOLD_SEC ?? 30;

  // ===== selectors =====
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
    chart: document.getElementById("chart"),       // Recent Trend (sparkline)
    timeline: document.getElementById("timeline"), // Environment Change (แทน Tips)
    themeToggle: document.getElementById("themeToggle"),
    yr: document.getElementById("yr"),
    empty: document.getElementById("emptyHint"),
  };

  // info เล็ก ๆ
  el.yr   && (el.yr.textContent   = new Date().getFullYear());
  el.dev  && (el.dev.textContent  = DEVICE_ID);
  el.poll && (el.poll.textContent = (POLL_MS / 1000).toFixed(0) + "s");

  // ===== theme toggle =====
  const LS_KEY = "esp32-theme";
  const setTheme = (m) => {
    document.documentElement.classList.toggle("light", m === "light");
    localStorage.setItem(LS_KEY, m);
  };
  setTheme(localStorage.getItem(LS_KEY) || "dark");
  el.themeToggle?.addEventListener("click", () => {
    setTheme((localStorage.getItem(LS_KEY) || "dark") === "dark" ? "light" : "dark");
  });

  // ===== helpers =====
  async function fetchJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
    return r.json();
  }

  function setStatus(online) {
    el.status?.classList.toggle("online", !!online);
    el.status?.classList.toggle("offline", !online);
    const label = el.status?.querySelector(".label");
    if (label) label.textContent = online ? "Connected" : "Disconnected";
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  // Magnus (approx)
  function dewPointC(tC, rh) {
    if (!isFinite(tC) || !isFinite(rh) || rh <= 0) return NaN;
    const a = 17.62, b = 243.12;
    const gamma = (a * tC) / (b + tC) + Math.log(rh / 100);
    return (b * gamma) / (a - gamma);
  }

  function updateGauges(t, h) {
    const p = Math.max(0, Math.min(100, (Number(t) / 50) * 100));
    el.tempRing?.style.setProperty("--p", p.toFixed(2));
    el.temp && (el.temp.textContent = isFinite(t) ? Number(t).toFixed(1) : "--.-");
    el.hum  && (el.hum.textContent  = isFinite(h) ? Math.round(Number(h)) : "--");
    el.humBar && (el.humBar.style.width = `${Math.max(0, Math.min(100, Number(h) || 0)).toFixed(0)}%`);
    const dp = dewPointC(Number(t), Number(h));
    el.dew && (el.dew.textContent = isFinite(dp) ? dp.toFixed(1) : "--.-");
  }

  // ===== parsers =====
  function pickArray(j) {
    if (Array.isArray(j)) return j;
    return j?.data || j?.items || j?.rows || j?.docs || j?.result || j?.history || [];
  }
  function parseReading(obj) {
    const t = Number(obj.temperature ?? obj.temp ?? obj.t ?? obj.value?.temperature);
    const h = Number(obj.humidity    ?? obj.hum  ?? obj.h ?? obj.value?.humidity);
    const ts = obj.updated_at ?? obj.created_at ?? obj.ts ?? obj.time ?? obj.at;
    return { t, h, at: ts ? new Date(ts) : new Date() };
  }

  // ===== endpoints =====
  const URL_STATUS = `${API_BASE}/api/status/${encodeURIComponent(DEVICE_ID)}?threshold_sec=${THRESH_SEC}`;
  const URL_LATESTS = [
    `${API_BASE}/api/readings/latest?device_id=${encodeURIComponent(DEVICE_ID)}`,
    `${API_BASE}/api/last/${encodeURIComponent(DEVICE_ID)}`, // สำรองถ้ามี
    `${API_BASE}/api/readings?device_id=${encodeURIComponent(DEVICE_ID)}&limit=1&sort=-created_at`,
  ];
  const URL_HISTORY = (limit = 50) =>
    `${API_BASE}/api/readings?device_id=${encodeURIComponent(DEVICE_ID)}&limit=${limit}&sort=-created_at`;

  // ===== latest (fallback) =====
  async function getLatest() {
    for (const base of URL_LATESTS) {
      const url = `${base}${base.includes("?") ? "&" : "?"}_=${Date.now()}`;
      try {
        const j = await fetchJSON(url);
        if (Array.isArray(j)) return j[0] ?? null;
        if (j?.data)          return Array.isArray(j.data) ? j.data[0] : j.data;
        if (j?.items)         return Array.isArray(j.items) ? j.items[0] : j.items;
        if (j?.temperature != null || j?.humidity != null) return j;
      } catch {}
    }
    return null;
  }

  // ===== Responsive canvas utils =====
  const state = { spark: [], timeline: [] }; // เก็บข้อมูลล่าสุดไว้ redraw

  function fitCanvas(canvas) {
    if (!canvas) return { w: 0, h: 0, ctx: null };
    const ratioAttr = Number(canvas.dataset.ratio) || 3.2; // กว้าง/สูง
    const cw = Math.max(100, Math.floor(canvas.clientWidth || canvas.parentElement?.clientWidth || 300));
    const ch = Math.max(80, Math.floor(cw / ratioAttr));
    const dpr = Math.min(2, window.devicePixelRatio || 1); // จำกัดไม่ให้กินแรงเกิน
    canvas.width  = Math.floor(cw * dpr);
    canvas.height = Math.floor(ch * dpr);
    canvas.style.height = `${ch}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // ให้พิกัด = CSS pixel
    return { w: cw, h: ch, ctx };
  }

  // ===== small sparkline (Recent Trend) =====
  function drawSparkline(canvas, series) {
    const { w: W, h: H, ctx } = fitCanvas(canvas);
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (series.length < 2) {
      ctx.globalAlpha = .6; ctx.fillStyle = "#fff";
      ctx.fillText("No history", 14, 18); ctx.globalAlpha = 1; return;
    }
    // grid
    ctx.globalAlpha = .12; ctx.strokeStyle = "#fff";
    for (let i = 1; i < 6; i++) { const y = (H / 6) * i; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.globalAlpha = 1;

    const pad = 10, N = series.length;
    const xAt = i => pad + (W - 2 * pad) * (i / Math.max(1, N - 1));
    const norm = vals => { const mn = Math.min(...vals), mx = Math.max(...vals), span = (mx - mn) || 1; return v => pad + (H - 2 * pad) * (1 - (v - mn) / span); };

    const tvals = series.map(s => s.t), yt = norm(tvals);
    ctx.lineWidth = 2.2; ctx.strokeStyle = "rgba(96,165,250,.95)";
    ctx.beginPath(); series.forEach((s, i) => { const x = xAt(i), y = yt(s.t); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();

    const hvals = series.map(s => s.h), yh = norm(hvals);
    ctx.strokeStyle = "rgba(52,211,153,.95)";
    ctx.beginPath(); series.forEach((s, i) => { const x = xAt(i), y = yh(s.h); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  }

  // ===== big timeline (Temp/Hum/Dew) =====
  function drawTimeline(canvas, series) {
    const { w: W, h: H, ctx } = fitCanvas(canvas);
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    if (series.length < 2) {
      ctx.globalAlpha = .6; ctx.fillStyle = "#fff";
      ctx.fillText("No history", 14, 22); ctx.globalAlpha = 1; return;
    }
    // grid
    ctx.globalAlpha = .12; ctx.strokeStyle = "#fff";
    for (let i = 1; i <= 5; i++) { const y = (H / 6) * i; ctx.beginPath(); ctx.moveTo(40, y); ctx.lineTo(W - 10, y); ctx.stroke(); }
    ctx.globalAlpha = 1;

    const padL = 40, padR = 10, padT = 10, padB = 28;
    const X = (i, N) => padL + (W - padL - padR) * (i / Math.max(1, N - 1));
    const range = vals => { const mn = Math.min(...vals), mx = Math.max(...vals); return { mn, mx, span: (mx - mn) || 1 }; };
    const tvals = series.map(s => s.t), hvals = series.map(s => s.h), dvals = series.map(s => s.d);
    const Rt = range(tvals), Rh = range(hvals), Rd = range(dvals);
    const mapY = (v, r) => padT + (H - padT - padB) * (1 - (v - r.mn) / r.span);

    // temp area
    ctx.beginPath();
    series.forEach((s, i) => { const x = X(i, series.length), y = mapY(s.t, Rt); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.lineTo(W - padR, H - padB); ctx.lineTo(padL, H - padB); ctx.closePath();
    ctx.fillStyle = "rgba(96,165,250,.18)"; ctx.fill();

    // temp line
    ctx.lineWidth = 2.4; ctx.strokeStyle = "rgba(96,165,250,.95)";
    ctx.beginPath();
    series.forEach((s, i) => { const x = X(i, series.length), y = mapY(s.t, Rt); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();

    // hum line
    ctx.lineWidth = 2.2; ctx.strokeStyle = "rgba(52,211,153,.95)";
    ctx.beginPath();
    series.forEach((s, i) => { const x = X(i, series.length), y = mapY(s.h, Rh); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();

    // dew line
    ctx.lineWidth = 2.0; ctx.strokeStyle = "rgba(250,204,21,.95)";
    ctx.beginPath();
    series.forEach((s, i) => { const x = X(i, series.length), y = mapY(s.d, Rd); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();

    // x-ticks
    ctx.fillStyle = "rgba(255,255,255,.65)"; ctx.font = "12px system-ui";
    const step = Math.max(1, Math.ceil(series.length / 6));
    for (let i = 0; i < series.length; i += step) {
      const x = X(i, series.length), d = series[i].at;
      const label = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      ctx.fillText(label, x - 16, H - 8);
    }
  }

  // ===== history loaders =====
  function toSeries(arr) {
    const rows = arr
      .map(parseReading)
      .filter(s => isFinite(s.t) && isFinite(s.h))
      .sort((a, b) => a.at - b.at);
    rows.forEach(r => r.d = dewPointC(r.t, r.h));
    return rows;
  }

  async function loadHistory(limit = 50) {
    try {
      const j = await fetchJSON(`${URL_HISTORY(limit)}&_=${Date.now()}`);
      const rows = toSeries(pickArray(j));
      state.spark = rows;
      state.timeline = rows;
      drawSparkline(el.chart, rows);
      drawTimeline(el.timeline, rows);
    } catch (e) {
      console.warn("history error", e);
      state.spark = [];
      state.timeline = [];
      drawSparkline(el.chart, []);
      drawTimeline(el.timeline, []);
    }
  }

  // ===== refresh latest + status =====
  async function refresh() {
    try {
      const [status, latest] = await Promise.all([
        fetchJSON(`${URL_STATUS}&_=${Date.now()}`),
        getLatest(),
      ]);
      // ตัดสิน online จากฟิลด์ online / is_online เท่านั้น (อย่าใช้ ok)
      const isOnline = (typeof status?.online === "boolean")
        ? status.online
        : (typeof status?.is_online === "boolean" ? status.is_online : false);

      setStatus(isOnline);

      if (isOnline && latest) {
        const t = Number(latest.temperature ?? latest.temp ?? latest.t);
        const h = Number(latest.humidity    ?? latest.hum  ?? latest.h);
        const ts = latest.updated_at ?? latest.created_at ?? latest.ts ?? latest.time;
        updateGauges(t, h);
        el.last && (el.last.textContent = fmtTime(ts));
        el.card?.classList.remove("hidden");
        el.empty && (el.empty.style.display = "none");
      } else {
        el.card?.classList.add("hidden");
        el.empty && (el.empty.style.display = "block");
      }
    } catch (e) {
      console.warn("refresh error:", e);
      setStatus(false);
      el.card?.classList.add("hidden");
      el.empty && (el.empty.style.display = "block");
    }
  }

  // ===== range buttons สำหรับ timeline =====
  document.querySelectorAll(".range").forEach(btn => {
    btn.addEventListener("click", () => {
      const lim = Number(btn.dataset.limit || 50);
      loadHistory(lim);
    });
  });

  // ===== auto redraw on resize/orientation =====
  const ro = new ResizeObserver(() => {
    if (state.spark.length)   drawSparkline(el.chart, state.spark);
    if (state.timeline.length) drawTimeline(el.timeline, state.timeline);
  });
  if (el.chart)    ro.observe(el.chart.parentElement || el.chart);
  if (el.timeline) ro.observe(el.timeline.parentElement || el.timeline);

  window.addEventListener("orientationchange", () => {
    setTimeout(() => {
      if (state.spark.length)   drawSparkline(el.chart, state.spark);
      if (state.timeline.length) drawTimeline(el.timeline, state.timeline);
    }, 250);
  });

  // ===== boot =====
  refresh();            // ค่าปัจจุบัน + สถานะ
  loadHistory(50);      // ประวัติเริ่มต้น
  setInterval(refresh, Math.max(3000, POLL_MS));
  setInterval(() => loadHistory(50), 20000);
})();
