import mongoose from 'mongoose';

const ReadingSchema = new mongoose.Schema({
  device_id: { type: String, required: true, index: true },
  temperature: { type: Number, required: true },
  humidity: { type: Number, required: true },
  created_at: { type: Date, default: Date.now, index: true }
}, { versionKey: false });

export default mongoose.model('Reading', ReadingSchema);
