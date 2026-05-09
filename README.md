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

## Run all bots at once

```bash
./run-bots.sh
```

Opens 7 separate Terminal windows, one per bot:

| # | Platform | Command inside run-bots.sh |
|---|----------|---------------------------|
| 1 | Dice | `node dice-bot.js` |
| 2 | RobertHalf | `node roberthalf-bot.js` |
| 3 | MatlenSilver | `node matlensilver-bot.js` |
| 4 | Randstad-DS | `node randstad-ds-bot.js scrape` |
| 5 | Kforce | `node kforce-bot.js` |
| 6 | InsightGlobal | `node insightglobal-bot.js 240` |
| 7 | Collabera | `node collabera-bot.js 240` |

## Run bots individually

```bash
node Dice/dice-bot.js 240
node RobertHalf/roberthalf-bot.js 240
node MatlenSilver/matlensilver-bot.js 240
node Randstad-DS/randstad-ds-bot.js scrape
node Kforce/kforce-bot.js
node InsightGlobal/insightglobal-bot.js 240
node Collabera/collabera-bot.js 240
```

The number argument is how many minutes to run. Omit it to run until the queue is exhausted or Ctrl+C.

## Other bots (not yet in run-bots.sh)

These exist in the repo but are not launched by `run-bots.sh` yet:

| Platform | Command |
|----------|---------|
| Randstad | `node Randstad/randstad-bot.js` |
| Indeed | `node Indeed/indeed-bot.js` |
| Vaco | `node Vaco/vaco-bot.js` |
| Yoh | `node Yoh/yoh-bot.js` |
| S3Strategic | `node S3Strategic/s3-bot.js` |
| Brian (multi-ATS) | `node brian/multiats-bot.js` |

## Output files

Each bot writes to its own directory:

| File | Purpose |
|------|---------|
| `applied_jobs.txt` | Human-readable log with timestamps and job details |
| `applied_ids.txt` | Persistent ID list — prevents re-applying across sessions |
| `scanned_jobs.txt` | All jobs found this session |
| `failed_jobs.txt` | Jobs that failed or are uncertain |

These files are gitignored and stay local only.
