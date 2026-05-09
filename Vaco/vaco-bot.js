#!/usr/bin/env node
/**
 * Vaco Job Application Bot — 4 Parallel Workers
 *
 * ATS: Custom front-end over Bullhorn
 * No login required — guest apply works.
 *
 * Apply flow:
 *   1. API call to jobs.vaco.com/api/requisitions/search to discover jobs.
 *   2. Filter by date (client-side) and title.
 *   3. Navigate each job detail page: jobs.vaco.com/job/{id}/{title-slug}/en
 *   4. Find and click Apply / Apply Now.
 *   5. Fill inline form: First Name, Last Name, Email, Phone, Resume upload.
 *   6. Submit — wait for confirmation.
 *
 * ⚠️  RESUME SIZE: Vaco hard-limits resume uploads at 512 KB.
 *      Make sure Nikhil_Resume.pdf is under 512 KB before running.
 *
 * RUN:
 *   node Vaco/vaco-bot.js          ← discover + apply
 *   node Vaco/vaco-bot.js probe    ← inspect one job page, print DOM info
 *   node --check Vaco/vaco-bot.js  ← syntax check only
 */

'use strict';

const { chromium } = require('playwright');
const fs            = require('fs');
const path          = require('path');
const https         = require('https');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const HOME_DIR      = process.env.HOME || process.env.USERPROFILE || '';
const PROFILE_DIR   = process.env.VACO_PROFILE_PATH || path.join(HOME_DIR, 'vaco-bot-profile');
const WORKSPACE_DIR = path.join(HOME_DIR, '.openclaw', 'workspace');
const STATUS_FILE   = path.join(WORKSPACE_DIR, 'vaco_worker_status.json');
const APPLIED_IDS   = path.join(WORKSPACE_DIR, 'vaco_applied_ids.txt');

const SCANNED_FILE  = path.join(__dirname, 'scanned_jobs.txt');
const APPLIED_FILE  = path.join(__dirname, 'applied_jobs.txt');
const FAILED_FILE   = path.join(__dirname, 'failed_jobs.txt');

// User details
const USER_FIRST    = 'Nikhil';
const USER_LAST     = 'Premachandra rao';
const USER_EMAIL    = 'nikhilprao9066@gmail.com';
const USER_PHONE    = '5555555555';
const RESUME_PATH   = process.env.RESUME_PATH || (() => {
  const candidates = [
    path.join(__dirname, 'resume.pdf'),
    path.join(__dirname, 'Nikhil_Resume.pdf'),
    path.join(__dirname, '..', 'resume.pdf'),
    path.join(__dirname, '..', 'Nikhil_Resume.pdf'),
    path.join(process.env.HOME || '', 'Desktop', 'Jobs', 'Nikhil_Resume.pdf'),
  ];
  return candidates.find(p => { try { return require('fs').existsSync(p); } catch(_){} }) || candidates[0];
})();

const NUM_WORKERS   = 4;
const RATE_LIMIT_MS = 8000;   // ms between applications per worker
const PAGE_TIMEOUT  = 30000;  // ms
const MAX_RETRIES   = 2;
const BATCH_SIZE    = 200;

// Vaco search: REST API for job discovery, one page = up to 20 results
// category=Technology narrows to tech roles on Vaco
const SEARCH_QUERIES = [
  'data scientist',
  'machine learning engineer',
  'machine learning',
  'data science',
  'applied scientist',
  'nlp engineer',
  'artificial intelligence',
];

const VACO_BASE_URL = 'https://jobs.vaco.com';
const VACO_API_BASE = `${VACO_BASE_URL}/api/requisitions/search`;

// Block non-DS roles that may bleed into DS search results
const TITLE_BLOCK_RE = /data\s*engineer(ing)?|database\s*(developer|admin|architect|engineer)|etl\s*(developer|engineer)?|data\s*analyst|pipeline\s*engineer|bi\s*(developer|engineer)|reporting\s*(developer|analyst)/i;

// ─── SHARED STATE ─────────────────────────────────────────────────────────────

