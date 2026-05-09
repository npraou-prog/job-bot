#!/usr/bin/env node
/**
 * TekSystems Job Application Bot — 4 Parallel Workers
 *
 * RUN:    node teksystems-bot.js [minutes]   ← load session, scan, apply
 * LOGIN:  node teksystems-bot.js login       ← open browser, user logs in, saves session
 * PROBE:  node teksystems-bot.js probe       ← inspect one search/apply page, print DOM info
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── USER PROFILE ─────────────────────────────────────────────────────────────

const PROFILE = {
  firstName:      'Nikhil',
  lastName:       'Premachandra Rao',
  fullName:       'Nikhil Premachandra Rao',
  email:          'nikhilprao9066@gmail.com',
  phone:          '7746368916',
  city:           'Atlanta',
  state:          'GA',
  stateFullName:  'Georgia',
  zip:            '30519',
  country:        'United States',
  street:         '4188 woodfern ln',
  linkedin:       'https://linkedin.com/in/nikhil-p-rao',
  portfolio:      'https://nikprao.vercel.app',
  github:         '',
  yearsExp:       '5',
  salary:         '100000',
  noticeDays:     '14',
  sponsorship:    false,
  citizenStatus:  'Non-citizen allowed to work for any employer',
  ethnicity:      'Asian',
  gender:         'Male',
  disability:     false,
  veteran:        false,
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

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const HOME_DIR      = process.env.HOME || process.env.USERPROFILE || '';
const PROFILE_DIR   = process.env.TS_PROFILE_PATH || path.join(HOME_DIR, 'teksystems-bot-profile');
const LOGIN_URL     = 'https://careers.teksystems.com/us/en/login';
const BASE_SEARCH   = 'https://careers.teksystems.com/us/en/search-results';
const WORKSPACE_DIR = path.join(HOME_DIR, '.openclaw', 'workspace');
const STATUS_FILE   = path.join(WORKSPACE_DIR, 'teksystems_worker_status.json');
const SCANNED_FILE  = path.join(__dirname, 'scanned_jobs.txt');
const APPLIED_FILE  = path.join(__dirname, 'applied_jobs.txt');
const FAILED_FILE   = path.join(__dirname, 'failed_jobs.txt');
const APPLIED_IDS   = path.join(__dirname, 'applied_ids.txt');

const NUM_WORKERS    = 4;
const RATE_LIMIT_MS  = 8000;   // ms between applications per worker
const PAGE_TIMEOUT   = 25000;
const BATCH_SIZE     = 200;
const RESCAN_WAIT_MS = 90000;  // wait between full scans

// Search keywords — Phenom People uses ?keywords= param
const SEARCH_KEYWORDS = [
  'data scientist',
  'machine learning engineer',
  'machine learning',
  'data science',
  'applied scientist',
  'nlp engineer',
  'artificial intelligence engineer',
];

// Build search URL with dateCreated=1 (last 24 hours) and from=0 for pagination
function buildSearchUrl(keyword, fromOffset = 0) {
  const kw = encodeURIComponent(keyword);
  return `${BASE_SEARCH}?keywords=${kw}&dateCreated=1&from=${fromOffset}`;
}

// Block list for non-DS titles
const TITLE_BLOCK_RE = /\b(data\s*engineer(ing)?|database\s*(developer|admin|architect|engineer)|etl\s*(developer|engineer)?|data\s*analyst|pipeline\s*engineer|bi\s*(developer|engineer)|reporting\s*(developer|analyst)|qa\s*(engineer|analyst)|quality\s*assurance|recruiter|sales|talent\s*acquisition|staffing|account\s*manager|software\s*engineer(?!\s*(ml|machine|ai|llm)))\b/i;

// Accepted title keywords — at least one must appear
const TITLE_ALLOW_RE = /data\s*scien|machine\s*learn|ml\s*engineer|applied\s*scient|ai\s*engineer|nlp|natural\s*language|artificial\s*intel|analytics\s*engineer|deep\s*learn|computer\s*vision|large\s*language|llm/i;

// ─── SHARED STATE ─────────────────────────────────────────────────────────────

let _shouldStop = false;
let _sigintCount = 0;
let MAX_JOBS = Infinity;

process.on('SIGINT', () => {
  _sigintCount++;
  if (_sigintCount >= 2) { console.log('\nForce exiting.'); process.exit(1); }
  _shouldStop = true;
  console.log('\n[WARN] Stopping after current job. (Ctrl+C again to force quit)');
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

let reportPath      = '';
let reportStartTime = null;
let totalScanned    = 0;
let reportLog       = [];

// ─── FILE HELPERS ─────────────────────────────────────────────────────────────

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadAppliedIds() {
  ensureDir(APPLIED_IDS);
  if (!fs.existsSync(APPLIED_IDS)) { fs.writeFileSync(APPLIED_IDS, ''); return new Set(); }
  return new Set(fs.readFileSync(APPLIED_IDS, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
}

function markApplied(jobId) {
  ensureDir(APPLIED_IDS);
  fs.appendFileSync(APPLIED_IDS, jobId + '\n');
}

// ─── SCANNED JOBS FILE ────────────────────────────────────────────────────────

function writeScannedJobs(allJobsOnPage, queuedIds, appliedJobs) {
  ensureDir(SCANNED_FILE);
  const ts       = new Date().toLocaleString('en-US', { hour12: false });
  const newCount  = queuedIds.size;
  const skipCount = allJobsOnPage.length - newCount;

  const lines = [
    '='.repeat(80),
    `TEKSYSTEMS SCAN  —  ${ts}`,
    `${allJobsOnPage.length} jobs found  |  ${newCount} new  |  ${skipCount} already applied / filtered`,
    '='.repeat(80),
    '',
  ];

  allJobsOnPage.forEach((j, i) => {
    const already = appliedJobs.has(j.id);
    const badge   = already
      ? '[ALREADY APPLIED]'
      : (queuedIds.has(j.id) ? '[QUEUED          ]' : '[FILTERED        ]');
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
    `TEKSYSTEMS SESSION  —  ${ts}`,
    `${queueSize} jobs queued for application`,
    '='.repeat(80),
    '',
  ].join('\n'));
}

function writeAppliedEntry(workerId, title, company, jobId, status, jobUrl) {
  ensureDir(APPLIED_FILE);
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
  ensureDir(APPLIED_FILE);
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
  const url  = jobUrl || `https://careers.teksystems.com (ID: ${jobId})`;
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

// ─── STATUS FILE ──────────────────────────────────────────────────────────────

function updateStatus(workerId, state, jobTitle = '') {
  workerStatus[workerId] = {
    state,
    job:        jobTitle.slice(0, 50),
    lastUpdate: new Date().toLocaleTimeString('en-US', { hour12: false }),
  };
  try {
    ensureDir(STATUS_FILE);
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      stats,
      workers: workerStatus,
      queue: {
        total:     jobQueue.length,
        remaining: jobQueue.length - queueIndex,
        processed: queueIndex,
      },
      updated: new Date().toLocaleTimeString(),
    }, null, 2));
  } catch (e) {
    console.warn(`   [WARN] Status file write error: ${e.message}`);
  }
}

// ─── COLORED WORKER LOGGING ───────────────────────────────────────────────────

function wlog(workerId, msg) {
  const colors = { W1: '\x1b[36m', W2: '\x1b[33m', W3: '\x1b[35m', W4: '\x1b[32m' };
  const reset  = '\x1b[0m';
  const color  = colors[workerId] || '';
  console.log(`${color}[${workerId}]${reset} ${msg}`);
}

// ─── DATE / RECENCY FILTER ────────────────────────────────────────────────────

function isRecentJob(postedText) {
  if (!postedText) return true; // unknown — let through
  const t = postedText.toLowerCase();
  if (t.includes('just now') || t.includes('today') || t.includes('hour') || t.includes('minute')) return true;
  if (t.includes('1 day') || t.includes('yesterday')) return true;
  if (t.includes('day') || t.includes('week') || t.includes('month')) return false;
  return true;
}

// ─── SCROLL TO LOAD LAZY JOB CARDS ───────────────────────────────────────────

async function scrollToLoadAll(page) {
  let prev = 0;
  for (let i = 0; i < 12; i++) {
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      const count = await page.evaluate(() =>
        document.querySelectorAll('a[href*="/job/JP-"]').length
      );
      if (count === prev && i > 2) break;
      prev = count;
    } catch (e) {
      break; // SPA navigated mid-scroll
    }
  }
  try { await page.evaluate(() => window.scrollTo(0, 0)); } catch (_) {}
}

// ─── EXTRACT JOB CARDS FROM PHENOM SPA ───────────────────────────────────────

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    const map = {};

    // Strategy 1: links containing /job/JP-
    const links = Array.from(document.querySelectorAll('a[href*="/job/JP-"]'));
    for (const a of links) {
      const href = a.href || '';
      // Extract JP-XXXXXXXXX from URL: /job/JP-005564162/...
      const m = href.match(/\/job\/(JP-\d{9})/);
      if (!m) continue;
      const id = m[1];
      if (!map[id]) {
        map[id] = { id, title: '', company: '', posted: '', url: href.split('?')[0] };
      }
      const text = (a.textContent || '').trim();
      if (!text) continue;
      if (/\d+\s*(hour|minute|day|week|month)|today|just now|yesterday/i.test(text)) {
        map[id].posted = text;
      } else if (text.length > 4 && text.length > (map[id].title || '').length) {
        map[id].title = text;
      }
    }

    // Strategy 2: data-ph-at-id links (Phenom standard attribute)
    const phenomLinks = Array.from(document.querySelectorAll(
      '[data-ph-at-id="job-item-title-link"], [data-ph-at-id*="job-title"]'
    ));
    for (const a of phenomLinks) {
      const href = a.href || '';
      const m = href.match(/\/job\/(JP-\d{9})/);
      if (!m) continue;
      const id = m[1];
      if (!map[id]) {
        map[id] = { id, title: '', company: '', posted: '', url: href.split('?')[0] };
      }
      const text = (a.textContent || '').trim();
      if (text.length > 4) map[id].title = text;
    }

    // Enrich each entry with card-level metadata
    for (const id of Object.keys(map)) {
      const a = document.querySelector(`a[href*="/job/${id}"]`);
      if (!a) continue;

      const card = a.closest(
        '[data-ph-at-id="jobs-list-item"], [class*="job-card"], [class*="jobCard"], ' +
        '[class*="job-listing"], [class*="jobListing"], [class*="result-item"], article, li'
      );
      if (!card) continue;

      // Posted date
      if (!map[id].posted) {
        const allText = card.innerText || '';
        const dm = allText.match(/(\d+\s+(?:hour|minute|day|week|month)s?\s+ago|today|just now|yesterday)/i);
        if (dm) map[id].posted = dm[0];
      }

      // Company / location text — Phenom often has a subtitle element
      if (!map[id].company) {
        const compEl = card.querySelector(
          '[data-ph-at-id="job-item-company-text"], [class*="company"], ' +
          '[class*="employer"], [class*="location"], [class*="subtitle"]'
        );
        if (compEl) {
          const txt = compEl.textContent.trim();
          if (txt && txt.length < 80) map[id].company = txt;
        }
      }
    }

    return Object.values(map).filter(j => j.url && j.id);
  });
}

// ─── BUILD APPLY URL FROM JOB ID ─────────────────────────────────────────────

function buildApplyUrl(jobId) {
  // JP-005564162 → TESYUSJP005564162ENUS
  const jobSeqNo = 'TESYUS' + jobId.replace('JP-', 'JP') + 'ENUS';
  return `https://careers.teksystems.com/us/en/apply?jobSeqNo=${jobSeqNo}`;
}

// ─── SCAN ONE KEYWORD ─────────────────────────────────────────────────────────

async function scanKeyword(context, keyword, appliedJobs) {
  console.log(`\n[scan] Keyword: "${keyword}"`);
  const page    = await context.newPage();
  const found   = [];
  const allSeen = [];
  const seenIds = new Set();
  let fromOffset = 0;
  let totalAdded = 0;
  let totalOld   = 0;

  try {
    while (found.length < BATCH_SIZE) {
      const url = buildSearchUrl(keyword, fromOffset);
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
          page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
        );
        await page.waitForTimeout(3000);
        await scrollToLoadAll(page);

        // Check for empty results
        const noJobs = await page.evaluate(() => {
          const body = (document.body.innerText || '').toLowerCase();
          return (
            body.includes('no jobs found') ||
            body.includes('no results found') ||
            body.includes('0 jobs') ||
            body.includes("we couldn't find") ||
            body.includes('no matching jobs')
          );
        }).catch(() => false);

        if (noJobs) {
          if (fromOffset === 0) {
            console.log(`   [skip] No results for "${keyword}"`);
          } else {
            console.log(`   [done] "${keyword}" page from=${fromOffset}: end of results`);
          }
          break;
        }

        const jobs = await extractJobsFromPage(page);
        if (jobs.length === 0) {
          if (fromOffset > 0) {
            console.log(`   [done] "${keyword}" from=${fromOffset}: no cards found`);
          }
          break;
        }

        const newOnPage = jobs.filter(j => !seenIds.has(j.id));
        if (fromOffset > 0 && newOnPage.length === 0) break; // duplicate page — stop

        for (const job of jobs) {
          if (seenIds.has(job.id)) continue;
          seenIds.add(job.id);
          allSeen.push(job);

          if (appliedJobs.has(job.id)) continue;
          if (!isRecentJob(job.posted)) { totalOld++; continue; }

          // Title filter — skip clearly non-DS roles
          if (job.title && TITLE_BLOCK_RE.test(job.title)) {
            console.log(`   [filter] Blocked title: ${job.title}`);
            continue;
          }
          // Optional: must have at least one DS keyword (relaxed — pass if title unknown)
          if (job.title && !TITLE_ALLOW_RE.test(job.title)) {
            console.log(`   [filter] No DS keyword in title: ${job.title}`);
            continue;
          }

          found.push({
            id:      job.id,
            url:     job.url,
            applyUrl: buildApplyUrl(job.id),
            title:   job.title || job.id,
            company: job.company || '',
            posted:  job.posted,
          });
          totalAdded++;
        }

        console.log(`   "${keyword}" from=${fromOffset}: ${jobs.length} cards | ${newOnPage.length} new | running: ${totalAdded} to apply`);
        fromOffset += 10;

      } catch (err) {
        console.error(`   [error] "${keyword}" from=${fromOffset}: ${err.message}`);
        break;
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  console.log(`   [done] "${keyword}": ${totalAdded} queued | ${totalOld} >24h skipped`);
  return { found, allSeen };
}

// ─── FILL FORM FIELD HELPERS ──────────────────────────────────────────────────

async function fillInput(page, selectors, value, workerId) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible({ timeout: 2000 })) {
        await loc.fill('');
        await loc.fill(value);
        return true;
      }
    } catch (_) { /* try next */ }
  }
  return false;
}

