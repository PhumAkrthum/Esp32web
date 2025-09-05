// display/app.js
// โฟกัสรอบนี้: ทำให้กราฟทั้ง 3 ใบ "เท่ากัน", ใช้แค่ 5 จุดล่าสุด และเว้นช่วงเท่ากัน

(function () {
  const CFG = window.CONFIG || window.DHT_CONFIG || {};
  const API_BASE = CFG.API_BASE || "";
  const DEVICE_ID = CFG.DEVICE_ID || "esp32-1";
  const POLL_MS = (CFG.POLL_MS | 0) || 5000;
  const THRESH_SEC = CFG.ONLINE_THRESHOLD_SEC ?? CFG.THRESHOLD_SEC ?? CFG.STATUS_THRESHOLD_SEC ?? 30;
  const LIVE_POINTS = CFG.LIVE_POINTS ?? 5;           // << ใช้แค่ 5 จุดล่าสุด
  const Y_GRID_LINES = 6;                              // แนวนอน = 6 เส้น (5 ช่อง) ทุกกราฟเหมือนกัน

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

    // สามกราฟ
    chartT: $("#chartT"),
    chartH: $("#chartH"),
    chartD: $("#chartD"),

    // ค่าหัวแต่ละกราฟ
    lastT: $("#lastT"),
    lastH: $("#lastH"),
    lastD: $("#lastD"),
    nowT: $("#nowT"),
    nowH: $("#nowH"),
    nowD: $("#nowD"),

    themeToggle: $("#themeToggle"),
    yr: $("#yr"),
    empty: $("#emptyHint"),
  };

  el.yr && (el.yr.textContent = new Date().getFullYear());
  el.dev && (el.dev.textContent = DEVICE_ID);
  el.poll && (el.poll.textContent = (POLL_MS / 1000).toFixed(0) + "s");

  // Theme
  const LS_KEY = "esp32-theme";
  const setTheme = (m) => {
    document.documentElement.classList.toggle("light", m === "light");
    localStorage.setItem(LS_KEY, m);
  };
  setTheme(localStorage.getItem(LS_KEY) || "dark");
  el.themeToggle?.addEventListener("click", () => {
    setTheme((localStorage.getItem(LS_KEY) || "dark") === "dark" ? "light" : "dark");
  });

  // Helpers
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

  // API
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

  // ====== Drawing: ทำเส้นกริด/ช่องเท่ากันทุกใบ + ใช้แค่ 5 จุดล่าสุด ======
  function niceRange(min, max) {
    // ให้ขอบเขตสวย ๆ แต่บังคับจำนวนเส้นแนวนอน = Y_GRID_LINES
    if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] };
    if (min === max) { const r = Math.abs(min || 1) * 0.05; min -= r; max += r; }
    const span = max - min;
    const unrounded = span / (Y_GRID_LINES - 1);
    const pow10 = Math.pow(10, Math.floor(Math.log10(unrounded)));
    const baseSteps = [1, 2, 2.5, 5, 10].map(v => v * pow10);
    const step = baseSteps.reduce((a, b) => Math.abs(a - unrounded) < Math.abs(b - unrounded) ? a : b);
    const nmin = Math.floor(min / step) * step;
    const nmax = Math.ceil(max / step) * step;
    const exactStep = (nmax - nmin) / (Y_GRID_LINES - 1);
    const ticks = Array.from({ length: Y_GRID_LINES }, (_, i) => nmin + exactStep * i);
    return { min: nmin, max: nmax, step: exactStep, ticks };
  }

  function renderLineChart(canvas, xs, ys, opts = {}) {
    if (!canvas) return;

    // ขนาดคมชัดตาม CSS
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600;
    const cssH = canvas.clientHeight || 200;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ขอบ + พื้นที่วาดเท่ากันทุกใบ
    const m = { l: 40, r: 12, t: 10, b: 30 };
    const W = cssW, H = cssH;
    const iw = W - m.l - m.r, ih = H - m.t - m.b;

    ctx.clearRect(0, 0, W, H);

    if (xs.length === 0 || ys.length === 0) {
      ctx.fillStyle = "#fff"; ctx.globalAlpha = 0.8;
      ctx.fillText("No data", m.l + 8, m.t + 16);
      ctx.globalAlpha = 1;
      return;
    }

    // — X: ใช้ N จุดสุดท้ายและวางคงที่ —
    const N = xs.length; // จะถูกจำกัดไว้ที่ LIVE_POINTS แล้ว
    const xAt = (i) => m.l + (iw * (N === 1 ? 0 : i / (N - 1)));

    // — Y: ช่วงสวย ๆ + จำนวนกริดคงที่ —
    const vmin = Math.min(...ys), vmax = Math.max(...ys);
    const R = niceRange(vmin, vmax);
    const yAt = (v) => m.t + ih - ih * ((v - R.min) / Math.max(1e-9, (R.max - R.min)));

    // --- Grid แนวนอน (Y) + labels (เท่ากันทุกใบ) ---
    ctx.strokeStyle = "rgba(255,255,255,.14)";
    ctx.lineWidth = 1;
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    const dec = R.step >= 1 ? 0 : (R.step >= 0.1 ? 1 : 2);
    R.ticks.forEach((tv) => {
      const y = yAt(tv);
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(W - m.r, y); ctx.stroke();
      ctx.fillText(tv.toFixed(dec), m.l - 6, y);
    });

    // --- Grid แนวตั้ง (X) ที่ "จุดข้อมูล" ทุกจุด = ระยะเท่ากัน ---
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i < N; i++) {
      const x = xAt(i);
      ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, H - m.b); ctx.stroke();
      const d = xs[i];
      const label = d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      ctx.fillText(label, x, H - m.b + 6);
    }

    // --- เส้นกราฟ ---
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = opts.stroke || "rgba(96,165,250,.95)";
    ctx.beginPath();
    ys.forEach((v, i) => {
      const x = xAt(i), y = yAt(v);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // ======= state =======
  let SERIES = { xs: [], t: [], h: [], d: [] };

  function setNowClock() {
    const now = new Date();
    const s = `Now ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    el.nowT && (el.nowT.textContent = s);
    el.nowH && (el.nowH.textContent = s);
    el.nowD && (el.nowD.textContent = s);
  }

  function redrawAll() {
    renderLineChart(el.chartT, SERIES.xs, SERIES.t, { stroke: "rgba(96,165,250,.95)" });
    renderLineChart(el.chartH, SERIES.xs, SERIES.h, { stroke: "rgba(52,211,153,.95)" });
    renderLineChart(el.chartD, SERIES.xs, SERIES.d, { stroke: "rgba(250,204,21,.95)" });
  }
  window.addEventListener("resize", redrawAll);

  // ===== history loader (ตัดให้เหลือ 5 จุดล่าสุดเสมอ) =====
  function pickArray(j) { return Array.isArray(j) ? j : j?.data || []; }
  function parseReading(o) {
    const t = Number(o.temperature ?? o.temp ?? o.t ?? o.value?.temperature);
    const h = Number(o.humidity ?? o.hum ?? o.h ?? o.value?.humidity);
    const ts = o.updated_at ?? o.created_at ?? o.ts ?? o.time ?? o.at;
    return { t, h, at: ts ? new Date(ts) : new Date() };
  }

  async function loadHistory(limit = 50) {
    try {
      const j = await fetchJSON(`${URL_HISTORY(limit)}&_=${Date.now()}`);
      const rows = pickArray(j).map(parseReading).filter(s => isFinite(s.t) && isFinite(s.h)).sort((a, b) => a.at - b.at);

      // เหลือเฉพาะ N=LIVE_POINTS จุดล่าสุด
      const lastN = rows.slice(-LIVE_POINTS);
      const xs = lastN.map(r => r.at);
      const ts = lastN.map(r => r.t);
      const hs = lastN.map(r => r.h);
      const ds = lastN.map(r => dewPointC(r.t, r.h));

      SERIES = { xs, t: ts, h: hs, d: ds };

      // อัปหัวกราฟ
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

  // ===== latest + status =====
  async function refresh() {
    try {
      const [status, latest] = await Promise.all([
        fetchJSON(`${URL_STATUS}&_=${Date.now()}`),
        getLatest(),
      ]);
      const isOnline = !!(status.is_online ?? status.online ?? status.ok ?? true);
      setStatus(isOnline);

      if (isOnline && latest) {
        const t = Number(latest.temperature ?? latest.temp ?? latest.t);
        const h = Number(latest.humidity ?? latest.hum ?? latest.h);
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

  // ปุ่มช่วงเวลาเดิม (ยังใช้งานได้) แต่กราฟจะ “ตัดเหลือ 5 จุดล่าสุด” เสมอ
  document.querySelectorAll(".range").forEach(btn => {
    btn.addEventListener("click", () => loadHistory(Number(btn.dataset.limit || 50)));
  });

  // boot
  refresh();
  loadHistory(50);
  setInterval(refresh, Math.max(3000, POLL_MS));
  setInterval(() => { setNowClock(); }, 1000);
})();
