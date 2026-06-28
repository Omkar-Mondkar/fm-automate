// ═══════════════════════════════════════════════════════════════
//  FM-Automate — Playwright Automation Engine
//  Phase 1: Sequential job runner with polling
//  Phase 2: Infinite auto-poller wrapper
// ═══════════════════════════════════════════════════════════════
'use strict';

const { chromium, firefox, webkit } = require('playwright');
const path = require('path');
const fs   = require('fs');
const { EventEmitter } = require('events');

const DATA_DIR       = path.join(__dirname, 'data');
const PROGRESS_FILE  = path.join(DATA_DIR, 'progress.json');
const SESSION_FILE   = path.join(DATA_DIR, 'session.json');
const CONTEXT_RECYCLE_EVERY = 5;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── ENGINE STATE ─────────────────────────────────────────────
const EngineState = {
  IDLE:        'IDLE',
  RUNNING:     'RUNNING',
  POLLING:     'POLLING',
  RECYCLING:   'RECYCLING',
  COMPLETE:    'COMPLETE',
  ERROR:       'ERROR',
  STOPPING:    'STOPPING',
  PHASE2_WAITING: 'PHASE2_WAITING',
};

class AutomationEngine extends EventEmitter {
  constructor() {
    super();
    this.state       = EngineState.IDLE;
    this.browser     = null;
    this.context     = null;
    this.page        = null;
    this.config      = null;
    this.abortFlag   = false;
    this.phase2Active = false;
    this.phase2CycleCount = 0;
    this.completedInRun = 0;
    this.totalInRun = 0;
    this.runStartTime = null;
  }

  // ─── SSE EMIT HELPER ─────────────────────────────────────────
  _emit(eventType, data = {}) {
    const payload = {
      status: eventType,
      timestamp: new Date().toISOString(),
      ...data,
    };
    this.emit('sse', payload);
    const logLine = `[${payload.timestamp}] ${eventType}: ${data.message || JSON.stringify(data)}`;
    console.log(logLine);
  }

  // ─── PROGRESS LEDGER ─────────────────────────────────────────
  _loadProgress() {
    try {
      if (fs.existsSync(PROGRESS_FILE)) {
        return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
      }
    } catch (e) {
      console.warn('Failed to load progress.json, starting fresh:', e.message);
    }
    return { completedJobs: [], currentCycle: 1, lastUpdated: null, totalJobs: 0 };
  }

  _saveProgress(progress) {
    progress.lastUpdated = new Date().toISOString();
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf-8');
  }

  _clearProgress() {
    const fresh = { completedJobs: [], currentCycle: 1, lastUpdated: new Date().toISOString(), totalJobs: 0 };
    this._saveProgress(fresh);
    return fresh;
  }

  // ─── BROWSER CONTEXT MANAGEMENT ──────────────────────────────
  async _launchBrowser() {
    const browserType = (this.config && this.config.browserType) ? this.config.browserType : 'chromium';
    this._emit('INFO', { message: `Launching headless ${browserType}...` });

    const browserLauncher = { chromium, firefox, webkit }[browserType] || chromium;
    const isHeadless = this.config && this.config.headless !== undefined ? this.config.headless : false;

    this.browser = await browserLauncher.launch({
      headless: isHeadless,
      args: browserType === 'chromium' ? [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
      ] : [],
    });

    await this._createContext();
  }

  async _createContext() {
    const contextOpts = {};

    // Hydrate session if available
    if (fs.existsSync(SESSION_FILE)) {
      try {
        contextOpts.storageState = SESSION_FILE;
        this._emit('INFO', { message: 'Restoring session from session.json' });
      } catch (e) {
        this._emit('WARN', { message: 'Failed to restore session, starting fresh' });
      }
    }

    this.context = await this.browser.newContext(contextOpts);
    this.page = await this.context.newPage();

    // Set infinite timeouts
    this.page.setDefaultTimeout(0);
    this.page.setDefaultNavigationTimeout(0);

    // Block heavy resources to save memory
    await this.page.route('**/*', (route) => {
      const blocked = ['image', 'media', 'font'];
      if (blocked.includes(route.request().resourceType())) {
        return route.abort();
      }
      return route.continue();
    });

    // Auto-dismiss unexpected dialogs
    this.page.on('dialog', async (dialog) => {
      this._emit('WARN', { message: `Browser dialog auto-dismissed: "${dialog.message()}"` });
      try { await dialog.accept(); } catch (e) { /* already handled */ }
    });

    this._emit('INFO', { message: 'Browser context ready' });
  }