async function selectOption(page, selectors, valueOrLabel, workerId) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible({ timeout: 2000 })) {
        // Try by value, then by label
        try { await loc.selectOption({ value: valueOrLabel }); return true; } catch (_) {}
        try { await loc.selectOption({ label: valueOrLabel }); return true; } catch (_) {}
      }
    } catch (_) { /* try next */ }
  }
  return false;
}

// ─── UPLOAD RESUME ────────────────────────────────────────────────────────────

async function uploadResume(page, workerId) {
  if (!fs.existsSync(PROFILE.resumePath)) {
    wlog(workerId, `   [WARN] resume.pdf not found at ${PROFILE.resumePath} — skipping upload`);
    return false;
  }

  const uploadSelectors = [
    'input[type="file"][accept*="pdf"]',
    'input[type="file"][name*="resume"]',
    'input[type="file"][name*="cv"]',
    'input[type="file"]',
  ];

  for (const sel of uploadSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        await loc.setInputFiles(PROFILE.resumePath);
        wlog(workerId, `   [upload] Resume uploaded via ${sel}`);
        await page.waitForTimeout(2000);
        return true;
      }
    } catch (_) { /* try next */ }
  }

  // Phenom sometimes has a styled "Upload Resume" button that triggers a hidden input
  try {
    const uploadBtn = page.locator('button, label', { hasText: /upload.*resume|attach.*resume|upload.*cv/i }).first();
    if (await uploadBtn.count() > 0 && await uploadBtn.isVisible({ timeout: 2000 })) {
      // Set up file chooser intercept
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }),
        uploadBtn.click(),
      ]);
      await fileChooser.setFiles(PROFILE.resumePath);
      wlog(workerId, `   [upload] Resume uploaded via button click`);
      await page.waitForTimeout(2000);
      return true;
    }
  } catch (_) { /* no button */ }

  wlog(workerId, `   [WARN] Could not find resume upload input — continuing`);
  return false;
}

