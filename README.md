# Job Bot

Automated job application suite using Playwright.

## Setup

```bash
git clone https://github.com/npraou-prog/job-bot.git
cd job-bot
npm install
npx playwright install chromium
```

## One-time login (required for Dice and RobertHalf)

```bash
node Dice/dice-bot.js login
node RobertHalf/roberthalf-bot.js login
```

Log in manually in the browser window that opens — the session is saved to disk.

## Run all bots

```bash
./run-bots.sh
```

Or run individually:

```bash
node Dice/dice-bot.js 240
node RobertHalf/roberthalf-bot.js 240
node Collabera/collabera-bot.js 240
node InsightGlobal/insightglobal-bot.js 240
node Kforce/kforce-bot.js
```
