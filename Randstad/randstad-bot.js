#!/usr/bin/env node
/**
 * Randstad USA Job Application Bot — 4 Parallel Workers
 *
 * ATS: Randstad proprietary (login-gated, Short Apply + full apply flows)
 * Requires login: user logs in once via headed browser, session saved to profile dir.
 *
 * RUN:  node randstad-bot.js login        ← save session
 *       node randstad-bot.js 240          ← run for 240 minutes
 *       node --check randstad-bot.js      ← syntax check only
 */

'use strict';

const { chromium } = require('playwright');
const fs            = require('fs');
const path          = require('path');
const readline      = require('readline');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const HOME_DIR       = process.env.HOME || process.env.USERPROFILE || '';
const PROFILE_DIR    = path.join(HOME_DIR, 'randstad-bot-profile');
const APPLIED_IDS    = path.join(PROFILE_DIR, 'applied_ids.txt');

const WORKSPACE_DIR  = path.join(HOME_DIR, '.openclaw', 'workspace');
const STATUS_FILE    = path.join(WORKSPACE_DIR, 'randstad_worker_status.json');

const OUTPUT_DIR     = path.join(__dirname);   // /Users/nikhil/Desktop/Jobs/Randstad/
const SCANNED_FILE   = path.join(OUTPUT_DIR, 'scanned_jobs.txt');
const APPLIED_FILE   = path.join(OUTPUT_DIR, 'applied_jobs.txt');
const FAILED_FILE    = path.join(OUTPUT_DIR, 'failed_jobs.txt');

const NUM_WORKERS    = 4;
const RATE_LIMIT_MS  = 8000;    // ms between applications per worker
const PAGE_TIMEOUT   = 30000;   // ms
const MAX_RETRIES    = 2;

// User details
const USER_FIRST     = 'Nikhil';
const USER_LAST      = 'Premachandra rao';
const USER_FULL      = 'Nikhil Premachandra rao';
const USER_EMAIL     = 'Npraou@gmail.com';
const RESUME_PATH    = (() => {
  const candidates = [
    path.join(__dirname, 'resume.pdf'),
    path.join(__dirname, 'Nikhil_Resume.pdf'),
    path.join(__dirname, '..', 'resume.pdf'),
    path.join(__dirname, '..', 'Nikhil_Resume.pdf'),
    path.join(process.env.HOME || '', 'Desktop', 'Jobs', 'Nikhil_Resume.pdf'),
  ];
  return candidates.find(p => { try { return require('fs').existsSync(p); } catch(_){} }) || candidates[0];
})();
const PROFILE = { resumePath: RESUME_PATH };
const COVER_PATH     = path.join(__dirname, '..', 'Nikhil_Rao_Cover_Letter.pdf');

const COVER_TEXT = `Dear Hiring Manager,

I am writing to express my interest in this position. I am a Data Scientist and Machine Learning Engineer with strong expertise in Python, statistical modeling, NLP, and deploying production ML systems. I am confident my background aligns well with your needs. Please find my resume attached for your review.

I would welcome the opportunity to discuss how my skills can contribute to your team.

Best regards,
Nikhil Premachandra Rao`;

// Search URLs to scan
const SCAN_URLS = [
  'https://www.randstadusa.com/jobs/q-data-sceince/',
  'https://www.randstadusa.com/jobs/q-ai/',
];

// Search keyword slugs → /jobs/q-{slug}/ (used by run mode)
const SEARCH_QUERIES = [
  'data-scientist',
  'machine-learning-engineer',
  'data-engineer',
  'data-analyst',
  'ai-engineer',
  'nlp-engineer',
  'mlops',
  'analytics-engineer',
  'machine-learning',
  'artificial-intelligence-engineer',
];

// Title filter — case insensitive. Jobs NOT matching are skipped.
const TITLE_FILTER = /data scientist|machine learning|ml engineer|data engineer|data analyst|ai engineer|nlp|mlops|analytics engineer/i;

// Randstad base URLs
const BASE_URL       = 'https://www.randstadusa.com';
const LOGIN_URL      = 'https://www.randstadusa.com/login';

// ─── SHARED STATE ─────────────────────────────────────────────────────────────

let _shouldStop  = false;
let MAX_JOBS = Infinity;
let _sigintCount = 0;

process.on('SIGINT', () => {
  _sigintCount++;
  if (_sigintCount >= 2) { console.log('\nForce exiting.'); process.exit(1); }
  _shouldStop = true;
  console.log('\n[!] Stopping after current job — failed jobs will open in browser. (Ctrl+C again to force quit)');
});

const stats = { applied: 0, skipped: 0, failed: 0, uncertain: 0, total: 0 };

const sessionFailedUrls = new Set();

const workerStatus = {};
for (let i = 1; i <= NUM_WORKERS; i++) {
  workerStatus[`W${i}`] = { state: 'IDLE', job: '', lastUpdate: '' };
}

let jobQueue   = [];
let queueIndex = 0;

function getNextJob() {
  if (queueIndex < jobQueue.length) return jobQueue[queueIndex++];
  return null;
}

