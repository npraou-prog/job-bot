#!/usr/bin/env node
/**
 * Yoh Job Application Bot — 4 Parallel Workers
 * ATS: Shazamme + Bullhorn  |  Site: jobs.yoh.com (SPA, hash routing)
 *
 * LOGIN:   node yoh-bot.js login     ← opens headed browser, saves session
 * RUN:     node yoh-bot.js [minutes] ← apply mode (default: run until queue empty)
 * PROBE:   node yoh-bot.js probe     ← inspect one job page, print DOM info
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── USER PROFILE ─────────────────────────────────────────────────────────────

const PROFILE = {
  firstName:    'Nikhil',
  lastName:     'Premachandra Rao',
  fullName:     'Nikhil Premachandra Rao',
  email:        'nikhilprao9066@gmail.com',
  phone:        '7746368916',
  city:         'Atlanta',
  state:        'GA',
  stateFullName:'Georgia',
  zip:          '30519',
  country:      'United States',
  street:       '4188 woodfern ln',
  linkedin:     'https://linkedin.com/in/nikhil-p-rao',
  portfolio:    'https://nikprao.vercel.app',
  github:       '',
  yearsExp:     '5',
  salary:       '100000',
  noticeDays:   '14',
  sponsorship:  false,
  citizenStatus:'Non-citizen allowed to work for any employer',
  ethnicity:    'Asian',
  gender:       'Male',
  disability:   false,
  veteran:      false,
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
const PROFILE_DIR   = process.env.YOH_PROFILE_PATH || path.join(HOME_DIR, 'yoh-bot-profile');
const WORKSPACE_DIR = path.join(HOME_DIR, '.openclaw', 'workspace');
const STATUS_FILE   = path.join(WORKSPACE_DIR, 'yoh_worker_status.json');
const SCANNED_FILE  = path.join(__dirname, 'scanned_jobs.txt');
const APPLIED_FILE  = path.join(__dirname, 'applied_jobs.txt');
const FAILED_FILE   = path.join(__dirname, 'failed_jobs.txt');
const APPLIED_IDS   = path.join(__dirname, 'applied_ids.txt');

const NUM_WORKERS   = 4;
const RATE_LIMIT_MS = 8000;   // ms between applications per worker
const PAGE_TIMEOUT  = 30000;
const RESCAN_WAIT_MS = 90000; // ms between full scan cycles
const MAX_MINUTES   = parseInt(process.argv[2], 10) || 0; // 0 = unlimited

const BASE_URL      = 'https://jobs.yoh.com';
const SEARCH_KEYWORDS = [
  'data scientist',
  'machine learning engineer',
  'data science',
  'ml engineer',
  'applied scientist',
  'nlp engineer',
];

function buildSearchUrl(keyword) {
  return `${BASE_URL}/#/jobs?keyword=${encodeURIComponent(keyword)}`;
}

// Title allow/block patterns
const TITLE_ALLOW_RE = /data\s*scien|machine\s*learn|ml\s*engineer|applied\s*scien|ai\s*engineer|nlp|analytics\s*engineer|deep\s*learn|computer\s*vision|artificial\s*intel/i;
const TITLE_BLOCK_RE = /(?<!\bml\b.{0,20})\bdata\s*engineer(ing)?\b(?!\s*\/\s*scien)|database\s*(developer|admin|architect|engineer)|etl\s*(developer|engineer)?|\bdata\s*analyst\b(?!\s*\/)|pipeline\s*engineer|\bbi\s*(developer|engineer)\b|reporting\s*(developer|analyst)|\bqa\b|\bquality\s*assur|\bsoftware\s*engineer\b(?!.*\b(ml|ai|machine|learn)\b)/i;

// ─── SHARED STATE ─────────────────────────────────────────────────────────────

let _shouldStop  = false;
let _sigintCount = 0;
let _startTime   = Date.now();
let MAX_JOBS = Infinity;

process.on('SIGINT', () => {
  _sigintCount++;
  if (_sigintCount >= 2) { console.log('\nForce exiting.'); process.exit(1); }
  _shouldStop = true;
  console.log('\n[!]  Stopping after current job. (Ctrl+C again to force quit)');
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

// ─── SCANNED JOBS FILE ────────────────────────────────────────────────────────

function writeScannedJobs(allJobsOnPage, queuedIds, appliedJobs) {
  ensureDir(SCANNED_FILE);
  const ts        = new Date().toLocaleString('en-US', { hour12: false });
  const newCount  = queuedIds.size;
  const skipCount = allJobsOnPage.length - newCount;

  const lines = [
    '='.repeat(80),
    `YOH SCAN  —  ${ts}`,
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
    `YOH SESSION  —  ${ts}`,
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
  const url  = jobUrl || `${BASE_URL}/#/jobs/${jobId}`;
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
      bot:     'yoh',
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
    console.warn(`   [!] Status file write error: ${e.message}`);
  }
}

// Status heartbeat — write every 5 seconds
setInterval(() => updateStatus('heartbeat', 'RUNNING'), 5000).unref();

// ─── LOGGING WITH WORKER PREFIX ───────────────────────────────────────────────

function wlog(workerId, msg) {
  const colors = { W1: '\x1b[36m', W2: '\x1b[33m', W3: '\x1b[35m', W4: '\x1b[32m' };
  const reset  = '\x1b[0m';
  const color  = colors[workerId] || '';
  console.log(`${color}[${workerId}]${reset} ${msg}`);
}

// ─── DATE FILTER — only jobs posted within 24 hours ───────────────────────────

function isRecentJob(postedText) {
  if (!postedText) return true; // unknown — let through
  const t = postedText.toLowerCase();
  if (/just\s*now|today|this\s*morning/.test(t)) return true;
  if (/\d+\s*(minute|hour)s?\s*ago/.test(t))     return true;
  if (/^(less than an hour|an hour)/.test(t))    return true;
  if (/\b1\s*day\s*ago\b/.test(t))               return true;
  if (/\b([2-9]|\d{2,})\s*days?\s*ago\b/.test(t)) return false;
  if (/\bweek|\bmonth|\byear/.test(t))            return false;
  // Try parsing an actual date string
  if (/\d{4}/.test(t)) {
    const parsed = new Date(postedText);
    if (!isNaN(parsed.getTime())) {
      return (Date.now() - parsed.getTime()) < 25 * 60 * 60 * 1000; // 25h buffer
    }
  }
  return true; // unknown format — let through
}

// ─── SCROLL TO LOAD LAZY CARDS ────────────────────────────────────────────────

async function scrollToLoadAll(page) {
  let prev = 0;
  for (let i = 0; i < 20; i++) {
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
      const count = await page.evaluate(() =>
        document.querySelectorAll('a[href*="#/jobs/"]').length
      ).catch(() => 0);
      if (count === prev && i > 3) break;
      prev = count;
    } catch (e) {
      break;
    }
  }
  try { await page.evaluate(() => window.scrollTo(0, 0)); } catch (_) {}
}

// ─── EXTRACT JOB ID FROM HASH URL ────────────────────────────────────────────

function extractJobIdFromUrl(href) {
  // https://jobs.yoh.com/#/jobs/12345  or  /#/jobs/12345?foo=bar
  const m = href.match(/#\/jobs\/([^/?#&]+)/);
  return m ? m[1] : null;
}

// ─── EXTRACT JOBS FROM SEARCH PAGE ───────────────────────────────────────────

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    // Collect all anchor tags pointing to individual job pages
    const links = Array.from(document.querySelectorAll('a[href*="#/jobs/"]'));
    const map   = {};

    for (const a of links) {
      const href = a.href || a.getAttribute('href') || '';
      // Only individual job pages, not the search listing itself
      const m = href.match(/#\/jobs\/([^/?#&]+)/);
      if (!m) continue;
      const id = m[1];
      // Skip if id looks like a search result page (contains "keyword=")
      if (href.includes('keyword=') || href.includes('?keyword')) continue;
      if (!map[id]) {
        map[id] = { id, title: '', company: '', location: '', posted: '', url: `${location.origin}/#/jobs/${id}` };
      }
    }

    // Walk each card to extract metadata
    for (const id of Object.keys(map)) {
      // Find any link whose href matches this job id
      const anchor = links.find(a => {
        const href = a.href || a.getAttribute('href') || '';
        return href.includes(`#/jobs/${id}`) && !href.includes('keyword=');
      });
      if (!anchor) continue;

      // Walk up to find the job card container
      const card = anchor.closest(
        '[class*="job-card"], [class*="jobCard"], [class*="job-item"], [class*="jobItem"], ' +
        '[class*="result-item"], [class*="resultItem"], [class*="listing"], ' +
        'article, li, [class*="card"], [class*="row"]'
      );
      const root = card || anchor.parentElement;

      if (root) {
        const text = root.innerText || '';

        // Title: look for a heading element, or a bold/strong, or the anchor text itself
        const heading = root.querySelector('h1, h2, h3, h4, [class*="title"], [class*="job-name"], [class*="jobName"]');
        if (heading) {
          map[id].title = heading.textContent.trim();
        } else if (anchor.textContent.trim().length > 5) {
          map[id].title = anchor.textContent.trim();
        }

        // Company
        const compEl = root.querySelector(
          '[class*="company"], [class*="employer"], [class*="client"], [class*="org"]'
        );
        if (compEl) map[id].company = compEl.textContent.trim();

        // Location
        const locEl = root.querySelector(
          '[class*="location"], [class*="city"], [class*="place"]'
        );
        if (locEl) map[id].location = locEl.textContent.trim();

        // Posted date
        const dateMatch = text.match(
          /(\d+\s+(?:minute|hour|day|week|month)s?\s+ago|just\s*now|today|yesterday|posted[:\s]+[^\n]+)/i
        );
        if (dateMatch) map[id].posted = dateMatch[0].trim();
      }

      // Fall back to anchor text if title still empty
      if (!map[id].title && anchor.textContent.trim()) {
        map[id].title = anchor.textContent.trim();
      }
    }

    return Object.values(map).filter(j => j.url && j.id);
  });
}

// ─── FETCH POSTED DATE FROM JOB DETAIL PAGE ──────────────────────────────────

async function fetchJobPostedDate(page, jobUrl) {
  try {
    await page.goto(jobUrl, { waitUntil: 'networkidle', timeout: 35000 }).catch(() =>
      page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
    );
    await page.waitForTimeout(2500);

    // Wait for the job detail to render (look for a heading or apply button)
    await page.waitForSelector(
      'h1, h2, [class*="job-title"], [class*="jobTitle"], button, [class*="apply"]',
      { timeout: 10000 }
    ).catch(() => {});

    return page.evaluate(() => {
      const body = document.body.innerText;
      const m = body.match(
        /(\d+\s+(?:minute|hour|day|week|month)s?\s+ago|just\s*now|today|yesterday|posted[:\s]+\w[^\n]{0,40})/i
      );
      return m ? m[0].trim() : '';
    });
  } catch (e) {
    return ''; // unknown — let through
  }
}

// ─── SCAN ONE KEYWORD ─────────────────────────────────────────────────────────

async function scanKeyword(context, keyword, appliedJobs) {
  const searchUrl = buildSearchUrl(keyword);
  console.log(`\n[scan] Scanning: ${keyword}`);

  const page = await context.newPage();
  const found   = [];
  const allSeen = [];
  const seenIds = new Set();

  try {
    try {
      await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 40000 }).catch(() =>
        page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
      );
    } catch (e) {
      console.error(`   [!] Failed to load search page for "${keyword}": ${e.message}`);
      return { found, allSeen };
    }

    await page.waitForTimeout(3000);

    // Wait for job cards to appear
    await page.waitForSelector(
      'a[href*="#/jobs/"], [class*="job-card"], [class*="jobCard"], [class*="job-item"]',
      { timeout: 15000 }
    ).catch(() => {
      console.log(`   [!] No job card selector found for "${keyword}" — page may be empty`);
    });

    await scrollToLoadAll(page);

    // Check for "no results" state
    const noJobs = await page.evaluate(() => {
      const body = (document.body.innerText || '').toLowerCase();
      return body.includes('no jobs found') ||
             body.includes('no results found') ||
             body.includes('0 results') ||
             body.includes("no matching jobs") ||
             body.includes("couldn't find any");
    }).catch(() => false);

    if (noJobs) {
      console.log(`   [x] No results for "${keyword}"`);
      return { found, allSeen };
    }

    const jobs = await extractJobsFromPage(page);
    console.log(`   [${keyword}] Extracted ${jobs.length} job card(s)`);

    for (const job of jobs) {
      if (seenIds.has(job.id)) continue;
      seenIds.add(job.id);
      allSeen.push(job);

      if (appliedJobs.has(job.id)) continue;

      // If we got no posted date from the card, we'll accept it and check on detail page
      // (date check is re-done per-job in applyToJob for reliability)
      if (job.posted && !isRecentJob(job.posted)) {
        console.log(`   [~] Old posting skipped: ${job.title || job.id} (${job.posted})`);
        continue;
      }

      // Title filter
      if (job.title) {
        if (TITLE_BLOCK_RE.test(job.title) && !TITLE_ALLOW_RE.test(job.title)) {
          console.log(`   [x] Title blocked: ${job.title}`);
          continue;
        }
      }

      found.push({
        id:      job.id,
        url:     job.url,
        title:   job.title   || `Job #${job.id}`,
        company: job.company || '',
        posted:  job.posted  || '',
      });
    }

    console.log(`   [ok] "${keyword}": ${found.length} queued, ${allSeen.length - found.length} skipped`);

  } finally {
    await page.close().catch(() => {});
  }

  return { found, allSeen };
}

// ─── FILL APPLY FORM ──────────────────────────────────────────────────────────

/**
 * Fill the visible apply form fields with PROFILE data.
 * Handles: text inputs, selects, file upload.
 * Returns number of fields filled.
 */
