// ═══════════════════════════════════════════════════════════════
//  FM-Automate — Frontend JavaScript (v2 Dashboard)
//  EventSource consumer, view switching, form logic
// ═══════════════════════════════════════════════════════════════
'use strict';

const $ = (id) => document.getElementById(id);

/* ─── DOM REFS ─────────────────────────────────────────────── */
const DOM = {
  // Config
  cfgUrl:          $('cfg-url'),
  cfgSerialClass:  $('cfg-serial-class'),
  cfgCheckboxClass:$('cfg-checkbox-class'),
  cfgDoneClass:    $('cfg-done-class'),
  cfgSequence:     $('cfg-sequence'),
  cfgPollIntervals:$('cfg-poll-intervals'),
  cfgBrowser:      $('cfg-browser'),
  cfgHeadless:     $('cfg-headless'),
  cfgRecycle:      $('cfg-recycle'),

  // PRE-EOD
  preEodGate:      $('pre-eod-gate'),
  preEodNative:    $('pre-eod-native'),
  gateCheckbox:    $('gate-checkbox'),

  // Controls
  btnStart:        $('btn-start'),
  btnStop:         $('btn-stop'),
  btnPhase2:       $('btn-phase2'),
  btnClear:        $('btn-clear'),

  // Status
  statusChip:      $('status-chip'),
  statusDot:       $('status-dot'),
  statusText:      $('status-text'),
  sidebarDot:      $('sidebar-dot'),
  sidebarState:    $('sidebar-state'),

  // KPIs
  kpiCompleted:    $('kpi-completed'),
  kpiRemaining:    $('kpi-remaining'),
  kpiElapsed:      $('kpi-elapsed'),
  kpiCycles:       $('kpi-cycles'),

  // Progress
  progressPct:     $('progress-pct'),
  progressFill:    $('progress-fill'),
  progDone:        $('prog-done'),
  progTotal:       $('prog-total'),
  progCurrent:     $('prog-current'),

  // Phase 2
  phase2Bar:       $('phase2-bar'),
  phase2CycleNum:  $('phase2-cycle-num'),

  // Logs
  logTerminal:     $('log-terminal'),
  miniLog:         $('mini-log'),
  btnAutoScroll:   $('btn-autoscroll'),

  // Modal & Toast
  modalOverlay:    $('modal-confirm'),
  modalPreview:    $('modal-config-preview'),
  toastNotify:     $('toast-notify'),

  // Topbar
  topbarClock:     $('topbar-clock'),
  pageTitle:       $('page-title'),
  pageSubtitle:    $('page-subtitle'),
};

/* ─── APP STATE ────────────────────────────────────────────── */
let engineState    = 'IDLE';
let autoScroll     = true;
let sseSource      = null;
let runStartTime   = null;
let elapsedTimer   = null;
let phase2Active   = false;
let completedCount = 0;
let totalCount     = 0;

/* ─── VIEW SWITCHING ───────────────────────────────────────── */
const viewTitles = {
  dashboard: { title: 'Dashboard',     sub: 'Automation overview and controls' },
  config:    { title: 'Configuration', sub: 'Target application and CSS selectors' },
  logs:      { title: 'Logs',          sub: 'Live telemetry feed' },
};

function switchView(viewId, btnEl) {
  // Hide all views
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  // Show target
  const target = $('view-' + viewId);
  if (target) target.classList.add('active');

  // Update nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');

  // Update topbar
  const info = viewTitles[viewId] || {};
  DOM.pageTitle.textContent = info.title || viewId;
  DOM.pageSubtitle.textContent = info.sub || '';
}

/* ─── PRE-EOD ──────────────────────────────────────────────── */
function togglePreEod() {
  DOM.preEodNative.checked = !DOM.preEodNative.checked;
  DOM.preEodGate.classList.toggle('checked', DOM.preEodNative.checked);
  updateButtons();
}