// ─── FILL PERSONAL INFO ───────────────────────────────────────────────────────

async function fillPersonalInfo(page, workerId) {
  let filled = 0;

  // First name
  if (await fillInput(page,
    ['input[name*="firstName" i]', 'input[id*="firstName" i]', 'input[placeholder*="first name" i]',
     '[data-ph-at-id="first-name-input"] input', 'input[name="fname"]'],
    PROFILE.firstName, workerId
  )) { filled++; }

  // Last name
  if (await fillInput(page,
    ['input[name*="lastName" i]', 'input[id*="lastName" i]', 'input[placeholder*="last name" i]',
     '[data-ph-at-id="last-name-input"] input', 'input[name="lname"]'],
    PROFILE.lastName, workerId
  )) { filled++; }

  // Email
  if (await fillInput(page,
    ['input[name*="email" i]', 'input[type="email"]', 'input[id*="email" i]',
     '[data-ph-at-id="email-input"] input'],
    PROFILE.email, workerId
  )) { filled++; }

  // Phone
  if (await fillInput(page,
    ['input[name*="phone" i]', 'input[type="tel"]', 'input[id*="phone" i]',
     '[data-ph-at-id="phone-input"] input', 'input[placeholder*="phone" i]'],
    PROFILE.phone, workerId
  )) { filled++; }

  // Address fields (if present)
  await fillInput(page,
    ['input[name*="address" i]', 'input[id*="address" i]', 'input[placeholder*="street" i]'],
    PROFILE.street, workerId
  );
  await fillInput(page,
    ['input[name*="city" i]', 'input[id*="city" i]', 'input[placeholder*="city" i]'],
    PROFILE.city, workerId
  );
  await fillInput(page,
    ['input[name*="zip" i]', 'input[name*="postal" i]', 'input[id*="zip" i]'],
    PROFILE.zip, workerId
  );

  // State dropdown
  await selectOption(page,
    ['select[name*="state" i]', 'select[id*="state" i]'],
    PROFILE.state, workerId
  );
  await selectOption(page,
    ['select[name*="state" i]', 'select[id*="state" i]'],
    PROFILE.stateFullName, workerId
  );

  if (filled > 0) wlog(workerId, `   [form] Filled ${filled} personal info field(s)`);
  return filled;
}

