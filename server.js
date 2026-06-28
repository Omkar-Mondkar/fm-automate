// ═══════════════════════════════════════════════════════════════
//  FM-Automate — Express.js Server
//  API routes, SSE endpoint, static file serving
// ═══════════════════════════════════════════════════════════════
'use strict';

const express = require('express');
const path    = require('path');
const { AutomationEngine } = require('./automation');
const mongoose = require('mongoose');
const Job = require('./models/Job');

const app    = express();
const PORT   = process.env.PORT || 3000;
const engine = new AutomationEngine();

// Connect to MongoDB
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB connection error:', err));
} else {
  console.warn('⚠️ MONGODB_URI not provided. CRUD API will fail until configured.');
}

// ─── MIDDLEWARE ──────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SSE CLIENT MANAGEMENT ──────────────────────────────────
const sseClients = new Set();

engine.on('sse', (payload) => {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch (e) { sseClients.delete(res); }
  }
});

// ─── API: SSE STREAM ────────────────────────────────────────
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send initial connection event
  const initPayload = {
    status: 'CONNECTED',
    timestamp: new Date().toISOString(),
    message: 'SSE stream connected',
    engineState: engine.getStatus(),
  };
  res.write(`data: ${JSON.stringify(initPayload)}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ─── API: START AUTOMATION (Phase 1) ────────────────────────
app.post('/api/start', (req, res) => {
  const { targetUrl, serialCssClass, checkboxCssClass, doneCssClass, executionSequence, pollIntervals, browserType, headless, recycleContext } = req.body;

  // Validation
  const errors = [];
  if (!targetUrl)        errors.push('targetUrl is required');
  if (!serialCssClass)   errors.push('serialCssClass is required');
  if (!checkboxCssClass) errors.push('checkboxCssClass is required');
  if (!executionSequence || !Array.isArray(executionSequence) || executionSequence.length === 0) {
    errors.push('executionSequence must be a non-empty array');
  }

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  const status = engine.getStatus();
  if (status.state === 'RUNNING' || status.state === 'POLLING') {
    return res.status(409).json({ error: 'A run is already in progress', state: status.state });
  }

  // Parse poll intervals
  let parsedIntervals;
  if (pollIntervals && typeof pollIntervals === 'string') {
    parsedIntervals = pollIntervals.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  } else if (Array.isArray(pollIntervals)) {
    parsedIntervals = pollIntervals;
  }

  const config = {
    targetUrl,
    serialCssClass,
    checkboxCssClass,
    doneCssClass: doneCssClass || 'job-complete',
    executionSequence,
    pollIntervals: parsedIntervals || [2000, 5000, 5000],
    browserType: browserType || 'chromium',
    headless: headless !== undefined ? headless : false,
    recycleContext: recycleContext !== undefined ? recycleContext : true,
  };

  // Fire and forget — runs asynchronously
  engine.start(config).catch(err => {
    console.error('Engine error:', err);
  });

  res.json({
    message: 'Automation started',
    totalJobs: executionSequence.length,
    config: {
      targetUrl,
      serialCssClass,
      checkboxCssClass,
      doneCssClass: config.doneCssClass,
      sequenceLength: executionSequence.length,
    },
  });
});

// ─── API: STOP AUTOMATION ───────────────────────────────────
app.post('/api/stop', async (req, res) => {
  try {
    await engine.stop();
    res.json({ message: 'Stop signal sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: STATUS ────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json(engine.getStatus());
});

// ─── API: CLEAR PROGRESS ───────────────────────────────────
app.post('/api/clear-progress', (req, res) => {
  engine._clearProgress();
  res.json({ message: 'Progress cleared' });
});

// ─── API: PHASE 2 — START AUTO-POLLER ───────────────────────
app.post('/api/phase2/start', (req, res) => {
  const { targetUrl, serialCssClass, checkboxCssClass, doneCssClass, executionSequence, pollIntervals, browserType, headless, recycleContext } = req.body;

  const errors = [];
  if (!targetUrl)        errors.push('targetUrl is required');
  if (!serialCssClass)   errors.push('serialCssClass is required');
  if (!checkboxCssClass) errors.push('checkboxCssClass is required');
  if (!executionSequence || !Array.isArray(executionSequence) || executionSequence.length === 0) {
    errors.push('executionSequence must be a non-empty array');
  }

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  const status = engine.getStatus();
  if (status.phase2Active) {
    return res.status(409).json({ error: 'Phase 2 is already running' });
  }

  let parsedIntervals;
  if (pollIntervals && typeof pollIntervals === 'string') {
    parsedIntervals = pollIntervals.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  } else if (Array.isArray(pollIntervals)) {
    parsedIntervals = pollIntervals;
  }

  const config = {
    targetUrl,
    serialCssClass,
    checkboxCssClass,
    doneCssClass: doneCssClass || 'job-complete',
    executionSequence,
    pollIntervals: parsedIntervals || [2000, 5000, 5000],
    browserType: browserType || 'chromium',
    headless: headless !== undefined ? headless : false,
    recycleContext: recycleContext !== undefined ? recycleContext : true,
  };

  engine.startPhase2(config).catch(err => {
    console.error('Phase 2 error:', err);
  });

  res.json({ message: 'Phase 2 auto-poller started' });
});

// ─── API: PHASE 2 — STOP AUTO-POLLER ───────────────────────
app.post('/api/phase2/stop', (req, res) => {
  engine.stopPhase2();
  res.json({ message: 'Phase 2 stop signal sent' });
});

// ─── API: CRUD JOBS ──────────────────────────────────────────

const DEFAULT_JOBS = [
  { id:'EOD-001', name:'Equity Trade Settlement',       prio:'CRITICAL' },
  { id:'EOD-002', name:'Fixed Income Reconciliation',   prio:'HIGH'     },
  { id:'EOD-003', name:'FX Position Rollover',          prio:'HIGH'     },
  { id:'EOD-004', name:'Derivatives Mark-to-Market',    prio:'CRITICAL' },
  { id:'EOD-005', name:'Cash Ledger Sweep',             prio:'MEDIUM'   },
  { id:'EOD-006', name:'Collateral Margin Update',      prio:'HIGH'     },
  { id:'EOD-007', name:'Portfolio NAV Calculation',     prio:'CRITICAL' },
  { id:'EOD-008', name:'Risk Exposure Report',          prio:'HIGH'     },
  { id:'EOD-009', name:'Dividend Processing',           prio:'MEDIUM'   },
  { id:'EOD-010', name:'Corporate Actions Processing',  prio:'HIGH'     },
  { id:'EOD-011', name:'Trade Confirmation Matching',   prio:'HIGH'     },
  { id:'EOD-012', name:'Counterparty Netting',          prio:'MEDIUM'   },
  { id:'EOD-013', name:'Repo Agreement Rollover',       prio:'HIGH'     },
  { id:'EOD-014', name:'Futures Settlement',            prio:'HIGH'     },
  { id:'EOD-015', name:'Options Expiry Check',          prio:'MEDIUM'   },
  { id:'EOD-016', name:'Bond Coupon Accrual',           prio:'MEDIUM'   },
  { id:'EOD-017', name:'FX Spot Settlement',            prio:'HIGH'     },
  { id:'EOD-018', name:'Equity Dividend Recon',         prio:'MEDIUM'   },
  { id:'EOD-019', name:'Credit Risk Calculation',       prio:'CRITICAL' },
  { id:'EOD-020', name:'Liquidity Coverage Report',     prio:'HIGH'     },
  { id:'EOD-021', name:'Regulatory Position Report',    prio:'CRITICAL' },
  { id:'EOD-022', name:'Tax Lot Processing',            prio:'MEDIUM'   },
  { id:'EOD-023', name:'Performance Attribution',       prio:'LOW'      },
  { id:'EOD-024', name:'Benchmark Rebalance Check',     prio:'LOW'      },
  { id:'EOD-025', name:'End of Day Data Archive',       prio:'HIGH'     },
  { id:'EOD-026', name:'System Integrity Validation',   prio:'CRITICAL' }
];

function generateDurations(jobs, min = 8, max = 30, maxCount = 2) {
  const jobIds = jobs.map(j => j.id);
  const shuffled = [...jobIds].sort(() => Math.random() - 0.5);
  const maxIds = shuffled.slice(0, maxCount);
  
  return jobs.map(job => {
    const isMax = maxIds.includes(job.id);
    const durationMs = isMax ? (max * 1000) : Math.round((min + 3 + Math.random()) * 1000);
    return { ...job, status: 'pending', durationMs, isMax };
  });
}

app.get('/api/jobs', async (req, res) => {
  try {
    let jobs = await Job.find().sort({ _id: 1 });
    if (jobs.length === 0) {
      const initializedJobs = generateDurations(DEFAULT_JOBS);
      jobs = await Job.insertMany(initializedJobs);
    }
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/jobs/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const job = await Job.findOneAndUpdate({ id: req.params.id }, { status }, { new: true });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jobs/reset', async (req, res) => {
  try {
    const { min = 8, max = 30, maxCount = 2 } = req.body;
    await Job.deleteMany({});
    const newJobs = generateDurations(DEFAULT_JOBS, min, max, maxCount);
    const jobs = await Job.insertMany(newJobs);
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║   FM-Automate — JSP Job Automation Tool  ║`);
  console.log(`  ║   Server running on port ${PORT}            ║`);
  console.log(`  ║   UI: http://localhost:${PORT}              ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