/* ─── BUTTON STATE ─────────────────────────────────────────── */
function updateButtons() {
  const idle      = ['IDLE', 'COMPLETE', 'ERROR'].includes(engineState);
  const running   = ['RUNNING', 'POLLING', 'RECYCLING'].includes(engineState);
  const preEodOk  = DOM.preEodNative.checked;

  DOM.btnStart.disabled = !(idle && preEodOk) || phase2Active;
  DOM.btnStop.disabled  = !running && !phase2Active;
  DOM.btnClear.disabled = running;

  if (phase2Active) {
    DOM.btnPhase2.classList.add('active');
    DOM.btnPhase2.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg> Stop Phase 2';
  } else {
    DOM.btnPhase2.classList.remove('active');
    DOM.btnPhase2.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-6.219-8.56"/><path d="M21 3v5h-5"/></svg> Phase 2: Auto';
  }
}

/* ─── STATUS ───────────────────────────────────────────────── */
function setStatus(state) {
  engineState = state;

  const map = {
    IDLE:           { cls: '',        text: 'IDLE',       sidebar: 'Idle' },
    RUNNING:        { cls: 'running', text: 'RUNNING',    sidebar: 'Running' },
    POLLING:        { cls: 'polling', text: 'POLLING',    sidebar: 'Polling' },
    RECYCLING:      { cls: 'running', text: 'RECYCLING',  sidebar: 'Recycling' },
    COMPLETE:       { cls: 'complete',text: 'COMPLETE',   sidebar: 'Complete' },
    ERROR:          { cls: 'error',   text: 'ERROR',      sidebar: 'Error' },
    STOPPING:       { cls: 'polling', text: 'STOPPING',   sidebar: 'Stopping' },
    PHASE2_WAITING: { cls: 'polling', text: 'WAITING',    sidebar: 'Phase 2 Wait' },
  };

  const info = map[state] || map.IDLE;

  DOM.statusChip.className  = 'status-chip ' + info.cls;
  DOM.statusText.textContent = info.text;
  DOM.sidebarState.textContent = info.sidebar;

  DOM.sidebarDot.className = 'sidebar-status-dot';
  if (['RUNNING', 'POLLING', 'RECYCLING'].includes(state)) DOM.sidebarDot.classList.add('running');
  else if (state === 'COMPLETE') DOM.sidebarDot.classList.add('complete');
  else if (state === 'ERROR') DOM.sidebarDot.classList.add('error');

  updateButtons();
}

/* ─── CONFIG BUILDER ───────────────────────────────────────── */
function buildConfig() {
  const seqRaw = DOM.cfgSequence.value.trim();
  let sequence;
  try {
    sequence = seqRaw.startsWith('[') ? JSON.parse(seqRaw) : seqRaw.split(',').map(s => s.trim()).filter(Boolean);
  } catch { sequence = seqRaw.split(',').map(s => s.trim()).filter(Boolean); }

  const pollRaw = DOM.cfgPollIntervals.value.trim();
  const pollIntervals = pollRaw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

  return {
    targetUrl:        DOM.cfgUrl.value.trim(),
    serialCssClass:   DOM.cfgSerialClass.value.trim(),
    checkboxCssClass: DOM.cfgCheckboxClass.value.trim(),
    doneCssClass:     DOM.cfgDoneClass.value.trim(),
    executionSequence: sequence,
    pollIntervals:    pollIntervals.length > 0 ? pollIntervals : [2000, 5000, 5000],
    browserType:      DOM.cfgBrowser ? DOM.cfgBrowser.value : 'chromium',
    headless:         DOM.cfgHeadless ? DOM.cfgHeadless.value === 'true' : false,
    recycleContext:   DOM.cfgRecycle ? DOM.cfgRecycle.value === 'true' : true,
  };
}

function saveConfig() {
  const cfg = {
    url: DOM.cfgUrl.value,
    serial: DOM.cfgSerialClass.value,
    checkbox: DOM.cfgCheckboxClass.value,
    done: DOM.cfgDoneClass.value,
    seq: DOM.cfgSequence.value,
    poll: DOM.cfgPollIntervals.value,
    browser: DOM.cfgBrowser ? DOM.cfgBrowser.value : 'chromium',
    headless: DOM.cfgHeadless ? DOM.cfgHeadless.value : 'false',
    recycle: DOM.cfgRecycle ? DOM.cfgRecycle.value : 'true'
  };
  localStorage.setItem('fmAutoConfig', JSON.stringify(cfg));
  
  if (DOM.toastNotify) {
    DOM.toastNotify.classList.add('show');
    setTimeout(() => DOM.toastNotify.classList.remove('show'), 2000);
  }
}

