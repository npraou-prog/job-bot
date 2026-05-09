#!/usr/bin/env node
/**
 * RobertHalf Job Application Bot — 4 Parallel Workers
 *
 * RUN:         node roberthalf-bot.js              ← auto-login if needed, then apply
 * PROBE:       node roberthalf-bot.js probe        ← inspect one job page, print DOM info
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const HOME_DIR       = process.env.HOME || process.env.USERPROFILE || '';
const PROFILE_DIR    = process.env.RH_PROFILE_PATH || path.join(HOME_DIR, 'roberthalf-bot-profile');
const RH_EMAIL       = process.env.RH_EMAIL    || 'npraou@gmail.com';
const RH_PASSWORD    = process.env.RH_PASSWORD || 'Nikhil@7052nikhil';
const RH_LOGIN_URL   = 'https://online.roberthalf.com/s/login?app=0sp3w000001UJH5&c=US&d=en_US&language=en_US&redirect=false';
const WORKSPACE_DIR  = path.join(HOME_DIR, '.openclaw', 'workspace');
const LOG_FILE       = path.join(WORKSPACE_DIR, 'roberthalf_applications_log.md');
const APPLIED_IDS    = path.join(WORKSPACE_DIR, 'rh_applied_ids.txt');   // raw ID dedup guard
const STATUS_FILE    = path.join(WORKSPACE_DIR, 'rh_worker_status.json');
const SCANNED_FILE   = path.join(__dirname, 'scanned_jobs.txt');
const APPLIED_FILE   = path.join(__dirname, 'applied_jobs.txt');
const FAILED_FILE    = path.join(__dirname, 'failed_jobs.txt');

const NUM_WORKERS    = 4;
const RATE_LIMIT_MS  = 8000;   // ms between applications per worker
const PAGE_TIMEOUT   = 30000;
const BATCH_SIZE     = 200;
const RESCAN_WAIT_MS = 90000;  // wait between full scans (ms)

// After this many consecutive empty scans, switch to location-based search
const EMPTY_SCANS_BEFORE_LOCATION = 3;

// RobertHalf search — path-based slugs, paginated with ?pagenumber=N
const SEARCH_SLUGS = [
  'data-scientist',
  'data-science',
  'machine-learning-engineer',
  'machine-learning',
  'artificial-intelligence',
  'nlp-engineer',
  'applied-scientist',
];
const BASE_SEARCH  = 'https://www.roberthalf.com/us/en/jobs/all';
// postedwithin=1 filters to jobs posted within the last 24 hours on RobertHalf
const SEARCH_URLS  = SEARCH_SLUGS.map(s => `${BASE_SEARCH}/${s}?postedwithin=1`);

// Top US tech hub cities for location fallback
const LOCATIONS = [
  'new-york-ny',
  'san-francisco-ca',
  'seattle-wa',
  'austin-tx',
  'boston-ma',
  'atlanta-ga',
  'chicago-il',
  'washington-dc',
  'dallas-tx',
  'denver-co',
];

function buildLocationUrls(citySlug) {
  return SEARCH_SLUGS.map(s =>
    `https://www.roberthalf.com/us/en/jobs/${citySlug}/${s}?postedwithin=1`
  );
}

const PROFILE = {
  resumePath: (() => {
    const candidates = [
      path.join(__dirname, 'resume.pdf'),
      path.join(__dirname, 'Nikhil_Resume.pdf'),
      path.join(__dirname, '..', 'resume.pdf'),
      path.join(__dirname, '..', 'Nikhil_Resume.pdf'),
      path.join(process.env.HOME || '', 'Desktop', 'Jobs', 'Nikhil_Resume.pdf'),
    ];
    return candidates.find(p => { try { return require('fs').existsSync(p); } catch(_){} }) || candidates[0];
  })(),
};

const TITLE_KEYWORDS = [];
const TITLE_BLOCK    = [];
const DESC_BLOCK     = [];

// Block non-DS roles that appear in DS search results
const TITLE_BLOCK_RE = /data\s*engineer(ing)?|database\s*(developer|admin|architect|engineer)|etl\s*(developer|engineer)?|data\s*analyst|pipeline\s*engineer|bi\s*(developer|engineer)|reporting\s*(developer|analyst)/i;

// ─── SHARED STATE ─────────────────────────────────────────────────────────────

let _shouldStop = false;
let MAX_JOBS = Infinity;
let _sigintCount = 0;

process.on('SIGINT', () => {
  _sigintCount++;
  if (_sigintCount >= 2) { console.log('\nForce exiting.'); process.exit(1); }
  _shouldStop = true;
  console.log('\n⚠️  Stopping after current job. (Ctrl+C again to force quit)');
});

const stats = { applied: 0, skipped: 0, failed: 0, uncertain: 0, total: 0 };

const sessionFailedUrls = new Set();

const workerStatus = {};
for (let i = 1; i <= NUM_WORKERS; i++) {
  workerStatus[`W${i}`] = { state: 'IDLE', job: '', lastUpdate: '' };
}

let jobQueue  = [];
let queueIndex = 0;

function getNextJob() {
  if (queueIndex < jobQueue.length) return jobQueue[queueIndex++];
  return null;
}

// ─── REPORT STATE ─────────────────────────────────────────────────────────────

let reportPath      = '';          // set at start of runBot
let reportStartTime = null;        // Date object
let totalScanned    = 0;           // running total of jobs ever added to queue
let reportLog       = [];          // { status, title, company, url, jobId, reason, time }

// ─── FILE HELPERS ─────────────────────────────────────────────────────────────

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadAppliedJobs() {
  ensureDir(APPLIED_IDS);
  if (!fs.existsSync(APPLIED_IDS)) { fs.writeFileSync(APPLIED_IDS, ''); return new Set(); }
  return new Set(fs.readFileSync(APPLIED_IDS, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
}

function markApplied(jobId) {
  fs.appendFileSync(APPLIED_IDS, jobId + '\n');
}

// ─── SCANNED JOBS FILE ────────────────────────────────────────────────────────

function writeScannedJobs(allJobsOnPage, queuedIds, appliedJobs) {
  ensureDir(SCANNED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  const newCount  = queuedIds.size;
  const skipCount = allJobsOnPage.length - newCount;

  const lines = [
    '='.repeat(80),
    `ROBERTHALF SCAN  —  ${ts}`,
    `${allJobsOnPage.length} jobs found  |  ${newCount} new  |  ${skipCount} already applied / filtered`,
    '='.repeat(80),
    '',
  ];

  allJobsOnPage.forEach((j, i) => {
    const already = appliedJobs.has(j.id);
    const badge   = already ? '[ALREADY APPLIED]' : (queuedIds.has(j.id) ? '[QUEUED          ]' : '[FILTERED        ]');
    lines.push(`${String(i + 1).padStart(3)}.  ${badge}  ${j.title || '(no title)'}`);
    if (j.company) lines.push(`       Company : ${j.company}`);
    lines.push(`       Posted  : ${j.posted || 'unknown'}`);
    lines.push(`       Link    : ${j.url}`);
    lines.push(`       ID      : ${j.id}`);
    lines.push('');
  });

  lines.push('='.repeat(80), '');
  fs.appendFileSync(SCANNED_FILE, lines.join('\n'));
}

// ─── APPLIED JOBS FILE ────────────────────────────────────────────────────────

function initAppliedFile(queueSize) {
  ensureDir(APPLIED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  fs.appendFileSync(APPLIED_FILE, [
    '='.repeat(80),
    `ROBERTHALF SESSION  —  ${ts}`,
    `${queueSize} jobs queued for application`,
    '='.repeat(80),
    '',
  ].join('\n'));
}

function writeAppliedEntry(workerId, title, company, jobId, status, jobUrl) {
  const time      = new Date().toLocaleTimeString('en-US', { hour12: false });
  const statusPad = status.padEnd(9);
  fs.appendFileSync(APPLIED_FILE, [
    `[${time}] [${workerId}]  ${statusPad}  —  ${title}`,
    `  Company : ${company || '-'}`,
    `  Link    : ${jobUrl || '-'}`,
    `  ID      : ${jobId}`,
    '',
  ].join('\n'));
}

function writeSessionSummary() {
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  fs.appendFileSync(APPLIED_FILE, [
    '-'.repeat(80),
    `SESSION COMPLETE  —  ${ts}`,
    `Applied: ${stats.applied}  |  Skipped: ${stats.skipped}  |  Failed: ${stats.failed}  |  Uncertain: ${stats.uncertain}`,
    '='.repeat(80),
    '',
  ].join('\n'));
}

function writeFailedEntry(workerId, title, company, jobId, status, reason, jobUrl) {
  ensureDir(FAILED_FILE);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const note = reason ? `  Reason  : ${reason}` : '';
  const url  = jobUrl || `https://www.roberthalf.com (ID: ${jobId})`;
  sessionFailedUrls.add(url);
  fs.appendFileSync(FAILED_FILE, [
    `[${time}] [${workerId}]  ${status.padEnd(9)}  —  ${title}`,
    `  Company : ${company || '-'}`,
    `  Link    : ${url}`,
    `  ID      : ${jobId}`,
    ...(note ? [note] : []),
    '',
  ].join('\n'));
}

function initLogFile() {
  ensureDir(LOG_FILE);
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE,
      '# RobertHalf Job Applications Log\n\n' +
      '| Worker | # | Time | Job Title | Company | Job ID | Status |\n' +
      '|--------|---|------|-----------|---------|--------|--------|\n'
    );
  }
}

function logJob(workerId, num, title, company, jobId, status) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `| ${workerId} | ${num} | ${time} | ${title} | ${company || '-'} | ${jobId} | ${status} |\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function updateStatus(workerId, state, jobTitle = '') {
  workerStatus[workerId] = {
    state,
    job: jobTitle.slice(0, 50),
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
    console.warn(`   ⚠️  Status file write error: ${e.message}`);
  }
}

// ─── LOGGING WITH WORKER PREFIX ───────────────────────────────────────────────

function wlog(workerId, msg) {
  const colors = { W1: '\x1b[36m', W2: '\x1b[33m', W3: '\x1b[35m', W4: '\x1b[32m' };
  const reset = '\x1b[0m';
  const color = colors[workerId] || '';
  console.log(`${color}[${workerId}]${reset} ${msg}`);
}

// ─── DATE FILTER — only jobs posted within 24-48 hours ───────────────────────

function isRecentJob(postedText) {
  if (!postedText) return true; // unknown — let through
  const t = postedText.toLowerCase();
  if (t.includes('just now') || t.includes('today') || t.includes('hour') || t.includes('minute')) return true;
  if (t.includes('1 day') || t.includes('yesterday')) return true;
  if (t.includes('day') || t.includes('week') || t.includes('month')) return false;
  return true;
}

// ─── SCROLL TO LOAD ALL LAZY CARDS ───────────────────────────────────────────

async function scrollToLoadAll(page) {
  let prev = 0;
  for (let i = 0; i < 15; i++) {
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
      const count = await page.evaluate(() =>
        document.querySelectorAll('a[href*="/us/en/job/"]').length
      );
      if (count === prev && i > 2) break;
      prev = count;
    } catch (e) {
      // SPA navigated mid-scroll — stop scrolling, let caller re-evaluate
      break;
    }
  }
  try { await page.evaluate(() => window.scrollTo(0, 0)); } catch (_) {}
}

// ─── EXTRACT JOBS FROM PAGE ───────────────────────────────────────────────────
// RobertHalf job URL: /us/en/job/{city-state}/{title-slug}/{id1}-{id2}-usen

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/us/en/job/"]'));
    const map = {};

    for (const a of links) {
      const href = a.href || '';
      // Extract the last path segment as the unique job ID (e.g. "01020-9504306170-usen")
      const m = href.match(/\/us\/en\/job\/[^/]+\/[^/]+\/([^/?#]+)/);
      if (!m) continue;
      const id = m[1];
      if (!map[id]) map[id] = { id, title: '', company: '', posted: '', url: href.split('?')[0] };

      const text = a.textContent.trim();
      if (!text) continue;

      // Detect posted date patterns
      if (/\d+\s*(hour|minute|day|week|month)|today|just now|yesterday/i.test(text)) {
        map[id].posted = text.trim();
      } else if (text.length > 4) {
        // Longest text is likely the job title
        if (text.length > (map[id].title || '').length) map[id].title = text;
      }
    }

    // Try to extract more info from the card containers
    for (const id of Object.keys(map)) {
      // Find the link element for this job
      const a = links.find(l => l.href.includes(id));
      if (!a) continue;

      const card = a.closest(
        '[class*="job-listing"], [class*="jobListing"], [class*="job-card"], [class*="jobCard"], ' +
        'article, li, [class*="result"], [class*="search-result"]'
      );
      if (!card) continue;

      // Look for posted date within the card
      if (!map[id].posted) {
        const allText = card.innerText || '';
        const dateMatch = allText.match(/(\d+\s+(?:hour|minute|day|week|month)s?\s+ago|today|just now|yesterday)/i);
        if (dateMatch) map[id].posted = dateMatch[0];
      }

      // Look for company name
      if (!map[id].company) {
        const compEl = card.querySelector(
          '[class*="company"], [class*="employer"], [class*="client"], ' +
          '[data-automation*="company"], [data-testid*="company"]'
        );
        if (compEl) map[id].company = compEl.textContent.trim();
      }
    }

    return Object.values(map).filter(j => j.url);
  });
}

// ─── SCAN FOR JOBS ────────────────────────────────────────────────────────────

/**
 * scanSlug — opens its own page, scans a single search URL (with pagination),
 * closes the page, and returns an array of job objects that pass all filters.
 * Designed to run in parallel via Promise.all.
 */