// ─── ANSWER SCREENING QUESTIONS ───────────────────────────────────────────────

async function answerScreeningQuestions(page, workerId) {
  const answered = await page.evaluate(({ yearsExp, sponsorship }) => {
    const SPONSOR_RE = /sponsor|visa\s*transfer|work\s*visa|h[1-4]b|opt|cpt|require.*sponsor/i;
    const AUTH_RE    = /authoriz|eligible|legally\s*work|work.*us|permitted|right\s*to\s*work/i;
    const YES_RE     = /\byes\b/i;
    const NO_RE      = /\bno\b/i;
    const PLACEHOLDER_RE = /^(select|choose|please|--|none|0|null|undefined)$/i;

    let count = 0;

    // ── Radio buttons ──
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const groups = {};
    for (const r of radios) {
      const key = r.name || r.closest('fieldset')?.id || Math.random().toString();
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }

    for (const [, options] of Object.entries(groups)) {
      if (options.some(r => r.checked)) continue;

      const fieldset   = options[0].closest('fieldset, [role="group"]');
      const labelEl    = fieldset
        ? fieldset.querySelector('legend, [class*="label"], [class*="question"]')
        : null;
      const groupLabel = (labelEl ? labelEl.textContent : (fieldset ? fieldset.textContent : '')).toLowerCase();

      const wantNo = SPONSOR_RE.test(groupLabel);
      const wantYes = AUTH_RE.test(groupLabel);

      let pick = null;
      if (wantNo) {
        pick = options.find(r => NO_RE.test(r.value) || NO_RE.test(r.parentElement?.textContent || ''));
      } else if (wantYes) {
        pick = options.find(r => YES_RE.test(r.value) || YES_RE.test(r.parentElement?.textContent || ''));
      }
      if (!pick) {
        // Default: Yes for anything unknown
        pick = options.find(r => YES_RE.test(r.value) || YES_RE.test(r.parentElement?.textContent || ''));
      }
      if (!pick) pick = options[0];

      pick.click();
      pick.dispatchEvent(new Event('change', { bubbles: true }));
      count++;
    }

    // ── Select dropdowns ──
    for (const sel of document.querySelectorAll('select')) {
      if (sel.value && !PLACEHOLDER_RE.test(sel.value.trim())) continue;
      const label = (sel.labels?.[0]?.textContent || sel.name || sel.id || '').toLowerCase();

      let chosen = null;
      const opts = Array.from(sel.options).filter(o =>
        o.value && !PLACEHOLDER_RE.test(o.value.trim()) && !PLACEHOLDER_RE.test(o.text.trim())
      );

      if (SPONSOR_RE.test(label)) {
        chosen = opts.find(o => NO_RE.test(o.text)) || opts[opts.length - 1];
      } else if (AUTH_RE.test(label)) {
        chosen = opts.find(o => YES_RE.test(o.text)) || opts[0];
      } else if (/years.*exp|experience/i.test(label)) {
        // Pick the option whose text contains the yearsExp number
        chosen = opts.find(o => o.text.includes(yearsExp)) || opts[0];
      } else {
        chosen = opts[0];
      }

      if (chosen) {
        sel.value = chosen.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        count++;
      }
    }

    // ── Text inputs that look like experience / salary ──
    for (const inp of document.querySelectorAll('input[type="text"], input[type="number"]')) {
      if (inp.value) continue;
      const label = (inp.labels?.[0]?.textContent || inp.placeholder || inp.name || '').toLowerCase();
      if (/years.*exp|experience/i.test(label)) {
        inp.value = yearsExp;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        count++;
      } else if (/salary|compensation|pay/i.test(label)) {
        inp.value = '100000';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        count++;
      }
    }

    return count;
  }, { yearsExp: PROFILE.yearsExp, sponsorship: PROFILE.sponsorship }).catch(() => 0);

  if (answered > 0) {
    wlog(workerId, `   [form] Answered ${answered} screening question(s)`);
    await page.waitForTimeout(600);
  }
  return answered;
}