function loadConfig() {
  try {
    const saved = localStorage.getItem('fmAutoConfig');
    if (saved) {
      const cfg = JSON.parse(saved);
      if (cfg.url) DOM.cfgUrl.value = cfg.url;
      if (cfg.serial) DOM.cfgSerialClass.value = cfg.serial;
      if (cfg.checkbox) DOM.cfgCheckboxClass.value = cfg.checkbox;
      if (cfg.done) DOM.cfgDoneClass.value = cfg.done;
      if (cfg.seq) DOM.cfgSequence.value = cfg.seq;
      if (cfg.poll) DOM.cfgPollIntervals.value = cfg.poll;
      if (cfg.browser && DOM.cfgBrowser) DOM.cfgBrowser.value = cfg.browser;
      if (cfg.headless && DOM.cfgHeadless) DOM.cfgHeadless.value = cfg.headless;
      if (cfg.recycle && DOM.cfgRecycle) DOM.cfgRecycle.value = cfg.recycle;
    }
  } catch (e) {
    console.error('Failed to load config from localStorage', e);
  }
}

function validateConfig(cfg) {
  const err = [];
  if (!cfg.targetUrl) err.push('Target URL is required');
  if (!cfg.serialCssClass) err.push('Serial CSS Class is required');
  if (!cfg.checkboxCssClass) err.push('Checkbox CSS Class is required');
  if (!cfg.executionSequence?.length) err.push('Execution sequence is empty');
  return err;
}

/* ─── START ────────────────────────────────────────────────── */
function handleStart() {
  const cfg = buildConfig();
  const err = validateConfig(cfg);
  if (err.length) return alert('Configuration errors:\n\n' + err.join('\n'));
  showConfirmModal(cfg);
}

function showConfirmModal(cfg) {
  DOM.modalPreview.innerHTML =
    `<span class="cfg-key">URL:</span> <span class="cfg-val">${escapeHtml(cfg.targetUrl)}</span>\n` +
    `<span class="cfg-key">Serial:</span> <span class="cfg-val">.${cfg.serialCssClass}</span>\n` +
    `<span class="cfg-key">Checkbox:</span> <span class="cfg-val">.${cfg.checkboxCssClass}</span>\n` +
    `<span class="cfg-key">Done:</span> <span class="cfg-val">.${cfg.doneCssClass}</span>\n` +
    `<span class="cfg-key">Jobs:</span> <span class="cfg-val">${cfg.executionSequence.length} (${cfg.executionSequence[0]} → ${cfg.executionSequence[cfg.executionSequence.length - 1]})</span>`;
  DOM.modalOverlay.classList.add('open');
}

function closeConfirmModal() { DOM.modalOverlay.classList.remove('open'); }