// ─── FILE HELPERS ─────────────────────────────────────────────────────────────

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadAppliedJobs() {
  ensureDir(APPLIED_IDS);
  if (!fs.existsSync(APPLIED_IDS)) { fs.writeFileSync(APPLIED_IDS, ''); return new Set(); }
  return new Set(
    fs.readFileSync(APPLIED_IDS, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  );
}

function markApplied(jobId) {
  ensureDir(APPLIED_IDS);
  fs.appendFileSync(APPLIED_IDS, jobId + '\n');
}

// ─── DATE FILTER — only jobs posted within 48 hours ──────────────────────────

function isWithin24Hours(postedText) {
  if (!postedText) return true; // unknown — let through
  const t = postedText.toLowerCase().trim();

  // Relative time strings Randstad uses
  if (t.includes('just now') || t.includes('today')) return true;
  if (/\d+\s*(minute|hour)s?\s+ago/i.test(t)) return true;
  if (/^[12]\s+days?\s+ago$/i.test(t)) return true;
  if (/\b([3-9]|\d{2,})\s+days?\s+ago\b/i.test(t)) return false;
  if (t.includes('week') || t.includes('month') || t.includes('year')) return false;

  // Absolute date strings "may 6, 2026" / "May 8, 2026" etc.
  const m = t.match(/([a-z]+\s+\d{1,2},?\s*\d{4})/i);
  if (m) {
    const parsed = new Date(m[1]);
    if (!isNaN(parsed.getTime())) {
      const diffDays = Math.floor((Date.now() - parsed.getTime()) / 86400000);
      return diffDays <= 1; // today or yesterday
    }
  }
  return true; // unknown format — let through
}

// ─── EXTRACT JOBS FROM SEARCH PAGE ───────────────────────────────────────────
//
// Randstad search pages: /jobs/q-{keyword}/
// Job card structure (server-rendered):
//   <article> or <li> with a link to /jobs/{sector}/{id}/{slug}/
//   Posted date in an element with class containing "date" or "posted"
//
// Job ID is the numeric segment in the URL: /jobs/4/1102792/data-scientist_.../
//                                                           ^^^^^^^ this

async function extractJobsFromPage(page) {
  return page.evaluate((baseUrl) => {
    const map = {};
    const links = Array.from(document.querySelectorAll('a[href*="/jobs/"]'));

    for (const a of links) {
      const href = (a.href || '').split('?')[0];
      const m = href.match(/\/jobs\/(\d+)\/(\d+)\/([^/]+)\/?$/);
      if (!m) continue;
      const sectorId = m[1];
      const jobId    = m[2];
      const slug     = m[3];
      const url      = `${baseUrl}/jobs/${sectorId}/${jobId}/${slug}/`;
      if (map[jobId]) continue;

      // Walk up to card — broad selector, fall back to closest div
      const card = a.closest(
        'article, li, [class*="job"], [class*="result"], [class*="card"], ' +
        '[class*="listing"], [class*="vacancy"], section, div[data-job-id], div[data-id]'
      ) || a.closest('div') || a.parentElement;

      // Title
      let title = '';
      if (card) {
        const heading = card.querySelector('h1, h2, h3, h4, [class*="title"], [class*="name"]');
        if (heading) title = heading.textContent.trim();
      }
      if (!title) title = a.textContent.trim();

      // Date — Randstad uses "posted may 6, 2026" in card text
      let posted = '';
      const cardText = card ? (card.innerText || '') : '';

      // 1. Try dedicated date element
      if (card) {
        const dateEl = card.querySelector('[class*="date"], [class*="posted"], time, [datetime]');
        if (dateEl) posted = dateEl.getAttribute('datetime') || dateEl.textContent.trim();
      }

      // 2. "posted [month] [day], [year]" — extract just the date part
      if (!posted) {
        const pm = cardText.match(/posted\s+([a-z]+\s+\d{1,2},?\s*\d{4})/i);
        if (pm) posted = pm[1];
      }

      // 3. Relative time strings
      if (!posted) {
        const rm = cardText.match(/(\d+\s+(?:minute|hour|day|week|month)s?\s+ago|today|just now|yesterday)/i);
        if (rm) posted = rm[0];
      }

      map[jobId] = { id: jobId, sectorId, slug, title, posted, url };
    }

    return Object.values(map).filter(j => j.url);
  }, BASE_URL);
}

// ─── SCAN FOR JOBS ────────────────────────────────────────────────────────────

async function scanForJobs(page, appliedJobs) {
  const toApply  = [];
  const allSeen  = [];
  const seenIds  = new Set();

  for (const query of SEARCH_QUERIES) {
    if (_shouldStop) break;

    const keyword = query.replace(/-/g, ' ');
    console.log(`\n[S] Scanning: "${keyword}"`);

    // Randstad paginates via ?start=N (0-based, 25 per page) or path /page-N/
    // Try up to 4 pages per keyword (100 jobs max per keyword)
    let pageNum    = 1;
    let totalNew   = 0;
    let totalOld   = 0;

    while (true) {
      // Build paginated URL: /jobs/q-{keyword}/ for page 1, /jobs/q-{keyword}/page-2/ etc.
      const searchUrl = pageNum === 1
        ? `${BASE_URL}/jobs/q-${query}/`
        : `${BASE_URL}/jobs/q-${query}/page-${pageNum}/`;

      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        await page.waitForTimeout(2500);

        // Check for no results
        const noJobs = await page.evaluate(() => {
          const body = (document.body && document.body.innerText
            ? document.body.innerText.toLowerCase()
            : '');
          return (
            body.includes('no jobs found') ||
            body.includes('no results found') ||
            body.includes('0 jobs') ||
            body.includes('sorry, no') ||
            body.includes('there are no job')
          );
        }).catch(() => false);

        if (noJobs) {
          if (pageNum === 1) console.log(`   [x] No results for "${keyword}" — skipping`);
          else console.log(`   [x] Page ${pageNum}: end of results`);
          break;
        }

        const jobs = await extractJobsFromPage(page);
        if (jobs.length === 0) {
          if (pageNum > 1) console.log(`   [x] Page ${pageNum}: no job cards — stopping`);
          break;
        }

        const newOnPage = jobs.filter(j => !seenIds.has(j.id));
        if (pageNum > 1 && newOnPage.length === 0) break;

        for (const job of jobs) {
          if (seenIds.has(job.id)) continue;
          seenIds.add(job.id);
          allSeen.push(job);

          if (appliedJobs.has(job.id)) {
            console.log(`   [dup] Already applied — skip ${job.id}`);
            continue;
          }

          // Title filter
          if (!TITLE_FILTER.test(job.title)) {
            console.log(`   [title] Filtered out: "${job.title}"`);
            continue;
          }

          // Date filter
          if (!isWithin24Hours(job.posted)) {
            totalOld++;
            continue;
          }

          toApply.push({ id: job.id, url: job.url, title: job.title || job.id, posted: job.posted });
          totalNew++;
        }

        console.log(`   Page ${pageNum}: ${jobs.length} cards | ${newOnPage.length} new | queued so far: ${totalNew}`);

        // Stop paginating after 4 pages per keyword — most fresh jobs appear on page 1
        if (pageNum >= 4) break;
        pageNum++;

      } catch (err) {
        console.error(`   [!] Page ${pageNum} error: ${err.message}`);
        break;
      }
    }

    console.log(`   [ok] "${keyword}": ${totalNew} queued | ${totalOld} >24h skipped`);
  }

  _writeScannedJobs(allSeen, new Set(toApply.map(j => j.id)), appliedJobs);
  return toApply;
}

