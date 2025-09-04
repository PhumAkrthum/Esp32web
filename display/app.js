const cfg = window.CONFIG;
const $ = s => document.querySelector(s);

async function fetchJSON(url) {
  const r = await fetch(url);
  return r.json();
}

async function refresh() {
  const dev = cfg.DEVICE_ID;
  try {
    const status = await fetchJSON(`${cfg.API_BASE}/api/status/${dev}?threshold_sec=${cfg.ONLINE_THRESHOLD_SEC}`);
    const statusEl = $('#status');
    const labelEl = $('#status .label');
    const cardEl = $('#card');
    const hintEl = $('#hint');

    if (status.ok && status.online) {
      statusEl.classList.remove('offline');
      statusEl.classList.add('online');
      labelEl.textContent = 'Connected';

      const latest = await fetchJSON(`${cfg.API_BASE}/api/readings/latest?device_id=${dev}`);
      if (latest.ok && latest.data) {
        $('#temp').textContent = Number(latest.data.temperature).toFixed(1);
        $('#hum').textContent = Number(latest.data.humidity).toFixed(0);
        $('#dev').textContent = latest.data.device_id;
        $('#last').textContent = new Date(latest.data.created_at).toLocaleString();
        cardEl.classList.remove('hidden');
        hintEl.style.display = 'none';
      }
    } else {
      statusEl.classList.remove('online');
      statusEl.classList.add('offline');
      labelEl.textContent = 'Disconnected';
      cardEl.classList.add('hidden');
      hintEl.style.display = 'block';
    }
  } catch (e) {
    console.error(e);
  }
}

setInterval(refresh, cfg.POLL_MS);
refresh();