let _shouldStop  = false;
let _sigintCount = 0;
let MAX_JOBS = Infinity;

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
  return new Set(fs.readFileSync(APPLIED_IDS, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
}

function markApplied(jobId) {
  fs.appendFileSync(APPLIED_IDS, jobId + '\n');
}

// ─── SCANNED JOBS FILE ────────────────────────────────────────────────────────

function writeScannedJobs(allJobs, queuedIds, appliedJobs) {
  ensureDir(SCANNED_FILE);
  const ts       = new Date().toLocaleString('en-US', { hour12: false });
  const newCount = queuedIds.size;
  const skip     = allJobs.length - newCount;

  const lines = [
    '='.repeat(80),
    `VACO SCAN  —  ${ts}`,
    `${allJobs.length} jobs found  |  ${newCount} new  |  ${skip} already applied / filtered`,
    '='.repeat(80),
    '',
  ];

  allJobs.forEach((j, i) => {
    const already = appliedJobs.has(j.id);
    const badge   = already
      ? '[ALREADY APPLIED]'
      : queuedIds.has(j.id) ? '[QUEUED          ]' : '[FILTERED        ]';
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
    `VACO SESSION  —  ${ts}`,
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
  const url  = jobUrl || `${VACO_BASE_URL} (ID: ${jobId})`;
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

// ─── WORKER-PREFIXED LOGGER ───────────────────────────────────────────────────

function wlog(workerId, msg) {
  const colors = { W1: '\x1b[36m', W2: '\x1b[33m', W3: '\x1b[35m', W4: '\x1b[32m' };
  const reset  = '\x1b[0m';
  const color  = colors[workerId] || '';
  console.log(`${color}[${workerId}]${reset} ${msg}`);
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────

/**
 * Returns true if the ISO date string (or relative text) is within the last 48 hours.
 * Vaco API returns dateCreated as an ISO 8601 string, e.g. "2026-05-01T14:32:11Z".
 * We accept up to 48 h to avoid accidentally filtering jobs from yesterday morning.
 */
function isRecentJob(postedValue) {
  if (!postedValue) return true; // unknown — let through

  // ISO date from API
  if (/^\d{4}-\d{2}-\d{2}/.test(postedValue)) {
    const age = Date.now() - new Date(postedValue).getTime();
    return age <= 48 * 60 * 60 * 1000;
  }

  // Relative text (scraped from DOM)
  const t = postedValue.toLowerCase();
  if (/just now|today|hour|minute/.test(t)) return true;
  if (/1 day|yesterday/.test(t)) return true;
  if (/[2-9] days?|week|month|year/.test(t)) return false;

  return true; // unrecognised — let through
}

// ─── VACO REST API ────────────────────────────────────────────────────────────

/**
 * Fetches one page of Vaco jobs via their undocumented Bullhorn API wrapper.
 * Returns an array of raw job objects from the API.
 */
function fetchVacoJobsPage(keyword, page) {
  return new Promise((resolve, reject) => {
    const encodedKw = encodeURIComponent(keyword);
    const url = `${VACO_API_BASE}?page=${page}&keyword=${encodedKw}&category=Technology`;
    const opts = {
      hostname: 'jobs.vaco.com',
      path: `/api/requisitions/search?page=${page}&keyword=${encodedKw}&category=Technology`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://jobs.vaco.com/',
        'Origin': 'https://jobs.vaco.com',
      },
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`API returned HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}. Body: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

/**
 * Build a human-readable job URL from job id and title.
 * Pattern: jobs.vaco.com/job/{id}/{title-slug}/en
 */
function buildJobUrl(jobId, title) {
  const slug = (title || 'job')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return `${VACO_BASE_URL}/job/${jobId}/${slug}/en`;
}

// ─── SCAN FOR JOBS VIA API ────────────────────────────────────────────────────

/**
 * Queries the Vaco API for one keyword, paginating until no more results.
 * Returns { found: [...], allSeen: [...] }
 */
async function scanKeyword(keyword, appliedJobs) {
  console.log(`\n🔍 [api] Scanning: "${keyword}"`);

  const found   = [];
  const allSeen = [];
  const seenIds = new Set();
  let page      = 1;
  let totalAdded = 0;
  let totalOld   = 0;

  while (found.length < BATCH_SIZE) {
    let apiResp;
    try {
      apiResp = await fetchVacoJobsPage(keyword, page);
    } catch (e) {
      console.warn(`   ⚠️  API error on page ${page}: ${e.message}`);
      break;
    }

    // The Vaco API returns { data: [...], total: N } or just an array — handle both
    const jobs = Array.isArray(apiResp) ? apiResp
      : (apiResp.data || apiResp.results || apiResp.requisitions || apiResp.jobs || []);

    if (!Array.isArray(jobs) || jobs.length === 0) {
      if (page === 1) console.log(`   ⛔ No results from API for "${keyword}"`);
      else console.log(`   ⛔ Page ${page}: end of results`);
      break;
    }

    let newOnPage = 0;
    for (const raw of jobs) {
      // Normalise field names — Bullhorn API uses various conventions
      const id    = String(raw.id || raw.jobOrderId || raw.requisitionId || raw.externalID || '').trim();
      const title = (raw.title || raw.jobTitle || raw.positionName || '').trim();
      const comp  = (raw.clientName || raw.clientCorporation?.name || raw.companyName || raw.company || '').trim();
      const loc   = (raw.location || raw.city || raw.state || '').trim();
      const posted = raw.dateAdded || raw.dateCreated || raw.publishedDate || raw.date || '';

      if (!id) continue;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      newOnPage++;

      const url = buildJobUrl(id, title);
      allSeen.push({ id, title, company: comp, location: loc, posted, url });

      if (appliedJobs.has(id)) continue;
      if (!isRecentJob(posted)) { totalOld++; continue; }
      if (title && TITLE_BLOCK_RE.test(title)) {
        console.log(`   🚫 Blocked: ${title}`);
        continue;
      }

      found.push({ id, url, title: title || id, company: comp, location: loc, posted });
      totalAdded++;
    }

    console.log(`   [api] Page ${page}: ${jobs.length} jobs | ${newOnPage} new | running total: ${totalAdded}`);

    // Pagination: stop if we got fewer results than expected (last page)
    // Most Bullhorn wrappers return 20 per page
    const pageSize = apiResp.pageSize || apiResp.perPage || apiResp.limit || 20;
    if (jobs.length < pageSize) break;

    page++;
  }

  console.log(`   ✅ "${keyword}": ${totalAdded} queued | ${totalOld} >48h skipped`);
  return { found, allSeen };
}

// ─── SCROLL TO LOAD LAZY CONTENT ──────────────────────────────────────────────

async function scrollToLoadAll(page) {
  let prev = 0;
  for (let i = 0; i < 15; i++) {
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
      const h = await page.evaluate(() => document.body.scrollHeight);
      if (h === prev && i > 2) break;
      prev = h;
    } catch (_) { break; }
  }
  try { await page.evaluate(() => window.scrollTo(0, 0)); } catch (_) {}
}

// ─── FIND AND CLICK APPLY BUTTON ──────────────────────────────────────────────

async function findAndClickApply(page) {
  // Priority 1: "Apply Now" button
  for (const pattern of [/apply now/i, /^apply$/i, /apply for this job/i, /apply for position/i]) {
    const loc = page.locator('button, a', { hasText: pattern });
    try {
      const count = await loc.count();
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        if (await el.isVisible()) { await el.click(); return 'apply'; }
      }
    } catch (_) {}
  }

  // Last resort: JS evaluate
  const clicked = await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      const txt = (el.textContent || '').trim().toLowerCase();
      if (/apply now|^apply$|apply for this|apply for position/i.test(txt) && el.offsetParent !== null) {
        el.click();
        return txt;
      }
    }
    return null;
  }).catch(() => null);

  return clicked;
}

// ─── FILL APPLY FORM ──────────────────────────────────────────────────────────

/**
 * Fills and submits the Vaco inline application form.
 * Fields: First Name, Last Name, Email, Phone, Resume upload.
 * ⚠️  Vaco hard-limits resume at 512 KB.
 */
async function fillApplyForm(page, workerId) {
  // Helper: fill a visible input that matches one of the given selectors
  async function fillField(sels, value, label) {
    for (const sel of sels) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible({ timeout: 3000 })) {
          await el.fill(value);
          wlog(workerId, `   ✅ Filled ${label}`);
          return true;
        }
      } catch (_) {}
    }
    wlog(workerId, `   ⚠️  Could not fill ${label} — selector not found`);
    return false;
  }

  // First Name
  await fillField([
    'input[name*="first" i]',
    'input[placeholder*="first name" i]',
    'input[id*="first" i]',
    'input[autocomplete="given-name"]',
    '[data-testid*="first" i]',
  ], USER_FIRST, 'First Name');

  // Last Name
  await fillField([
    'input[name*="last" i]',
    'input[placeholder*="last name" i]',
    'input[id*="last" i]',
    'input[autocomplete="family-name"]',
    '[data-testid*="last" i]',
  ], USER_LAST, 'Last Name');

  // Full name (some forms use a single name field)
  await fillField([
    'input[name="name"]',
    'input[placeholder*="full name" i]',
    'input[id="name"]',
    'input[autocomplete="name"]',
  ], `${USER_FIRST} ${USER_LAST}`, 'Full Name');

  // Email
  await fillField([
    'input[type="email"]',
    'input[name*="email" i]',
    'input[placeholder*="email" i]',
    'input[id*="email" i]',
    'input[autocomplete*="email"]',
  ], USER_EMAIL, 'Email');

  // Phone
  await fillField([
    'input[type="tel"]',
    'input[name*="phone" i]',
    'input[placeholder*="phone" i]',
    'input[id*="phone" i]',
    'input[autocomplete*="tel"]',
  ], USER_PHONE, 'Phone');

  // Resume upload
  if (!fs.existsSync(RESUME_PATH)) {
    wlog(workerId, `   ⚠️  Resume not found at ${RESUME_PATH}`);
  } else {
    // Check size
    const sizeKB = fs.statSync(RESUME_PATH).size / 1024;
    if (sizeKB > 512) {
      wlog(workerId, `   ⚠️  Resume is ${sizeKB.toFixed(0)} KB — Vaco limit is 512 KB! Upload may fail.`);
    }

    try {
      const allInputs = page.locator('input[type="file"]');
      const count = await allInputs.count();
      if (count > 0) {
        // Prefer an input whose context mentions "resume"
        let uploaded = false;
        for (let i = 0; i < count; i++) {
          const inp = allInputs.nth(i);
          const ctx = await inp.evaluate(el => {
            const parts = [el.id, el.name, el.getAttribute('aria-label') || '', el.getAttribute('data-cy') || ''];
            if (el.id) {
              const lbl = document.querySelector(`label[for="${el.id}"]`);
              if (lbl) parts.push(lbl.textContent);
            }
            let node = el.parentElement;
            for (let n = 0; n < 3 && node; n++, node = node.parentElement) parts.push(node.textContent);
            return parts.join(' ').toLowerCase();
          }).catch(() => '');

          if (/resume|cv|upload|file/i.test(ctx)) {
            await inp.setInputFiles(RESUME_PATH);
            wlog(workerId, `   📄 Resume uploaded (input ${i + 1}/${count}, ${sizeKB.toFixed(0)} KB)`);
            await page.waitForTimeout(1500);
            uploaded = true;
            break;
          }
        }
        // Fallback: single file input — use it regardless of context
        if (!uploaded && count === 1) {
          await allInputs.first().setInputFiles(RESUME_PATH);
          wlog(workerId, `   📄 Resume uploaded (sole file input, ${sizeKB.toFixed(0)} KB)`);
          await page.waitForTimeout(1500);
          uploaded = true;
        }
        if (!uploaded) {
          wlog(workerId, `   ⚠️  No resume-like file input found (${count} file inputs on page)`);
        }
      } else {
        wlog(workerId, `   ⚠️  No file input found on page — resume not uploaded`);
      }
    } catch (err) {
      wlog(workerId, `   ⚠️  Resume upload error: ${err.message}`);
    }
  }

  await page.waitForTimeout(500);
}

// ─── AUTO-ANSWER SCREENING QUESTIONS ─────────────────────────────────────────

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
      const wantNo     = NO_KEYWORDS.test(groupLabel);
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

const CONFIRM_RE = /thank you for applying|application.*submitted|application.*received|successfully applied|you.ve applied|we.ve received your application|application complete|your application has been|submission.*received/i;

async function navigateApplyForm(page, workerId, alreadyFilled = false) {
  const maxSteps    = 12;
  let formFilled    = alreadyFilled;

  for (let step = 0; step < maxSteps; step++) {
    if (_shouldStop) return 'UNCERTAIN';
    await page.waitForTimeout(2000);

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

    // Confirmation check
    if (CONFIRM_RE.test(bodyText) || /submitted|thank you|successfully/i.test(bodyText)) {
      return 'APPLIED';
    }

    // Fill the form fields on the first meaningful step that has a form
    if (!formFilled) {
      const hasForm = await page.evaluate(() =>
        !!document.querySelector('input[type="email"], input[name*="email" i], input[type="file"]')
      ).catch(() => false);

      if (hasForm) {
        if (!alreadyFilled && step === 0) {
          await fillApplyForm(page, workerId);
        }
        formFilled = true;
      }
    }

    // Auto-answer screening questions
    const answered = await answerQuestions(page);
    if (answered > 0) wlog(workerId, `   ✏️  Answered ${answered} question(s)`);

    // Submit button — try various labels
    const submitLoc = page.locator([
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
      'button:has-text("Send Application")',
      'button:has-text("Apply")',
      'button[type="submit"]',
      'input[type="submit"]',
      '[data-testid*="submit" i]',
      '[data-cy*="submit" i]',
    ].join(', ')).first();

    try {
      if (await submitLoc.count() > 0 && await submitLoc.isVisible() && await submitLoc.isEnabled()) {
        wlog(workerId, `   🖱️  Step ${step + 1}: Submit`);
        await submitLoc.click();

        try {
          await page.waitForFunction(
            () => /submitted|thank you|successfully|application.*received|your application/i.test(document.body.innerText),
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
      '[data-testid*="next" i]',
    ].join(', ')).first();

    try {
      if (await nextLoc.count() > 0 && await nextLoc.isVisible() && await nextLoc.isEnabled()) {
        wlog(workerId, `   🖱️  Step ${step + 1}: Next`);
        await nextLoc.click();
        continue;
      }
    } catch (e) { wlog(workerId, `   ⚠️  Next button error: ${e.message}`); }

    // JS fallback
    const clickedNext = await page.evaluate(() => {
      for (const el of document.querySelectorAll('button, a, [role="button"]')) {
        const txt = (el.textContent || '').trim();
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

    // Nothing found — log visible interactives for debugging
    const visible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a[role="button"], input[type="submit"]'))
        .filter(b => b.offsetParent !== null)
        .map(b => b.textContent.trim() || b.value)
        .filter(Boolean)
    ).catch(() => []);
    wlog(workerId, `   ⚠️  Step ${step + 1}: No Next/Submit. Visible: [${visible.slice(0, 10).join(' | ')}]`);
    break;
  }

  return 'UNCERTAIN';
}

// ─── APPLY TO ONE JOB ─────────────────────────────────────────────────────────

async function applyToJob(context, job, workerId, jobNumber) {
  wlog(workerId, `📝 #${jobNumber} — ${job.title} | ${job.posted || 'no date'}`);
  updateStatus(workerId, 'APPLYING', job.title);

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
      await jobPage.waitForTimeout(3000);

      // Refresh title and company from detail page
      let title = job.title, company = job.company || '-';
      try {
        const h1 = await jobPage.$('h1');
        if (h1) title = ((await h1.textContent()) || '').trim() || title;
      } catch (_) {}
      try {
        const cEl = await jobPage.$(
          '[class*="company" i], [class*="employer" i], [class*="client" i], ' +
          '[data-testid*="company" i]'
        );
        if (cEl) company = ((await cEl.textContent()) || '').trim() || company;
      } catch (_) {}

      // Find and click Apply button
      const clicked = await findAndClickApply(jobPage);
      if (!clicked) {
        wlog(workerId, `   ⏭️  No Apply button found — SKIPPED`);
        writeAppliedEntry(workerId, title, company, job.id, 'SKIPPED', job.url);
        stats.skipped++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      // Wait for possible new tab
      const newTabPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
      await jobPage.waitForTimeout(2000);
      const newTab = await newTabPromise;
      let applyPage;

      if (newTab) {
        await newTab.waitForFunction(
          () => location.href !== 'about:blank' && location.href !== '',
          { timeout: 12000 }
        ).catch(() => {});
        await newTab.waitForLoadState('domcontentloaded').catch(() => {});
        await newTab.waitForTimeout(2000);
        const tabUrl = newTab.url();
        if (!tabUrl || tabUrl === 'about:blank') {
          wlog(workerId, `   ⚠️  New tab stayed blank — skipping`);
          await newTab.close().catch(() => {});
          await jobPage.close().catch(() => {});
          stats.skipped++;
          updateStatus(workerId, 'IDLE');
          return 'SKIPPED';
        }
        wlog(workerId, `   📂 New tab: ${tabUrl}`);
        applyPage = newTab;
      } else {
        applyPage = jobPage;
        wlog(workerId, `   📂 Modal or same-page form`);
      }

      const result = await navigateApplyForm(applyPage, workerId);

      if (newTab) await applyPage.close().catch(() => {});
      await jobPage.close().catch(() => {});

      if (result === 'APPLIED') {
        wlog(workerId, `   ✅ APPLIED — ${title}`);
        markApplied(job.id);
        writeAppliedEntry(workerId, title, company, job.id, 'APPLIED', job.url);
        stats.applied++;
        updateStatus(workerId, 'IDLE');
        return 'APPLIED';
      }

      if (result === 'UNCERTAIN') {
        wlog(workerId, `   ❓ UNCERTAIN — ${title}`);
        markApplied(job.id);
        writeAppliedEntry(workerId, title, company, job.id, 'UNCERTAIN', job.url);
        writeFailedEntry(workerId, title, company, job.id, 'UNCERTAIN', 'submitted but no confirmation detected', job.url);
        stats.uncertain++;
        updateStatus(workerId, 'IDLE');
        return 'UNCERTAIN';
      }

    } catch (err) {
      wlog(workerId, `   ❌ Error (attempt ${attempt}): ${err.stack || err.message}`);
      await jobPage.close().catch(() => {});
      if (/closed|destroyed|Target page/i.test(err.message)) {
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }
      if (attempt === MAX_RETRIES) {
        markApplied(job.id);
        writeAppliedEntry(workerId, job.title, '-', job.id, 'FAILED', job.url);
        writeFailedEntry(workerId, job.title, '-', job.id, 'FAILED', err.message, job.url);
        stats.failed++;
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }
    }
  }

  markApplied(job.id);
  writeFailedEntry('--', job.title, '-', job.id, 'FAILED', 'exhausted retries', job.url);
  updateStatus(workerId, 'IDLE');
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
    appliedJobs.add(job.id); // claim immediately to avoid duplicate applications

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

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function printDashboard() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 VACO DASHBOARD — ${new Date().toLocaleTimeString()}`);
  console.log(`   ✅ Applied: ${stats.applied}  ⏭️  Skipped: ${stats.skipped}  ❌ Failed: ${stats.failed}  ❓ Uncertain: ${stats.uncertain}`);
  console.log(`   📋 Queue: ${queueIndex}/${jobQueue.length} processed`);
  for (const [id, s] of Object.entries(workerStatus)) {
    console.log(`   ${id}: [${s.state}] ${s.job || '-'}`);
  }
  console.log(`${'─'.repeat(60)}\n`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function runBot() {
  const startTime = Date.now();

  // Warn if resume is over 512 KB
  if (fs.existsSync(RESUME_PATH)) {
    const sizeKB = fs.statSync(RESUME_PATH).size / 1024;
    if (sizeKB > 512) {
      console.warn(`\n⚠️  WARNING: Resume is ${sizeKB.toFixed(0)} KB — Vaco hard-limits at 512 KB!`);
      console.warn(`   Compress it before running or uploads will likely fail.\n`);
    } else {
      console.log(`✅ Resume: ${sizeKB.toFixed(0)} KB (under 512 KB limit)`);
    }
  } else {
    console.warn(`⚠️  Resume not found at ${RESUME_PATH}`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🤖 Vaco Bot — ${NUM_WORKERS} Parallel Workers`);
  console.log(`📂 Profile  : ${PROFILE_DIR}`);
  console.log(`📊 Status   : ${STATUS_FILE}`);
  console.log(`${'═'.repeat(60)}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // Keep one page open to hold the session / display status
  const pages    = context.pages();
  const holdPage = pages.length > 0 ? pages[0] : await context.newPage();

  // Navigate to Vaco homepage so the browser session is warm
  await holdPage.goto(`${VACO_BASE_URL}/jobs/technology`, {
    waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT,
  }).catch(() => holdPage.goto(VACO_BASE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT }).catch(() => {}));

  let appliedJobs = loadAppliedJobs();
  console.log(`\n📂 Loaded ${appliedJobs.size} previously applied jobs`);

  const dashInterval = setInterval(printDashboard, 30000);

  try {
    while (!_shouldStop) {
      console.log(`\n🔍 Scanning Vaco API for all keywords...`);

      // Scan all keywords in parallel
      const scanResults = await Promise.all(
        SEARCH_QUERIES.map(kw => scanKeyword(kw, appliedJobs))
      );

      // Merge and dedup by job ID
      const seenIds    = new Set();
      const allSeen    = [];
      const mergedJobs = [];

      for (const { found, allSeen: kSeen } of scanResults) {
        for (const j of kSeen) {
          if (!seenIds.has(j.id)) { seenIds.add(j.id); allSeen.push(j); }
        }
        for (const j of found) {
          if (!seenIds.has(j.id)) {
            // allSeen already handles dedup globally — use a local set for mergedJobs
          }
        }
      }

      // Re-merge found (separate dedup set needed)
      const foundIds = new Set();
      for (const { found } of scanResults) {
        for (const j of found) {
          if (!foundIds.has(j.id)) { foundIds.add(j.id); mergedJobs.push(j); }
        }
      }

      const queuedIds = new Set(mergedJobs.map(j => j.id));
      writeScannedJobs(allSeen, queuedIds, appliedJobs);

      if (mergedJobs.length === 0) {
        console.log(`😴 No new Vaco jobs found — session complete`);
        break;
      }

      jobQueue   = mergedJobs;
      queueIndex = 0;

      console.log(`\n🎯 ${mergedJobs.length} Vaco jobs queued — launching ${NUM_WORKERS} workers\n`);
      initAppliedFile(mergedJobs.length);
      printDashboard();

      await Promise.all(
        Array.from({ length: NUM_WORKERS }, (_, i) =>
          runWorker(`W${i + 1}`, context, appliedJobs, i * 2000)
        )
      );

      printDashboard();
      break; // done — Vaco has no rescan loop (apply to all new jobs found today, then exit)
    }

  } catch (err) {
    console.error(`\n❌ Fatal:`, err.stack || err.message);
  } finally {
    clearInterval(dashInterval);
    writeSessionSummary();
    await context.close().catch(e => console.error('Failed to close context:', e.message));
  }

  const ran = Math.floor((Date.now() - startTime) / 60000);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🏁 Session Complete — ran ${ran} min`);
  console.log(`✅ Applied: ${stats.applied} | ⏭️ Skipped: ${stats.skipped} | ❌ Failed: ${stats.failed} | ❓ Uncertain: ${stats.uncertain}`);
  console.log(`Scanned log  → ${SCANNED_FILE}`);
  console.log(`Applied log  → ${APPLIED_FILE}`);
  if (sessionFailedUrls.size > 0) {
    console.log(`Failed jobs  → ${FAILED_FILE}`);
  }
  console.log(`${'═'.repeat(60)}\n`);
}

// ─── PROBE MODE — inspect live DOM to verify selectors ───────────────────────

async function probeMode() {
  console.log(`\n🔬 PROBE MODE — opening jobs.vaco.com to inspect the apply flow\n`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  for (const p of ctx.pages()) await p.close().catch(() => {});
  const page = await ctx.newPage();

  // 1. Hit the API and show first few jobs
  console.log(`\n[1] Fetching jobs via API for "data scientist"...`);
  let apiJobs = [];
  try {
    const resp = await fetchVacoJobsPage('data scientist', 1);
    apiJobs = Array.isArray(resp) ? resp : (resp.data || resp.results || resp.requisitions || resp.jobs || []);
    console.log(`   API returned ${apiJobs.length} jobs. First 3:`);
    apiJobs.slice(0, 3).forEach((j, i) => {
      const id    = j.id || j.jobOrderId || j.requisitionId || j.externalID || '(no id)';
      const title = j.title || j.jobTitle || '(no title)';
      const comp  = j.clientName || j.clientCorporation?.name || j.companyName || '-';
      const date  = j.dateAdded || j.dateCreated || '-';
      console.log(`   ${i + 1}. [${id}] ${title} @ ${comp} | ${date}`);
    });
    console.log(`\n   Raw first job keys: ${Object.keys(apiJobs[0] || {}).join(', ')}`);
  } catch (e) {
    console.error(`   ⚠️  API fetch failed: ${e.message}`);
    console.log(`   Falling back to browser probe only...`);
  }

  // 2. Navigate to job detail page (use first API result or a known test URL)
  const testJob = apiJobs[0];
  const testId  = testJob ? String(testJob.id || testJob.jobOrderId || testJob.requisitionId || '') : '';
  const testTitle = testJob ? (testJob.title || testJob.jobTitle || 'job') : 'job';
  const testUrl = testId ? buildJobUrl(testId, testTitle) : `${VACO_BASE_URL}/jobs/technology`;

  console.log(`\n[2] Opening: ${testUrl}`);
  await page.goto(testUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
    page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
  );

  console.log(`\n⏸️  Browser open. Dismiss popups if any, then press ENTER to dump buttons/links...`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();

  await scrollToLoadAll(page);

  const interactive = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
      .filter(el => el.offsetParent !== null)
      .map(el => ({
        tag:     el.tagName.toLowerCase(),
        text:    (el.textContent || el.value || '').trim().slice(0, 60),
        href:    el.href || '',
        classes: el.className.slice(0, 80),
        type:    el.type || '',
      }))
      .filter(el => el.text)
      .slice(0, 40)
  );

  console.log(`\n🖱️  Visible buttons/links on job detail page:`);
  interactive.forEach(el => {
    const dest = el.href ? `  →  ${el.href.slice(0, 80)}` : '';
    console.log(`   <${el.tag}${el.type ? ' type=' + el.type : ''}> "${el.text}"${dest}`);
  });

  // 3. Try clicking Apply and show resulting form fields
  console.log(`\n[3] Attempting to click Apply button...`);
  const clicked = await findAndClickApply(page);
  if (clicked) {
    console.log(`   Clicked: "${clicked}"`);
    await page.waitForTimeout(3000);

    const formFields = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, select, textarea'))
        .filter(el => el.offsetParent !== null)
        .map(el => ({
          tag:         el.tagName.toLowerCase(),
          type:        el.type || '',
          name:        el.name || '',
          id:          el.id || '',
          placeholder: el.placeholder || '',
          label:       (() => {
            if (el.id) {
              const lbl = document.querySelector(`label[for="${el.id}"]`);
              if (lbl) return lbl.textContent.trim().slice(0, 60);
            }
            return '';
          })(),
        }))
        .slice(0, 30)
    );

    console.log(`\n📝 Form fields after clicking Apply:`);
    formFields.forEach(f => {
      const lbl = f.label ? ` [label: "${f.label}"]` : '';
      console.log(`   <${f.tag} type="${f.type}" name="${f.name}" id="${f.id}" ph="${f.placeholder}">${lbl}`);
    });
  } else {
    console.log(`   ⚠️  No Apply button found — check selectors above`);
  }

  console.log(`\n✅ Probe complete. Press ENTER to close browser...`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();
  await ctx.close();
}

// ─── FORM TEST MODE ───────────────────────────────────────────────────────────

async function formTestMode(applyUrl) {
  console.log(`\n[formtest] URL: ${applyUrl}`);
  console.log(`[formtest] Resume: ${RESUME_PATH} (exists: ${fs.existsSync(RESUME_PATH)})\n`);

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

  // Call the existing fill function — use whatever fill/apply function the bot has
  // Try fillApplyForm first, then applyForm, then any function named fill*
  if (typeof fillApplyForm === 'function') await fillApplyForm(page, 'FT');

  console.log('\n[formtest] Form filled. Inspect browser, then press ENTER to SUBMIT (Ctrl+C to abort).');
  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();

  if (typeof navigateApplyForm === 'function') {
    const result = await navigateApplyForm(page, 'FT', true);
    console.log(`[formtest] Result: ${result}`);
  } else {
    // Generic submit
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
if (arg === 'probe') {
  probeMode().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'test') {
  MAX_JOBS = 1;
  console.log('[test] Single-job test mode — will stop after 1 application attempt.');
  runBot(null).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'formtest') {
  const url = process.argv[3];
  if (!url) { console.error('[err] Usage: node vaco-bot.js formtest <applyUrl>'); process.exit(1); }
  formTestMode(url).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else {
  runBot().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