// ─── NAVIGATE PHENOM MULTI-STEP APPLY FORM ───────────────────────────────────

const CONFIRM_RE = /thank\s*you\s*for\s*apply|application.*submitted|application.*received|successfully\s*applied|you.ve\s*applied|we.ve\s*received\s*your\s*application|application\s*complete|your\s*application\s*has\s*been/i;

async function navigateApplyForm(page, workerId) {
  const maxSteps = 15;
  let resumeUploaded = false;

  for (let step = 0; step < maxSteps; step++) {
    if (_shouldStop) return 'UNCERTAIN';
    await page.waitForTimeout(2500);

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

    // ── Confirmation check ──
    if (CONFIRM_RE.test(bodyText) || /submitted|thank\s*you|successfully/i.test(bodyText)) {
      return 'APPLIED';
    }

    // ── Error / already applied check ──
    if (/already\s*applied|duplicate\s*application/i.test(bodyText)) {
      wlog(workerId, `   [info] Already applied to this job`);
      return 'ALREADY_APPLIED';
    }

    // ── Login wall check ──
    if (/sign\s*in|log\s*in|create\s*account/i.test(bodyText) && step > 1) {
      wlog(workerId, `   [warn] Hit login wall — may need re-authentication`);
      return 'FAILED';
    }

    // ── Fill personal info (first pass on first step) ──
    if (step === 0) {
      await fillPersonalInfo(page, workerId);
    }

    // ── Upload resume if an upload field is visible ──
    if (!resumeUploaded) {
      const hasUpload = await page.locator('input[type="file"]').count().catch(() => 0);
      const hasUploadBtn = await page.locator('button, label').filter({ hasText: /upload|attach/i }).count().catch(() => 0);
      if (hasUpload > 0 || hasUploadBtn > 0) {
        resumeUploaded = await uploadResume(page, workerId);
      }
    }

    // ── Answer screening questions ──
    await answerScreeningQuestions(page, workerId);

    // ── Submit button ──
    const submitSelectors = [
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
      'button:has-text("Send Application")',
      'button:has-text("Complete Application")',
      'button:has-text("Finish")',
      '[data-ph-at-id="submit-button"]',
      '[data-ph-at-id*="submit"]',
      'button[type="submit"]',
    ];
    const submitLoc = page.locator(submitSelectors.join(', ')).first();
    try {
      if (await submitLoc.count() > 0 && await submitLoc.isVisible({ timeout: 2000 })) {
        const isEnabled = await submitLoc.isEnabled().catch(() => true);
        if (isEnabled) {
          wlog(workerId, `   [step ${step + 1}] Clicking Submit`);
          await submitLoc.click();
          // Wait up to 25s for confirmation
          try {
            await page.waitForFunction(
              () => /submitted|thank\s*you|successfully|application.*received|you.ve\s*applied/i.test(document.body.innerText),
              { timeout: 25000 }
            );
            return 'APPLIED';
          } catch {
            const afterText = await page.evaluate(() => document.body.innerText).catch(() => '');
            if (CONFIRM_RE.test(afterText)) return 'APPLIED';
            return 'UNCERTAIN';
          }
        }
      }
    } catch (e) {
      wlog(workerId, `   [warn] Submit click error: ${e.message}`);
    }

    // ── Next / Continue button ──
    const nextSelectors = [
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Next Step")',
      'button:has-text("Save & Continue")',
      '[data-ph-at-id="next-button"]',
      '[data-ph-at-id*="next"]',
      'button[data-ph-at-id*="continue"]',
    ];
    const nextLoc = page.locator(nextSelectors.join(', ')).first();
    try {
      if (await nextLoc.count() > 0 && await nextLoc.isVisible({ timeout: 2000 }) && await nextLoc.isEnabled()) {
        wlog(workerId, `   [step ${step + 1}] Clicking Next/Continue`);
        await nextLoc.click();
        continue;
      }
    } catch (e) {
      wlog(workerId, `   [warn] Next click error: ${e.message}`);
    }

    // ── JS fallback for Next / Continue ──
    const clickedNext = await page.evaluate(() => {
      for (const el of document.querySelectorAll('button, a, [role="button"]')) {
        const txt = (el.textContent || '').trim();
        if (/^(Next|Continue|Next Step|Save & Continue|Proceed)$/i.test(txt) && el.offsetParent !== null) {
          el.click(); return txt;
        }
      }
      return null;
    }).catch(() => null);

    if (clickedNext) {
      wlog(workerId, `   [step ${step + 1}] Clicked "${clickedNext}" via JS fallback`);
      continue;
    }

    // ── Nothing clickable — log visible elements for debugging ──
    const visible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a[role="button"]'))
        .filter(b => b.offsetParent !== null)
        .map(b => (b.textContent || '').trim())
        .filter(Boolean)
    ).catch(() => []);
    wlog(workerId, `   [step ${step + 1}] No Next/Submit found. Visible: [${visible.slice(0, 8).join(' | ')}]`);
    break;
  }

  return 'UNCERTAIN';
}

// ─── APPLY TO ONE JOB ─────────────────────────────────────────────────────────

