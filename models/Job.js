const mongoose = require('mongoose');

const JobSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  prio: {
    type: String,
    required: true,
    enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
  },
  status: {
    type: String,
    required: true,
    enum: ['pending', 'processing', 'complete'],
    default: 'pending'
  },
  durationMs: {
    type: Number,
    required: true
  },
  isMax: {
    type: Boolean,
    default: false
  }
});

module.exports = mongoose.model('Job', JobSchema);
