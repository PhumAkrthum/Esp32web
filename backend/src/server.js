import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import morgan from 'morgan';
import Reading from './models/Reading.js';



const app = express();
const PORT = process.env.PORT || 8080;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/esp32db';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use(express.json());
app.use(cors({ origin: CORS_ORIGIN }));
app.use(morgan('dev'));

mongoose.connect(MONGODB_URI).then(() => {
  console.log('MongoDB connected');
}).catch(err => {
  console.error('Mongo error:', err.message);
  process.exit(1);
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.post('/api/readings', async (req, res) => {
  try {
    const { device_id, temperature, humidity } = req.body || {};
    if (!device_id || typeof temperature !== 'number' || typeof humidity !== 'number') {
      return res.status(400).json({ ok: false, error: 'Invalid payload' });
    }
    const saved = await Reading.create({ device_id, temperature, humidity });
    return res.json({ ok: true, id: saved._id, ts: saved.created_at });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/readings/latest', async (req, res) => {
  try {
    const deviceId = req.query.device_id;
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id required' });
    const latest = await Reading.findOne({ device_id: deviceId }).sort({ created_at: -1 }).lean();
    if (!latest) return res.json({ ok: true, data: null });
    return res.json({ ok: true, data: latest });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/status/:device_id', async (req, res) => {
  try {
    const { device_id } = req.params;
    const thresholdSec = Number(req.query.threshold_sec || 30);
    const latest = await Reading.findOne({ device_id }).sort({ created_at: -1 }).lean();
    if (!latest) return res.json({ ok: true, device_id, online: false, last_seen: null, threshold_sec: thresholdSec });
    const ageSec = Math.round((Date.now() - new Date(latest.created_at).getTime()) / 1000);
    const online = ageSec <= thresholdSec;
    return res.json({ ok: true, device_id, online, age_sec: ageSec, last_seen: latest.created_at, threshold_sec: thresholdSec });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/', (req, res) => res.json({ name: 'esp32-dht-api', ok: true }));

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