// ─── SCANNED JOBS FILE ────────────────────────────────────────────────────────

function _writeScannedJobs(all, queuedIds, appliedJobs) {
  ensureDir(SCANNED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  const lines = [
    '='.repeat(80),
    `RANDSTAD SCAN  —  ${ts}`,
    `${all.length} found  |  ${queuedIds.size} to apply  |  ${all.length - queuedIds.size} skipped`,
    '='.repeat(80), '',
  ];
  all.forEach((j, i) => {
    const badge = appliedJobs.has(j.id)
      ? '[ALREADY APPLIED]'
      : queuedIds.has(j.id) ? '[QUEUED          ]' : '[FILTERED        ]';
    lines.push(`${String(i + 1).padStart(3)}.  ${badge}  ${j.title || '(no title)'}`);
    lines.push(`       Posted  : ${j.posted || 'unknown'}`);
    lines.push(`       Link    : ${j.url}`);
    lines.push(`       ID      : ${j.id}`);
    lines.push('');
  });
  lines.push('='.repeat(80), '');
  fs.appendFileSync(SCANNED_FILE, lines.join('\n'));
}

// ─── APPLIED / FAILED FILES ───────────────────────────────────────────────────

function initAppliedFile(queueSize) {
  ensureDir(APPLIED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  fs.appendFileSync(APPLIED_FILE, [
    '='.repeat(80),
    `RANDSTAD SESSION  —  ${ts}`,
    `${queueSize} jobs queued for application`,
    '='.repeat(80), '',
  ].join('\n'));
}

function writeAppliedEntry(workerId, title, jobId, status, jobUrl) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  fs.appendFileSync(APPLIED_FILE, [
    `[${time}] [${workerId}]  ${status.padEnd(9)}  —  ${title}`,
    `  Link    : ${jobUrl || '-'}`,
    `  ID      : ${jobId}`, '',
  ].join('\n'));
}

function writeSessionSummary() {
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  fs.appendFileSync(APPLIED_FILE, [
    '-'.repeat(80),
    `SESSION COMPLETE  —  ${ts}`,
    `Applied: ${stats.applied}  |  Skipped: ${stats.skipped}  |  Failed: ${stats.failed}  |  Uncertain: ${stats.uncertain}`,
    '='.repeat(80), '',
  ].join('\n'));
}

function writeFailedEntry(workerId, title, jobId, status, reason, jobUrl) {
  ensureDir(FAILED_FILE);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const url  = jobUrl || `${BASE_URL}/jobs/ (ID: ${jobId})`;
  sessionFailedUrls.add(url);
  fs.appendFileSync(FAILED_FILE, [
    `[${time}] [${workerId}]  ${status.padEnd(9)}  —  ${title}`,
    `  Link    : ${url}`,
    `  ID      : ${jobId}`,
    ...(reason ? [`  Reason  : ${reason}`] : []),
    '',
  ].join('\n'));
}

// ─── STATUS FILE ──────────────────────────────────────────────────────────────

function updateStatus(workerId, state, jobTitle) {
  workerStatus[workerId] = {
    state,
    job: (jobTitle || '').slice(0, 60),
    lastUpdate: new Date().toLocaleTimeString('en-US', { hour12: false }),
  };
  try {
    ensureDir(STATUS_FILE);
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      stats,
      workers: workerStatus,
      queue: { total: jobQueue.length, remaining: jobQueue.length - queueIndex, processed: queueIndex },
      updated: new Date().toLocaleTimeString(),
    }, null, 2));
  } catch (e) {
    console.warn(`[!] Status write error: ${e.message}`);
  }
}

// ─── WORKER COLORED LOGGER ────────────────────────────────────────────────────

function wlog(workerId, msg) {
  const colors = { W1: '\x1b[36m', W2: '\x1b[33m', W3: '\x1b[35m', W4: '\x1b[32m' };
  const reset  = '\x1b[0m';
  const color  = colors[workerId] || '';
  console.log(`${color}[${workerId}]${reset} ${msg}`);
}