async function confirmAndStart() {
  closeConfirmModal();
  const cfg = buildConfig();
  try {
    const res = await fetch('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    const data = await res.json();
    if (!res.ok) return alert('Failed: ' + (data.error || 'Unknown'));

    totalCount = cfg.executionSequence.length;
    completedCount = 0;
    DOM.progTotal.textContent = totalCount;
    DOM.kpiRemaining.textContent = totalCount;
    setStatus('RUNNING');
    startElapsedTimer();
    connectSSE();

    // Switch to dashboard if on config
    switchView('dashboard', $('nav-dashboard'));
  } catch (e) { alert('Network error: ' + e.message); }
}

/* ─── STOP ─────────────────────────────────────────────────── */
async function handleStop() {
  try {
    if (phase2Active) {
      await fetch('/api/phase2/stop', { method: 'POST' });
      phase2Active = false;
      DOM.phase2Bar.classList.remove('visible');
    } else {
      await fetch('/api/stop', { method: 'POST' });
    }
    setStatus('STOPPING');
  } catch (e) { console.error(e); }
}

/* ─── PHASE 2 ──────────────────────────────────────────────── */
async function handlePhase2() {
  if (phase2Active) {
    try {
      await fetch('/api/phase2/stop', { method: 'POST' });
      phase2Active = false;
      DOM.phase2Bar.classList.remove('visible');
      updateButtons();
    } catch (e) { console.error(e); }
    return;
  }

  const cfg = buildConfig();
  const err = validateConfig(cfg);
  if (err.length) return alert('Configuration errors:\n\n' + err.join('\n'));
  if (!DOM.preEodNative.checked) return alert('PRE-EOD check must be confirmed first.');

  try {
    const res = await fetch('/api/phase2/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    const data = await res.json();
    if (!res.ok) return alert('Failed: ' + (data.error || 'Unknown'));

    phase2Active = true;
    totalCount = cfg.executionSequence.length;
    DOM.phase2Bar.classList.add('visible');
    DOM.progTotal.textContent = totalCount;
    setStatus('RUNNING');
    startElapsedTimer();
    connectSSE();
    switchView('dashboard', $('nav-dashboard'));
  } catch (e) { alert('Network error: ' + e.message); }
}

/* ─── CLEAR PROGRESS ───────────────────────────────────────── */
async function handleClearProgress() {
  try {
    await fetch('/api/clear-progress', { method: 'POST' });
    appendLog('INFO', 'Progress cleared — fresh start on next run');
  } catch (e) { console.error(e); }
}

/* ─── SSE ──────────────────────────────────────────────────── */
function connectSSE() {
  if (sseSource) sseSource.close();
  sseSource = new EventSource('/api/stream');
  sseSource.onmessage = (e) => { try { handleSSE(JSON.parse(e.data)); } catch (x) { console.error(x); } };
  sseSource.onerror   = () => appendLog('WARN', 'SSE connection lost. Reconnecting...');
}

function handleSSE(d) {
  switch (d.status) {
    case 'CONNECTED':
      appendLog('INFO', 'Connected to telemetry stream');
      if (d.engineState?.state && d.engineState.state !== 'IDLE') setStatus(d.engineState.state);
      break;
    case 'RUN_STARTED':
      setStatus('RUNNING');
      totalCount = d.totalCount || 0;
      DOM.progTotal.textContent = totalCount;
      DOM.kpiRemaining.textContent = totalCount;
      appendLog('STARTED', d.message);
      break;
    case 'INFO':
      appendLog('INFO', d.message);
      break;
    case 'WARN':
      appendLog('WARN', d.message);
      break;
    case 'JOB_STARTED':
      setStatus('RUNNING');
      DOM.progCurrent.textContent = d.job || '—';
      appendLog('STARTED', d.message);
      break;
    case 'POLLING':
      setStatus('POLLING');
      if (d.pollCount <= 3 || d.pollCount % 5 === 0) appendLog('POLLING', d.message);
      break;
    case 'JOB_COMPLETE':
      setStatus('RUNNING');
      updateProgress(d.completedCount, d.totalCount);
      appendLog('COMPLETE', d.message);
      break;
    case 'JOB_SKIPPED':
      updateProgress(d.completedCount, d.totalCount);
      appendLog('SKIPPED', d.message);
      break;
    case 'CONTEXT_RECYCLED':
      appendLog('RECYCLED', d.message);
      break;
    case 'ERROR':
      if (d.fatal) setStatus('ERROR');
      appendLog('ERROR', d.message);
      break;
    case 'RUN_COMPLETE':
      setStatus('COMPLETE');
      updateProgress(d.completedCount, d.totalCount);
      stopElapsedTimer();
      appendLog('COMPLETE', d.message);
      break;
    case 'RUN_ABORTED':
      setStatus('IDLE');
      stopElapsedTimer();
      appendLog('WARN', d.message);
      break;
    case 'PHASE2_STARTED':
      appendLog('PHASE2', d.message);
      break;
    case 'PHASE2_CYCLE':
      DOM.phase2CycleNum.textContent = d.cycleNumber || 0;
      DOM.kpiCycles.textContent = d.cycleNumber || 0;
      appendLog('PHASE2', d.message);
      break;
    case 'PHASE2_POLL':
      appendLog('PHASE2', d.message);
      break;
    case 'PHASE2_STOPPED':
      phase2Active = false;
      DOM.phase2Bar.classList.remove('visible');
      setStatus('IDLE');
      stopElapsedTimer();
      appendLog('PHASE2', d.message);
      break;
    default:
      appendLog('INFO', d.message || JSON.stringify(d));
  }
}

/* ─── PROGRESS ─────────────────────────────────────────────── */
function updateProgress(done, total) {
  completedCount = done;
  totalCount = total;
  DOM.progDone.textContent  = done;
  DOM.progTotal.textContent = total;
  DOM.kpiCompleted.textContent = done;
  DOM.kpiRemaining.textContent = Math.max(0, total - done);

  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  DOM.progressPct.textContent  = pct + '%';
  DOM.progressFill.style.width = pct + '%';
}

/* ─── ELAPSED ──────────────────────────────────────────────── */
function startElapsedTimer() {
  runStartTime = Date.now();
  stopElapsedTimer();
  elapsedTimer = setInterval(() => {
    const ms = Date.now() - runStartTime;
    const m  = Math.floor(ms / 60000);
    const s  = Math.floor((ms % 60000) / 1000);
    const str = `${m}:${s.toString().padStart(2, '0')}`;
    DOM.kpiElapsed.textContent = str;
  }, 1000);
}

function stopElapsedTimer() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; } }

