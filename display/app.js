// display/app.js
// Live dashboard: กราฟ 3 ใบปรับสเกล Y อัตโนมัติจากข้อมูลล่าสุดเสมอ
// รองรับปุ่ม Last 50/200/500 เพื่อเลือกจำนวนจุดที่แสดง

(function () {
  const CFG = window.CONFIG || window.DHT_CONFIG || {};
  const API_BASE = CFG.API_BASE || "";
  const DEVICE_ID = CFG.DEVICE_ID || "esp32-1";
  const POLL_MS = (CFG.POLL_MS | 0) || 5000;
  const THRESH_SEC = CFG.ONLINE_THRESHOLD_SEC ?? CFG.THRESHOLD_SEC ?? CFG.STATUS_THRESHOLD_SEC ?? 30;

  // ===== คอนฟิกกราฟ =====
  const AXIS_MODE = "auto"; // "fixed" | "auto"  <<<<< สำคัญ: ใช้ "auto" เพื่อให้สเกลตามค่าจริง
  const AXIS = {
    temp: { min: 31.5, max: 33.5 }, // ใช้เมื่อ AXIS_MODE = "fixed"
    hum:  { min: 60,   max: 90   },
    dew:  { min: 26,   max: 32   },
  };

  let LIVE_POINTS = 50;   // จำนวนจุดล่าสุดที่จะแสดง (สลับได้ด้วยปุ่ม Last 50/200/500)
  const Y_GRID_LINES = 6; // เส้นกริดแนวนอนเท่ากันทุกใบ

  const $ = (s) => document.querySelector(s);
  const el = {
    status: $("#status"),
    temp: $("#temp"),
    hum: $("#hum"),
    dew: $("#dew"),
    last: $("#last"),
    dev: $("#dev"),
    poll: $("#poll"),
    tempRing: $("#tempRing"),
    humBar: $("#humBar"),
    card: $("#card"),

    chartT: $("#chartT"),
    chartH: $("#chartH"),
    chartD: $("#chartD"),

    lastT: $("#lastT"),  nowT: $("#nowT"),
    lastH: $("#lastH"),  nowH: $("#nowH"),
    lastD: $("#lastD"),  nowD: $("#nowD"),

    themeToggle: $("#themeToggle"),
    yr: $("#yr"),
    empty: $("#emptyHint"),
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

  // ===== API Endpoints =====
  const URL_STATUS = `${API_BASE}/api/status/${encodeURIComponent(DEVICE_ID)}?threshold_sec=${THRESH_SEC}`;
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

  // ===== วาดกราฟ (Canvas 2D) =====
  function niceTicks(min, max) {
    const span = max - min;
    const raw = span / (Y_GRID_LINES - 1);
    const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
    const steps = [1, 2, 2.5, 5, 10].map(v => v * pow10);
    const step = steps.reduce((a, b) => Math.abs(a - raw) < Math.abs(b - raw) ? a : b);
    const nmin = Math.floor(min / step) * step;
    const nmax = Math.ceil(max / step) * step;
    const exact = (nmax - nmin) / (Y_GRID_LINES - 1);
    const ticks = Array.from({ length: Y_GRID_LINES }, (_, i) => nmin + exact * i);
    return { min: nmin, max: nmax, step: exact, ticks };
  }

  function renderLineChart(canvas, xs, ys, opts = {}) {
    if (!canvas) return;

    // Retina-safe size
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 560;
    const cssH = canvas.clientHeight || 190;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // พื้นที่วาดเท่ากันทุกใบ
    const m = { l: 43, r: 12, t: 10, b: 32 };
    const W = cssW, H = cssH;
    const iw = W - m.l - m.r, ih = H - m.t - m.b;

    ctx.clearRect(0, 0, W, H);

    if (!xs.length || !ys.length) {
      ctx.fillStyle = "#fff";
      ctx.globalAlpha = 0.8;
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText("No data", m.l + 8, m.t + 16);
      ctx.globalAlpha = 1;
      return;
    }

    // X: ช่องเท่ากันตามจำนวนจุด
    const N = xs.length;
    const xAt = (i) => m.l + (iw * (N === 1 ? 0 : i / (N - 1)));

    // Y: fixed หรือ auto (พร้อมระยะเผื่อ)
    let ymin, ymax;
    if (opts.yRange && AXIS_MODE === "fixed") {
      ymin = opts.yRange.min; ymax = opts.yRange.max;
    } else {
      const vmin = Math.min(...ys), vmax = Math.max(...ys);
      let pad = (vmax - vmin) * 0.15;               // เผื่อขอบ 15%
      if (!isFinite(pad) || pad === 0) pad = Math.abs(vmin || 1) * 0.1; // กรณีมีจุดเดียว/คงที่
      ymin = vmin - pad;
      ymax = vmax + pad;
    }
    const T = niceTicks(ymin, ymax);
    const yAt = (v) => m.t + ih - ih * ((v - T.min) / Math.max(1e-9, (T.max - T.min)));

    // Grid Y + labels
    ctx.strokeStyle = "rgba(255,255,255,.14)";
    ctx.lineWidth = 1;
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const dec = T.step >= 1 ? 0 : (T.step >= 0.1 ? 1 : 2);
    T.ticks.forEach(tv => {
      const y = yAt(tv);
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(W - m.r, y); ctx.stroke();
      ctx.fillText(tv.toFixed(dec), m.l - 6, y);
    });

    // Grid X (ตามจุดเวลา)
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i < N; i++) {
      const x = xAt(i);
      ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, H - m.b); ctx.stroke();
      const d = xs[i];
      const label = d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      ctx.fillText(label, x, H - m.b + 6);
    }

    // เส้นกราฟ
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = opts.stroke || "rgba(96,165,250,.95)";
    ctx.beginPath();
    ys.forEach((v, i) => {
      const x = xAt(i), y = yAt(v);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
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
    const t = Number(o.temperature ?? o.temp ?? o.t ?? o.value?.temperature);
    const h = Number(o.humidity    ?? o.hum  ?? o.h ?? o.value?.humidity);
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

      const lastN = rows.slice(-limit); // ใช้จำนวนจุดตามปุ่ม
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

  // ===== ปุ่มเลือกจำนวนจุด =====
  function setupRangeButtons() {
    const btns = document.querySelectorAll(".range");
    const setActive = (n) => {
      btns.forEach(b => b.classList.toggle("active", Number(b.dataset.limit) === n));
    };
    btns.forEach(b => {
      b.addEventListener("click", () => {
        const n = Number(b.dataset.limit) || 50;
        LIVE_POINTS = n;
        setActive(n);
        loadHistory(n);
      });
    });
    setActive(LIVE_POINTS);
  }

  // ===== refresh latest + status =====
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