  async _recycleContext() {
    this._emit('CONTEXT_RECYCLED', {
      message: 'Recycling browser context to free memory...',
      completedCount: this.completedInRun,
    });

    // Save session state
    try {
      await this.context.storageState({ path: SESSION_FILE });
    } catch (e) {
      this._emit('WARN', { message: 'Failed to save session state during recycle' });
    }

    // Destroy old context
    try { await this.page.close(); } catch (e) { /* */ }
    try { await this.context.close(); } catch (e) { /* */ }

    // Create fresh context
    await this._createContext();

    // Re-navigate
    await this.page.goto(this.config.targetUrl, { waitUntil: 'domcontentloaded' });
    await this._injectHeartbeat();

    this._emit('INFO', { message: 'Context recycled, page reloaded' });
  }

  // ─── SESSION HEARTBEAT ────────────────────────────────────────
  async _injectHeartbeat() {
    const url = this.config.targetUrl;
    await this.page.evaluate((targetUrl) => {
      if (window.__jatHeartbeat) clearInterval(window.__jatHeartbeat);
      window.__jatHeartbeat = setInterval(() => {
        fetch(targetUrl, { method: 'HEAD', credentials: 'include' })
          .catch(() => {}); // Silently ignore errors
      }, 10 * 60 * 1000); // Every 10 minutes
    }, url);
  }