/* ─── LOG ──────────────────────────────────────────────────── */
function appendLog(tag, message) {
  const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const cls = tag.toLowerCase();

  const html = `<div class="log-entry"><span class="log-time">${now}</span><span class="log-tag ${cls}">[${tag}]</span><span class="log-msg">${escapeHtml(message)}</span></div>`;

  // Full log
  const ph = DOM.logTerminal.querySelector('.log-placeholder');
  if (ph) ph.remove();
  DOM.logTerminal.insertAdjacentHTML('beforeend', html);
  while (DOM.logTerminal.children.length > 500) DOM.logTerminal.removeChild(DOM.logTerminal.firstChild);
  if (autoScroll) DOM.logTerminal.scrollTop = DOM.logTerminal.scrollHeight;

  // Mini log
  const mph = DOM.miniLog.querySelector('.log-placeholder');
  if (mph) mph.remove();
  DOM.miniLog.insertAdjacentHTML('beforeend', html);
  while (DOM.miniLog.children.length > 8) DOM.miniLog.removeChild(DOM.miniLog.firstChild);
  DOM.miniLog.scrollTop = DOM.miniLog.scrollHeight;
}

function clearLogs() {
  DOM.logTerminal.innerHTML = '<div class="log-placeholder">Log cleared</div>';
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  DOM.btnAutoScroll.classList.toggle('active', autoScroll);
}

function escapeHtml(s) { return s ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''; }

/* ─── CLOCK ────────────────────────────────────────────────── */
setInterval(() => { DOM.topbarClock.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false }); }, 1000);

/* ─── INIT ─────────────────────────────────────────────────── */
(function init() {
  loadConfig();
  
  // Attach saveConfig to inputs
  const inputs = [DOM.cfgUrl, DOM.cfgSerialClass, DOM.cfgCheckboxClass, DOM.cfgDoneClass, DOM.cfgSequence, DOM.cfgPollIntervals, DOM.cfgBrowser, DOM.cfgHeadless, DOM.cfgRecycle];
  inputs.forEach(el => {
    if (el) el.addEventListener('change', saveConfig);
  });

  updateButtons();
  connectSSE();

  fetch('/api/status').then(r => r.json()).then(d => {
    if (d.state && d.state !== 'IDLE') {
      setStatus(d.state);
      if (d.completedCount > 0) updateProgress(d.completedCount, d.totalCount);
      if (d.phase2Active) {
        phase2Active = true;
        DOM.phase2Bar.classList.add('visible');
        DOM.phase2CycleNum.textContent = d.phase2CycleCount || 0;
      }
      startElapsedTimer();
    }
  }).catch(() => {});
})();