// ─── FILL FIELD HELPER ────────────────────────────────────────────────────────

async function fillField(page, selectors, value, workerId, label) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible({ timeout: 3000 })) {
        await loc.fill(value);
        wlog(workerId, `   [form] ${label} filled (${sel})`);
        return true;
      }
    } catch (_) { /* try next */ }
  }
  // JS fallback
  const filled = await page.evaluate(({ selectors: sels, value: v }) => {
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        );
        if (nativeInputValueSetter && nativeInputValueSetter.set) {
          nativeInputValueSetter.set.call(el, v);
        } else {
          el.value = v;
        }
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return sel;
      }
    }
    return null;
  }, { selectors, value }).catch(() => null);

  if (filled) { wlog(workerId, `   [form] ${label} filled via JS (${filled})`); return true; }
  wlog(workerId, `   [!] Could not fill "${label}" — no matching field`);
  return false;
}

// ─── CLICK BUTTON HELPER ──────────────────────────────────────────────────────

async function clickButton(page, selectors, workerId, label) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible({ timeout: 3000 })) {
        await loc.click();
        wlog(workerId, `   [click] ${label} (${sel})`);
        return true;
      }
    } catch (_) { /* try next */ }
  }
  // JS fallback
  const clicked = await page.evaluate((sels) => {
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return sel; }
    }
    // Text-based fallback
    for (const el of document.querySelectorAll('button, input[type="submit"], a[role="button"]')) {
      const txt = (el.textContent || el.value || '').toLowerCase().trim();
      if (/apply|submit/i.test(txt) && el.offsetParent !== null) { el.click(); return txt; }
    }
    return null;
  }, selectors).catch(() => null);

  if (clicked) { wlog(workerId, `   [click] ${label} via JS (${clicked})`); return true; }
  wlog(workerId, `   [!] Could not click "${label}"`);
  return false;
}

// ─── APPLY TO ONE JOB ─────────────────────────────────────────────────────────

