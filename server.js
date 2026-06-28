// ═══════════════════════════════════════════════════════════════
//  FM-Automate — Express.js Server
//  API routes, SSE endpoint, static file serving
// ═══════════════════════════════════════════════════════════════
'use strict';

const express = require('express');
const path    = require('path');
const { AutomationEngine } = require('./automation');

const app    = express();
const PORT   = process.env.PORT || 3000;
const engine = new AutomationEngine();

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

// ─── START SERVER ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║   FM-Automate — JSP Job Automation Tool  ║`);
  console.log(`  ║   Server running on port ${PORT}            ║`);
  console.log(`  ║   UI: http://localhost:${PORT}              ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
