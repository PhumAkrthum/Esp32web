// display/app.js
// โฟกัส: ทำให้กริด/สเกลของทั้ง 3 กราฟ "เท่ากันเป๊ะ" แบบกราฟซ้าย

(function () {
  const CFG = window.CONFIG || window.DHT_CONFIG || {};
  const API_BASE = CFG.API_BASE || "";
  const DEVICE_ID = CFG.DEVICE_ID || "esp32-1";
  const POLL_MS = (CFG.POLL_MS | 0) || 5000;
  const THRESH_SEC =
    CFG.ONLINE_THRESHOLD_SEC ??
    CFG.THRESHOLD_SEC ??
    CFG.STATUS_THRESHOLD_SEC ??
    30;

  // ===== selectors =====
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

    // กราฟแยก 3 ใบ
    chartT: $("#chartT"),
    chartH: $("#chartH"),
    chartD: $("#chartD"),

    // ค่าบนหัวกราฟ
    lastT: $("#lastT"),
    lastH: $("#lastH"),
    lastD: $("#lastD"),
    nowT: $("#nowT"),
    nowH: $("#nowH"),
    nowD: $("#nowD"),

    // Comfort (เดิม)
    hiText: $("#hiText"),
    hiPointer: $("#hiPointer"),
    feelsLike: $("#feelsLike"),
    factDew: $("#factDew"),
    comfortZone: $("#comfortZone"),

    themeToggle: $("#themeToggle"),
    yr: $("#yr"),
    empty: $("#emptyHint"),
  };

  // ===== small infos =====
  el.yr && (el.yr.textContent = new Date().getFullYear());
  el.dev && (el.dev.textContent = DEVICE_ID);
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
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }

  // Magnus (approx)
  function dewPointC(tC, rh) {
    if (!isFinite(tC) || !isFinite(rh) || rh <= 0) return NaN;
    const a = 17.62,
      b = 243.12;
    const gamma = (a * tC) / (b + tC) + Math.log(rh / 100);
    return (b * gamma) / (a - gamma);
  }

  function heatIndexC(tC, rh) {
    // NOAA HI (แปลง C->F แล้วกลับ C)
    const tF = tC * 9 / 5 + 32;
    const HI =
      -42.379 +
      2.04901523 * tF +
      10.14333127 * rh -
      0.22475541 * tF * rh -
      0.00683783 * tF * tF -
      0.05481717 * rh * rh +
      0.00122874 * tF * tF * rh +
      0.00085282 * tF * rh * rh -
      0.00000199 * tF * tF * rh * rh;
    return (HI - 32) * 5 / 9;
  }

  function updateGauges(t, h) {
    const p = Math.max(0, Math.min(100, (Number(t) / 50) * 100));
    el.tempRing?.style.setProperty("--p", p.toFixed(2));
    el.temp && (el.temp.textContent = isFinite(t) ? Number(t).toFixed(1) : "--.-");
    el.hum && (el.hum.textContent = isFinite(h) ? Math.round(Number(h)) : "--");
    el.humBar &&
      (el.humBar.style.width = `${Math.max(0, Math.min(100, Number(h) || 0)).toFixed(0)}%`);
    const dp = dewPointC(Number(t), Number(h));
    el.dew && (el.dew.textContent = isFinite(dp) ? dp.toFixed(1) : "--.-");
  }

  // ===== parsers =====
  const pickArray = (j) =>
    Array.isArray(j) ? j : j?.data || j?.items || j?.rows || j?.docs || j?.result || j?.history || [];

  function parseReading(obj) {
    const t = Number(obj.temperature ?? obj.temp ?? obj.t ?? obj.value?.temperature);
    const h = Number(obj.humidity ?? obj.hum ?? obj.h ?? obj.value?.humidity);
    const ts = obj.updated_at ?? obj.created_at ?? obj.ts ?? obj.time ?? obj.at;
    return { t, h, at: ts ? new Date(ts) : new Date() };
  }

  // ===== endpoints =====
  const URL_STATUS = `${API_BASE}/api/status/${encodeURIComponent(
    DEVICE_ID
  )}?threshold_sec=${THRESH_SEC}`;
  const URL_LATESTS = [
    `${API_BASE}/api/readings/latest?device_id=${encodeURIComponent(DEVICE_ID)}`,
    `${API_BASE}/api/last/${encodeURIComponent(DEVICE_ID)}`,
    `${API_BASE}/api/readings?device_id=${encodeURIComponent(
      DEVICE_ID
    )}&limit=1&sort=-created_at`,
  ];
  const URL_HISTORY = (limit = 50) =>
    `${API_BASE}/api/readings?device_id=${encodeURIComponent(
      DEVICE_ID
    )}&limit=${limit}&sort=-created_at`;

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

  // ======== DRAWING (ทำให้กริดเท่ากันทุกใบ) ========
  // สร้างสเกลสวย ๆ (nice numbers)
  function niceScale(min, max, maxTicks = 5) {
    if (!isFinite(min) || !isFinite(max)) return { ticks: [0, 1], niceMin: 0, niceMax: 1, step: 1 };
    if (min === max) {
      const eps = Math.abs(min || 1);
      min -= eps * 0.05;
      max += eps * 0.05;
    }
    const span = max - min;
    const unroundedStep = span / maxTicks;
    const pow10 = Math.pow(10, Math.floor(Math.log10(unroundedStep)));
    const candidates = [1, 2, 2.5, 5, 10].map((x) => x * pow10);
    let step = candidates.reduce((a, b) => (Math.abs(a - unroundedStep) < Math.abs(b - unroundedStep) ? a : b));

    // ขยาย min/max ให้ลงตัวตาม step
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;

    // สร้าง tick (ให้ได้ 5-6 เส้น เท่ากันทุกใบ)
    const ticks = [];
    for (let v = niceMin; v <= niceMax + 1e-9; v += step) ticks.push(v);
    return { ticks, niceMin, niceMax, step };
  }

  function renderLineChart(canvas, xs, ys, opts = {}) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    // กำหนดขนาดตาม CSS ให้คมชัด
    const cssW = canvas.clientWidth || 600;
    const cssH = canvas.clientHeight || 200;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    // พื้นที่วาด + margin
    const m = { l: 36, r: 12, t: 10, b: 26 };
    const W = cssW, H = cssH;
    const iw = W - m.l - m.r, ih = H - m.t - m.b;

    ctx.clearRect(0, 0, W, H);

    if (!xs.length || !ys.length) {
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = "#fff";
      ctx.fillText("No data", m.l + 8, m.t + 16);
      ctx.globalAlpha = 1;
      return;
    }

    // ===== สร้างสเกลให้ "เท่ากันทุกใบ" =====
    const xTicksCount = 6; // แนวตั้ง 6 เส้นคงที่
    const yMaxTicks = 5;   // แนวนอน 5 ช่องคงที่

    // X scale (index-based)
    const xMin = 0, xMax = xs.length - 1;
    const xScale = (i) => m.l + (iw * (i - xMin)) / Math.max(1, xMax - xMin);

    // Y scale (nice)
    const yVals = ys.filter((v) => isFinite(v));
    const yMin0 = Math.min(...yVals), yMax0 = Math.max(...yVals);
    const { ticks: yTicks, niceMin, niceMax } = niceScale(yMin0, yMax0, yMaxTicks);
    const yScale = (v) => m.t + ih - (ih * (v - niceMin)) / Math.max(1e-9, niceMax - niceMin);

    // ===== Grid (เส้นเท่ากัน/ความหนาเท่ากัน) =====
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,.14)";

    // Y grid + labels (แนวนอน)
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    yTicks.forEach((v) => {
      const y = yScale(v);
      ctx.beginPath();
      ctx.moveTo(m.l, y);
      ctx.lineTo(W - m.r, y);
      ctx.stroke();
      // labels
      const text =
        Math.abs(v) >= 100
          ? v.toFixed(0)
          : Math.abs(v % 1) < 1e-6
          ? v.toFixed(0)
          : v.toFixed(1);
      ctx.fillText(text, m.l - 6, y);
    });

    // X grid + labels (แนวตั้ง) : 6 เส้นเท่ากันทุกใบ
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let k = 0; k <= xTicksCount; k++) {
      const idx = Math.round((k * xMax) / xTicksCount);
      const x = xScale(idx);
      ctx.beginPath();
      ctx.moveTo(x, m.t);
      ctx.lineTo(x, H - m.b);
      ctx.stroke();

      const d = xs[idx];
      const label = d
        ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
      ctx.fillText(label, x, H - m.b + 6);
    }

    // ===== เส้นกราฟ =====
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = opts.stroke || "rgba(96,165,250,.95)";
    ctx.beginPath();
    ys.forEach((v, i) => {
      const x = xScale(i);
      const y = yScale(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // ======= state for redraw =======
  let SERIES = { xs: [], t: [], h: [], d: [] };

  function setNowClock() {
    const now = new Date();
    const s = `Now ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    if (el.nowT) el.nowT.textContent = s;
    if (el.nowH) el.nowH.textContent = s;
    if (el.nowD) el.nowD.textContent = s;
  }

  function redrawAll() {
    const colT = "rgba(96,165,250,.95)";
    const colH = "rgba(52,211,153,.95)";
    const colD = "rgba(250,204,21,.95)";
    renderLineChart(el.chartT, SERIES.xs, SERIES.t, { stroke: colT });
    renderLineChart(el.chartH, SERIES.xs, SERIES.h, { stroke: colH });
    renderLineChart(el.chartD, SERIES.xs, SERIES.d, { stroke: colD });
  }
  window.addEventListener("resize", () => redrawAll());

  // ===== history loaders =====
  function calcSeries(arr) {
    const rows = arr
      .map(parseReading)
      .filter((s) => isFinite(s.t) && isFinite(s.h))
      .sort((a, b) => a.at - b.at);
    rows.forEach((r) => (r.d = dewPointC(r.t, r.h)));
    return rows;
  }

  async function loadHistory(limit = 50) {
    try {
      const j = await fetchJSON(`${URL_HISTORY(limit)}&_=${Date.now()}`);
      const rows = calcSeries(pickArray(j));
      SERIES.xs = rows.map((r) => r.at);
      SERIES.t = rows.map((r) => r.t);
      SERIES.h = rows.map((r) => r.h);
      SERIES.d = rows.map((r) => r.d);

      // อัปเดตตัวเลขหัวกราฟ (ค่าล่าสุด)
      if (rows.length) {
        const last = rows[rows.length - 1];
        el.lastT && (el.lastT.textContent = `${last.t.toFixed(1)}°C`);
        el.lastH && (el.lastH.textContent = `${Math.round(last.h)}%`);
        el.lastD && (el.lastD.textContent = `${last.d.toFixed(1)}°C`);
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

  // ===== refresh latest + status + comfort =====
  function comfortText(hi) {
    if (!isFinite(hi)) return "—";
    if (hi < 27) return "Comfortable";
    if (hi < 32) return "Warm";
    if (hi < 41) return "Hot";
    return "Very Hot";
  }

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

        // Comfort
        const dp = dewPointC(t, h);
        const hi = heatIndexC(t, h);
        const hiPct = Math.min(100, Math.max(0, ((hi - 20) / 25) * 100)); // แปลง ~20–45°C เป็น 0–100%
        el.hiPointer && (el.hiPointer.style.left = `${hiPct}%`);
        el.hiText && (el.hiText.textContent = comfortText(hi));
        el.feelsLike && (el.feelsLike.textContent = `${hi.toFixed(1)} °C`);
        el.factDew && (el.factDew.textContent = `${isFinite(dp) ? dp.toFixed(1) : "--.-"} °C`);
        el.comfortZone && (el.comfortZone.textContent = hi >= 41 ? "Oppressive" : hi >= 32 ? "Very Hot" : hi >= 27 ? "Warm" : "Comfortable");
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

  // ===== range buttons =====
  document.querySelectorAll(".range").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lim = Number(btn.dataset.limit || 50);
      loadHistory(lim);
    });
  });

  // ===== boot =====
  refresh();
  loadHistory(50);
  setInterval(refresh, Math.max(3000, POLL_MS));
  setInterval(() => {
    setNowClock();
    // ไม่ดึงข้อมูลซ้ำถี่เกิน — คง refresh history ทุก 20s ถ้าต้องการ
  }, 1000);
})();