async function applyToJob(context, job, workerId, jobNumber) {
  wlog(workerId, `[>] #${jobNumber} — ${job.title} | ${job.posted || 'no date'}`);
  updateStatus(workerId, 'APPLYING', job.title);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (_shouldStop) { updateStatus(workerId, 'IDLE'); return 'SKIPPED'; }
    if (attempt > 1) {
      wlog(workerId, `   [~] Retry ${attempt}/${MAX_RETRIES}`);
      await new Promise(r => setTimeout(r, 5000));
    }

    const jobPage = await context.newPage();
    try {
      // ── 1. Navigate to job detail page ────────────────────────────────────
      await jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await jobPage.waitForTimeout(3000);

      // ── 2. Grab real title from h1 ────────────────────────────────────────
      let title = job.title;
      try {
        const h1 = await jobPage.$('h1');
        if (h1) {
          const h1Text = (await h1.textContent()).trim();
          if (h1Text.length > 3) title = h1Text;
        }
      } catch (_) { /* keep job.title */ }

      // ── 3. Date check on detail page ─────────────────────────────────────
      const detailDate = await jobPage.evaluate(() => {
        const sels = [
          '[class*="date"]', '[class*="posted"]', '[class*="ago"]',
          'time', '[datetime]', '[class*="publish"]',
        ];
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (el) {
            const txt = el.getAttribute('datetime') || el.textContent.trim();
            if (txt) return txt;
          }
        }
        // Regex scan body text for relative/absolute dates
        const m = (document.body.innerText || '').match(
          /(\d+\s+(?:minute|hour|day|week|month)s?\s+ago|today|just now|yesterday|[A-Z][a-z]+ \d{1,2},?\s*\d{4})/i
        );
        return m ? m[0] : '';
      }).catch(() => '');

      if (detailDate && !isWithin24Hours(detailDate)) {
        wlog(workerId, `   [-] Older than 24h (${detailDate}) — SKIPPED`);
        writeAppliedEntry(workerId, title, job.id, 'SKIPPED', job.url);
        stats.skipped++;
        markApplied(job.id);
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      // ── 4. Check if already applied (Randstad shows "Applied" badge) ──────
      const alreadyApplied = await jobPage.evaluate(() => {
        const body = (document.body.innerText || '').toLowerCase();
        return body.includes('you\'ve already applied') || body.includes('already applied');
      }).catch(() => false);

      if (alreadyApplied) {
        wlog(workerId, `   [dup] Already applied per site — SKIPPED`);
        markApplied(job.id);
        stats.skipped++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      // ── 5. Find and click the Apply / Easy Apply button ───────────────────
      //
      // Randstad has two flows:
      //   A. "Short Apply" — inline modal/section that appears on the same page
      //   B. Full apply — navigates to a dedicated apply page
      //
      // Button selectors to try (in order of specificity)
      const applyBtnSelectors = [
        'button:has-text("Apply Now")',
        'button:has-text("Apply now")',
        'a:has-text("Apply Now")',
        'a:has-text("Apply now")',
        'button:has-text("Easy Apply")',
        'button:has-text("Quick Apply")',
        'button:has-text("Short Apply")',
        '[class*="apply-btn"]',
        '[class*="applyBtn"]',
        '[class*="apply-now"]',
        '[class*="applyNow"]',
        '[data-testid*="apply"]',
        '[id*="apply-btn"]',
        '[id*="applyBtn"]',
        'a[href*="/apply/"]',
        'button[type="button"]:has-text("Apply")',
        'a:has-text("Apply")',
      ];

      const clickedApply = await clickButton(jobPage, applyBtnSelectors, workerId, 'Apply button');
      if (!clickedApply) {
        wlog(workerId, `   [!] No Apply button found — SKIPPED`);
        writeAppliedEntry(workerId, title, job.id, 'SKIPPED', job.url);
        writeFailedEntry(workerId, title, job.id, 'SKIPPED', 'no apply button found', job.url);
        stats.skipped++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      await jobPage.waitForTimeout(3000);

      // ── 6. Detect which flow opened ───────────────────────────────────────
      //
      // Short Apply: a modal/inline form appeared on the same page.
      // Full Apply:  navigated to a new URL ending in /apply/ or /apply-confirmation/

      const currentUrl = jobPage.url();
      const isFullApply = currentUrl.includes('/apply') && !currentUrl.includes(job.url.split('/').pop());

      wlog(workerId, `   [flow] ${isFullApply ? 'Full Apply page' : 'Short Apply modal'} — ${currentUrl}`);

      // ── 7. Handle login gate ──────────────────────────────────────────────
      // If we land on login page, the session expired
      if (currentUrl.includes('/login') || currentUrl.includes('/register')) {
        wlog(workerId, `   [!] Session expired — login required. FAILED.`);
        writeAppliedEntry(workerId, title, job.id, 'FAILED', job.url);
        writeFailedEntry(workerId, title, job.id, 'FAILED', 'session expired, need re-login', job.url);
        stats.failed++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }

      // ── 8. Wait for form to appear ────────────────────────────────────────
      // Give modals/SPA pages time to render
      await jobPage.waitForTimeout(2000);

      // ── 9. Fill form fields ───────────────────────────────────────────────
      // Randstad short apply typically pre-fills from profile.
      // We try to fill/confirm each field just in case.

      // First name
      await fillField(jobPage, [
        'input[name="firstName"]', 'input[name="first_name"]',
        'input[id*="first"]', 'input[placeholder*="first name" i]',
        'input[aria-label*="first name" i]',
        '[data-testid*="first"]',
      ], USER_FIRST, workerId, 'First name');

      // Last name
      await fillField(jobPage, [
        'input[name="lastName"]', 'input[name="last_name"]',
        'input[id*="last"]', 'input[placeholder*="last name" i]',
        'input[aria-label*="last name" i]',
        '[data-testid*="last"]',
      ], USER_LAST, workerId, 'Last name');

      // Full name (some forms use single field)
      await fillField(jobPage, [
        'input[name="name"]', 'input[name="fullName"]',
        'input[id*="name"]:not([id*="first"]):not([id*="last"])',
        'input[placeholder*="full name" i]',
        'input[aria-label*="name" i]:not([aria-label*="first" i]):not([aria-label*="last" i])',
      ], USER_FULL, workerId, 'Full name').catch(() => {});

      // Email
      await fillField(jobPage, [
        'input[type="email"]',
        'input[name="email"]', 'input[name="emailAddress"]',
        'input[id*="email"]', 'input[placeholder*="email" i]',
        'input[aria-label*="email" i]',
        '[data-testid*="email"]',
      ], USER_EMAIL, workerId, 'Email');

      // Phone (optional — skip if not visible, many Randstad profiles pre-fill)
      // We attempt but don't require it
      await fillField(jobPage, [
        'input[type="tel"]',
        'input[name="phone"]', 'input[name="phoneNumber"]',
        'input[name="mobile"]', 'input[id*="phone"]',
        'input[placeholder*="phone" i]', 'input[aria-label*="phone" i]',
      ], '4088675309', workerId, 'Phone').catch(() => {});

      // Cover letter textarea
      await fillField(jobPage, [
        'textarea[name*="cover"]', 'textarea[id*="cover"]',
        'textarea[name*="message"]', 'textarea[id*="message"]',
        'textarea[name*="letter"]', 'textarea[id*="letter"]',
        'textarea[placeholder*="cover" i]', 'textarea[placeholder*="message" i]',
        'textarea',
      ], COVER_TEXT, workerId, 'Cover letter').catch(() => {});

      // ── 10. Upload resume ─────────────────────────────────────────────────
      if (fs.existsSync(RESUME_PATH)) {
        try {
          const fileInputs = jobPage.locator('input[type="file"]');
          const fileCount  = await fileInputs.count();

          if (fileCount > 0) {
            let resumeInput = null;
            let coverInput  = null;

            for (let fi = 0; fi < fileCount; fi++) {
              const inp = fileInputs.nth(fi);
              const ctx = await inp.evaluate(el => {
                const parts = [el.id, el.name, el.getAttribute('aria-label') || '', el.getAttribute('accept') || ''];
                let node = el.parentElement;
                for (let n = 0; n < 4 && node; n++, node = node.parentElement) {
                  parts.push(node.textContent || '');
                }
                return parts.join(' ').toLowerCase();
              }).catch(() => '');

              if (/cover/i.test(ctx)) coverInput = coverInput || inp;
              else resumeInput = resumeInput || inp;
            }

            if (!resumeInput) resumeInput = fileInputs.first();

            await resumeInput.setInputFiles(RESUME_PATH);
            wlog(workerId, `   [resume] Resume uploaded`);

            if (coverInput && fs.existsSync(COVER_PATH)) {
              await coverInput.setInputFiles(COVER_PATH);
              wlog(workerId, `   [cover]  Cover letter uploaded`);
            }

            await jobPage.waitForTimeout(2000);
          } else {
            wlog(workerId, `   [!] No file input found — no upload`);
          }
        } catch (e) {
          wlog(workerId, `   [!] Resume upload error: ${e.message}`);
        }
      } else {
        wlog(workerId, `   [!] Resume not found at ${RESUME_PATH}`);
      }

      // ── 11. Handle any checkboxes (terms, consent) ────────────────────────
      try {
        const checkboxes = jobPage.locator('input[type="checkbox"]:not(:checked)');
        const cbCount    = await checkboxes.count();
        for (let ci = 0; ci < cbCount; ci++) {
          try {
            const cb  = checkboxes.nth(ci);
            const ctx = await cb.evaluate(el => {
              const parts = [el.id, el.name, el.getAttribute('aria-label') || ''];
              let node = el.parentElement;
              for (let n = 0; n < 3 && node; n++, node = node.parentElement) {
                parts.push(node.textContent || '');
              }
              return parts.join(' ').toLowerCase();
            }).catch(() => '');

            // Only check consent/terms/agreement boxes — skip marketing opt-in
            if (/terms|consent|agree|acknowledge|certif|confirm/i.test(ctx)) {
              await cb.check().catch(() => {});
              wlog(workerId, `   [check] Checked consent box`);
            }
          } catch (_) { /* ok */ }
        }
      } catch (_) { /* ok */ }

      // ── 12. Click Submit / Continue / Next ────────────────────────────────
      const submitSelectors = [
        'button:has-text("Submit Application")',
        'button:has-text("Submit application")',
        'button:has-text("Submit")',
        'button:has-text("Apply")',
        'button:has-text("Continue")',
        'button:has-text("Next")',
        'input[type="submit"]',
        'button[type="submit"]',
        '[class*="submit"]',
        '[data-testid*="submit"]',
        '[id*="submit"]',
      ];

      const submitted = await clickButton(jobPage, submitSelectors, workerId, 'Submit');

      if (!submitted) {
        wlog(workerId, `   [!] No submit button — UNCERTAIN`);
        writeAppliedEntry(workerId, title, job.id, 'UNCERTAIN', job.url);
        writeFailedEntry(workerId, title, job.id, 'UNCERTAIN', 'no submit button found', job.url);
        stats.uncertain++;
        markApplied(job.id);
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'UNCERTAIN';
      }

      // ── 13. Wait 8 seconds, check confirmation ────────────────────────────
      await jobPage.waitForTimeout(8000);

      // Handle multi-step forms: if another submit button appears, click it
      for (let step = 0; step < 3; step++) {
        const nextBtn = await jobPage.locator(
          'button:has-text("Next"), button:has-text("Continue"), button:has-text("Submit")'
        ).first();
        const nextVisible = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);
        if (nextVisible) {
          wlog(workerId, `   [multi-step] Clicking next step button`);
          await nextBtn.click().catch(() => {});
          await jobPage.waitForTimeout(4000);
        } else {
          break;
        }
      }

      const finalUrl  = jobPage.url();
      const bodyText  = await jobPage.evaluate(() => document.body.innerText || '').catch(() => '');

      // Randstad confirmation signals:
      // - URL contains /confirmation/ or /apply-confirmation/
      // - Body text contains success phrases
      const CONFIRM_RE = /application.*submit|submit.*application|successfully applied|thank you for applying|you've applied|application.*received|application.*sent|first step to your new career|we.*received.*application/i;
      const isConfirmPage = finalUrl.includes('confirmation') || finalUrl.includes('applied');
      const isConfirmText = CONFIRM_RE.test(bodyText);

      let result = (isConfirmPage || isConfirmText) ? 'APPLIED' : 'UNCERTAIN';

      if (result === 'APPLIED') {
        wlog(workerId, `   [ok] APPLIED — "${title}"`);
        markApplied(job.id);
        writeAppliedEntry(workerId, title, job.id, 'APPLIED', job.url);
        stats.applied++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'APPLIED';
      }

      // UNCERTAIN
      wlog(workerId, `   [?] UNCERTAIN — no confirmation detected. URL: ${finalUrl}`);
      markApplied(job.id);
      writeAppliedEntry(workerId, title, job.id, 'UNCERTAIN', job.url);
      writeFailedEntry(workerId, title, job.id, 'UNCERTAIN', `submitted, no confirm. URL: ${finalUrl}`, job.url);
      stats.uncertain++;
      await jobPage.close().catch(() => {});
      updateStatus(workerId, 'IDLE');
      return 'UNCERTAIN';

    } catch (err) {
      wlog(workerId, `   [x] Error (attempt ${attempt}): ${err.message}`);
      await jobPage.close().catch(() => {});

      if (/closed|destroyed|Target page/i.test(err.message)) {
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }

      if (attempt === MAX_RETRIES) {
        markApplied(job.id);
        writeAppliedEntry(workerId, job.title, job.id, 'FAILED', job.url);
        writeFailedEntry(workerId, job.title, job.id, 'FAILED', err.message, job.url);
        stats.failed++;
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }
    }
  }

  markApplied(job.id);
  updateStatus(workerId, 'IDLE');
  writeFailedEntry('--', job.title, job.id, 'FAILED', 'exhausted retries', job.url);
  return 'FAILED';
}