async function applyToJob(context, job, workerId, jobNumber) {
  wlog(workerId, `[apply] #${jobNumber} — ${job.title} | ${job.posted || 'no date'}`);
  updateStatus(workerId, 'APPLYING', job.title);

  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (_shouldStop) { updateStatus(workerId, 'IDLE'); return 'SKIPPED'; }
    if (attempt > 1) {
      wlog(workerId, `   [retry] Attempt ${attempt}/${MAX_RETRIES}`);
      await new Promise(r => setTimeout(r, 5000));
    }

    const applyPage = await context.newPage();
    try {
      // Navigate directly to the apply URL (skips job detail page)
      const applyUrl = job.applyUrl || buildApplyUrl(job.id);
      wlog(workerId, `   [nav] ${applyUrl}`);

      await applyPage.goto(applyUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
        applyPage.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
      );
      await applyPage.waitForTimeout(3000);

      // Check for 404 / job expired
      const pageText = await applyPage.evaluate(() => document.body.innerText).catch(() => '');
      if (/job.*not found|position.*closed|no longer available|expired|404/i.test(pageText)) {
        wlog(workerId, `   [skip] Job not found / expired`);
        writeAppliedEntry(workerId, job.title, job.company, job.id, 'SKIPPED', applyUrl);
        stats.skipped++;
        logReport('SKIPPED', job.title, job.company, applyUrl, job.id, 'job not found or expired');
        await applyPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      // Check if already applied (Phenom sometimes shows this immediately)
      if (/already\s*applied|duplicate\s*application/i.test(pageText)) {
        wlog(workerId, `   [skip] Already applied`);
        markApplied(job.id);
        writeAppliedEntry(workerId, job.title, job.company, job.id, 'SKIPPED', applyUrl);
        stats.skipped++;
        logReport('SKIPPED', job.title, job.company, applyUrl, job.id, 'already applied');
        await applyPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      // Check if redirected to login page
      const currentUrl = applyPage.url();
      if (/login|sign-in|signin/i.test(currentUrl) && !/apply/i.test(currentUrl)) {
        wlog(workerId, `   [warn] Redirected to login at ${currentUrl} — session may have expired`);
        await applyPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }

      // Run the form navigation
      const result = await navigateApplyForm(applyPage, workerId);
      await applyPage.close().catch(() => {});

      if (result === 'APPLIED') {
        wlog(workerId, `   [ok] APPLIED — ${job.title}`);
        markApplied(job.id);
        writeAppliedEntry(workerId, job.title, job.company, job.id, 'APPLIED', applyUrl);
        stats.applied++;
        logReport('APPLIED', job.title, job.company, applyUrl, job.id, '');
        updateStatus(workerId, 'IDLE');
        return 'APPLIED';
      }

      if (result === 'ALREADY_APPLIED') {
        markApplied(job.id);
        writeAppliedEntry(workerId, job.title, job.company, job.id, 'SKIPPED', applyUrl);
        stats.skipped++;
        logReport('SKIPPED', job.title, job.company, applyUrl, job.id, 'already applied');
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      if (result === 'UNCERTAIN') {
        wlog(workerId, `   [uncertain] UNCERTAIN — ${job.title}`);
        markApplied(job.id);
        writeAppliedEntry(workerId, job.title, job.company, job.id, 'UNCERTAIN', applyUrl);
        writeFailedEntry(workerId, job.title, job.company, job.id, 'UNCERTAIN', 'submitted but no confirmation detected', applyUrl);
        stats.uncertain++;
        logReport('UNCERTAIN', job.title, job.company, applyUrl, job.id, 'submitted but no confirmation detected');
        updateStatus(workerId, 'IDLE');
        return 'UNCERTAIN';
      }

      // FAILED — retry
      wlog(workerId, `   [fail] Result=${result} on attempt ${attempt}`);

    } catch (err) {
      wlog(workerId, `   [error] Attempt ${attempt}: ${err.stack || err.message}`);
      await applyPage.close().catch(() => {});
      if (/closed|destroyed|Target page/i.test(err.message)) {
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }
      if (attempt === MAX_RETRIES) {
        markApplied(job.id);
        writeAppliedEntry(workerId, job.title, job.company, job.id, 'FAILED', job.applyUrl || '');
        writeFailedEntry(workerId, job.title, job.company, job.id, 'FAILED', err.message, job.applyUrl || '');
        stats.failed++;
        logReport('FAILED', job.title, job.company, job.applyUrl || '', job.id, err.message);
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }
    }
  }

  markApplied(job.id);
  writeFailedEntry('--', job.title, job.company, job.id, 'FAILED', 'exhausted retries', job.applyUrl || '');
  logReport('FAILED', job.title, job.company, job.applyUrl || '', job.id, 'exhausted retries');
  stats.failed++;
  updateStatus(workerId, 'IDLE');
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
      updateStatus(workerId, 'WAITING');
      break;
    }

    stats.total++;
    const jobNumber = stats.total;
    appliedJobs.add(job.id);

    await applyToJob(context, job, workerId, jobNumber);
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  wlog(workerId, `[done] Worker done — queue exhausted`);
  updateStatus(workerId, 'DONE');
}

// ─── LIVE REPORT ──────────────────────────────────────────────────────────────

function writeReport() {
  if (!reportPath) return;

  const now       = new Date();
  const started   = reportStartTime || now;
  const elapsedS  = Math.floor((now - started) / 1000);
  const elapsedMin = Math.floor(elapsedS / 60);
  const elapsedSec = elapsedS % 60;

  function fmt(d) {
    return d.toLocaleString('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).replace(',', '');
  }

  const applied    = reportLog.filter(e => e.status === 'APPLIED');
  const skipped    = reportLog.filter(e => e.status === 'SKIPPED');
  const failed     = reportLog.filter(e => e.status === 'FAILED');
  const uncertain  = reportLog.filter(e => e.status === 'UNCERTAIN');
  const pending    = totalScanned - applied.length - skipped.length - failed.length - uncertain.length;

  const W    = 63;
  const rule = '='.repeat(W);
  const dash = '-'.repeat(W);

  const lines = [
    rule,
    'TEKSYSTEMS BOT — LIVE REPORT',
    `Started : ${fmt(started)}`,
    `Updated : ${fmt(now)}`,
    `Duration: ${elapsedMin} min ${elapsedSec} sec`,
    rule,
    '',
    'TALLY',
    dash,
    `  Scanned (total found)  : ${String(totalScanned).padStart(3)}`,
    `  |-- Applied            : ${String(applied.length).padStart(3)}`,
    `  |-- Skipped (filtered) : ${String(skipped.length).padStart(3)}`,
    `  |-- Failed             : ${String(failed.length).padStart(3)}`,
    `  |-- Uncertain          : ${String(uncertain.length).padStart(3)}`,
    `  +-- Pending (in queue) : ${String(Math.max(0, pending)).padStart(3)}`,
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
      lines.push(`        Time: ${e.time}`);
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
      if (e.url)    lines.push(`        ${e.url}`);
      if (e.reason) lines.push(`        Reason: ${e.reason}`);
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
    console.warn(`   [WARN] Report write error: ${e.message}`);
  }
}

function logReport(status, title, company, url, jobId, reason) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  reportLog.push({ status, title, company, url, jobId, reason, time });
  writeReport();
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function printDashboard() {
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`DASHBOARD — ${new Date().toLocaleTimeString()}`);
  console.log(`  Applied: ${stats.applied}  Skipped: ${stats.skipped}  Failed: ${stats.failed}  Uncertain: ${stats.uncertain}`);
  console.log(`  Queue: ${queueIndex}/${jobQueue.length} processed`);
  for (const [id, s] of Object.entries(workerStatus)) {
    console.log(`  ${id}: [${s.state}] ${s.job || '-'}`);
  }
  console.log(`${'-'.repeat(60)}\n`);
}

// ─── LOGIN MODE ───────────────────────────────────────────────────────────────

async function loginMode() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TekSystems Bot — LOGIN MODE`);
  console.log(`Profile will be saved to: ${PROFILE_DIR}`);
  console.log(`${'='.repeat(60)}\n`);

  ensureDir(PROFILE_DIR + '/dummy');  // ensure parent exists

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const pages = context.pages();
  const page  = pages.length > 0 ? pages[0] : await context.newPage();

  console.log(`Opening TekSystems login page...`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() =>
    page.goto('https://careers.teksystems.com/us/en', { waitUntil: 'domcontentloaded', timeout: 30000 })
  );

  console.log(`\nBrowser is open. Please log in manually, then press ENTER here to save the session...`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();

  console.log(`\nSession saved to: ${PROFILE_DIR}`);
  console.log(`You can now run: node teksystems-bot.js [minutes]\n`);

  await context.close().catch(() => {});
}

// ─── PROBE MODE ───────────────────────────────────────────────────────────────

async function probeMode() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TekSystems Bot — PROBE MODE`);
  console.log(`${'='.repeat(60)}\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  for (const p of context.pages()) await p.close().catch(() => {});
  const page = await context.newPage();

  const probeUrl = buildSearchUrl('data scientist', 0);
  console.log(`Loading: ${probeUrl}`);
  await page.goto(probeUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
    page.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
  );

  console.log(`\nBrowser is open. Dismiss any popups / confirm page looks right, then press ENTER to extract jobs...`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();

  await scrollToLoadAll(page);

  const jobs = await extractJobsFromPage(page);
  console.log(`\nFound ${jobs.length} job(s):`);
  jobs.slice(0, 10).forEach((j, i) =>
    console.log(`  ${i + 1}. [${j.id}] ${j.title || '(no title)'} | ${j.posted || 'no date'}\n      ${j.url}`)
  );

  if (jobs.length === 0) {
    console.log(`\nNo jobs extracted. All /job links on page:`);
    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/job"]'))
        .map(a => ({ href: a.href, text: (a.textContent || '').trim().slice(0, 80) }))
        .filter(l => l.href.includes('teksystems'))
        .slice(0, 20)
    );
    allLinks.forEach(l => console.log(`  "${l.text}"  ->  ${l.href}`));
  } else {
    // Probe apply page for first job
    const testJob = jobs[0];
    const applyUrl = buildApplyUrl(testJob.id);
    console.log(`\nOpening apply page: ${applyUrl}`);
    await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
      page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
    );

    console.log(`\nApply page loaded. Press ENTER to dump all interactive elements...`);
    process.stdin.resume();
    await new Promise(resolve => process.stdin.once('data', resolve));
    process.stdin.pause();

    const interactive = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, input, select, a'))
        .filter(el => el.offsetParent !== null)
        .map(el => ({
          tag:         el.tagName.toLowerCase(),
          type:        el.type || '',
          text:        (el.textContent || el.value || el.placeholder || '').trim().slice(0, 60),
          name:        el.name || el.id || '',
          dataAttr:    el.getAttribute('data-ph-at-id') || '',
        }))
        .filter(el => el.text || el.name)
        .slice(0, 40)
    );

    console.log(`\nAll interactive elements on apply page:`);
    interactive.forEach(el => {
      const extra = el.dataAttr ? ` [data-ph-at-id="${el.dataAttr}"]` : '';
      console.log(`  <${el.tag}${el.type ? ' type="' + el.type + '"' : ''}${extra}> name="${el.name}" — "${el.text}"`);
    });
  }

  console.log(`\nProbe complete. Press ENTER to close...`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();

  await context.close().catch(() => {});
}

// ─── MAIN RUN ─────────────────────────────────────────────────────────────────

async function runBot(runtimeMinutes) {
  const startTime = Date.now();
  const stopTime  = runtimeMinutes > 0 ? startTime + runtimeMinutes * 60 * 1000 : Infinity;

  // Report setup
  reportStartTime = new Date();
  const tsTag = reportStartTime.toISOString()
    .replace('T', '_').replace(/:/g, '-').slice(0, 19);
  reportPath  = path.join(__dirname, `report_${tsTag}.txt`);
  reportLog   = [];
  totalScanned = 0;
  writeReport();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TekSystems Bot — ${NUM_WORKERS} Parallel Workers`);
  if (runtimeMinutes > 0) console.log(`Runtime : ${runtimeMinutes} minutes`);
  console.log(`Profile : ${PROFILE_DIR}`);
  console.log(`Status  : ${STATUS_FILE}`);
  console.log(`Report  : ${reportPath}`);
  console.log(`${'='.repeat(60)}`);

  if (!fs.existsSync(PROFILE_DIR)) {
    console.error(`\n[ERROR] Profile directory not found: ${PROFILE_DIR}`);
    console.error(`Run "node teksystems-bot.js login" first to create a session.\n`);
    process.exit(1);
  }

  const reportInterval = setInterval(writeReport, 12000);
  const dashInterval   = setInterval(printDashboard, 30000);

  // Status heartbeat every 5s
  const statusInterval = setInterval(() => updateStatus('W1', workerStatus.W1?.state || 'IDLE', workerStatus.W1?.job || ''), 5000);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const pages    = context.pages();
  const holdPage = pages.length > 0 ? pages[0] : await context.newPage();

  // Quick session check — if we see a login page, warn and continue anyway
  try {
    await holdPage.goto('https://careers.teksystems.com/us/en', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    await holdPage.waitForTimeout(2000);
    const url = holdPage.url();
    if (/login|sign-in/i.test(url)) {
      console.log(`\n[WARN] Session appears to have expired. URL: ${url}`);
      console.log(`[WARN] Run "node teksystems-bot.js login" to refresh session.`);
      console.log(`[WARN] Continuing anyway — will fail per job if not authenticated.\n`);
    } else {
      console.log(`[ok] Session active — ${url}`);
    }
  } catch (e) {
    console.warn(`[WARN] Session check failed: ${e.message}`);
  }

  let appliedJobs = loadAppliedIds();
  console.log(`\n[init] Loaded ${appliedJobs.size} previously applied job IDs`);

  try {
    while (!_shouldStop && Date.now() < stopTime) {

      console.log(`\n[scan] Launching ${SEARCH_KEYWORDS.length} parallel keyword scans...`);

      // Phase 1: parallel scan across all keywords
      const scanResults = await Promise.all(
        SEARCH_KEYWORDS.map(kw => scanKeyword(context, kw, appliedJobs))
      );

      // Merge and dedup by job ID
      const seenAllIds  = new Set();
      const allSeen     = [];
      const mergedIds   = new Set();
      const mergedJobs  = [];

      for (const { found, allSeen: kwSeen } of scanResults) {
        for (const j of kwSeen) {
          if (!seenAllIds.has(j.id)) { seenAllIds.add(j.id); allSeen.push(j); }
        }
        for (const j of found) {
          if (!mergedIds.has(j.id)) { mergedIds.add(j.id); mergedJobs.push(j); }
        }
      }

      const queuedIds = new Set(mergedJobs.map(j => j.id));
      writeScannedJobs(allSeen, queuedIds, appliedJobs);

      if (mergedJobs.length === 0) {
        console.log(`\n[wait] No new jobs found — waiting ${RESCAN_WAIT_MS / 1000}s before rescan...`);
        // Poll every second during the wait so Ctrl+C is responsive
        for (let i = 0; i < RESCAN_WAIT_MS / 1000 && !_shouldStop && Date.now() < stopTime; i++) {
          await new Promise(r => setTimeout(r, 1000));
        }
        continue;
      }

      jobQueue   = mergedJobs;
      queueIndex = 0;
      totalScanned += mergedJobs.length;
      writeReport();

      console.log(`\n[queue] ${mergedJobs.length} jobs queued — launching ${NUM_WORKERS} workers\n`);
      initAppliedFile(mergedJobs.length);
      printDashboard();

      // Phase 2: 4 workers drain the queue
      await Promise.all(
        Array.from({ length: NUM_WORKERS }, (_, i) =>
          runWorker(`W${i + 1}`, context, appliedJobs, i * 2000)
        )
      );

      writeReport();
      printDashboard();

      if (_shouldStop || Date.now() >= stopTime) break;

      console.log(`\n[wait] All workers done — waiting ${RESCAN_WAIT_MS / 1000}s before next scan...`);
      for (let i = 0; i < RESCAN_WAIT_MS / 1000 && !_shouldStop && Date.now() < stopTime; i++) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

  } catch (err) {
    console.error(`\n[FATAL]`, err.stack || err.message);
  } finally {
    clearInterval(dashInterval);
    clearInterval(reportInterval);
    clearInterval(statusInterval);
    writeReport();
    writeSessionSummary();

    // Open failed jobs in browser
    if (sessionFailedUrls.size > 0) {
      console.log(`\n[info] Opening ${sessionFailedUrls.size} failed/uncertain job(s) in browser...`);
      for (const url of [...sessionFailedUrls].slice(0, 10)) {
        try { await context.newPage().then(p => p.goto(url, { timeout: 15000 })); } catch (_) {}
      }
      await new Promise(r => setTimeout(r, 3000));
    }

    await context.close().catch(e => console.error('[close error]', e.message));
  }

  const ran = Math.floor((Date.now() - startTime) / 60000);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Session Complete — ran ${ran} min`);
  console.log(`Applied: ${stats.applied}  Skipped: ${stats.skipped}  Failed: ${stats.failed}  Uncertain: ${stats.uncertain}`);
  console.log(`Scanned log  -> ${SCANNED_FILE}`);
  console.log(`Applied log  -> ${APPLIED_FILE}`);
  console.log(`Live report  -> ${reportPath}`);
  console.log(`${'='.repeat(60)}\n`);
}

// ─── ENTRY ────────────────────────────────────────────────────────────────────

const arg = process.argv[2];
if (arg === 'login') {
  loginMode().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'probe') {
  probeMode().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else {
  const minutes = parseInt(arg, 10);
  runBot(isNaN(minutes) ? 0 : minutes).catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
