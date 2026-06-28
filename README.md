# FM-Automate — JSP Job Automation Tool

A lightweight Node.js + Playwright application that automates sequential EOD jobs on a JSP-based web page.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Install Playwright Chromium
npx playwright install chromium

# 3. Start the server
npm start

# 4. Open the control panel
# Navigate to http://localhost:3000
```

## How It Works

### Phase 1 — Semi-Manual (Start Button)

1. Configure the target URL, CSS class names, and job sequence in the control panel
2. Check the **PRE-EOD Check** checkbox to confirm prerequisites
3. Click **Start** → Review configuration in confirmation modal → **Confirm & Start**
4. The system:
   - Launches a headless Chromium browser
   - Navigates to the target JSP page
   - For each job in sequence: locates the row → clicks the checkbox → polls until done
   - Streams real-time progress via SSE to your browser
5. Monitor progress via the live log feed and progress bar

### Phase 2 — Auto-Poller (Infinite Loop)

After Phase 1 is verified stable, enable Phase 2:

1. Click **Phase 2: Auto** button
2. The system runs Phase 1, then polls every 60s for a page reset (new EOD cycle)
3. When a fresh cycle is detected, it automatically re-executes the full sequence
4. Runs indefinitely until manually stopped

## Configuration Reference

| Field | Description | Example |
|---|---|---|
| Target URL | The JSP page URL | `http://server/eod/manage.jsp` |
| Serial CSS Class | CSS class on serial number elements | `job-serial` |
| Checkbox CSS Class | CSS class on checkbox elements | `job-trigger` |
| Done CSS Class | CSS class added to checkbox when job completes | `job-complete` |
| Execution Sequence | Comma-separated serial numbers in desired order | `EOD-001, EOD-005, EOD-003, ...` |
| Poll Intervals (ms) | Backoff intervals for checking job completion | `2000, 5000, 5000` |

## Demo Mode

To test against the included sample portal:

1. Set Target URL to the full file path of `fm_sample_portal.html`  
   Example: `file:///e:/FM-Automate/fm_sample_portal.html`
2. Use default CSS classes (pre-filled)
3. Jobs will complete in 8-30 seconds (configurable in the portal's Settings tab)

## Architecture

```
Express.js (port 3000)
├── POST /api/start         → Launch Phase 1 automation
├── POST /api/stop          → Graceful abort
├── GET  /api/stream        → SSE telemetry stream
├── GET  /api/status        → Engine state
├── POST /api/clear-progress → Reset progress ledger
├── POST /api/phase2/start  → Start auto-poller
└── POST /api/phase2/stop   → Stop auto-poller
```

## Crash Recovery

The system maintains two files in the `data/` directory:

- **progress.json** — Records completed job serial numbers. On restart, already-completed jobs are skipped.
- **session.json** — Browser session state (cookies, localStorage). On restart, the session is restored without re-authentication.

## Requirements

- Node.js 18+
- Playwright (installed automatically via npm)
- The target JSP application must be accessible from the host machine