// ─── WORKER LOOP ──────────────────────────────────────────────────────────────

async function runWorker(workerId, context, appliedJobs, startDelay) {
  await new Promise(r => setTimeout(r, startDelay));
  wlog(workerId, `[start] Worker started`);
  updateStatus(workerId, 'IDLE');

  while (!_shouldStop) {
    const job = getNextJob();
    if (!job) {
      wlog(workerId, `[done] Queue exhausted`);
      updateStatus(workerId, 'DONE');
      break;
    }

    stats.total++;
    const jobNumber = stats.total;
    appliedJobs.add(job.id); // claim immediately

    await applyToJob(context, job, workerId, jobNumber);
    if (stats.applied + stats.failed + stats.uncertain >= MAX_JOBS) {
      _shouldStop = true;
      break;
    }
    if (!_shouldStop) await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  updateStatus(workerId, _shouldStop ? 'STOPPED' : 'DONE');
}

// ─── OPEN FAILED JOBS IN BROWSER ─────────────────────────────────────────────

async function openFailedJobs(context) {
  if (sessionFailedUrls.size === 0) return false;
  const urls = [...sessionFailedUrls];
  console.log(`\n[>] Opening ${urls.length} failed/uncertain job(s) in browser for review...`);
  for (const url of urls) {
    try {
      const tab = await context.newPage();
      await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    } catch (e) {
      console.warn(`   Could not open ${url}: ${e.message}`);
    }
  }
  return true;
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function printDashboard() {
  const sep = '─'.repeat(62);
  console.log(`\n${sep}`);
  console.log(`DASHBOARD — ${new Date().toLocaleTimeString()}`);
  console.log(`  Applied: ${stats.applied}  Skipped: ${stats.skipped}  Failed: ${stats.failed}  Uncertain: ${stats.uncertain}`);
  console.log(`  Queue: ${queueIndex}/${jobQueue.length} processed`);
  for (const [id, s] of Object.entries(workerStatus)) {
    console.log(`  ${id}: [${s.state}] ${s.job || '-'}`);
  }
  console.log(`${sep}\n`);
}

// ─── LOGIN MODE ───────────────────────────────────────────────────────────────

async function loginMode() {
  console.log('\n' + '='.repeat(60));
  console.log('Randstad Bot — LOGIN MODE');
  console.log(`Profile dir: ${PROFILE_DIR}`);
  console.log('='.repeat(60));

  ensureDir(path.join(PROFILE_DIR, 'placeholder'));

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });

  const page = await browser.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

  console.log('\n>>> Browser is open. Please log in to Randstad USA.');
  console.log('>>> Once logged in successfully, come back here and press ENTER to save your session...\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('', () => { rl.close(); resolve(); }));

  console.log('[i] Saving session...');
  await browser.close();
  console.log(`[ok] Session saved to ${PROFILE_DIR}`);
  console.log('\nYou can now run the bot:');
  console.log(`  node randstad-bot.js 240\n`);
}

// ─── RUN MODE ─────────────────────────────────────────────────────────────────

async function runBot(durationMinutes) {
  const startTime = Date.now();
  const endTime   = durationMinutes != null ? startTime + durationMinutes * 60 * 1000 : Infinity;

  // Verify profile exists
  if (!fs.existsSync(PROFILE_DIR)) {
    console.error(`[!] Profile directory not found: ${PROFILE_DIR}`);
    console.error('    Run "node randstad-bot.js login" first to save your session.');
    process.exit(1);
  }

  // Verify resume exists
  if (!fs.existsSync(RESUME_PATH)) {
    console.error(`[!] Resume not found at ${RESUME_PATH}`);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(62));
  console.log('Randstad USA Bot — 4 Parallel Workers');
  console.log(`Duration : ${durationMinutes != null ? durationMinutes + ' min | Stop at: ' + new Date(endTime).toLocaleTimeString() : 'unlimited (test mode)'}`);
  console.log(`Profile  : ${PROFILE_DIR}`);
  console.log(`Resume   : ${RESUME_PATH}`);
  console.log(`Applied  : ${APPLIED_FILE}`);
  console.log(`Status   : ${STATUS_FILE}`);
  console.log('='.repeat(62));

  // Launch with persistent profile (carries saved login session)
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });

  const scanPage   = await context.newPage();
  let appliedJobs  = loadAppliedJobs();

  console.log(`\n[i] Loaded ${appliedJobs.size} previously applied job IDs`);

  initAppliedFile(0);
  const dashInterval = setInterval(printDashboard, 30000);

  try {
    if (_shouldStop || Date.now() >= endTime) throw new Error('Time expired before scan');

    const remaining = endTime === Infinity ? '∞' : Math.floor((endTime - Date.now()) / 60000);
    console.log(`\n[t] ${remaining} min remaining — starting scan...`);

    // ── Scan all keywords ──────────────────────────────────────────────────
    const newJobs = await scanForJobs(scanPage, appliedJobs);

    if (newJobs.length === 0) {
      console.log(`\n[z] No new matching jobs found within 24h — exiting.`);
    } else {
      jobQueue   = newJobs;
      queueIndex = 0;

      console.log(`\n[>] ${newJobs.length} jobs queued — launching ${NUM_WORKERS} workers\n`);
      printDashboard();

      // ── Run 4 parallel workers ─────────────────────────────────────────
      await Promise.all(
        Array.from({ length: NUM_WORKERS }, (_, i) =>
          runWorker(`W${i + 1}`, context, appliedJobs, i * 2000)
        )
      );

      printDashboard();
      console.log(`\n[z] All workers done — exiting.`);
    }

  } catch (err) {
    if (err.message !== 'Time expired before scan') {
      console.error(`\n[x] Fatal error:`, err.stack || err.message);
    }
  } finally {
    clearInterval(dashInterval);
    writeSessionSummary();

    // Open failed jobs in browser for review
    const hadFailed = await openFailedJobs(context).catch(() => false);

    if (hadFailed) {
      console.log('\n[>] Failed/uncertain jobs are open in browser. Review them.');
      console.log('    Press ENTER when done to close the browser...');
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      await new Promise(resolve => rl2.question('', () => { rl2.close(); resolve(); }));
    } else {
      console.log('\n[i] Browser will stay open for review. Close manually when done.');
      // Keep process alive briefly so user can see the final state
      await new Promise(r => setTimeout(r, 5000));
    }

    await context.close().catch(e => console.error('Error closing context:', e.message));
  }

  const ran = Math.floor((Date.now() - startTime) / 60000);
  console.log('\n' + '='.repeat(62));
  console.log(`Session Complete — ran ${ran} min`);
  console.log(`Applied: ${stats.applied}  Skipped: ${stats.skipped}  Failed: ${stats.failed}  Uncertain: ${stats.uncertain}`);
  console.log(`Scanned log  -> ${SCANNED_FILE}`);
  console.log(`Applied log  -> ${APPLIED_FILE}`);
  console.log(`Failed log   -> ${FAILED_FILE}`);
  console.log('='.repeat(62) + '\n');
}

