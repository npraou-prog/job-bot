# Job Bot

Automated job application suite using Playwright. Applies to Data Scientist, ML Engineer, and related roles across multiple job platforms.

## Setup

```bash
git clone https://github.com/npraou-prog/job-bot.git
cd job-bot
npm install
npx playwright install chromium
```

## One-time login (required for Dice and RobertHalf only)

```bash
node Dice/dice-bot.js login
node RobertHalf/roberthalf-bot.js login
```

Log in manually in the browser window that opens — the session is saved to disk. All other bots apply as guest and need no login.

## Bot Status

| Bot | Folder | In run-bots.sh | Notes |
|-----|--------|:--------------:|-------|
| Dice | `Dice/` | ✅ | Requires one-time login |
| RobertHalf | `RobertHalf/` | ✅ | Requires one-time login |
| MatlenSilver | `MatlenSilver/` | ✅ | |
| Randstad-DS | `Randstad-DS/` | ✅ | |
| Kforce | `Kforce/` | ✅ | |
| InsightGlobal | `InsightGlobal/` | ✅ | |
| Collabera | `Collabera/` | ✅ | |
| S3Strategic | `S3Strategic/` | ✅ | |
| Randstad | `Randstad/` | ❌ | Not yet integrated |
| Indeed | `Indeed/` | ❌ | Not yet integrated |
| Vaco | `Vaco/` | ❌ | Not yet integrated |
| Yoh | `Yoh/` | ❌ | Not yet integrated |
| Brian (multi-ATS) | `brian/` | ❌ | Not yet integrated |
| TekSystems | `TekSystems/` | ❌ | Research phase only |

## Run all active bots

```bash
./run-bots.sh
```

Opens 8 separate Terminal windows (one per active bot).

## Run bots individually

```bash
node Dice/dice-bot.js 240
node RobertHalf/roberthalf-bot.js 240
node MatlenSilver/matlensilver-bot.js 240
node Randstad-DS/randstad-ds-bot.js scrape
node Kforce/kforce-bot.js
node InsightGlobal/insightglobal-bot.js 240
node Collabera/collabera-bot.js 240
node S3Strategic/s3-bot.js 240
```

The number argument is how many minutes to run. Omit it to run until the queue is exhausted or Ctrl+C.

## Output files

Each bot writes to its own directory:

| File | Purpose |
|------|---------|
| `applied_jobs.txt` | Human-readable log with timestamps and job details |
| `applied_ids.txt` | Persistent ID list — prevents re-applying across sessions |
| `scanned_jobs.txt` | All listings found each session |
| `failed_jobs.txt` | Jobs that failed or are uncertain |

These files are gitignored and stay local only.