async function fillApplyForm(page, workerId) {
  let filled = 0;

  // Helper — fill an input if visible and currently empty
  async function tryFill(selector, value) {
    if (!value) return;
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        const current = await el.inputValue().catch(() => '');
        if (!current) {
          await el.fill(String(value));
          filled++;
        }
      }
    } catch (_) {}
  }

  // Helper — select an option in a <select> by matching value or text
  async function trySelect(selector, value) {
    if (!value) return;
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        // Try exact value first, then partial label match
        await el.selectOption({ value: String(value) }).catch(async () => {
          await el.selectOption({ label: String(value) }).catch(async () => {
            // Fuzzy: find option whose text contains value
            const matched = await el.evaluate((sel, val) => {
              const opts = Array.from(sel.options);
              const lower = val.toLowerCase();
              const opt = opts.find(o =>
                o.text.toLowerCase().includes(lower) ||
                o.value.toLowerCase().includes(lower)
              );
              if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
              return false;
            }, String(value)).catch(() => false);
            if (matched) filled++;
          });
        });
        filled++;
      }
    } catch (_) {}
  }

  // ── Personal info ──────────────────────────────────────────────────────────

  // First name
  await tryFill('input[name*="firstName" i], input[name*="first_name" i], input[placeholder*="first name" i], input[id*="firstName" i], input[id*="first_name" i], input[data-qa*="firstName" i]', PROFILE.firstName);

  // Last name
  await tryFill('input[name*="lastName" i], input[name*="last_name" i], input[placeholder*="last name" i], input[id*="lastName" i], input[id*="last_name" i], input[data-qa*="lastName" i]', PROFILE.lastName);

  // Full name (single field)
  await tryFill('input[name*="fullName" i], input[name*="full_name" i], input[name*="name" i]:not([name*="first" i]):not([name*="last" i]), input[placeholder*="full name" i], input[placeholder*="your name" i]', PROFILE.fullName);

  // Email
  await tryFill('input[type="email"], input[name*="email" i], input[placeholder*="email" i], input[id*="email" i]', PROFILE.email);

  // Phone
  await tryFill('input[type="tel"], input[name*="phone" i], input[name*="mobile" i], input[placeholder*="phone" i], input[id*="phone" i]', PROFILE.phone);

  // Address fields
  await tryFill('input[name*="street" i], input[name*="address" i], input[placeholder*="street" i]', PROFILE.street);
  await tryFill('input[name*="city" i], input[placeholder*="city" i], input[id*="city" i]', PROFILE.city);
  await tryFill('input[name*="zip" i], input[name*="postal" i], input[placeholder*="zip" i], input[placeholder*="postal" i]', PROFILE.zip);

  // State — try select first, then text input
  await trySelect('select[name*="state" i], select[id*="state" i], select[placeholder*="state" i]', PROFILE.stateFullName);
  await tryFill('input[name*="state" i], input[placeholder*="state" i]', PROFILE.state);

  // Country
  await trySelect('select[name*="country" i], select[id*="country" i]', PROFILE.country);
  await tryFill('input[name*="country" i], input[placeholder*="country" i]', PROFILE.country);

  // LinkedIn
  await tryFill('input[name*="linkedin" i], input[placeholder*="linkedin" i], input[id*="linkedin" i]', PROFILE.linkedin);

  // Portfolio / Website
  await tryFill('input[name*="portfolio" i], input[name*="website" i], input[placeholder*="portfolio" i], input[placeholder*="website" i], input[placeholder*="personal site" i]', PROFILE.portfolio);

  // Years of experience
  await tryFill('input[name*="years" i], input[name*="experience" i], input[placeholder*="years" i]', PROFILE.yearsExp);
  await trySelect('select[name*="years" i], select[name*="experience" i]', PROFILE.yearsExp);

  // Salary expectation
  await tryFill('input[name*="salary" i], input[name*="compensation" i], input[placeholder*="salary" i], input[placeholder*="desired salary" i]', PROFILE.salary);

  // Notice period
  await tryFill('input[name*="notice" i], input[name*="available" i], input[placeholder*="notice" i]', PROFILE.noticeDays);
  await trySelect('select[name*="notice" i], select[name*="available" i]', PROFILE.noticeDays);

  // ── Sponsorship / work authorization ──────────────────────────────────────
  // Answer "Do you need sponsorship?" → No
  await page.evaluate(() => {
    const sponsorRE = /sponsor|visa\s*sponsor/i;
    const noRE      = /\bno\b/i;
    const yesRE     = /\byes\b/i;

    // Radio buttons
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const groups = {};
    for (const r of radios) { if (!groups[r.name]) groups[r.name] = []; groups[r.name].push(r); }
    for (const [, opts] of Object.entries(groups)) {
      const fieldset = opts[0].closest('fieldset, [role="group"], .form-group, .field');
      const label    = (fieldset ? fieldset.textContent : '').toLowerCase();
      if (!sponsorRE.test(label)) continue;
      const noOpt = opts.find(r => noRE.test(r.value) || noRE.test(r.parentElement.textContent));
      if (noOpt && !noOpt.checked) { noOpt.click(); noOpt.dispatchEvent(new Event('change', { bubbles: true })); }
    }

    // Work authorization — yes
    const authRE = /authoriz|eligible|legally\s*work|work\s*in\s*us/i;
    for (const [, opts] of Object.entries(groups)) {
      const fieldset = opts[0].closest('fieldset, [role="group"], .form-group, .field');
      const label    = (fieldset ? fieldset.textContent : '').toLowerCase();
      if (!authRE.test(label)) continue;
      const yesOpt = opts.find(r => yesRE.test(r.value) || yesRE.test(r.parentElement.textContent));
      if (yesOpt && !yesOpt.checked) { yesOpt.click(); yesOpt.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  }).catch(() => {});

  // ── EEO / self-ID ─────────────────────────────────────────────────────────
  await fillEEO(page);

  // ── Resume upload ──────────────────────────────────────────────────────────
  if (fs.existsSync(PROFILE.resumePath)) {
    try {
      const fileInputs = await page.$$('input[type="file"]');
      for (const fi of fileInputs) {
        const visible = await fi.isVisible().catch(() => false);
        const accept  = (await fi.getAttribute('accept') || '').toLowerCase();
        // Target resume fields — accept pdf/doc, or no accept restriction
        if (!accept || accept.includes('pdf') || accept.includes('doc') || accept.includes('*')) {
          if (visible) {
            await fi.setInputFiles(PROFILE.resumePath);
            filled++;
            wlog(workerId, `   [upload] Resume attached`);
            break;
          } else {
            // Some file inputs are hidden — use setInputFiles directly
            await fi.setInputFiles(PROFILE.resumePath).catch(() => {});
            filled++;
            wlog(workerId, `   [upload] Resume attached (hidden input)`);
            break;
          }
        }
      }
    } catch (e) {
      wlog(workerId, `   [!] Resume upload error: ${e.message}`);
    }
  } else {
    wlog(workerId, `   [!] resume.pdf not found at ${PROFILE.resumePath} — skipping upload`);
  }

  return filled;
}

// ─── EEO / SELF-ID FIELDS ─────────────────────────────────────────────────────

async function fillEEO(page) {
  await page.evaluate(({ ethnicity, gender, disability, veteran }) => {
    function trySelectByText(sel, value) {
      if (!sel || !value) return;
      const lower = value.toLowerCase();
      const opts  = Array.from(sel.options);
      // Exact match first
      let opt = opts.find(o => o.text.trim().toLowerCase() === lower || o.value.toLowerCase() === lower);
      // Partial match
      if (!opt) opt = opts.find(o => o.text.toLowerCase().includes(lower) || lower.includes(o.text.toLowerCase()));
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    }

    // Ethnicity
    for (const sel of document.querySelectorAll('select')) {
      const label = (sel.labels?.[0]?.textContent || sel.getAttribute('aria-label') || sel.name || sel.id || '').toLowerCase();
      if (/ethnic|race/.test(label)) trySelectByText(sel, ethnicity);
    }

    // Gender
    for (const sel of document.querySelectorAll('select')) {
      const label = (sel.labels?.[0]?.textContent || sel.getAttribute('aria-label') || sel.name || sel.id || '').toLowerCase();
      if (/gender|sex\b/.test(label)) trySelectByText(sel, gender);
    }

    // Disability
    for (const sel of document.querySelectorAll('select')) {
      const label = (sel.labels?.[0]?.textContent || sel.getAttribute('aria-label') || sel.name || sel.id || '').toLowerCase();
      if (/disabilit/.test(label)) {
        const noText = disability ? 'yes' : 'no';
        trySelectByText(sel, noText);
      }
    }

    // Veteran
    for (const sel of document.querySelectorAll('select')) {
      const label = (sel.labels?.[0]?.textContent || sel.getAttribute('aria-label') || sel.name || sel.id || '').toLowerCase();
      if (/veteran/.test(label)) {
        const text = veteran ? 'yes' : 'no';
        trySelectByText(sel, text);
      }
    }

    // Radio buttons for EEO
    const eeoRE    = /ethnic|race|gender|sex\b|disabilit|veteran/i;
    const radios   = Array.from(document.querySelectorAll('input[type="radio"]'));
    const groups   = {};
    for (const r of radios) { if (!groups[r.name]) groups[r.name] = []; groups[r.name].push(r); }

    for (const [, opts] of Object.entries(groups)) {
      const fieldset = opts[0].closest('fieldset, [role="group"], .form-group, .field, .eeo-field');
      const labelText = (fieldset ? fieldset.textContent : '').toLowerCase();
      if (!eeoRE.test(labelText)) continue;

      let targetText = '';
      if (/gender|sex\b/.test(labelText)) targetText = gender.toLowerCase();
      else if (/disabilit/.test(labelText)) targetText = disability ? 'yes' : 'no';
      else if (/veteran/.test(labelText))  targetText  = veteran ? 'yes' : 'no';
      else if (/ethnic|race/.test(labelText)) targetText = ethnicity.toLowerCase();

      if (!targetText) continue;
      const pick = opts.find(r =>
        (r.value || r.parentElement.textContent).toLowerCase().includes(targetText)
      );
      if (pick && !pick.checked) {
        pick.click();
        pick.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }, { ethnicity: PROFILE.ethnicity, gender: PROFILE.gender, disability: PROFILE.disability, veteran: PROFILE.veteran }).catch(() => {});
}

// ─── FIND AND CLICK APPLY NOW ─────────────────────────────────────────────────

async function findAndClickApply(page) {
  // Priority 1: "Apply Now" button
  for (const text of ['Apply Now', 'Apply now', 'APPLY NOW', 'Apply']) {
    const loc = page.locator(`button:has-text("${text}"), a:has-text("${text}")`).first();
    try {
      if (await loc.isVisible({ timeout: 3000 })) {
        await loc.click();
        return 'apply';
      }
    } catch (_) {}
  }

  // Priority 2: any element matching apply patterns
  const clicked = await page.evaluate(() => {
    const applyRE = /apply\s*now|^apply$/i;
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      if (applyRE.test(el.textContent.trim()) && el.offsetParent !== null) {
        el.click(); return el.textContent.trim();
      }
    }
    return null;
  }).catch(() => null);

  return clicked;
}

// ─── NAVIGATE APPLY FORM ──────────────────────────────────────────────────────

const CONFIRM_RE = /thank\s*you\s*for\s*(your\s*)?apply|application.*submitted|application.*received|successfully\s*appl|you.ve\s*applied|we.ve\s*received\s*your|application\s*complete|your\s*application\s*has\s*been|submission\s*successful/i;

async function navigateApplyForm(page, workerId, alreadyFilled = false) {
  const maxSteps = 15;

  for (let step = 0; step < maxSteps; step++) {
    if (_shouldStop) return 'UNCERTAIN';
    await page.waitForTimeout(2000);

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

    // Confirmation check
    if (CONFIRM_RE.test(bodyText)) {
      return 'APPLIED';
    }

    // Fill any visible form fields
    let filled = 0;
    if (!alreadyFilled && step === 0) {
      filled = await fillApplyForm(page, workerId);
    } else if (step > 0) {
      filled = await fillApplyForm(page, workerId);
    }
    if (filled > 0) wlog(workerId, `   [fill] Filled ${filled} field(s)`);

    // Submit button
    const submitLoc = page.locator([
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
      'button:has-text("Send Application")',
      'button:has-text("Send")',
      '[type="submit"]',
    ].join(', ')).first();

    try {
      if (await submitLoc.count() > 0 && await submitLoc.isVisible({ timeout: 1500 })) {
        wlog(workerId, `   [click] Step ${step + 1}: Submit`);
        await submitLoc.click();
        // Wait up to 15s for confirmation
        try {
          await page.waitForFunction(
            () => /thank|submitted|received|successfully appl|application complete/i.test(document.body.innerText),
            { timeout: 15000 }
          );
          return 'APPLIED';
        } catch {
          const after = await page.evaluate(() => document.body.innerText).catch(() => '');
          if (CONFIRM_RE.test(after)) return 'APPLIED';
          // Check for validation errors — don't return uncertain yet
          const hasErrors = await page.evaluate(() => {
            const body = document.body.innerText.toLowerCase();
            return body.includes('required') || body.includes('invalid') || body.includes('error');
          }).catch(() => false);
          if (hasErrors) {
            wlog(workerId, `   [!] Form has validation errors — attempting to fix and re-submit`);
            await fillApplyForm(page, workerId);
            await page.waitForTimeout(1000);
            continue;
          }
          return 'UNCERTAIN';
        }
      }
    } catch (e) {
      wlog(workerId, `   [!] Submit error: ${e.message}`);
    }

    // Next / Continue button
    const nextLoc = page.locator([
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Next Step")',
      'button:has-text("Proceed")',
    ].join(', ')).first();

    try {
      if (await nextLoc.count() > 0 && await nextLoc.isVisible({ timeout: 1500 }) && await nextLoc.isEnabled()) {
        wlog(workerId, `   [click] Step ${step + 1}: Next`);
        await nextLoc.click();
        continue;
      }
    } catch (e) {
      wlog(workerId, `   [!] Next button error: ${e.message}`);
    }

    // JS fallback for Next/Continue
    const clickedNext = await page.evaluate(() => {
      for (const el of document.querySelectorAll('button, a, [role="button"]')) {
        const txt = el.textContent.trim();
        if (/^(Next|Continue|Next Step|Proceed)$/i.test(txt) && el.offsetParent !== null) {
          el.click(); return txt;
        }
      }
      return null;
    }).catch(() => null);

    if (clickedNext) {
      wlog(workerId, `   [click] Step ${step + 1}: ${clickedNext} (JS fallback)`);
      continue;
    }

    // Nothing found — log visible interactive elements for debugging
    const visible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a[role="button"], input[type="submit"]'))
        .filter(b => b.offsetParent !== null)
        .map(b => b.textContent.trim() || b.value || b.type)
        .filter(Boolean)
    ).catch(() => []);
    wlog(workerId, `   [!] Step ${step + 1}: No Next/Submit. Visible: [${visible.slice(0, 8).join(' | ')}]`);
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

    const jobPage = await context.newPage();
    try {
      await jobPage.goto(job.url, { waitUntil: 'networkidle', timeout: 40000 }).catch(() =>
        jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
      );
      await jobPage.waitForTimeout(3000);

      // Wait for the job detail to render
      await jobPage.waitForSelector(
        'h1, h2, [class*="job-title"], [class*="jobTitle"], button, [class*="apply"]',
        { timeout: 12000 }
      ).catch(() => {});

      // Extract title & company from detail page
      let title   = job.title;
      let company = job.company || '-';
      try {
        const h = await jobPage.$('h1');
        if (h) { const t = (await h.textContent()).trim(); if (t) title = t; }
      } catch (_) {}
      try {
        const c = await jobPage.$(
          '[class*="company"], [class*="employer"], [class*="client"], [class*="org-name"]'
        );
        if (c) company = (await c.textContent()).trim();
      } catch (_) {}

      // Re-check posted date from the detail page (more reliable)
      if (!job.posted || job.posted === '') {
        const detailPosted = await jobPage.evaluate(() => {
          const body = document.body.innerText;
          const m = body.match(
            /(\d+\s+(?:minute|hour|day|week|month)s?\s+ago|just\s*now|today|yesterday|posted[:\s]+[^\n]{0,40})/i
          );
          return m ? m[0].trim() : '';
        }).catch(() => '');
        if (detailPosted) job.posted = detailPosted;
      }

      // Date gate on detail page
      if (job.posted && !isRecentJob(job.posted)) {
        wlog(workerId, `   [skip] Old posting: ${job.posted}`);
        writeAppliedEntry(workerId, title, company, job.id, 'SKIPPED', job.url);
        stats.skipped++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      // Title re-check with detail page title
      if (TITLE_BLOCK_RE.test(title) && !TITLE_ALLOW_RE.test(title)) {
        wlog(workerId, `   [skip] Title blocked: ${title}`);
        writeAppliedEntry(workerId, title, company, job.id, 'UNSUITABLE', job.url);
        stats.skipped++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'UNSUITABLE';
      }

      // Find and click Apply Now
      const clicked = await findAndClickApply(jobPage);
      if (!clicked) {
        wlog(workerId, `   [skip] No Apply button found`);
        writeAppliedEntry(workerId, title, company, job.id, 'SKIPPED', job.url);
        writeFailedEntry(workerId, title, company, job.id, 'SKIPPED', 'no apply button found', job.url);
        stats.skipped++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      wlog(workerId, `   [click] Clicked: ${clicked}`);

      // Shazamme/Bullhorn apply forms typically open in a modal or new page
      const newTabPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
      await jobPage.waitForTimeout(2000);
      const newTab = await newTabPromise;
      let applyPage;

      if (newTab) {
        applyPage = newTab;
        await applyPage.waitForFunction(
          () => location.href !== 'about:blank',
          { timeout: 12000 }
        ).catch(() => {});
        await applyPage.waitForLoadState('domcontentloaded').catch(() => {});
        await applyPage.waitForTimeout(2500);
        const tabUrl = applyPage.url();
        if (!tabUrl || tabUrl === 'about:blank') {
          wlog(workerId, `   [!] New tab stayed blank — skipping`);
          await applyPage.close().catch(() => {});
          await jobPage.close().catch(() => {});
          stats.skipped++;
          updateStatus(workerId, 'IDLE');
          return 'SKIPPED';
        }
        wlog(workerId, `   [tab] Apply tab: ${tabUrl}`);
      } else {
        // Modal on same page — wait for the form to appear
        await jobPage.waitForSelector(
          'form, [class*="apply-form"], [class*="applyForm"], [class*="modal"], [class*="dialog"]',
          { timeout: 8000 }
        ).catch(() => {});
        applyPage = jobPage;
        wlog(workerId, `   [modal] Apply form on same page`);
      }

      const result = await navigateApplyForm(applyPage, workerId);

      if (newTab) await applyPage.close().catch(() => {});
      await jobPage.close().catch(() => {});

      if (result === 'APPLIED') {
        wlog(workerId, `   [ok] APPLIED — ${title}`);
        markApplied(job.id);
        writeAppliedEntry(workerId, title, company, job.id, 'APPLIED', job.url);
        stats.applied++;
        updateStatus(workerId, 'IDLE');
        return 'APPLIED';
      }

      if (result === 'UNCERTAIN') {
        wlog(workerId, `   [?] UNCERTAIN — ${title}`);
        markApplied(job.id);
        writeAppliedEntry(workerId, title, company, job.id, 'UNCERTAIN', job.url);
        writeFailedEntry(workerId, title, company, job.id, 'UNCERTAIN', 'submitted but no confirmation detected', job.url);
        stats.uncertain++;
        updateStatus(workerId, 'IDLE');
        return 'UNCERTAIN';
      }

    } catch (err) {
      wlog(workerId, `   [err] Attempt ${attempt}: ${err.message}`);
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
    appliedJobs.add(job.id); // optimistic lock to prevent double-pickup

    await applyToJob(context, job, workerId, jobNumber);
    if (stats.applied + stats.failed + stats.uncertain >= MAX_JOBS) {
      _shouldStop = true;
      break;
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  wlog(workerId, `[done] Worker finished — queue exhausted`);
  updateStatus(workerId, 'DONE');
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function printDashboard() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`DASHBOARD — ${new Date().toLocaleTimeString()}`);
  console.log(`  Applied: ${stats.applied}  Skipped: ${stats.skipped}  Failed: ${stats.failed}  Uncertain: ${stats.uncertain}`);
  console.log(`  Queue  : ${queueIndex}/${jobQueue.length} processed`);
  for (const [id, s] of Object.entries(workerStatus)) {
    if (id === 'heartbeat') continue;
    console.log(`  ${id}: [${s.state}] ${s.job || '-'}`);
  }
  console.log(`${'─'.repeat(60)}\n`);
}

// ─── MAIN RUN LOOP ────────────────────────────────────────────────────────────

async function runBot() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Yoh Job Bot — ${NUM_WORKERS} Parallel Workers`);
  console.log(`Profile    : ${PROFILE_DIR}`);
  console.log(`Status     : ${STATUS_FILE}`);
  console.log(`Max runtime: ${MAX_MINUTES > 0 ? MAX_MINUTES + ' min' : 'unlimited'}`);
  console.log(`${'='.repeat(60)}\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const pages    = context.pages();
  const holdPage = pages.length > 0 ? pages[0] : await context.newPage();

  // Warm up — navigate to site to confirm it loads
  console.log(`Loading ${BASE_URL} ...`);
  await holdPage.goto(`${BASE_URL}/#/jobs`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() =>
    holdPage.goto(`${BASE_URL}/#/jobs`, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
  );
  await holdPage.waitForTimeout(2000);
  console.log(`Site loaded. URL: ${holdPage.url()}\n`);

  let appliedJobs = loadAppliedJobs();
  console.log(`Loaded ${appliedJobs.size} previously applied job IDs`);

  const dashInterval = setInterval(printDashboard, 30000);

  try {
    while (!_shouldStop) {
      // Check runtime limit
      if (MAX_MINUTES > 0 && (Date.now() - _startTime) > MAX_MINUTES * 60 * 1000) {
        console.log(`\n[time] Runtime limit (${MAX_MINUTES} min) reached — stopping`);
        break;
      }

      console.log(`\n${'='.repeat(50)}`);
      console.log(`[scan] Starting scan across ${SEARCH_KEYWORDS.length} keywords in parallel...`);

      // Parallel scan of all keywords
      const scanResults = await Promise.all(
        SEARCH_KEYWORDS.map(kw => scanKeyword(context, kw, appliedJobs))
      );

      // Merge and dedup by ID
      const seenAllIds = new Set();
      const allSeen    = [];
      const mergedIds  = new Set();
      const mergedJobs = [];

      for (const { found, allSeen: slugSeen } of scanResults) {
        for (const j of slugSeen) {
          if (!seenAllIds.has(j.id)) { seenAllIds.add(j.id); allSeen.push(j); }
        }
        for (const j of found) {
          if (!mergedIds.has(j.id)) { mergedIds.add(j.id); mergedJobs.push(j); }
        }
      }

      const queuedIds = new Set(mergedJobs.map(j => j.id));
      writeScannedJobs(allSeen, queuedIds, appliedJobs);

      if (mergedJobs.length === 0) {
        console.log(`\n[scan] No new jobs found — waiting ${RESCAN_WAIT_MS / 1000}s before rescan...`);
        // Interruptible sleep
        for (let i = 0; i < RESCAN_WAIT_MS / 1000; i++) {
          if (_shouldStop) break;
          if (MAX_MINUTES > 0 && (Date.now() - _startTime) > MAX_MINUTES * 60 * 1000) break;
          await new Promise(r => setTimeout(r, 1000));
        }
        continue;
      }

      jobQueue   = mergedJobs;
      queueIndex = 0;

      console.log(`\n[queue] ${mergedJobs.length} new jobs — launching ${NUM_WORKERS} workers`);
      initAppliedFile(mergedJobs.length);
      printDashboard();

      // Run workers in parallel
      await Promise.all(
        Array.from({ length: NUM_WORKERS }, (_, i) =>
          runWorker(`W${i + 1}`, context, appliedJobs, i * 2000)
        )
      );

      printDashboard();

      if (_shouldStop) break;

      console.log(`\n[scan] Queue exhausted — waiting ${RESCAN_WAIT_MS / 1000}s before rescan...`);
      for (let i = 0; i < RESCAN_WAIT_MS / 1000; i++) {
        if (_shouldStop) break;
        if (MAX_MINUTES > 0 && (Date.now() - _startTime) > MAX_MINUTES * 60 * 1000) break;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

  } catch (err) {
    console.error(`\n[fatal]:`, err.stack || err.message);
  } finally {
    clearInterval(dashInterval);
    writeSessionSummary();

    // Open failed jobs in browser
    if (sessionFailedUrls.size > 0) {
      console.log(`\n[failed] Opening ${sessionFailedUrls.size} failed job(s) in browser...`);
      for (const url of sessionFailedUrls) {
        try {
          const p = await context.newPage();
          await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        } catch (_) {}
      }
      // Pause before closing so user can review
      console.log(`[failed] Press ENTER to close browser and exit...`);
      process.stdin.resume();
      await new Promise(resolve => process.stdin.once('data', resolve));
      process.stdin.pause();
    }

    await context.close().catch(e => console.error('Failed to close context:', e.message));
  }

  const ran = Math.floor((Date.now() - _startTime) / 60000);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Session Complete — ran ${ran} min`);
  console.log(`Applied: ${stats.applied} | Skipped: ${stats.skipped} | Failed: ${stats.failed} | Uncertain: ${stats.uncertain}`);
  console.log(`Scanned log  -> ${SCANNED_FILE}`);
  console.log(`Applied log  -> ${APPLIED_FILE}`);
  console.log(`Failed log   -> ${FAILED_FILE}`);
  console.log(`${'='.repeat(60)}\n`);
}

// ─── LOGIN MODE ───────────────────────────────────────────────────────────────

async function loginMode() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Yoh Bot — LOGIN MODE`);
  console.log(`Profile dir: ${PROFILE_DIR}`);
  console.log(`${'='.repeat(60)}\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const pages = context.pages();
  const page  = pages.length > 0 ? pages[0] : await context.newPage();

  // Navigate to Yoh jobs site
  await page.goto(`${BASE_URL}/#/jobs`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() =>
    page.goto(`${BASE_URL}/#/jobs`, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
  );

  console.log(`Browser is open at: ${BASE_URL}/#/jobs`);
  console.log(`\nNOTE: Yoh typically does not require login for guest apply.`);
  console.log(`If there is an account sign-in, please log in manually.`);
  console.log(`Session will be saved to: ${PROFILE_DIR}`);
  console.log(`\nPress ENTER when done (or just close the browser to abort)...`);

  process.stdin.resume();
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
    page.on('close', resolve);
    context.on('close', resolve);
  });
  process.stdin.pause();

  await context.close().catch(() => {});
  console.log(`\n[ok] Session saved. Run "node yoh-bot.js [minutes]" to start applying.\n`);
}

// ─── PROBE MODE ───────────────────────────────────────────────────────────────

async function probeMode() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Yoh Bot — PROBE MODE`);
  console.log(`${'='.repeat(60)}\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  for (const p of context.pages()) await p.close().catch(() => {});
  const page = await context.newPage();

  // Load first search URL
  const searchUrl = buildSearchUrl(SEARCH_KEYWORDS[0]);
  console.log(`Loading: ${searchUrl}`);
  await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 40000 }).catch(() =>
    page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
  );

  console.log(`\nBrowser open. Dismiss any popups, then press ENTER to extract jobs...`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();

  await scrollToLoadAll(page);

  const jobs = await extractJobsFromPage(page);
  console.log(`\nExtracted ${jobs.length} job(s):`);
  jobs.slice(0, 10).forEach((j, i) =>
    console.log(`  ${i + 1}. [${j.id}] ${j.title || '(no title)'} | posted: ${j.posted || 'unknown'} | ${j.url}`)
  );

  if (jobs.length === 0) {
    // Dump all hash-routed links for debugging
    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a'))
        .map(a => ({ href: a.href || a.getAttribute('href') || '', text: a.textContent.trim().slice(0, 80) }))
        .filter(l => l.href.includes('#/jobs'))
        .slice(0, 30)
    );
    console.log(`\nAll #/jobs links on page:`);
    allLinks.forEach(l => console.log(`  "${l.text.padEnd(50)}"  ->  ${l.href}`));
  }

  if (jobs.length > 0) {
    const testJob = jobs[0];
    console.log(`\nOpening first job detail: ${testJob.url}`);
    await page.goto(testJob.url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() =>
      page.goto(testJob.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
    );
    await page.waitForTimeout(3000);

    console.log(`\nJob detail page loaded. Press ENTER to dump buttons/links...`);
    process.stdin.resume();
    await new Promise(resolve => process.stdin.once('data', resolve));
    process.stdin.pause();

    const interactive = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
        .filter(el => el.offsetParent !== null)
        .map(el => ({
          tag:   el.tagName.toLowerCase(),
          text:  el.textContent.trim().slice(0, 80),
          href:  el.href || '',
          type:  el.type || '',
          class: el.className.slice(0, 60),
        }))
        .filter(el => el.text || el.type === 'submit')
        .slice(0, 40)
    );

    console.log(`\nVisible interactive elements on job detail page:`);
    interactive.forEach(el => {
      const dest = el.href ? `  ->  ${el.href.slice(0, 70)}` : '';
      console.log(`  <${el.tag}${el.type ? ' type="' + el.type + '"' : ''}> "${el.text}"${dest}`);
    });

    // Also try clicking Apply and inspect the form
    console.log(`\nPress ENTER to attempt clicking Apply and inspect the form...`);
    process.stdin.resume();
    await new Promise(resolve => process.stdin.once('data', resolve));
    process.stdin.pause();

    const clicked = await findAndClickApply(page);
    console.log(`Apply click result: ${clicked}`);
    await page.waitForTimeout(3000);

    // New tab?
    const allPages = context.pages();
    if (allPages.length > 1) {
      const newTab = allPages[allPages.length - 1];
      console.log(`New tab opened: ${newTab.url()}`);
      await newTab.waitForLoadState('domcontentloaded').catch(() => {});
      await newTab.waitForTimeout(2000);

      const formFields = await newTab.evaluate(() =>
        Array.from(document.querySelectorAll('input, select, textarea'))
          .map(el => ({
            tag:         el.tagName.toLowerCase(),
            type:        el.type || '',
            name:        el.name || '',
            id:          el.id || '',
            placeholder: el.placeholder || '',
            label:       el.labels?.[0]?.textContent?.trim() || '',
          }))
          .slice(0, 40)
      );
      console.log(`\nApply form fields:`);
      formFields.forEach(f =>
        console.log(`  <${f.tag} type="${f.type}" name="${f.name}" id="${f.id}" placeholder="${f.placeholder}"> ${f.label}`)
      );
    }
  }

  console.log(`\nProbe complete. Press ENTER to close...`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();

  await context.close();
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

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

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
  if (!url) { console.error('[err] Usage: node yoh-bot.js formtest <applyUrl>'); process.exit(1); }
  formTestMode(url).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else {
  // arg is either a number (minutes) or undefined (run until empty)
  _startTime = Date.now();
  runBot().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
