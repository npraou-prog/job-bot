# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Job Application Automation Suite — Node.js CLI tools that automate job applications on Dice.com and RobertHalf.com using Playwright browser automation with persistent sessions. A third bot for TekSystems is in the research phase.

## Running the Bots

No build step required. All bots run directly with Node.js.

```bash
# One-time login (saves authenticated browser session to disk)
node Dice/dice-bot.js login
node RobertHalf/roberthalf-bot.js login

# Run bot for N minutes
node Dice/dice-bot.js 240
node RobertHalf/roberthalf-bot.js 240
```

Syntax check only:
```bash
node --check Dice/dice-bot.js
```

## Architecture

Each bot follows the same pattern:

1. **Login mode** — Opens a headed Chromium browser, user logs in manually, session saved to `~/[service]-bot-profile`.
2. **Run mode** — Loads the saved session, spins up 4 parallel Playwright workers that share a job queue, scan search results, filter duplicates, and auto-apply.

**Worker loop per bot:**
- Scan search result pages for job listings
- Filter out already-applied job IDs (tracked in `applied_ids.txt`)
- Filter out non-matching titles
- Queue remaining jobs; workers process queue: click Apply → fill form → submit
- Refresh search every 90 seconds; stop after N minutes or Ctrl+C

**Output files (written to each bot's directory):**
| File | Purpose |
|------|---------|
| `applied_jobs.txt` | Human-readable log with timestamps & job details |
| `applied_ids.txt` | Persistent ID list for deduplication across sessions |
| `scanned_jobs.txt` | All jobs found this session |
| `failed_jobs.txt` | Jobs that failed or are uncertain; opened in browser at end |
| `report_TIMESTAMP.txt` | RobertHalf only; session summary |

A status JSON file under `~/.openclaw/workspace/` is written every 5 seconds for real-time monitoring.

## Configuration

All configuration is hardcoded at the top of each bot file:
- Search keywords/slugs (Data Scientist, ML Engineer roles)
- Filter parameters (24-hour posting window, remote/hybrid/onsite)
- 4 parallel workers, 8-second rate limit between applications per worker
- Page timeouts: 25–30 seconds
- Profile directories: `~/dice-bot-profile`, `~/roberthalf-bot-profile`

## Key Files

- `Dice/dice-bot.js` — Dice.com bot (~1100 lines)
- `Dice/dice_job_automation_agent.md` — Detailed spec: workflow, error handling, planned Telegram integration, logging format, retry policy
- `RobertHalf/roberthalf-bot.js` — RobertHalf.com bot (~1400 lines)
- `TekSystems/RESEARCH.md` — Technical analysis of Phenom People ATS for future TekSystems bot implementation

## Dependencies

Only two runtime dependencies:
- `playwright` (browser automation)
- Node.js built-ins: `fs`, `path`

No package.json, no build tools, no test framework.