  // ─── PHASE 1: SEQUENTIAL RUN ─────────────────────────────────
  async start(config) {
    if (this.state === EngineState.RUNNING || this.state === EngineState.POLLING) {
      throw new Error('A run is already in progress');
    }

    this.config        = config;
    this.abortFlag     = false;
    this.state         = EngineState.RUNNING;
    this.runStartTime  = Date.now();
    this.completedInRun = 0;
    this.totalInRun    = config.executionSequence.length;

    this._emit('RUN_STARTED', {
      message: `Starting automation: ${this.totalInRun} jobs in sequence`,
      totalCount: this.totalInRun,
    });

    try {
      // Load progress for crash recovery
      const progress = this._loadProgress();
      const alreadyDone = new Set(progress.completedJobs);

      // Launch browser
      await this._launchBrowser();

      // Navigate to target
      this._emit('INFO', { message: `Navigating to ${config.targetUrl}` });
      await this.page.goto(config.targetUrl, { waitUntil: 'domcontentloaded' });

      // Wait a moment for dynamic content to render
      await this.page.waitForTimeout(2000);

      // Inject heartbeat
      await this._injectHeartbeat();

      this._emit('INFO', { message: 'Page loaded, heartbeat active. Beginning job sequence.' });

      // Process each job in sequence
      let contextJobCounter = 0;

      for (let i = 0; i < config.executionSequence.length; i++) {
        if (this.abortFlag) {
          this._emit('INFO', { message: 'Abort requested, stopping gracefully...' });
          this.state = EngineState.STOPPING;
          break;
        }

        const serial = config.executionSequence[i];

        // Skip already completed jobs (crash recovery)
        if (alreadyDone.has(serial)) {
          this.completedInRun++;
          this._emit('JOB_SKIPPED', {
            job: serial,
            index: i + 1,
            total: this.totalInRun,
            completedCount: this.completedInRun,
            message: `Skipping ${serial} — already completed (crash recovery)`,
          });
          continue;
        }

        // ─── LOCATE ROW ───
        this._emit('JOB_STARTED', {
          job: serial,
          index: i + 1,
          total: this.totalInRun,
          completedCount: this.completedInRun,
          message: `[${i + 1}/${this.totalInRun}] Locating job ${serial}...`,
        });

        // Stage 1: Find the serial number cell with exact text match
        const serialCell = this.page
          .locator(`.${config.serialCssClass}`)
          .filter({ hasText: new RegExp(`^${this._escapeRegex(serial)}$`) });

        // Verify exactly one match
        const serialCount = await serialCell.count();
        if (serialCount === 0) {
          this._emit('ERROR', {
            job: serial,
            fatal: false,
            message: `Serial "${serial}" not found on page — skipping`,
          });
          continue;
        }

        // Stage 2: Navigate up to the row, then down to the checkbox
        const row = serialCell.locator('xpath=ancestor::tr');
        const checkbox = row.locator(`.${config.checkboxCssClass}`);

        const cbCount = await checkbox.count();
        if (cbCount === 0) {
          this._emit('ERROR', {
            job: serial,
            fatal: false,
            message: `Checkbox not found in row for serial "${serial}" — skipping`,
          });
          continue;
        }

        // Check if already complete (e.g. page was refreshed)
        const currentClasses = await checkbox.getAttribute('class') || '';
        if (currentClasses.includes(config.doneCssClass || 'job-complete')) {
          this.completedInRun++;
          alreadyDone.add(serial);
          const prog = this._loadProgress();
          prog.completedJobs.push(serial);
          prog.totalJobs = this.totalInRun;
          this._saveProgress(prog);

          this._emit('JOB_COMPLETE', {
            job: serial,
            index: i + 1,
            total: this.totalInRun,
            completedCount: this.completedInRun,
            totalCount: this.totalInRun,
            durationMs: 0,
            message: `${serial} already complete on page — recorded`,
          });
          continue;
        }

        // ─── CLICK CHECKBOX ───
        this._emit('INFO', {
          job: serial,
          message: `Clicking checkbox for ${serial}...`,
        });

        // Use evaluate to programmatically check the box AND fire the change event.
        // Playwright's .click() can fail to trigger onchange handlers on some pages
        // (especially file:// protocol or legacy JSP apps with inline event handlers).
        await checkbox.evaluate((el) => {
          el.checked = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });

        // ─── POLL FOR COMPLETION ───
        this.state = EngineState.POLLING;
        const pollStart = Date.now();
        let pollCount = 0;

        const doneCls = config.doneCssClass || 'job-complete';
        const intervals = config.pollIntervals || [2000, 5000, 5000];

        // Custom polling loop (more control than expect.poll for SSE emission)
        let jobDone = false;
        while (!jobDone && !this.abortFlag) {
          // Calculate interval using backoff pattern
          const intervalIndex = Math.min(pollCount, intervals.length - 1);
          const waitMs = intervals[intervalIndex];

          await this.page.waitForTimeout(waitMs);
          pollCount++;

          // Check done state
          try {
            const cls = await checkbox.getAttribute('class') || '';
            jobDone = cls.includes(doneCls);
          } catch (e) {
            // Element may have been destroyed during a page refresh
            this._emit('WARN', {
              job: serial,
              message: `Poll error: ${e.message}. Retrying...`,
            });
          }

          const elapsed = Date.now() - pollStart;
          this._emit('POLLING', {
            job: serial,
            pollCount,
            elapsed,
            message: `Polling ${serial}: attempt #${pollCount}, ${(elapsed / 1000).toFixed(0)}s elapsed`,
          });
        }

        if (this.abortFlag) break;

        // ─── JOB COMPLETE ───
        const durationMs = Date.now() - pollStart;
        this.completedInRun++;
        contextJobCounter++;
        this.state = EngineState.RUNNING;

        // Persist to ledger
        alreadyDone.add(serial);
        const prog = this._loadProgress();
        prog.completedJobs.push(serial);
        prog.totalJobs = this.totalInRun;
        this._saveProgress(prog);

        this._emit('JOB_COMPLETE', {
          job: serial,
          index: i + 1,
          total: this.totalInRun,
          completedCount: this.completedInRun,
          totalCount: this.totalInRun,
          durationMs,
          message: `✓ ${serial} complete in ${(durationMs / 1000).toFixed(1)}s [${this.completedInRun}/${this.totalInRun}]`,
        });

        // ─── CONTEXT RECYCLE CHECK ───
        const isRecycleEnabled = this.config && this.config.recycleContext !== undefined ? this.config.recycleContext : true;
        if (isRecycleEnabled && contextJobCounter >= CONTEXT_RECYCLE_EVERY && i < config.executionSequence.length - 1) {
          this.state = EngineState.RECYCLING;
          await this._recycleContext();
          contextJobCounter = 0;
          this.state = EngineState.RUNNING;
        }
      }

      // ─── RUN COMPLETE ───
      const totalDurationMs = Date.now() - this.runStartTime;

      if (this.abortFlag) {
        this.state = EngineState.IDLE;
        this._emit('RUN_ABORTED', {
          completedCount: this.completedInRun,
          totalCount: this.totalInRun,
          totalDurationMs,
          message: `Run aborted after ${this.completedInRun}/${this.totalInRun} jobs (${(totalDurationMs / 1000).toFixed(0)}s)`,
        });
      } else {
        this.state = EngineState.COMPLETE;
        this._emit('RUN_COMPLETE', {
          completedCount: this.completedInRun,
          totalCount: this.totalInRun,
          totalDurationMs,
          message: `🎉 All ${this.completedInRun} jobs complete in ${(totalDurationMs / 1000).toFixed(0)}s`,
        });
      }

    } catch (err) {
      this.state = EngineState.ERROR;
      this._emit('ERROR', {
        fatal: true,
        message: `Fatal error: ${err.message}`,
      });
      console.error(err);
    } finally {
      await this._cleanup();
    }
  }