async function scanSlug(context, baseUrl, appliedJobs) {
  const slugMatch = baseUrl.match(/\/jobs\/(?:all\/|[^/]+\/)([^/?]+)/);
  const keyword   = slugMatch ? slugMatch[1].replace(/-/g, ' ') : 'unknown';
  console.log(`\n🔍 [parallel] Scanning: ${keyword}`);

  const page = await context.newPage();
  const found     = [];
  const allSeen   = [];
  const seenIds   = new Set();
  let pageNum     = 1;
  let totalAdded  = 0;
  let totalOld    = 0;

  try {
    while (found.length < BATCH_SIZE) {
      const pagedUrl = pageNum === 1
        ? baseUrl
        : `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}pagenumber=${pageNum}`;

      try {
        await page.goto(pagedUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
          page.goto(pagedUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
        );
        await page.waitForTimeout(3000);
        await scrollToLoadAll(page);

        const noJobs = await page.evaluate(() => {
          const body = document.body.innerText.toLowerCase();
          return body.includes('no jobs found') ||
                 body.includes('no results') ||
                 body.includes('0 results') ||
                 body.includes("we couldn't find");
        }).catch(() => false);

        if (noJobs) {
          if (pageNum === 1) {
            console.log(`   ⛔ [${keyword}] No results — skipping`);
          } else {
            console.log(`   ⛔ [${keyword}] Page ${pageNum}: end of pagination`);
          }
          break;
        }

        const jobs = await extractJobsFromPage(page);
        if (jobs.length === 0) {
          if (pageNum > 1) { console.log(`   ⛔ [${keyword}] Page ${pageNum}: no cards found`); }
          break;
        }

        const newOnPage = jobs.filter(j => !seenIds.has(j.id));
        if (pageNum > 1 && newOnPage.length === 0) break;

        for (const job of jobs) {
          if (seenIds.has(job.id)) continue;
          seenIds.add(job.id);
          allSeen.push(job);

          if (appliedJobs.has(job.id)) continue;
          if (!isRecentJob(job.posted)) { totalOld++; continue; }
          if (job.title && TITLE_BLOCK_RE.test(job.title)) {
            console.log(`   🚫 [${keyword}] Blocked by title: ${job.title}`);
            continue;
          }

          found.push({ id: job.id, url: job.url, title: job.title || job.id, company: job.company || '', posted: job.posted });
          totalAdded++;
        }

        console.log(`   [${keyword}] Page ${pageNum}: ${jobs.length} cards | ${newOnPage.length} new | running total: ${totalAdded} to apply`);
        pageNum++;

      } catch (err) {
        console.error(`   ⚠️  [${keyword}] Page ${pageNum} error: ${err.message}`);
        break;
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  console.log(`   ✅ [${keyword}] Done: ${totalAdded} queued | ${totalOld} >24h skipped`);
  return { found, allSeen };
}

async function scanForJobs(page, appliedJobs, urlsToScan = SEARCH_URLS) {
  const found   = [];
  const allSeen = [];
  const seenIds = new Set();

  for (const baseUrl of urlsToScan) {
    const slugMatch = baseUrl.match(/\/jobs\/(?:all\/|[^/]+\/)([^/?]+)/);
    const keyword   = slugMatch ? slugMatch[1].replace(/-/g, ' ') : 'unknown';
    console.log(`\n🔍 Scanning: ${keyword}`);

    let pageNum = 1;
    let totalAdded = 0;
    let totalOld   = 0;

    while (found.length < BATCH_SIZE) {
      const pagedUrl = pageNum === 1 ? baseUrl : `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}pagenumber=${pageNum}`;
      try {
        await page.goto(pagedUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
          page.goto(pagedUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
        );
        await page.waitForTimeout(3000);
        await scrollToLoadAll(page);

        // Check for "no results" state
        const noJobs = await page.evaluate(() => {
          const body = document.body.innerText.toLowerCase();
          return body.includes('no jobs found') ||
                 body.includes('no results') ||
                 body.includes('0 results') ||
                 body.includes("we couldn't find");
        }).catch(() => false);

        if (noJobs) {
          if (pageNum === 1) {
            console.log(`   ⛔ No results for "${keyword}" — skipping`);
          } else {
            console.log(`   ⛔ Page ${pageNum}: end of pagination`);
          }
          break;
        }

        const jobs = await extractJobsFromPage(page);
        if (jobs.length === 0) {
          if (pageNum > 1) { console.log(`   ⛔ Page ${pageNum}: no cards found — stopping`); }
          break;
        }

        const newOnPage = jobs.filter(j => !seenIds.has(j.id));
        if (pageNum > 1 && newOnPage.length === 0) break;

        for (const job of jobs) {
          if (seenIds.has(job.id)) continue;
          seenIds.add(job.id);
          allSeen.push(job);

          if (appliedJobs.has(job.id)) continue;
          if (!isRecentJob(job.posted)) { totalOld++; continue; }
          if (job.title && TITLE_BLOCK_RE.test(job.title)) {
            console.log(`   🚫 Blocked by title: ${job.title}`);
            continue;
          }

          found.push({ id: job.id, url: job.url, title: job.title || job.id, company: job.company || '', posted: job.posted });
          totalAdded++;
        }

        console.log(`   Page ${pageNum}: ${jobs.length} cards | ${newOnPage.length} new | running total: ${totalAdded} to apply`);
        pageNum++;

      } catch (err) {
        console.error(`   ⚠️  Page ${pageNum} error: ${err.message}`);
        break;
      }
    }

    console.log(`   ✅ Done: ${totalAdded} queued | ${totalOld} >24h skipped`);
  }

  const queuedIds = new Set(found.map(j => j.id));
  writeScannedJobs(allSeen, queuedIds, appliedJobs);

  return found;
}

// ─── DESCRIPTION GATE ────────────────────────────────────────────────────────

async function checkJobSuitability(page) {
  try {
    const text = await page.evaluate(() => {
      const el = document.querySelector(
        '[class*="jobDescription"], [class*="job-description"], [id*="description"], ' +
        '[class*="description"], main, article'
      );
      return (el || document.body).innerText.toLowerCase();
    });

    for (const phrase of DESC_BLOCK) {
      if (text.includes(phrase.toLowerCase())) {
        return { ok: false, reason: `desc contains "${phrase}"` };
      }
    }
  } catch (e) {
    console.warn(`   ⚠️  Suitability check error: ${e.message}`);
  }
  return { ok: true };
}

// ─── FIND AND CLICK QUICK APPLY / APPLY NOW ──────────────────────────────────

async function findAndClickApply(page) {
  // Priority 1: "Quick apply" — the bolt-lightning button on RobertHalf
  const quickApplyLoc = page.locator('button, a', { hasText: /quick apply/i });
  try {
    const count = await quickApplyLoc.count();
    for (let i = 0; i < count; i++) {
      const el = quickApplyLoc.nth(i);
      if (await el.isVisible()) { await el.click(); return 'quick'; }
    }
  } catch (e) { /* try next */ }

  // Priority 2: "Apply Now"
  const applyNowLoc = page.locator('button, a', { hasText: /^apply now$/i });
  try {
    const count = await applyNowLoc.count();
    for (let i = 0; i < count; i++) {
      const el = applyNowLoc.nth(i);
      if (await el.isVisible()) { await el.click(); return 'apply'; }
    }
  } catch (e) { /* try next */ }

  // Priority 3: any visible Apply button
  const broadLoc = page.locator('button, a', { hasText: /^apply$/i });
  try {
    if (await broadLoc.count() > 0 && await broadLoc.first().isVisible()) {
      await broadLoc.first().click(); return 'apply';
    }
  } catch (e) { /* try next */ }

  // Last resort: JS evaluate
  const clicked = await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, a')) {
      const txt = el.textContent.trim().toLowerCase();
      if (/quick apply|apply now|^apply$/.test(txt) && el.offsetParent !== null) {
        el.click(); return txt;
      }
    }
    return null;
  }).catch(() => null);

  return clicked;  // null = not found
}

// ─── NOTE: RobertHalf does NOT review cover letters — upload skipped ──────────
// Source: roberthalf.com/us/en/contact/candidate/job-search/finding-a-job-with-robert-half

// ─── AUTO-ANSWER QUESTION PAGES ───────────────────────────────────────────────

async function answerQuestions(page) {
  const answered = await page.evaluate(() => {
    const NO_KEYWORDS  = /sponsor|sponsorship|visa/i;
    const YES_KEYWORDS = /authoriz|eligible|legally|willing|relocate|available/i;
    const PLACEHOLDER  = /^(select|choose|please|--|none|0|null|undefined)$/i;

    let count = 0;

    // Radio groups
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const groups = {};
    for (const r of radios) {
      if (!groups[r.name]) groups[r.name] = [];
      groups[r.name].push(r);
    }
    for (const [, options] of Object.entries(groups)) {
      if (options.some(r => r.checked)) continue;
      const fieldset   = options[0].closest('fieldset');
      const legend     = fieldset ? fieldset.querySelector('legend') : null;
      const groupLabel = (legend ? legend.textContent : fieldset ? fieldset.textContent : '').toLowerCase();

      const wantNo = NO_KEYWORDS.test(groupLabel);
      let pick = wantNo
        ? options.find(r => /\bno\b/i.test(r.value || r.parentElement.textContent))
        : options.find(r => /\byes\b/i.test(r.value || r.parentElement.textContent));
      if (!pick) pick = options[0];

      pick.click();
      pick.dispatchEvent(new Event('change', { bubbles: true }));
      count++;
    }

    // Select dropdowns
    for (const sel of document.querySelectorAll('select')) {
      if (sel.value) continue;
      const opts = Array.from(sel.options).filter(o =>
        o.value && !PLACEHOLDER.test(o.value.trim()) && !PLACEHOLDER.test(o.text.trim())
      );
      if (opts.length > 0) {
        sel.value = opts[0].value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        count++;
      }
    }

    return count;
  }).catch(() => 0);

  if (answered > 0) await page.waitForTimeout(500);
  return answered;
}

// ─── NAVIGATE APPLY FORM ──────────────────────────────────────────────────────

// RobertHalf confirmation phrases (SmartRecruiters + RH portal)
const CONFIRM_RE = /thank you for applying|application.*submitted|application.*received|successfully applied|you.ve applied|we.ve received your application|your application is on its way|application complete/i;

async function navigateApplyForm(page, workerId) {
  const maxSteps = 15;

  for (let step = 0; step < maxSteps; step++) {
    if (_shouldStop) return 'UNCERTAIN';
    await page.waitForTimeout(2000);

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

    // Confirmation check — broad to catch SmartRecruiters + RH portal variants
    if (CONFIRM_RE.test(bodyText) || /submitted|thank you|successfully/i.test(bodyText)) {
      return 'APPLIED';
    }

    // Auto-answer screening questions if any
    const answered = await answerQuestions(page);
    if (answered > 0) wlog(workerId, `   ✏️  Answered ${answered} question(s)`);

    // Submit button
    const submitLoc = page.locator([
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
      'button:has-text("Submit Your Application")',
      'button:has-text("Send Application")',
      '[data-automation="submit-button"]',
      '[data-testid="submit-button"]',
      '[data-cy="submit-btn"]',
    ].join(', ')).first();

    try {
      if (await submitLoc.count() > 0 && await submitLoc.isVisible()) {
        wlog(workerId, `   🖱️  Step ${step + 1}: Submit`);
        await submitLoc.click();
        // Wait up to 20s for confirmation
        try {
          await page.waitForFunction(
            () => /submitted|thank you|successfully|application.*received|you.ve applied/i.test(document.body.innerText),
            { timeout: 20000 }
          );
          wlog(workerId, `   🎉 Confirmation received`);
          return 'APPLIED';
        } catch {
          const afterText = await page.evaluate(() => document.body.innerText).catch(() => '');
          if (/submitted|thank you|successfully|application.*received/i.test(afterText)) return 'APPLIED';
          return 'UNCERTAIN';
        }
      }
    } catch (e) {
      wlog(workerId, `   ⚠️  Submit error: ${e.message}`);
    }

    // Next / Continue button
    const nextLoc = page.locator([
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Next Step")',
      '[data-automation="next-button"]',
      '[data-testid="next-button"]',
    ].join(', ')).first();

    try {
      if (await nextLoc.count() > 0 && await nextLoc.isVisible() && await nextLoc.isEnabled()) {
        wlog(workerId, `   🖱️  Step ${step + 1}: Next`);
        await nextLoc.click();
        continue;
      }
    } catch (e) { wlog(workerId, `   ⚠️  Next button error: ${e.message}`); }

    // JS fallback for any Next/Continue element
    const clickedNext = await page.evaluate(() => {
      for (const el of document.querySelectorAll('button, a, [role="button"]')) {
        const txt = el.textContent.trim();
        if (/^(Next|Continue|Next Step)$/.test(txt) && el.offsetParent !== null) {
          el.click(); return txt;
        }
      }
      return null;
    }).catch(() => null);

    if (clickedNext) {
      wlog(workerId, `   🖱️  Step ${step + 1}: ${clickedNext} (fallback)`);
      continue;
    }

    // Nothing — log visible buttons for debugging
    const visible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a[role="button"], a'))
        .filter(b => b.offsetParent !== null).map(b => b.textContent.trim()).filter(Boolean)
    ).catch(() => []);
    wlog(workerId, `   ⚠️  Step ${step + 1}: No Next/Submit found. Visible: [${visible.slice(0, 10).join(' | ')}]`);
    break;
  }

  return 'UNCERTAIN';
}

// ─── APPLY TO ONE JOB ─────────────────────────────────────────────────────────

async function applyToJob(context, job, workerId, jobNumber) {
  wlog(workerId, `📝 #${jobNumber} — ${job.title} | ${job.posted || 'no date'}`);
  updateStatus(workerId, 'APPLYING', job.title);

  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (_shouldStop) { updateStatus(workerId, 'IDLE'); return 'SKIPPED'; }
    if (attempt > 1) {
      wlog(workerId, `   🔄 Retry ${attempt}/${MAX_RETRIES}`);
      await new Promise(r => setTimeout(r, 5000));
    }

    const jobPage = await context.newPage();
    try {
      await jobPage.goto(job.url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
        jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
      );
      await jobPage.waitForTimeout(4000);

      // Extract title & company from detail page
      let title = job.title, company = '-';
      try {
        const h1 = await jobPage.$('h1');
        if (h1) title = (await h1.textContent()).trim();
      } catch (e) { wlog(workerId, `   ⚠️  Title extraction: ${e.message}`); }
      try {
        const c = await jobPage.$(
          '[class*="company"], [class*="employer"], [class*="client"], ' +
          '[data-automation*="company"], [data-testid*="company"]'
        );
        if (c) company = (await c.textContent()).trim();
      } catch (e) { wlog(workerId, `   ⚠️  Company extraction: ${e.message}`); }

      // Description gate
      const suitability = await checkJobSuitability(jobPage);
      if (!suitability.ok) {
        wlog(workerId, `   🚫 UNSUITABLE — ${suitability.reason}`);
        logJob(workerId, jobNumber, title, company, job.id, 'UNSUITABLE');
        writeAppliedEntry(workerId, title, company, job.id, `UNSUITABLE`, job.url);
        stats.skipped++;
        logReport('UNSUITABLE', title, company, job.url, job.id, suitability.reason);
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'UNSUITABLE';
      }

      // Find and click Apply Now
      const clicked = await findAndClickApply(jobPage);
      if (!clicked) {
        wlog(workerId, `   ⏭️  No Apply button found — SKIPPED`);
        logJob(workerId, jobNumber, title, company, job.id, 'SKIPPED');
        writeAppliedEntry(workerId, title, company, job.id, 'SKIPPED', job.url);
        stats.skipped++;
        logReport('SKIPPED', title, company, job.url, job.id, 'no apply button found');
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      // Wait for new tab (application might open in a new tab)
      const newTabPromise = context.waitForEvent('page', { timeout: 12000 }).catch(() => null);
      await jobPage.waitForTimeout(2000);
      const newTab = await newTabPromise;
      let applyPage;

      if (newTab) {
        applyPage = newTab;
        // Wait for the tab to navigate away from about:blank (apply links sometimes redirect)
        await applyPage.waitForFunction(
          () => location.href !== 'about:blank' && location.href !== '',
          { timeout: 15000 }
        ).catch(() => {});
        await applyPage.waitForLoadState('domcontentloaded').catch(() => {});
        await applyPage.waitForTimeout(2000);
        const tabUrl = applyPage.url();
        // If still blank after waiting, close and skip
        if (!tabUrl || tabUrl === 'about:blank') {
          wlog(workerId, `   ⚠️  New tab stayed blank — skipping`);
          await applyPage.close().catch(() => {});
          await jobPage.close().catch(() => {});
          stats.skipped++;
          logReport('SKIPPED', title, company, job.url, job.id, 'new tab stayed blank');
          updateStatus(workerId, 'IDLE');
          return 'SKIPPED';
        }
        wlog(workerId, `   📂 New tab: ${tabUrl}`);
      } else {
        applyPage = jobPage;
        wlog(workerId, `   📂 Modal or same-page form`);
      }

      const result = await navigateApplyForm(applyPage, workerId);

      if (newTab) await applyPage.close().catch(() => {});
      await jobPage.close().catch(() => {});

      logJob(workerId, jobNumber, title, company, job.id, result);

      if (result === 'APPLIED') {
        wlog(workerId, `   ✅ APPLIED — ${title}`);
        markApplied(job.id);
        writeAppliedEntry(workerId, title, company, job.id, 'APPLIED', job.url);
        stats.applied++;
        logReport('APPLIED', title, company, job.url, job.id, '');
        updateStatus(workerId, 'IDLE');
        return 'APPLIED';
      }

      if (result === 'UNCERTAIN') {
        wlog(workerId, `   ❓ UNCERTAIN — ${title}`);
        markApplied(job.id);
        writeAppliedEntry(workerId, title, company, job.id, 'UNCERTAIN', job.url);
        writeFailedEntry(workerId, title, company, job.id, 'UNCERTAIN', 'submitted but no confirmation detected', job.url);
        stats.uncertain++;
        logReport('UNCERTAIN', title, company, job.url, job.id, 'submitted but no confirmation detected');
        updateStatus(workerId, 'IDLE');
        return 'UNCERTAIN';
      }

    } catch (err) {
      wlog(workerId, `   ❌ Error (attempt ${attempt}): ${err.stack || err.message}`);
      await jobPage.close().catch(() => {});
      // Page/context was closed (e.g. Ctrl+C) — don't retry
      if (/closed|destroyed|Target page/i.test(err.message)) {
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }
      if (attempt === MAX_RETRIES) {
        markApplied(job.id);
        logJob(workerId, jobNumber, job.title, '-', job.id, 'FAILED');
        writeAppliedEntry(workerId, job.title, '-', job.id, 'FAILED', job.url);
        writeFailedEntry(workerId, job.title, '-', job.id, 'FAILED', err.message, job.url);
        stats.failed++;
        logReport('FAILED', job.title, '-', job.url, job.id, err.message);
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }
    }
  }

  markApplied(job.id);
  updateStatus(workerId, 'IDLE');
  writeFailedEntry('--', job.title, '-', job.id, 'FAILED', 'exhausted retries', job.url);
  logReport('FAILED', job.title, '-', job.url, job.id, 'exhausted retries');
  return 'FAILED';
}

// ─── WORKER LOOP ──────────────────────────────────────────────────────────────

async function runWorker(workerId, context, appliedJobs, startDelay) {
  await new Promise(r => setTimeout(r, startDelay));
  wlog(workerId, `🚀 Worker started`);
  updateStatus(workerId, 'IDLE');

  while (!_shouldStop) {
    const job = getNextJob();
    if (!job) {
      updateStatus(workerId, 'WAITING');
      break;
    }

    stats.total++;
    const jobNumber = stats.total;
    appliedJobs.add(job.id);

    await applyToJob(context, job, workerId, jobNumber);
    if (stats.applied + stats.failed + stats.uncertain >= MAX_JOBS) {
      _shouldStop = true;
      break;
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  wlog(workerId, `🏁 Worker done — queue exhausted`);
  updateStatus(workerId, 'DONE');
}

// ─── LIVE REPORT ──────────────────────────────────────────────────────────────

function writeReport() {
  if (!reportPath) return;

  const now      = new Date();
  const started  = reportStartTime || now;
  const elapsedS = Math.floor((now - started) / 1000);
  const elapsedMin = Math.floor(elapsedS / 60);
  const elapsedSec = elapsedS % 60;

  function fmt(d) {
    return d.toLocaleString('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).replace(',', '');
  }

  const applied   = reportLog.filter(e => e.status === 'APPLIED');
  const skipped   = reportLog.filter(e => e.status === 'SKIPPED' || e.status === 'UNSUITABLE');
  const failed    = reportLog.filter(e => e.status === 'FAILED');
  const uncertain = reportLog.filter(e => e.status === 'UNCERTAIN');
  const pending   = totalScanned - applied.length - skipped.length - failed.length - uncertain.length;
  const checkSum  = applied.length + skipped.length + failed.length + uncertain.length + Math.max(0, pending);
  const checkOk   = checkSum === totalScanned ? '✓' : '✗';

  const W = 63;
  const rule  = '═'.repeat(W);
  const dash  = '─'.repeat(W);

  const lines = [
    rule,
    'ROBERTHALF BOT — LIVE REPORT',
    `Started : ${fmt(started)}`,
    `Updated : ${fmt(now)}`,
    `Duration: ${elapsedMin} min ${elapsedSec} sec`,
    rule,
    '',
    'TALLY',
    dash,
    `  Scanned (total found)  : ${String(totalScanned).padStart(3)}`,
    `  ├─ Applied             : ${String(applied.length).padStart(3)}`,
    `  ├─ Skipped (filtered)  : ${String(skipped.length).padStart(3)}`,
    `  ├─ Failed              : ${String(failed.length).padStart(3)}`,
    `  ├─ Uncertain           : ${String(uncertain.length).padStart(3)}`,
    `  └─ Pending (in queue)  : ${String(Math.max(0, pending)).padStart(3)}`,
    '                           ──',
    `  CHECK (must = Scanned) : ${String(checkSum).padStart(3)}  ${checkOk}`,
    '',
    'WORKERS',
    dash,
  ];

  for (const [id, s] of Object.entries(workerStatus)) {
    const stateTag = `[${s.state}]`.padEnd(10);
    lines.push(`  ${id}  ${stateTag}  ${s.job || ''}`);
  }

  lines.push('');
  lines.push('APPLIED JOBS');
  lines.push(dash);
  if (applied.length === 0) {
    lines.push('  (none yet)');
  } else {
    applied.forEach((e, i) => {
      lines.push(`  ${String(i + 1).padStart(3)}.  ${e.title || '(unknown)'}${e.company ? ' — ' + e.company : ''}`);
      if (e.url) lines.push(`        ${e.url}`);
      lines.push(`        Status : APPLIED   Time: ${e.time}`);
      lines.push('');
    });
  }

  lines.push('');
  lines.push('SKIPPED JOBS');
  lines.push(dash);
  if (skipped.length === 0) {
    lines.push('  (none yet)');
  } else {
    skipped.forEach((e, i) => {
      const badge = e.status === 'UNSUITABLE' ? '[TITLE_BLOCKED]' : '[SKIPPED]';
      lines.push(`  ${String(i + 1).padStart(3)}.  ${e.title || '(unknown)'}${e.company ? ' — ' + e.company : ''}       ${badge}`);
      if (e.url) lines.push(`        ${e.url}`);
      lines.push('');
    });
  }

  lines.push('');
  lines.push('FAILED / UNCERTAIN JOBS');
  lines.push(dash);
  const failedUncertain = [...failed, ...uncertain];
  if (failedUncertain.length === 0) {
    lines.push('  (none yet)');
  } else {
    failedUncertain.forEach((e, i) => {
      lines.push(`  ${String(i + 1).padStart(3)}.  ${e.title || '(unknown)'}${e.company ? ' — ' + e.company : ''}`);
      if (e.url) lines.push(`        ${e.url}`);
      if (e.reason) lines.push(`        Reason : ${e.reason}`);
      lines.push('');
    });
  }

  lines.push('');
  lines.push(rule);
  lines.push('END OF REPORT');
  lines.push(rule);
  lines.push('');

  try {
    fs.writeFileSync(reportPath, lines.join('\n'));
  } catch (e) {
    console.warn(`   ⚠️  Report write error: ${e.message}`);
  }
}

function logReport(status, title, company, url, jobId, reason) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  reportLog.push({ status, title, company, url, jobId, reason, time });
  writeReport();
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

let _dashLocMode  = false;
let _dashLocIndex = 0;

function printDashboard() {
  const modeLabel = _dashLocMode
    ? `📍 Location ${_dashLocIndex + 1}/${LOCATIONS.length}: ${LOCATIONS[_dashLocIndex] || '-'}`
    : '🌐 Nationwide';
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 DASHBOARD — ${new Date().toLocaleTimeString()}  |  ${modeLabel}`);
  console.log(`   ✅ Applied: ${stats.applied}  ⏭️  Skipped: ${stats.skipped}  ❌ Failed: ${stats.failed}  ❓ Uncertain: ${stats.uncertain}`);
  console.log(`   📋 Queue: ${queueIndex}/${jobQueue.length} processed`);
  for (const [id, s] of Object.entries(workerStatus)) {
    console.log(`   ${id}: [${s.state}] ${s.job || '-'}`);
  }
  console.log(`${'─'.repeat(60)}\n`);
}

// ─── LOGIN PROMPT ─────────────────────────────────────────────────────────────

async function promptLogin(page) {
  console.log('\n🔐 Checking login status...');
  await page.goto(RH_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // If the site redirected us away from the login page, we're already signed in
  if (!page.url().includes('login')) {
    console.log('   ✅ Already logged in — starting bot\n');
    return;
  }

  console.log(`   Not logged in — auto-filling credentials (${RH_EMAIL})...`);

  // Dismiss cookie/consent banners
  for (const txt of ['Accept All', 'Accept', 'Agree', 'OK']) {
    await page.locator(`button:has-text("${txt}")`).first().click({ timeout: 1500 }).catch(() => {});
  }

  // Fill email
  const EMAIL_SELS = [
    'input[name="username"]', 'input[type="email"]', 'input[name="email"]',
    '#email', '#username', 'input[placeholder*="email" i]', 'input[placeholder*="username" i]',
  ];
  for (const sel of EMAIL_SELS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      await el.fill(RH_EMAIL);
      console.log('   ✅ Email filled');
      break;
    }
  }
  await page.waitForTimeout(500);

  // Some flows show Next before revealing the password field
  for (const sel of ['button:has-text("Next")', 'button:has-text("Continue")', 'input[value="Next"]']) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      await el.click();
      await page.waitForTimeout(1500);
      break;
    }
  }

  // Fill password
  const PASS_SELS = [
    'input[type="password"]', 'input[name="password"]',
    '#password', 'input[placeholder*="password" i]',
  ];
  for (const sel of PASS_SELS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
      await el.fill(RH_PASSWORD);
      console.log('   ✅ Password filled');
      break;
    }
  }
  await page.waitForTimeout(500);

  // Submit
  const SUBMIT_SELS = [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Sign In")', 'button:has-text("Sign in")',
    'button:has-text("Log In")', 'button:has-text("Login")',
  ];
  for (const sel of SUBMIT_SELS) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      await el.click();
      console.log('   ✅ Form submitted');
      break;
    }
  }

  await page.waitForTimeout(3000);
  console.log(`   📍 URL: ${page.url()}`);

  // If still on login page, user needs to handle captcha / 2FA
  if (page.url().includes('login')) {
    console.log('\n   ⚠️  Still on login page — complete any captcha or 2FA, then press ENTER (auto-continuing in 60s)...');
    process.stdin.resume();
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        console.log('   ⏱️  60s elapsed — auto-continuing...');
        resolve();
      }, 60000);
      process.stdin.once('data', () => { clearTimeout(timer); resolve(); });
    });
    process.stdin.pause();
  } else {
    console.log('   ✅ Signed in — starting bot\n');
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function runBot() {
  const startTime = Date.now();

  // ── Report setup ──
  reportStartTime = new Date();
  const tsTag = reportStartTime.toISOString()
    .replace('T', '_').replace(/:/g, '-').slice(0, 19);
  reportPath = path.join(__dirname, `report_${tsTag}.txt`);
  reportLog  = [];
  totalScanned = 0;
  writeReport(); // create the file immediately (empty state)

  initLogFile();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🤖 RobertHalf Bot — ${NUM_WORKERS} Parallel Workers`);
  console.log(`📂 Profile  : ${PROFILE_DIR}`);
  console.log(`📊 Status   : ${STATUS_FILE}`);
  console.log(`📋 Report   : ${reportPath}`);
  console.log(`${'═'.repeat(60)}`);

  const reportInterval = setInterval(writeReport, 12000);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // Keep one page open solely to hold the session / serve as a landing page.
  // The parallel scan workers each open their own page via context.newPage().
  const pages    = context.pages();
  const holdPage = pages.length > 0 ? pages[0] : await context.newPage();

  await promptLogin(holdPage);

  let appliedJobs = loadAppliedJobs();
  console.log(`\n📂 Loaded ${appliedJobs.size} previously applied jobs`);

  let locMode  = false;
  let locIndex = 0;

  const dashInterval = setInterval(printDashboard, 30000);

  try {
    while (!_shouldStop) {
      _dashLocMode  = locMode;
      _dashLocIndex = locIndex;

      let scanUrls  = SEARCH_URLS;
      let scanLabel = 'nationwide';

      if (locMode) {
        const city = LOCATIONS[locIndex];
        scanUrls   = buildLocationUrls(city);
        scanLabel  = `📍 ${city} (${locIndex + 1}/${LOCATIONS.length})`;
      }

      console.log(`\n🔍 Scanning  |  ${scanLabel}`);
      console.log(`🔀 Launching ${scanUrls.length} parallel scan workers...`);

      // Phase 1 — scan all slugs in parallel, one page per slug
      const scanResults = await Promise.all(
        scanUrls.map(url => scanSlug(context, url, appliedJobs))
      );

      // Flatten and dedup by job ID
      const seenAllIds  = new Set();
      const allSeen     = [];   // every card seen across all slugs (for writeScannedJobs)
      const mergedIds   = new Set();
      const mergedJobs  = [];   // filtered, deduped queue

      for (const { found, allSeen: slugSeen } of scanResults) {
        for (const j of slugSeen) {
          if (!seenAllIds.has(j.id)) { seenAllIds.add(j.id); allSeen.push(j); }
        }
        for (const j of found) {
          if (!mergedIds.has(j.id)) { mergedIds.add(j.id); mergedJobs.push(j); }
        }
      }

      // Write the consolidated scanned-jobs file
      const queuedIds = new Set(mergedJobs.map(j => j.id));
      writeScannedJobs(allSeen, queuedIds, appliedJobs);

      if (mergedJobs.length === 0) {
        if (locMode) {
          console.log(`😴 No new jobs in ${LOCATIONS[locIndex]}`);
          locIndex++;
          if (locIndex >= LOCATIONS.length) {
            console.log(`\n✅ All ${LOCATIONS.length} locations scanned — no more jobs`);
            break;
          }
        } else {
          console.log(`😴 No nationwide jobs — switching to location mode`);
          locMode  = true;
          locIndex = 0;
        }
        continue;
      }

      jobQueue      = mergedJobs;
      queueIndex    = 0;
      totalScanned += mergedJobs.length;  // running tally for report
      writeReport();

      console.log(`\n🎯 ${mergedJobs.length} jobs queued — launching ${NUM_WORKERS} workers\n`);
      initAppliedFile(mergedJobs.length);
      printDashboard();

      // Phase 2 — 4 apply workers drain the queue
      await Promise.all(
        Array.from({ length: NUM_WORKERS }, (_, i) =>
          runWorker(`W${i + 1}`, context, appliedJobs, i * 2000)
        )
      );

      writeReport();
      printDashboard();

      if (locMode) {
        locIndex++;
        if (locIndex >= LOCATIONS.length) {
          console.log(`\n✅ All ${LOCATIONS.length} locations done`);
          break;
        }
        // continue to next city
      } else {
        break;  // nationwide jobs applied — done
      }
    }

  } catch (err) {
    console.error(`\n❌ Fatal:`, err.stack || err.message);
  } finally {
    clearInterval(dashInterval);
    clearInterval(reportInterval);
    writeReport(); // final snapshot
    writeSessionSummary();
    await context.close().catch(e => console.error('Failed to close context:', e.message));
  }

  const ran = Math.floor((Date.now() - startTime) / 60000);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🏁 Session Complete — ran ${ran} min`);
  console.log(`✅ Applied: ${stats.applied} | ⏭️ Skipped: ${stats.skipped} | ❌ Failed: ${stats.failed} | ❓ Uncertain: ${stats.uncertain}`);
  console.log(`Scanned log  → ${SCANNED_FILE}`);
  console.log(`Applied log  → ${APPLIED_FILE}`);
  console.log(`Live report  → ${reportPath}`);
  console.log(`${'═'.repeat(60)}\n`);
}

// ─── LOGIN MODE ───────────────────────────────────────────────────────────────

async function loginMode() {
  // login is now smart: auto-detects session, logs in if needed, then starts applying
  await runBot();
}

// ─── PROBE MODE — inspect one job page to verify selectors ───────────────────

async function probeMode() {
  console.log(`\n🔬 PROBE MODE — opening a sample job page to inspect DOM\n`);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  // Always open a fresh page — existing pages from the profile can be stale/closed
  for (const p of ctx.pages()) await p.close().catch(() => {});
  const page = await ctx.newPage();

  // 1. Load the search page, then pause so user can see it / dismiss any popups
  const scanUrl = SEARCH_URLS[0];
  console.log(`Loading search page: ${scanUrl}`);
  await page.goto(scanUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
    page.goto(scanUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
  );
  console.log(`\n⏸️  Browser is open. Dismiss any popups / confirm page looks right, then press ENTER to extract jobs...`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();
  await scrollToLoadAll(page);

  const jobs = await extractJobsFromPage(page);
  console.log(`\n📋 Found ${jobs.length} job(s) on search page`);
  jobs.slice(0, 5).forEach((j, i) => console.log(`   ${i + 1}. [${j.id}] ${j.title} | posted: ${j.posted || 'unknown'} | ${j.url}`));

  if (jobs.length === 0) {
    console.log(`\n❌ No jobs extracted — search page selectors may need adjustment`);

    // Dump all links on page that contain "/job"
    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/job"]'))
        .map(a => ({ href: a.href, text: a.textContent.trim().slice(0, 80) }))
        .filter(l => l.href.includes('roberthalf.com'))
        .slice(0, 20)
    );
    console.log(`\n🔗 All /job links on page:`);
    allLinks.forEach(l => console.log(`   ${l.text.padEnd(50)}  →  ${l.href}`));
    await ctx.close();
    return;
  }

  // 2. Open the first job and probe apply button
  const testJob = jobs[0];
  console.log(`\n🔗 Opening: ${testJob.url}`);
  await page.goto(testJob.url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
    page.goto(testJob.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
  );
  console.log(`\n⏸️  Job detail page open. Press ENTER to dump all buttons/links...`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();
  await page.waitForTimeout(1000);

  // Dump all visible buttons and links
  const interactive = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a'))
      .filter(el => el.offsetParent !== null)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        text: el.textContent.trim().slice(0, 60),
        href: el.href || '',
        classes: el.className.slice(0, 80),
      }))
      .filter(el => el.text)
      .slice(0, 40)
  );

  console.log(`\n🖱️  All visible buttons/links on job detail page:`);
  interactive.forEach(el => {
    const dest = el.href ? `  →  ${el.href.slice(0, 80)}` : '';
    console.log(`   <${el.tag}> "${el.text}"${dest}`);
  });

  console.log(`\n✅ Probe complete. Review the output above, then press ENTER to close...`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();
  await ctx.close();
}

// ─── FORM TEST MODE ───────────────────────────────────────────────────────────

async function formTestMode(applyUrl) {
  console.log(`\n[formtest] URL: ${applyUrl}`);
  console.log(`[formtest] Resume: ${PROFILE.resumePath} (exists: ${fs.existsSync(PROFILE.resumePath)})\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
    page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  );
  await page.waitForTimeout(3000);
  console.log(`[formtest] Landed: ${page.url()}`);

  const fields = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input, select, textarea')).map(el => {
      const labelEl = el.id && document.querySelector(`label[for="${el.id}"]`);
      return {
        tag: el.tagName, type: el.getAttribute('type') || '',
        name: el.name || '', id: el.id || '',
        value: (el.type === 'radio' || el.type === 'checkbox') ? el.value : '',
        label: labelEl ? labelEl.textContent.trim() : '',
        required: el.required,
      };
    })
  );
  console.log('\n[formtest] ── Form fields ──');
  fields.forEach(f => {
    console.log(`  <${f.tag} type="${f.type}" name="${f.name}" id="${f.id}" ${f.required ? 'required' : ''}`);
    if (f.label) console.log(`      label="${f.label}"`);
    if (f.value) console.log(`      value="${f.value}"`);
  });
  console.log('[formtest] ──────────────────\n');

  console.log('[formtest] Press ENTER to fill the form...');
  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();

  if (typeof fillApplyForm === 'function') await fillApplyForm(page, 'FT');

  console.log('\n[formtest] Form filled. Inspect browser, then press ENTER to SUBMIT (Ctrl+C to abort).');
  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();

  if (typeof navigateApplyForm === 'function') {
    const result = await navigateApplyForm(page, 'FT', true);
    console.log(`[formtest] Result: ${result}`);
  } else {
    const submitted = await page.evaluate(() => {
      const btn = document.querySelector('#SubmitButton, button[type="submit"], input[type="submit"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    console.log(`[formtest] Submit clicked: ${submitted}`);
  }

  console.log('[formtest] Press ENTER to close.');
  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();
  await context.close();
}

// ─── ENTRY ────────────────────────────────────────────────────────────────────

const arg = process.argv[2];
if (arg === 'login') {
  loginMode().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'probe') {
  probeMode().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'test') {
  MAX_JOBS = 1;
  console.log('[test] Single-job test mode — will stop after 1 application attempt.');
  runBot(null).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'formtest') {
  const url = process.argv[3];
  if (!url) { console.error('[err] Usage: node roberthalf-bot.js formtest <applyUrl>'); process.exit(1); }
  formTestMode(url).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else {
  runBot().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
