// display/app.js
// ไม่มีเส้นกริด แต่คำนวณแกน/เวลาแม่น + ป้ายเวลาเว้นอัตโนมัติ
(function () {
  const CFG = window.CONFIG || window.DHT_CONFIG || {};
  const API_BASE = CFG.API_BASE || "";
  const DEVICE_ID = CFG.DEVICE_ID || "esp32-1";
  const POLL_MS = (CFG.POLL_MS | 0) || 5000;
  const THRESH_SEC = CFG.ONLINE_THRESHOLD_SEC ?? CFG.THRESHOLD_SEC ?? CFG.STATUS_THRESHOLD_SEC ?? 30;

  // ===== สวิตช์แสดงผล =====
  const SHOW_GRID_X = false; // ❌ ไม่วาดเส้นตั้ง
  const SHOW_GRID_Y = false; // ❌ ไม่วาดเส้นนอน
  const SHOW_Y_LABELS = true; // แสดงเลขสเกล Y (ไม่มีเส้น)
  const LABEL_BG = true;      // พื้นหลังป้ายเวลา
  const SKIP_END_LABEL = true;
  const MIN_LABEL_PADDING = 8;

  // ===== X window =====
  const TIME_WINDOW_MIN = 4;
  const TIME_WINDOW_MS  = TIME_WINDOW_MIN * 60 * 1000;
  const X_TICK_MS       = 60 * 1000;

  // ===== Y-axis =====
  const AXIS_MODE = "auto"; // "fixed" | "auto"
  const AXIS = {
    temp: { min: 20, max: 40 },
    hum:  { min: 40, max: 100 },
    dew:  { min: 10, max: 35 },
  };
  const Y_GRID_LINES = 6; // ใช้แค่คำนวณตำแหน่ง label (ไม่วาดเส้น)

  let LIVE_POINTS = 50;

  // ===== DOM =====
  const $ = (s) => document.querySelector(s);
  const el = {
    status: $("#status"),
    temp: $("#temp"), hum: $("#hum"), dew: $("#dew"),
    last: $("#last"), dev: $("#dev"), poll: $("#poll"),
    tempRing: $("#tempRing"), humBar: $("#humBar"), card: $("#card"),
    chartT: $("#chartT"), chartH: $("#chartH"), chartD: $("#chartD"),
    lastT: $("#lastT"),  nowT: $("#nowT"),
    lastH: $("#lastH"),  nowH: $("#nowH"),
    lastD: $("#lastD"),  nowD: $("#nowD"),
    themeToggle: $("#themeToggle"), yr: $("#yr"), empty: $("#emptyHint"),
  };

  el.yr && (el.yr.textContent = new Date().getFullYear());
  el.dev && (el.dev.textContent = DEVICE_ID);
  el.poll && (el.poll.textContent = (POLL_MS / 1000).toFixed(0) + "s");

  // ===== Theme =====
  const LS_KEY = "esp32-theme";
  const setTheme = (m) => {
    document.documentElement.classList.toggle("light", m === "light");
    localStorage.setItem(LS_KEY, m);
  };
  setTheme(localStorage.getItem(LS_KEY) || "dark");
  el.themeToggle?.addEventListener("click", () => {
    setTheme((localStorage.getItem(LS_KEY) || "dark") === "dark" ? "light" : "dark");
  });

  // ===== Helpers =====
  async function fetchJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} @ ${url}`);
    return r.json();
  }
  function setStatus(on) {
    el.status?.classList.toggle("online", !!on);
    el.status?.classList.toggle("offline", !on);
    const label = el.status?.querySelector(".label");
    if (label) label.textContent = on ? "Connected" : "Disconnected";
  }
  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  function dewPointC(tC, rh) {
    if (!isFinite(tC) || !isFinite(rh) || rh <= 0) return NaN;
    const a = 17.62, b = 243.12;
    const g = (a * tC) / (b + tC) + Math.log(rh / 100);
    return (b * g) / (a - g);
  }
  function updateGauges(t, h) {
    const p = Math.max(0, Math.min(100, (Number(t) / 50) * 100));
    el.tempRing?.style.setProperty("--p", p.toFixed(2));
    el.temp && (el.temp.textContent = isFinite(t) ? Number(t).toFixed(1) : "--.-");
    el.hum && (el.hum.textContent = isFinite(h) ? Math.round(Number(h)) : "--");
    el.humBar && (el.humBar.style.width = `${Math.max(0, Math.min(100, Number(h) || 0)).toFixed(0)}%`);
    const dp = dewPointC(Number(t), Number(h));
    el.dew && (el.dew.textContent = isFinite(dp) ? dp.toFixed(1) : "--.-");
  }

  // ===== API =====
  const URL_STATUS  = `${API_BASE}/api/status/${encodeURIComponent(DEVICE_ID)}?threshold_sec=${THRESH_SEC}`;
  const URL_LATESTS = [
    `${API_BASE}/api/readings/latest?device_id=${encodeURIComponent(DEVICE_ID)}`,
    `${API_BASE}/api/last/${encodeURIComponent(DEVICE_ID)}`,
    `${API_BASE}/api/readings?device_id=${encodeURIComponent(DEVICE_ID)}&limit=1&sort=-created_at`,
  ];
  const URL_HISTORY = (limit = 50) =>
    `${API_BASE}/api/readings?device_id=${encodeURIComponent(DEVICE_ID)}&limit=${limit}&sort=-created_at`;

  async function getLatest() {
    for (const base of URL_LATESTS) {
      const url = `${base}${base.includes("?") ? "&" : "?"}_=${Date.now()}`;
      try {
        const j = await fetchJSON(url);
        if (Array.isArray(j)) return j[0] ?? null;
        if (j?.data) return Array.isArray(j.data) ? j.data[0] : j.data;
        if (j?.items) return Array.isArray(j.items) ? j.items[0] : j.items;
        if (j?.temperature != null || j?.humidity != null) return j;
      } catch {}
    }
    return null;
  }

  // ========= Drawing =========
  const toMs = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
  const floorToMinute = (ms) => Math.floor(ms / 60000) * 60000;
  const ceilToMinute  = (ms) => Math.ceil (ms / 60000) * 60000;

  function niceIntTicks(min, max) {
    let step = Math.max(1, Math.ceil((max - min) / Math.max(1, (Y_GRID_LINES - 1))));
    let nmax = Math.ceil(max / step) * step;
    let nmin = nmax - step * (Y_GRID_LINES - 1);
    if (nmin > min) {
      nmin = Math.floor(min / step) * step;
      nmax = nmin + step * (Y_GRID_LINES - 1);
      if (nmax < max) {
        const k = Math.ceil((max - nmax) / step);
        nmax += k * step;
        nmin = nmax - step * (Y_GRID_LINES - 1);
      }
    }
    const ticks = Array.from({ length: Y_GRID_LINES }, (_, i) => nmin + step * i);
    return { min: nmin, max: nmax, step, ticks };
  }

  function renderLineChart(canvas, xs, ys, opts = {}) {
    if (!canvas) return;

    // retina-safe
    const dpr  = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 560;
    const cssH = canvas.clientHeight || 190;
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const m = { l: 46, r: 12, t: 10, b: 52 };
    const W = cssW, H = cssH, iw = W - m.l - m.r, ih = H - m.t - m.b;

    ctx.clearRect(0, 0, W, H);

    if (!xs.length || !ys.length) {
      ctx.fillStyle = "rgba(255,255,255,.75)";
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText("No data", m.l + 8, m.t + 16);
      return;
    }

    // X window
    const tsArr = xs.map(toMs);
    let tMax = Math.max(...tsArr, Date.now());
    let tMin = tMax - TIME_WINDOW_MS;
    const xAtTs = (t) => m.l + iw * ((t - tMin) / Math.max(1, (tMax - tMin)));

    // Y range
    let ymin, ymax;
    if (opts.yRange && AXIS_MODE === "fixed") {
      ymin = opts.yRange.min; ymax = opts.yRange.max;
    } else {
      const vmin = Math.min(...ys), vmax = Math.max(...ys);
      let pad = (vmax - vmin) * 0.15;
      if (!isFinite(pad) || pad === 0) pad = Math.abs(vmin || 1) * 0.1;
      ymin = vmin - pad; ymax = vmax + pad;
    }
    const T = niceIntTicks(ymin, ymax);
    const yAt = (v) => m.t + ih - ih * ((v - T.min) / Math.max(1e-9, (T.max - T.min)));

    // === ไม่มีเส้นกริด ===
    if (SHOW_Y_LABELS) {
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,.75)";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      T.ticks.forEach((tv) => {
        const y = Math.round(yAt(tv));
        ctx.fillText(String(Math.round(tv)), m.l - 6, y);
      });
    }

    // === ป้ายเวลา (คำนวณตามความกว้างจริง, พยายามให้ห่าง 1 นาทีถ้าพอ) ===
    ctx.textBaseline = "top";
    const xLabelY = H - m.b + 8;
    const startMin = floorToMinute(tMin);
    const endMin   = ceilToMinute(tMax);
    const totalMins = Math.max(1, Math.round((endMin - startMin) / 60000));

    ctx.font = "12px system-ui, sans-serif";
    const sampleW = ctx.measureText("11:11 AM").width;
    const minGap  = sampleW + MIN_LABEL_PADDING * 2;
    const maxLabels = Math.max(2, Math.floor(iw / minGap));
    // step เริ่มที่ 1 นาที แล้วเพิ่มจนพอดีกับพื้นที่
    let stepMin = 1;
    while (Math.floor(totalMins / stepMin) + 1 > maxLabels) stepMin++;

    let idx = 0, lastRight = -Infinity;
    for (let t = startMin; t <= endMin; t += X_TICK_MS, idx++) {
      const isStart = (t === startMin);
      const isEnd   = (t === endMin);
      if (SKIP_END_LABEL && isEnd) continue;
      if (!isStart && (idx % stepMin) !== 0) continue;

      let x = xAtTs(t);
      const label = new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      ctx.textAlign = "center";

      const w = ctx.measureText(label).width;
      let left = x - w / 2, right = x + w / 2;

      // clamp ขอบซ้าย/ขวา
      if (left < m.l + MIN_LABEL_PADDING) { left = m.l + MIN_LABEL_PADDING; right = left + w; x = left + w / 2; }
      if (right > W - m.r - MIN_LABEL_PADDING) { right = W - m.r - MIN_LABEL_PADDING; left = right - w; x = left + w / 2; }

      if (!isStart && left <= lastRight + MIN_LABEL_PADDING) continue;

      if (LABEL_BG) {
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,.28)";
        const padX = 4, padY = 2, r = 4;
        const bx = left - padX, by = xLabelY - padY, bw = w + padX * 2, bh = 16 + padY * 2;
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, r); ctx.fill(); }
        else { ctx.fillRect(bx, by, bw, bh); }
        ctx.restore();
      }
      ctx.fillStyle = "rgba(255,255,255,.92)";
      ctx.fillText(label, x, xLabelY);

      lastRight = right;
    }

    // === เส้นกราฟ (clip เฉพาะโซน plot) ===
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.l, m.t, iw, ih);
    ctx.clip();

    ctx.lineWidth = 2.2;
    ctx.strokeStyle = opts.stroke || "rgba(96,165,250,.95)";
    ctx.beginPath();
    ys.forEach((v, i) => {
      const x = xAtTs(tsArr[i]);
      const y = yAt(v);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  // ===== state =====
  let SERIES = { xs: [], t: [], h: [], d: [] };

  function setNowClock() {
    const s = `Now ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    el.nowT && (el.nowT.textContent = s);
    el.nowH && (el.nowH.textContent = s);
    el.nowD && (el.nowD.textContent = s);
  }

  function redrawAll() {
    renderLineChart(el.chartT, SERIES.xs, SERIES.t, { stroke: "rgba(96,165,250,.95)", yRange: AXIS.temp });
    renderLineChart(el.chartH, SERIES.xs, SERIES.h, { stroke: "rgba(52,211,153,.95)", yRange: AXIS.hum  });
    renderLineChart(el.chartD, SERIES.xs, SERIES.d, { stroke: "rgba(250,204,21,.95)", yRange: AXIS.dew  });
  }
  window.addEventListener("resize", redrawAll);

  function pickArray(j) { return Array.isArray(j) ? j : j?.data || []; }
  function parseReading(o) {
    const t  = Number(o.temperature ?? o.temp ?? o.t ?? o.value?.temperature);
    const h  = Number(o.humidity    ?? o.hum  ?? o.h ?? o.value?.humidity); // ✅ แก้บั๊กตัวแปรหลุด
    const ts = o.updated_at ?? o.created_at ?? o.ts ?? o.time ?? o.at;
    return { t, h, at: ts ? new Date(ts) : new Date() };
  }

  async function loadHistory(limit = LIVE_POINTS) {
    try {
      const j = await fetchJSON(`${URL_HISTORY(Math.max(limit, 1))}&_=${Date.now()}`);
      const rows = pickArray(j)
        .map(parseReading)
        .filter(s => isFinite(s.t) && isFinite(s.h))
        .sort((a, b) => a.at - b.at);

      const lastN = rows.slice(-limit);
      const xs = lastN.map(r => r.at);
      const ts = lastN.map(r => r.t);
      const hs = lastN.map(r => r.h);
      const ds = lastN.map(r => dewPointC(r.t, r.h));

      SERIES = { xs, t: ts, h: hs, d: ds };

      if (lastN.length) {
        const last = lastN[lastN.length - 1];
        el.lastT && (el.lastT.textContent = `${last.t.toFixed(1)}°C`);
        el.lastH && (el.lastH.textContent = `${Math.round(last.h)}%`);
        el.lastD && (el.lastD.textContent = `${dewPointC(last.t, last.h).toFixed(1)}°C`);
      } else {
        el.lastT && (el.lastT.textContent = "—");
        el.lastH && (el.lastH.textContent = "—");
        el.lastD && (el.lastD.textContent = "—");
      }

      setNowClock();
      redrawAll();
    } catch (e) {
      console.warn("history error", e);
      SERIES = { xs: [], t: [], h: [], d: [] };
      redrawAll();
    }
  }

  function setupRangeButtons() {
    const btns = document.querySelectorAll(".range");
    const setActive = (n) => btns.forEach(b => b.classList.toggle("active", Number(b.dataset.limit) === n));
    btns.forEach(b => b.addEventListener("click", () => {
      const n = Number(b.dataset.limit) || 50;
      LIVE_POINTS = n; setActive(n); loadHistory(n);
    }));
    setActive(LIVE_POINTS);
  }

  async function refresh() {
    try {
      const [status, latest] = await Promise.all([
        fetchJSON(`${URL_STATUS}&_=${Date.now()}`),
        getLatest()
      ]);
      const isOnline = !!(status.is_online ?? status.online ?? status.ok ?? true);
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

  // ===== boot =====
  setupRangeButtons();
  refresh();
  loadHistory(LIVE_POINTS);
  setInterval(refresh, Math.max(3000, POLL_MS));
  setInterval(setNowClock, 1000);
})();