  // ─── PHASE 2: AUTO-POLLER ────────────────────────────────────
  async startPhase2(config) {
    if (this.phase2Active) {
      throw new Error('Phase 2 auto-poller is already running');
    }

    this.phase2Active = true;
    this.phase2CycleCount = 0;
    this.config = config;

    this._emit('PHASE2_STARTED', {
      message: 'Phase 2 auto-poller activated. Will run indefinitely.',
    });

    while (this.phase2Active) {
      this.phase2CycleCount++;

      this._emit('PHASE2_CYCLE', {
        cycleNumber: this.phase2CycleCount,
        status: 'STARTING',
        message: `Phase 2 — Cycle #${this.phase2CycleCount} starting`,
      });

      // Clear progress for the new cycle
      this._clearProgress();

      // Run Phase 1
      await this.start(config);

      if (!this.phase2Active) break;

      // Wait for page reset (new EOD cycle)
      this.state = EngineState.PHASE2_WAITING;
      this._emit('PHASE2_CYCLE', {
        cycleNumber: this.phase2CycleCount,
        status: 'WAITING_FOR_RESET',
        message: `Cycle #${this.phase2CycleCount} complete. Waiting for page reset (new EOD cycle)...`,
      });

      await this._waitForPageReset(config);
    }

    this._emit('PHASE2_STOPPED', {
      message: `Phase 2 stopped after ${this.phase2CycleCount} cycles`,
      cycleCount: this.phase2CycleCount,
    });
  }

  async _waitForPageReset(config) {
    // Re-launch browser if it was cleaned up
    if (!this.browser || !this.browser.isConnected()) {
      await this._launchBrowser();
      await this.page.goto(config.targetUrl, { waitUntil: 'domcontentloaded' });
    }

    const doneCls = config.doneCssClass || 'job-complete';
    const pollInterval = 60000; // Check every 60 seconds

    while (this.phase2Active) {
      await this.page.waitForTimeout(pollInterval);

      if (!this.phase2Active) break;

      try {
        // Reload to get fresh state
        await this.page.reload({ waitUntil: 'domcontentloaded' });
        await this.page.waitForTimeout(2000);

        // Check if all checkboxes are unchecked (no done class)
        const doneCount = await this.page.locator(`.${config.checkboxCssClass}.${doneCls}`).count();
        const procCount = await this.page.locator('tr.row-proc').count();

        this._emit('PHASE2_POLL', {
          message: `Phase 2 poll: ${doneCount} done checkboxes, ${procCount} processing rows`,
          doneCount,
          procCount,
        });

        // Fresh cycle detected: no completed jobs and no processing rows
        if (doneCount === 0 && procCount === 0) {
          this._emit('PHASE2_CYCLE', {
            cycleNumber: this.phase2CycleCount + 1,
            status: 'FRESH_CYCLE_DETECTED',
            message: 'Fresh cycle detected! All checkboxes reset. Starting new run...',
          });

          // Clean up browser before next cycle (start() will re-launch)
          await this._cleanup();
          break;
        }
      } catch (e) {
        this._emit('WARN', {
          message: `Phase 2 poll error: ${e.message}. Will retry...`,
        });
      }
    }
  }

  // ─── STOP / ABORT ─────────────────────────────────────────────
  async stop() {
    this.abortFlag = true;
    this.phase2Active = false;
    this._emit('INFO', { message: 'Stop requested...' });
  }

  stopPhase2() {
    this.phase2Active = false;
    this.abortFlag = true;
    this._emit('INFO', { message: 'Phase 2 auto-poller stop requested...' });
  }

  // ─── CLEANUP ──────────────────────────────────────────────────
  async _cleanup() {
    try {
      if (this.context) {
        try { await this.context.storageState({ path: SESSION_FILE }); } catch (e) { /* */ }
      }
      if (this.page)    try { await this.page.close(); }    catch (e) { /* */ }
      if (this.context) try { await this.context.close(); } catch (e) { /* */ }
      if (this.browser) try { await this.browser.close(); } catch (e) { /* */ }
    } catch (e) {
      console.error('Cleanup error:', e.message);
    }
    this.page    = null;
    this.context = null;
    this.browser = null;
  }

  // ─── STATUS ───────────────────────────────────────────────────
  getStatus() {
    return {
      state: this.state,
      completedCount: this.completedInRun,
      totalCount: this.totalInRun,
      phase2Active: this.phase2Active,
      phase2CycleCount: this.phase2CycleCount,
      config: this.config ? {
        targetUrl: this.config.targetUrl,
        sequenceLength: this.config.executionSequence?.length || 0,
      } : null,
    };
  }

  // ─── HELPERS ──────────────────────────────────────────────────
  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

module.exports = { AutomationEngine, EngineState };
