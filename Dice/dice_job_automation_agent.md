# how to run
watch -n 2 cat ~/.openclaw/workspace/worker_status.json
Status file (updates after every action, watch it in real time):

watch -n 2 cat ~/.openclaw/workspace/worker_status.json
Dashboard prints to terminal every 30 seconds automatically.

To run:
node /Users/nikhil/Desktop/DiceBot/dice-bot.js 30
node /Users/nikhil/Desktop/DiceBot/dice-bot.js 240


### 🤖 Dice Job Application Automation Agent — Full Instructions

> **Platform:** OpenClaw Automation  
> **Model:** `qwen2.5:7b` *(mandatory — do not switch models)*  
> **Target Site:** [https://www.dice.com](https://www.dice.com)  
> **Schedule:** Monday – Friday | 6:00 AM – 10:00 AM  
> **Mode:** Continuous loop with real-time job tracking  

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Pre-Flight Checklist](#pre-flight-checklist)
3. [Schedule & Cron Configuration](#schedule--cron-configuration)
4. [Core Automation Workflow](#core-automation-workflow)
5. [Loop Logic & New Job Detection](#loop-logic--new-job-detection)
6. [Application Flow — Step by Step](#application-flow--step-by-step)
7. [Error Handling & Recovery](#error-handling--recovery)
8. [Job Tracking & Monitoring](#job-tracking--monitoring)
9. [Telegram Integration](#telegram-integration)
10. [Sub-Agent Architecture](#sub-agent-architecture)
11. [Rules & Constraints](#rules--constraints)
12. [Markdown Log Format](#markdown-log-format)

---

## Overview

This agent automates job applications on **Dice.com** using the **Easy Apply** button. All application forms are pre-filled (resume already uploaded). The agent runs in a continuous loop from **6 AM to 10 AM, Monday through Friday**, scanning for new job postings, clicking Easy Apply, and submitting applications as fast as possible.

The agent must:
- Detect **new jobs** that appear during the 4-hour window
- Click **Easy Apply** on each new posting
- Handle the two-step modal (first click → new browser/tab → second click)
- Hit **Next** and **Submit** without modifying any pre-filled fields
- Close the tab after each submission
- Log every applied job to a tracking file
- Send status updates via **Telegram** when needed

---

## Pre-Flight Checklist

Before the cron job starts, verify all of the following:

- [ ] Dice.com account is logged in (session cookie is valid)
- [ ] Resume is already uploaded to the Dice profile
- [ ] All profile fields are pre-filled (name, email, phone, location, work auth)
- [ ] Browser profile/session is saved and reusable
- [ ] `qwen2.5:7b` model is loaded and accessible
- [ ] Telegram bot token and chat ID are configured
- [ ] Job tracking log file path is writable
- [ ] Search filters (keywords, location, job type) are pre-configured
- [ ] Internet connection is stable
- [ ] Target URL/search query is saved

---

## Schedule & Cron Configuration

### Cron Expression

```cron
0 6 * * 1-5 /path/to/run_agent.sh
```

- Starts at **6:00 AM sharp**
- Runs **Monday through Friday** (1–5)
- Agent self-terminates or is killed at **10:00 AM**

### Hard Stop Logic

---

## Core Automation Workflow

```
START (6:00 AM)
     │
     ▼
Load Dice.com search results page (pre-configured filters)
     │
     ▼
┌─── MAIN LOOP ─────────────────────────────────────────────┐
│                                                            │
│   1. Scan all visible job cards on page                    │
│   2. Filter: only jobs NOT already applied                 │
│   3. For each new job → run APPLICATION FLOW               │
│   4. Wait N seconds (configurable, e.g. 5–10 sec)         │
│   5. Refresh page / scroll to load new jobs               │
│   6. Repeat until 10:00 AM                                 │
│                                                            │
└────────────────────────────────────────────────────────────┘
     │
     ▼
STOP (10:00 AM) → Save log → Send Telegram summary
```

---

## Loop Logic & New Job Detection

### Job Deduplication

The agent must maintain an **in-memory set** AND a **persistent file** of all job IDs already applied to, so it never applies to the same job twice across restarts.

```python
applied_job_ids = load_applied_ids("applied_jobs.txt")  # load from file on start

def is_already_applied(job_id):
    return job_id in applied_job_ids

def mark_as_applied(job_id):
    applied_job_ids.add(job_id)
    append_to_file("applied_jobs.txt", job_id)
```

### Detecting New Jobs

On every loop iteration:
1. Collect all job card elements currently on page
2. Extract the unique **job ID** from each card (from URL, `data-id`, or `aria` attribute)
3. Compare against `applied_job_ids`
4. Queue all un-applied jobs for application

### Page Refresh Strategy

- Refresh the search results page **every 60–90 seconds** (configurable)
- After refresh, re-scan all cards
- New cards = cards with IDs not in `applied_job_ids`
- Do NOT navigate away from the search results between job applications — open each job in a **new tab**, apply, close the tab, return to search results

---

## Application Flow — Step by Step

For each new job discovered:

### Step 1 — Click Easy Apply on Search Results Page

```
Locate the [Easy Apply] button on the job card
  → Click it
  → A new browser tab/window opens automatically
```

**If the button is not found:**
- Skip this job
- Log: `SKIPPED — No Easy Apply button`
- Continue to next job

---

### Step 2 — Switch to New Tab

```
Switch browser focus to the newly opened tab
  → Wait for page to fully load (max 15 seconds)
  → Confirm URL contains dice.com job detail page
```

---

### Step 3 — Click Easy Apply Again (Inside Job Detail Page)

```
Locate the [Easy Apply] button on the job detail page
  → Click it
  → Application modal/drawer opens
```

---

### Step 4 — Navigate the Application Form

```
Form is pre-filled — do NOT modify any fields
  → Click [Next] button
  → If more pages/steps exist, keep clicking [Next]
  → On final page: Click [Submit]
```

**Important rules:**
- Never fill in, clear, or modify any pre-filled field
- If a required field appears empty: **pause → send Telegram alert → wait for response**
- If CAPTCHA appears: **pause → send Telegram alert → wait for response**

---

### Step 5 — Confirm Submission

```
Wait for success confirmation message (e.g., "Application Submitted!")
  → Log the job as successfully applied
  → Close the current tab
  → Return focus to the search results tab
```

**If no confirmation appears within 20 seconds:**
- Log: `UNCERTAIN — No confirmation received`
- Close tab anyway
- Continue loop

---

### Step 6 — Log & Continue

```
Write job details to tracking log
  → Increment counter
  → Continue to next job in queue
```

---

## Error Handling & Recovery

| Situation | Action |
|---|---|
| Easy Apply button not found | Skip job, log as SKIPPED, continue |
| New tab doesn't open | Retry once, then skip |
| Page load timeout (>15s) | Close tab, log as FAILED, continue |
| Form has unexpected empty required field | Pause, send Telegram alert, await reply |
| CAPTCHA detected | Pause, send Telegram alert, await reply |
| Submit button not found | Log as FAILED, close tab, continue |
| No confirmation message | Log as UNCERTAIN, close tab, continue |
| Browser crash | Restart browser, reload session, resume loop |
| Network error | Wait 30 seconds, retry same job |
| Session expired / logged out | Pause, send Telegram alert, await reply |
| 10:00 AM reached mid-application | Finish current application, then exit |

### Retry Policy

- Max **2 retries** per job before marking as FAILED
- Wait **5 seconds** between retries
- Never retry more than 2 times on the same job

---

## Job Tracking & Monitoring

### Real-Time Counter

The agent maintains a running count:

```
Total Scanned:    [N]
Applied:          [N]
Skipped:          [N]
Failed:           [N]
Uncertain:        [N]
```

This counter is printed/logged after every application attempt.

### Log File

All applied jobs are recorded in:

```
dice_applications_log.md
```

Format is defined in the [Markdown Log Format](#markdown-log-format) section below.

### Persistent ID Store

All applied job IDs are saved to:

```
applied_jobs.txt
```

One job ID per line. This file **persists between sessions** so duplicate applications never happen on future days.

---

## Telegram Integration

The agent sends messages to a configured Telegram chat for:

### Automatic Notifications

| Event | Message Sent |
|---|---|
| Session starts | `🟢 Dice Agent STARTED — [DATE] 6:00 AM` |
| Every 30 minutes | `📊 Status Update: Applied [N] jobs so far` |
| CAPTCHA detected | `🚨 CAPTCHA on job [TITLE] — Need help!` |
| Empty required field | `⚠️ Empty field detected on [TITLE] — Pausing` |
| Session expired | `🔐 Session expired — Please re-login` |
| Session ends | `🔴 Agent STOPPED — [DATE] 10:00 AM — Total Applied: [N]` |

### Receiving Instructions via Telegram

The agent polls the Telegram bot API for incoming messages every **10 seconds** while paused. When an instruction arrives:

- `resume` → Continue the loop
- `skip` → Skip current job, continue
- `stop` → Exit cleanly, save log
- `status` → Reply with current counts

### Configuration

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

---

## Sub-Agent Architecture

The agent may use sub-agents for parallel or specialized tasks:

### Sub-Agent: Job Scanner
- **Role:** Scans the search results page and extracts all new job IDs and titles
- **Runs:** Every loop iteration
- **Output:** List of `{job_id, job_title, company, easy_apply_available}`

### Sub-Agent: Application Handler
- **Role:** Handles the tab switching, form navigation, and submission for a single job
- **Runs:** Once per job
- **Input:** Job URL or job card element
- **Output:** `{status: "APPLIED" | "SKIPPED" | "FAILED" | "UNCERTAIN", timestamp}`

### Sub-Agent: Logger
- **Role:** Writes all results to the markdown log and the applied_jobs.txt file
- **Runs:** After each application attempt
- **Thread-safe:** Uses file locks

### Sub-Agent: Telegram Monitor
- **Role:** Polls Telegram for incoming commands and sends outgoing alerts
- **Runs:** In background / async thread
- **Priority:** High — can pause or stop the main loop

### Sub-Agent: Session Watchdog
- **Role:** Monitors if the browser session is still valid (checks for login page redirect)
- **Runs:** Every 5 minutes
- **Action on fail:** Pause main loop, alert via Telegram

---

## Rules & Constraints

### MUST DO

- ✅ Use **`qwen2.5:7b`** model — no exceptions
- ✅ Run **only Monday–Friday, 6 AM–10 AM**
- ✅ Track every job applied in the markdown log
- ✅ Never apply to the same job twice
- ✅ Always close the application tab after submitting
- ✅ Return focus to search results tab after each application
- ✅ Send Telegram alert for any situation requiring human input
- ✅ Save all logs before shutdown
- ✅ Respect the hard stop at 10:00 AM (finish current app, then exit)

### MUST NOT DO

- ❌ Do NOT modify any pre-filled application fields
- ❌ Do NOT submit an application without clicking the second Easy Apply button
- ❌ Do NOT apply to jobs outside the pre-configured search filters
- ❌ Do NOT run on weekends
- ❌ Do NOT continue running after 10:00 AM
- ❌ Do NOT switch to a different AI model
- ❌ Do NOT ignore CAPTCHA — always pause and alert
- ❌ Do NOT let the loop run faster than 5 seconds between applications (respect rate limits)

### Speed & Rate Limits

- Minimum **5 seconds** between successive Easy Apply clicks
- Recommended **8–10 seconds** per application cycle (to avoid detection)
- Page refresh interval: **60–90 seconds**
- Telegram polling interval: **10 seconds** (only when paused or monitoring)

---

## Markdown Log Format

The agent writes and maintains this file: `dice_applications_log.md`

### File Structure

```markdown
# Dice Job Applications Log

**Agent Model:** qwen2.5:7b  
**Platform:** OpenClaw Automation  
**Site:** Dice.com  

---

## Summary

| Date | Total Applied | Skipped | Failed | Uncertain |
|------|--------------|---------|--------|-----------|
| 2025-01-06 (Mon) | 42 | 3 | 1 | 2 |
| 2025-01-07 (Tue) | 38 | 5 | 0 | 1 |

---

## Session: 2025-01-06 | Monday | 6:00 AM – 10:00 AM

### ✅ Applied (42)

| # | Time | Job Title | Company | Job ID | Status |
|---|------|-----------|---------|--------|--------|
| 1 | 06:02:14 | Senior React Developer | Acme Corp | JOB-001 | APPLIED |
| 2 | 06:02:31 | Full Stack Engineer | Beta Inc | JOB-002 | APPLIED |
| ... | ... | ... | ... | ... | ... |

### ⏭️ Skipped (3)

| # | Time | Job Title | Company | Reason |
|---|------|-----------|---------|--------|
| 1 | 06:15:00 | Data Scientist | XYZ Ltd | No Easy Apply button |

### ❌ Failed (1)

| # | Time | Job Title | Company | Job ID | Reason |
|---|------|-----------|---------|--------|--------|
| 1 | 07:45:12 | DevOps Engineer | Cloud Co | JOB-099 | Page load timeout |

### ⚠️ Uncertain (2)

| # | Time | Job Title | Company | Job ID | Reason |
|---|------|-----------|---------|--------|--------|
| 1 | 08:10:05 | Backend Dev | Startup X | JOB-150 | No confirmation message |

---

## Session: 2025-01-07 | Tuesday | 6:00 AM – 10:00 AM

...
```

### Appending Rules

- Each new day gets a **new session block** appended to the bottom of the file
- The **Summary table** at the top is updated after each session ends
- Log entries are written **immediately** after each application attempt (not batched)
- File is **never overwritten** — only appended

---

## Quick Reference — Agent Startup Sequence

```
1. Load qwen2.5:7b model
2. Check is_within_window() → exit if false
3. Load applied_jobs.txt into memory
4. Open browser → navigate to Dice.com search results
5. Verify session is active (not redirected to login)
6. Send Telegram: "🟢 Agent STARTED"
7. Begin MAIN LOOP
8. At 10:00 AM → send Telegram: "🔴 Agent STOPPED — Total Applied: [N]"
9. Save all logs → exit
```

---

*Last updated: auto-generated by agent setup*  
*For questions, contact via Telegram during active session window*