// ─── SCAN MODE ────────────────────────────────────────────────────────────────

async function scanMode() {
  console.log('\n' + '='.repeat(70));
  console.log('Randstad — SCAN MODE (no login, no apply)');
  console.log('URLs : ' + SCAN_URLS.join('\n       '));
  console.log('Pages: up to 6 per URL');
  console.log('='.repeat(70) + '\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  const context = await browser.newContext({
    viewport: null,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const allJobs = [];
  const seen    = new Set();

  for (const baseUrl of SCAN_URLS) {
    console.log(`\n── Scanning: ${baseUrl}`);

    for (let pageNum = 1; pageNum <= 6; pageNum++) {
      const url = pageNum === 1
        ? baseUrl
        : baseUrl.replace(/\/?$/, '') + `/page-${pageNum}/`;

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        await page.waitForTimeout(2500);

        const noResults = await page.evaluate(() => {
          const t = (document.body.innerText || '').toLowerCase();
          return /no jobs found|0 jobs|no results found|sorry, no/.test(t);
        }).catch(() => false);

        if (noResults) {
          console.log(`   Page ${pageNum}: no results — done`);
          break;
        }

        const jobs = await extractJobsFromPage(page);
        if (jobs.length === 0) {
          console.log(`   Page ${pageNum}: 0 cards — done`);
          break;
        }

        let newCount = 0;
        for (const job of jobs) {
          if (seen.has(job.id)) continue;
          seen.add(job.id);
          allJobs.push(job);
          newCount++;
        }

        console.log(`   Page ${pageNum}: ${jobs.length} cards | ${newCount} new`);
        if (newCount === 0) break;

      } catch (e) {
        console.log(`   Page ${pageNum}: error — ${e.message}`);
        break;
      }
    }
  }

  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  // ── ALL SCRAPED — simple numbered list ────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log(`ALL SCRAPED JOBS — ${allJobs.length} total`);
  console.log('='.repeat(70));
  allJobs.forEach((j, i) => {
    const date  = j.posted ? `[${j.posted}]` : '[no date]';
    const title = j.title  || '(no title)';
    console.log(`${String(i + 1).padStart(3)}. ${date.padEnd(20)} ${title}`);
    console.log(`      ${j.url}`);
  });

  // ── RELEVANT — title match + within 1 day, tabular ───────────────────────
  const relevant = allJobs.filter(j =>
    TITLE_FILTER.test(j.title) && isWithin24Hours(j.posted)
  );

  console.log('\n' + '='.repeat(70));
  console.log(`RELEVANT JOBS — title match + posted within 1 day — ${relevant.length} found`);
  console.log('='.repeat(70));

  if (relevant.length === 0) {
    console.log('  (none)\n');
  } else {
    const T = 42; // title col width
    const D = 14; // date col width
    const header = `${'#'.padEnd(4)} ${'Title'.padEnd(T)} ${'Posted'.padEnd(D)} URL`;
    console.log(header);
    console.log('-'.repeat(header.length + 20));
    relevant.forEach((j, i) => {
      const num    = String(i + 1).padEnd(4);
      const title  = (j.title || '(no title)').slice(0, T).padEnd(T);
      const posted = (j.posted || '?').slice(0, D).padEnd(D);
      console.log(`${num} ${title} ${posted} ${j.url}`);
    });
    console.log('');
  }

  console.log(`\nSummary: ${allJobs.length} scraped | ${relevant.length} relevant\n`);
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

const arg = process.argv[2];

if (arg === 'scan') {
  scanMode().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'login') {
  loginMode().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'test') {
  MAX_JOBS = 1;
  console.log('[test] Single-job test mode — will stop after 1 application attempt.');
  runBot(null).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'formtest') {
  const url = process.argv[3];
  if (!url) { console.error('[err] Usage: node randstad-bot.js formtest <applyUrl>'); process.exit(1); }
  formTestMode(url).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else {
  const duration = parseInt(arg, 10);
  if (!duration || duration < 1) {
    console.log('\nUsage:');
    console.log('  node randstad-bot.js login     ← save login session');
    console.log('  node randstad-bot.js 30         ← run for 30 minutes');
    console.log('  node randstad-bot.js 240        ← run for 4 hours');
    console.log('  node randstad-bot.js test       ← single-job test mode');
    console.log('  node randstad-bot.js formtest <url>  ← inspect apply form\n');
    process.exit(1);
  }
  runBot(duration).catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
