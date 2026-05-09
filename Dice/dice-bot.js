#!/usr/bin/env node
/**
 * Dice Job Application Bot — 4 Parallel Workers
 *
 * FIRST TIME:  node dice-bot.js login
 * RUN:         node dice-bot.js
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const HOME_DIR       = process.env.HOME || process.env.USERPROFILE || '';
const PROFILE_DIR    = process.env.DICE_PROFILE_PATH || path.join(HOME_DIR, 'dice-bot-profile');
const WORKSPACE_DIR  = path.join(HOME_DIR, '.openclaw', 'workspace');
const LOG_FILE       = path.join(WORKSPACE_DIR, 'dice_applications_log.md');
const APPLIED_IDS    = path.join(WORKSPACE_DIR, 'applied_ids.txt');   // raw ID dedup guard
const STATUS_FILE    = path.join(WORKSPACE_DIR, 'worker_status.json');
const SCANNED_FILE   = path.join(__dirname, 'scanned_jobs.txt');       // every scanned job
const APPLIED_FILE   = path.join(__dirname, 'applied_jobs.txt');       // jobs we acted on
const FAILED_FILE    = path.join(__dirname, 'failed_jobs.txt');        // FAILED + UNCERTAIN (need review)

const NUM_WORKERS    = 4;
const RATE_LIMIT_MS  = 8000;   // ms between applications per worker
const PAGE_TIMEOUT   = 25000;
const BATCH_SIZE     = 200;
const RESCAN_WAIT_MS = 90000;  // wait between full scans (ms)

// After this many consecutive empty scans, switch to location-based search
const EMPTY_SCANS_BEFORE_LOCATION = 3;

// Only jobs posted within 24 hours (Dice filter value ONE = last 24h)
const BASE_FILTERS = 'filters.easyApply=true&filters.postedDate=ONE&filters.workArrangement=REMOTE&filters.workArrangement=HYBRID&filters.workArrangement=ONSITE&countryCode=US&pageSize=100';
const SEARCH_QUERIES = ['Data+Scientist', 'Data+Science', 'Machine+Learning+Engineer'];
const SEARCH_URLS = SEARCH_QUERIES.map(q => `https://www.dice.com/jobs?q=${q}&${BASE_FILTERS}`);

// Top 10 US IT hub cities for location fallback
const LOCATIONS = [
  'New York, NY',
  'San Francisco, CA',
  'Seattle, WA',
  'Austin, TX',
  'Boston, MA',
  'Atlanta, GA',
  'Chicago, IL',
  'Washington, DC',
  'Dallas, TX',
  'Denver, CO',
];

// Build location-scoped URLs for a given city
function buildLocationUrls(city) {
  const encoded = encodeURIComponent(city);
  return SEARCH_QUERIES.map(q =>
    `https://www.dice.com/jobs?q=${q}&location=${encoded}&filters.locationPrecision=City&${BASE_FILTERS}`
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

// No title keyword requirements — apply to every easy-apply DS/ML job from search results
const TITLE_KEYWORDS = [];   // disabled: apply regardless of title
const TITLE_BLOCK    = [];   // disabled: no title blocking
const DESC_BLOCK     = [];   // disabled: no description blocking

// ─── SHARED STATE ─────────────────────────────────────────────────────────────

let _shouldStop = false;  // set true on first Ctrl+C for graceful shutdown
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

// Worker status — shown in status.json and terminal summary
const workerStatus = {};
for (let i = 1; i <= NUM_WORKERS; i++) {
  workerStatus[`W${i}`] = { state: 'IDLE', job: '', lastUpdate: '' };
}

// Shared job queue — JS is single-threaded so array ops are race-condition free
let jobQueue = [];
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

function writeScannedJobs(allJobsOnPage, queuedIds, appliedJobs) {
  ensureDir(SCANNED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  const newCount  = queuedIds.size;
  const skipCount = allJobsOnPage.length - newCount;

  const lines = [
    '='.repeat(80),
    `DICE SCAN  —  ${ts}`,
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
    lines.push(`       Link    : https://www.dice.com/job-detail/${j.id}`);
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
    `DICE SESSION  —  ${ts}`,
    `${queueSize} jobs queued for application`,
    '='.repeat(80),
    '',
  ].join('\n'));
}

function writeAppliedEntry(workerId, title, company, jobId, status) {
  const time      = new Date().toLocaleTimeString('en-US', { hour12: false });
  const statusPad = status.padEnd(9);
  fs.appendFileSync(APPLIED_FILE, [
    `[${time}] [${workerId}]  ${statusPad}  —  ${title}`,
    `  Company : ${company || '-'}`,
    `  Link    : https://www.dice.com/job-detail/${jobId}`,
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

function writeFailedEntry(workerId, title, company, jobId, status, reason = '') {
  ensureDir(FAILED_FILE);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const note = reason ? `  Reason  : ${reason}` : '';
  const url  = `https://www.dice.com/job-detail/${jobId}`;
  sessionFailedUrls.add(url);  // track for current-session browser review only
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
      '# Dice Job Applications Log\n\n' +
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

// ─── DATE FILTER — only jobs posted within 24 hours ──────────────────────────

function isWithin24Hours(postedText) {
  if (!postedText) return true; // unknown — let it through
  const t = postedText.toLowerCase();
  if (t.includes('just now') || t.includes('today') || t.includes('hour')) return true;
  if (t.includes('1 day')) return true; // "1 day ago" is borderline — include it
  if (t.includes('day') || t.includes('week') || t.includes('month')) return false;
  return true; // default: let through
}

// ─── SCROLL TO LOAD ALL LAZY CARDS ───────────────────────────────────────────

async function scrollToLoadAll(page) {
  let prev = 0;
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
    const count = await page.evaluate(() =>
      document.querySelectorAll('a[href*="/job-detail/"]').length
    );
    if (count === prev) break;
    prev = count;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

// ─── EXTRACT JOBS FROM PAGE ───────────────────────────────────────────────────

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/job-detail/"]'));
    const map = {};
    for (const a of links) {
      const m = a.href.match(/job-detail\/([a-f0-9-]+)/i);
      if (!m) continue;
      const id = m[1];
      const text = a.textContent.trim();
      if (!map[id]) map[id] = { id, title: '', company: '', hasEasyApply: false, posted: '' };
      const lower = text.toLowerCase();
      if (lower === 'easy apply') {
        map[id].hasEasyApply = true;
      } else if (/\d+\s*(hour|minute|day|week|month)|today|just now/i.test(text)) {
        map[id].posted = text.trim();
      } else if (text.length > 4 && lower !== 'applied' && lower !== 'view details') {
        if (text.length > (map[id].title || '').length) map[id].title = text;
      }
      // grab company from nearest card container
      if (!map[id].company) {
        const card = a.closest('[data-cy="card"], article, li, [class*="card"], [class*="job-tile"]');
        if (card) {
          const c = card.querySelector('[data-cy="companyNameLink"], [class*="company"], [class*="employer"]');
          if (c) map[id].company = c.textContent.trim();
        }
      }
    }
    return Object.values(map);
  });
}

// ─── SCAN FOR JOBS ────────────────────────────────────────────────────────────

async function scanForJobs(page, appliedJobs, urlsToScan = SEARCH_URLS) {
  const found    = [];   // jobs to apply (queued)
  const allSeen  = [];   // every card seen (for scanned_jobs.txt)
  const seenIds  = new Set();

  for (const searchUrl of urlsToScan) {
    const qMatch = searchUrl.match(/q=([^&]+)/);
    const keyword = qMatch ? qMatch[1].replace(/\+/g, ' ') : 'unknown';
    console.log(`\n🔍 Scanning: ${keyword}`);

    let pageNum = 1;
    let totalEasyApply = 0;
    let totalAdded = 0;
    let totalFiltered = 0;
    let totalOld = 0;

    // Wait for search results OR "no jobs" message to appear — avoids fixed-time races
    const waitForResultsOrEmpty = () => page.waitForFunction(() => {
      const text = document.body.innerText || '';
      const hasNoJobs = text.includes("We weren't able to find any jobs");
      const hasCards  = document.querySelectorAll(
        '[data-cy="search-card"], .card-title-link, [class*="search-card"], ' +
        '[data-testid*="job-card"], article[data-jobid]'
      ).length > 0;
      return hasNoJobs || hasCards;
    }, { timeout: 12000 }).catch(() => {});

    // Trigger the search by pressing Enter on the keyword input — works even when
    // Dice's SPA doesn't auto-fire the query after a direct URL navigation
    const retriggerSearch = async () => {
      // Press Enter on the keyword input (most reliable: mirrors what the user does)
      try {
        const kwInput = page.locator(
          'input[name="q"], input[placeholder*="Job title" i], #typeaheadInput'
        ).first();
        if (await kwInput.count()) { await kwInput.press('Enter'); return true; }
      } catch {}
      // Fallback: click any visible Search button (partial text match)
      try {
        await page.getByRole('button', { name: /search/i }).first().click({ timeout: 3000 });
        return true;
      } catch {}
      // Last resort: shadow DOM walker
      return !!(await shadowClick(page, /search/i).catch(() => null));
    };

    while (found.length < BATCH_SIZE) {
      const pagedUrl = searchUrl + `&page=${pageNum}`;
      try {
        await page.goto(pagedUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        await waitForResultsOrEmpty();   // wait for React to render, not a fixed timer
        await scrollToLoadAll(page);

        const noJobsCheck = () => page.evaluate(() =>
          (document.body.innerText || '').includes("We weren't able to find any jobs")
        ).catch(() => false);

        if (await noJobsCheck()) {
          if (pageNum === 1) {
            console.log(`   🔍 Page 1 "No jobs found" — re-triggering search...`);
            await retriggerSearch();
            await waitForResultsOrEmpty();
            await scrollToLoadAll(page);
            if (await noJobsCheck()) {
              console.log(`   ↩️  Still empty — reloading page...`);
              await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
              await waitForResultsOrEmpty();
              await scrollToLoadAll(page);
              if (await noJobsCheck()) { console.log(`   ⛔ Still no results — skipping query`); break; }
            } else {
              console.log(`   ✅ Search re-triggered successfully`);
            }
          } else {
            console.log(`   ⛔ Page ${pageNum} has no results — end of pagination`);
            break;
          }
        }

        const jobs = await extractJobsFromPage(page);
        if (jobs.length === 0) break;

        const newOnPage = jobs.filter(j => !seenIds.has(j.id));
        if (pageNum > 1 && newOnPage.length === 0) break;

        for (const job of jobs) {
          if (seenIds.has(job.id)) continue;
          seenIds.add(job.id);
          allSeen.push(job);

          if (!job.hasEasyApply) continue;
          totalEasyApply++;
          if (appliedJobs.has(job.id)) continue;

          // 24hr filter — only restriction besides Easy Apply
          if (!isWithin24Hours(job.posted)) { totalOld++; continue; }

          found.push({ id: job.id, url: `https://www.dice.com/job-detail/${job.id}`, title: job.title || job.id, company: job.company || '', posted: job.posted });
          totalAdded++;
        }

        console.log(`   Page ${pageNum}: ${jobs.length} cards | ${newOnPage.filter(j=>j.hasEasyApply).length} new Easy Apply | running total: ${totalAdded} to apply`);
        pageNum++;

      } catch (err) {
        console.error(`   ⚠️  Page ${pageNum} error: ${err.message}`);
        break;
      }
    }

    console.log(`   ✅ Done: ${totalEasyApply} Easy Apply | ${totalAdded} queued | ${totalOld} >24h skipped | ${totalFiltered} title-filtered`);
  }

  // Write scanned_jobs.txt
  const queuedIds = new Set(found.map(j => j.id));
  writeScannedJobs(allSeen, queuedIds, appliedJobs);

  return found;
}

// ─── DESCRIPTION GATE ────────────────────────────────────────────────────────
// Returns { ok: true } or { ok: false, reason: string }

async function checkJobSuitability(page) {
  try {
    const text = await page.evaluate(() => {
      // Grab job description container; fall back to full body
      const el = document.querySelector(
        '[data-cy="jobDescription"], [class*="jobDescription"], [class*="job-description"], #jobDescription, main'
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

// ─── FIND AND CLICK EASY APPLY ────────────────────────────────────────────────

async function findAndClickEasyApply(page) {
  const applyPattern = /^(easy apply|continue application)$/i;

  // Primary: <a> matching either label
  const aLoc = page.locator('a', { hasText: applyPattern });
  try {
    const count = await aLoc.count();
    for (let i = 0; i < count; i++) {
      const el = aLoc.nth(i);
      if (await el.isVisible()) { await el.click(); return true; }
    }
  } catch (e) { /* link locator failed — try next strategy */ }

  // Fallback: button matching either label
  const btnLoc = page.locator('button', { hasText: applyPattern });
  try {
    if (await btnLoc.count() > 0 && await btnLoc.first().isVisible()) {
      await btnLoc.first().click(); return true;
    }
  } catch (e) { /* button locator failed — try next strategy */ }

  // Fallback: data-cy
  for (const sel of ['[data-cy="apply-button-top"]', '[data-cy="apply-button"]', '[data-cy="continueApplication"]']) {
    try {
      const loc = page.locator(sel);
      if (await loc.count() > 0 && await loc.first().isVisible()) {
        await loc.first().click(); return true;
      }
    } catch (e) { /* data-cy selector failed — try next */ }
  }

  // Last resort: evaluate — matches "Easy Apply" OR "Continue Application"
  const clicked = await page.evaluate(() => {
    for (const el of document.querySelectorAll('a, button')) {
      const txt = el.textContent.trim().toLowerCase();
      if ((txt === 'easy apply' || txt === 'continue application') && el.offsetParent !== null) {
        el.click(); return true;
      }
    }
    return false;
  }).catch(() => false);

  return clicked;
}

// ─── COVER LETTER UPLOAD ─────────────────────────────────────────────────────

const COVER_LETTER_PATH = process.env.COVER_LETTER_PATH ||
  path.join(__dirname, '..', 'Nikhil_Rao_Cover_Letter.pdf');

async function uploadCoverLetter(page, workerId) {
  // Guard: file must exist on disk
  if (!fs.existsSync(COVER_LETTER_PATH)) {
    wlog(workerId, `   ⚠️  Cover letter not found at ${COVER_LETTER_PATH}`);
    return false;
  }

  try {
    const allInputs = page.locator('input[type="file"]');
    const count = await allInputs.count();
    if (count === 0) return false;

    for (let i = 0; i < count; i++) {
      const inp = allInputs.nth(i);

      // Collect all text context around this input
      const ctx = await inp.evaluate(el => {
        const parts = [];
        // own attributes
        parts.push(el.id, el.name, el.getAttribute('aria-label') || '', el.getAttribute('data-cy') || '');
        // associated label via for=
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) parts.push(lbl.textContent);
        }
        // ancestor label or wrapper text (up to 3 levels)
        let node = el.parentElement;
        for (let n = 0; n < 3 && node; n++, node = node.parentElement) {
          parts.push(node.textContent);
        }
        return parts.join(' ').toLowerCase();
      }).catch(() => '');

      if (/cover/i.test(ctx)) {
        await inp.setInputFiles(COVER_LETTER_PATH);
        wlog(workerId, `   📄 Cover letter uploaded (input ${i + 1}/${count})`);
        await page.waitForTimeout(1000);
        return true;
      }
    }

    // Fallback: page mentions "cover letter" and there's exactly one file input — use it
    const pageText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '');
    if (/cover letter/i.test(pageText) && count === 1) {
      await allInputs.first().setInputFiles(COVER_LETTER_PATH);
      wlog(workerId, `   📄 Cover letter uploaded (sole file input)`);
      await page.waitForTimeout(1000);
      return true;
    }

  } catch (err) {
    wlog(workerId, `   ⚠️  Cover letter upload error: ${err.message}`);
  }
  return false;
}

// ─── AUTO-ANSWER QUESTION PAGES ───────────────────────────────────────────────

async function answerQuestions(page) {
  const answered = await page.evaluate(() => {
    // Keywords that should be answered "No" (cost/risk to employer or applicant)
    const NO_KEYWORDS  = /sponsor|sponsorship|visa/i;
    // Keywords that should be answered "Yes" (eligibility / willingness)
    const YES_KEYWORDS = /authoriz|eligible|legally|willing|relocate|available/i;
    // Placeholder-like select option values to skip
    const PLACEHOLDER  = /^(select|choose|please|--|none|0|null|undefined)$/i;

    let count = 0;

    // ── Radio groups ────────────────────────────────────────────────────────────
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const groups = {};
    for (const r of radios) {
      if (!groups[r.name]) groups[r.name] = [];
      groups[r.name].push(r);
    }
    for (const [, options] of Object.entries(groups)) {
      if (options.some(r => r.checked)) continue;

      // Pull question text from fieldset legend or nearest label/wrapper
      const fieldset   = options[0].closest('fieldset');
      const legend     = fieldset ? fieldset.querySelector('legend') : null;
      const groupLabel = (legend ? legend.textContent : fieldset ? fieldset.textContent : '').toLowerCase();

      let wantNo = NO_KEYWORDS.test(groupLabel);
      if (!wantNo && YES_KEYWORDS.test(groupLabel)) wantNo = false; // explicit Yes

      let pick = wantNo
        ? options.find(r => /\bno\b/i.test(r.value || r.parentElement.textContent))
        : options.find(r => /\byes\b/i.test(r.value || r.parentElement.textContent));
      if (!pick) pick = options[0]; // fallback: first option

      pick.click();
      pick.dispatchEvent(new Event('change', { bubbles: true }));
      count++;
    }

    // ── Select dropdowns ────────────────────────────────────────────────────────
    for (const sel of document.querySelectorAll('select')) {
      if (sel.value) continue;
      // Filter out placeholder options (empty value or placeholder text)
      const opts = Array.from(sel.options).filter(o => o.value && !PLACEHOLDER.test(o.value.trim()) && !PLACEHOLDER.test(o.text.trim()));
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

async function navigateApplyForm(page, workerId) {
  const maxSteps = 15;
  let coverLetterDone = false;

  for (let step = 0; step < maxSteps; step++) {
    await page.waitForTimeout(2000).catch(() => {});

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

    // Confirmation check
    if (/submitted|thank you|successfully|application received|you.ve applied|applied!/i.test(bodyText)) {
      return 'APPLIED';
    }

    // Upload cover letter only once across all steps
    if (!coverLetterDone) {
      const uploaded = await uploadCoverLetter(page, workerId);
      if (uploaded) coverLetterDone = true;
    }

    // Auto-answer any questions
    const answered = await answerQuestions(page);
    if (answered > 0) wlog(workerId, `   ✏️  Answered ${answered} question(s)`);

    // Submit
    const submitLoc = page.locator([
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
      '[data-cy="submit-btn"]',
      '[data-cy="submit-application"]',
    ].join(', ')).first();

    try {
      if (await submitLoc.count() > 0 && await submitLoc.isVisible()) {
        wlog(workerId, `   🖱️  Step ${step + 1}: Submit`);
        await submitLoc.click();
        // Wait for Dice's confirmation screen — up to 20s before falling back
        try {
          await page.waitForSelector(
            'text="Excellent! Your application is on its way!"',
            { timeout: 20000 }
          );
          wlog(workerId, `   🎉 Confirmation received`);
          return 'APPLIED';
        } catch {
          const afterText = await page.evaluate(() => document.body.innerText).catch(() => '');
          if (/excellent.*application|submitted|thank you|successfully|application received|you.ve applied/i.test(afterText)) {
            return 'APPLIED';
          }
          return 'UNCERTAIN';
        }
      }
    } catch (e) {
      wlog(workerId, `   ⚠️  Submit error: ${e.message}`);
    }

    // Next — try Playwright locator first, then JS evaluate fallback (handles <a> and non-button elements)
    const nextLoc = page.locator([
      'button:has-text("Next")',
      'button:has-text("Continue")',
      '[data-cy="next-btn"]',
    ].join(', ')).first();

    try {
      if (await nextLoc.count() > 0 && await nextLoc.isVisible() && await nextLoc.isEnabled()) {
        wlog(workerId, `   🖱️  Step ${step + 1}: Next`);
        await nextLoc.click();
        continue;
      }
    } catch (e) { wlog(workerId, `   ⚠️  Next button error: ${e.message}`); }

    // Fallback: JS click on ANY visible "Next" / "Continue" element (catches <a>, <span>, etc.)
    const clickedNext = await page.evaluate(() => {
      const candidates = ['Next', 'Continue', 'next', 'continue'];
      for (const el of document.querySelectorAll('button, a, [role="button"], span')) {
        const txt = el.textContent.trim();
        if (candidates.includes(txt) && el.offsetParent !== null) {
          el.click();
          return txt;
        }
      }
      return null;
    }).catch(() => null);

    if (clickedNext) {
      wlog(workerId, `   🖱️  Step ${step + 1}: ${clickedNext} (fallback click)`);
      continue;
    }

    // Nothing — log visible buttons so we can debug if something goes wrong
    const visible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a[role="button"], a'))
        .filter(b => b.offsetParent !== null).map(b => b.textContent.trim()).filter(Boolean)
    ).catch(() => []);
    wlog(workerId, `   ⚠️  Step ${step + 1}: No Next/Submit. Visible: [${visible.join(' | ')}]`);
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
    if (attempt > 1) {
      wlog(workerId, `   🔄 Retry ${attempt}/${MAX_RETRIES}`);
      await new Promise(r => setTimeout(r, 5000));
    }

    let jobPage;
    try {
      if (_shouldStop) break;
      jobPage = await context.newPage();
      await jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await jobPage.waitForTimeout(5000).catch(() => {});

      // Grab title/company
      let title = job.title, company = '-';
      try { const h1 = await jobPage.$('h1'); if (h1) title = (await h1.textContent()).trim(); }
      catch (e) { wlog(workerId, `   ⚠️  Title extraction: ${e.message}`); }
      try {
        const c = await jobPage.$('[data-cy="companyNameLink"], [class*="companyName"], [class*="employer"]');
        if (c) company = (await c.textContent()).trim();
      } catch (e) { wlog(workerId, `   ⚠️  Company extraction: ${e.message}`); }

      // Description gate — check before touching the apply button
      const suitability = await checkJobSuitability(jobPage);
      if (!suitability.ok) {
        wlog(workerId, `   🚫 UNSUITABLE — ${suitability.reason}`);
        logJob(workerId, jobNumber, title, company, job.id, 'UNSUITABLE');
        writeAppliedEntry(workerId, title, company, job.id, `UNSUITABLE (${suitability.reason})`);
        stats.skipped++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'UNSUITABLE';
      }

      const clicked = await findAndClickEasyApply(jobPage);
      if (!clicked) {
        wlog(workerId, `   ⏭️  No Easy Apply button — SKIPPED`);
        logJob(workerId, jobNumber, title, company, job.id, 'SKIPPED');
        writeAppliedEntry(workerId, title, company, job.id, 'SKIPPED');
        stats.skipped++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      // Listen for new tab AFTER confirming the click succeeded; give 15s for slow pages
      const newTabPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
      await jobPage.waitForTimeout(1500);
      const newTab = await newTabPromise;
      let applyPage;

      if (newTab) {
        await newTab.waitForLoadState('domcontentloaded').catch(() => {});
        await newTab.waitForTimeout(2000).catch(() => {});
        const tabUrl = newTab.url();
        wlog(workerId, `   📂 New tab: ${tabUrl}`);

        // If the new tab just re-opened the same job-detail URL it has no apply
        // modal — the modal is on jobPage. Use jobPage in that case.
        const hasApplyForm = await newTab.evaluate(() =>
          !!document.querySelector(
            '[data-cy="submit-btn"], [data-cy="next-btn"], button[type="submit"], ' +
            'form, [class*="applyForm"], [class*="apply-form"]'
          )
        ).catch(() => false);

        if (hasApplyForm || !tabUrl.includes('/job-detail/')) {
          applyPage = newTab;
        } else {
          wlog(workerId, `   ↩️  New tab has no form — using jobPage modal`);
          await newTab.close().catch(() => {});
          applyPage = jobPage;
        }
      } else {
        applyPage = jobPage;
        wlog(workerId, `   📂 Modal on same page`);
      }

      const result = await navigateApplyForm(applyPage, workerId);

      if (applyPage !== jobPage) await applyPage.close().catch(() => {});
      await jobPage.close().catch(() => {});

      logJob(workerId, jobNumber, title, company, job.id, result);

      if (result === 'APPLIED') {
        wlog(workerId, `   ✅ APPLIED — ${title}`);
        markApplied(job.id);
        writeAppliedEntry(workerId, title, company, job.id, 'APPLIED');
        stats.applied++;
        updateStatus(workerId, 'IDLE');
        return 'APPLIED';
      }

      if (result === 'UNCERTAIN') {
        wlog(workerId, `   ❓ UNCERTAIN — ${title}`);
        markApplied(job.id);
        writeAppliedEntry(workerId, title, company, job.id, 'UNCERTAIN');
        writeFailedEntry(workerId, title, company, job.id, 'UNCERTAIN', 'submitted but no confirmation detected');
        stats.uncertain++;
        updateStatus(workerId, 'IDLE');
        return 'UNCERTAIN';
      }

    } catch (err) {
      if (_shouldStop) break;
      wlog(workerId, `   ❌ Error (attempt ${attempt}): ${err.stack || err.message}`);
      await jobPage?.close().catch(() => {});
      if (attempt === MAX_RETRIES) {
        markApplied(job.id);
        logJob(workerId, jobNumber, job.title, '-', job.id, 'FAILED');
        writeAppliedEntry(workerId, job.title, '-', job.id, 'FAILED');
        writeFailedEntry(workerId, job.title, '-', job.id, 'FAILED', err.message);
        stats.failed++;
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }
    }
  }

  markApplied(job.id);
  updateStatus(workerId, 'IDLE');
  writeFailedEntry('--', job.title, '-', job.id, 'FAILED', 'exhausted retries');
  return 'FAILED';
}

// ─── WORKER LOOP ──────────────────────────────────────────────────────────────

async function runWorker(workerId, context, appliedJobs, startDelay) {
  // Stagger worker starts so they don't all hit the same job simultaneously
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
    appliedJobs.add(job.id); // claim it immediately so other workers don't take it

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

// ─── PRINT DASHBOARD ──────────────────────────────────────────────────────────

// These are set by runBot and read here for display
let _dashLocMode = false;
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

// ─── AUTO LOGIN ───────────────────────────────────────────────────────────────

const DICE_EMAIL    = 'npraou@gmail.com';
const DICE_PASSWORD = 'Nikhil@7052nikhil';

// Broad selector that matches any email-like input
const EMAIL_SEL = [
  '#email',
  'input[type="email"]',
  'input[name="email"]',
  'input[placeholder*="email" i]',
  'input[autocomplete*="email"]',
  'input[data-automation*="email" i]',
  'input[id*="email" i]',
].join(', ');

const PASS_SEL = [
  '#password',
  'input[type="password"]',
  'input[name="password"]',
  'input[placeholder*="password" i]',
  'input[data-automation*="password" i]',
  'input[id*="password" i]',
].join(', ');

async function fillLoginForm(page) {
  await page.waitForSelector(EMAIL_SEL, { timeout: 12000 });
  const emailEl = page.locator(EMAIL_SEL).first();
  const passEl  = page.locator(PASS_SEL).first();
  await emailEl.fill(DICE_EMAIL);
  await passEl.fill(DICE_PASSWORD);
  const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
  await submitBtn.click();
}

// Recursively searches regular DOM + shadow DOM and clicks the first matching element.
// Returns the matched element's text, or null if nothing found.
async function shadowClick(page, pattern) {
  return page.evaluate((pat) => {
    const re = new RegExp(pat, 'i');
    function scan(root) {
      for (const el of root.querySelectorAll('button, a, [role="button"], [role="link"]')) {
        const txt = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
        if (re.test(txt) && el.offsetWidth > 0 && el.offsetHeight > 0) {
          el.click();
          return txt.slice(0, 80);
        }
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const r = scan(el.shadowRoot);
          if (r) return r;
        }
      }
      return null;
    }
    return scan(document);
  }, pattern.source);
}

async function promptLogin(page) {
  await page.goto('https://www.dice.com', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
    .catch(() => {});

  // Wait for web components to hydrate
  await page.waitForTimeout(3000);

  // ── 1. Check if already logged in (header lives inside shadow DOM at depth 1) ─
  const alreadyIn = await page.evaluate(() => {
    function scanShadow(root) {
      for (const el of root.querySelectorAll('button, a, span, li')) {
        const t = (el.innerText || el.textContent || '').trim();
        if (/Nikhil Premachandra Rao|Log Out/.test(t)) return true;
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && scanShadow(el.shadowRoot)) return true;
      }
      return false;
    }
    return scanShadow(document);
  }).catch(() => false);

  if (alreadyIn) {
    console.log(`\n✅ Already logged in to Dice.com — starting bot\n`);
    return;
  }

  console.log(`\n🔑 Not logged in — attempting auto-login...`);

  // ── 2. Click "Login / Register" (or similar) in the header ─────────────────
  // Try Playwright built-ins first (auto-pierce shadow DOM in modern Playwright)
  let headerClicked = null;
  for (const phrase of ['Login / Register', 'Login/Register', 'Sign In / Register']) {
    try {
      await page.getByText(phrase, { exact: true }).first().click({ timeout: 3000 });
      headerClicked = phrase;
      break;
    } catch {}
  }

  // Shadow DOM fallback — recursive JS walker
  if (!headerClicked) {
    headerClicked = await shadowClick(page, /^Login\s*[\\/]\s*Register$|^Login$|^Sign In$/).catch(() => null);
  }

  console.log(headerClicked
    ? `   Clicked: "${headerClicked}"`
    : `   ⚠️  Header button not found (shadow DOM may need extra wait)`);

  // ── 3. Click "Login" in dropdown (shadow DOM) ───────────────────────────────
  if (headerClicked) {
    await page.waitForTimeout(1000); // dropdown animation
    const dropClicked = await shadowClick(page, /^Login$/).catch(() => null);
    if (dropClicked) console.log(`   Clicked dropdown: "${dropClicked}"`);
  }

  // ── 4. Wait for navigation or modal to settle ──────────────────────────────
  await page.waitForTimeout(2000);
  console.log(`   URL after clicks: ${page.url()}`);

  // ── 5. Locate the email input ──────────────────────────────────────────────
  const formFound = await page.waitForSelector(EMAIL_SEL, { timeout: 10000 })
    .then(() => true).catch(() => false);

  if (!formFound) {
    // Diagnose: dump all inputs from shadow DOM too
    const inputs = await page.evaluate(() => {
      const result = [];
      function gatherInputs(root) {
        for (const el of root.querySelectorAll('input')) {
          result.push(`type=${el.type} id=${el.id} name=${el.name} ph="${el.placeholder}"`);
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) gatherInputs(el.shadowRoot);
        }
      }
      gatherInputs(document);
      return result;
    }).catch(() => []);
    console.log(`   ⚠️  Email input not found. All inputs (incl. shadow DOM):\n` +
      (inputs.length ? inputs.map(s => '      ' + s).join('\n') : '      (none)'));
    console.log(`\n   Please log in manually in the browser, then waiting 60 seconds before proceeding...`);
    await new Promise(resolve => setTimeout(resolve, 60000));
    return;
  }

  // ── 6. Fill and submit ─────────────────────────────────────────────────────
  await page.locator(EMAIL_SEL).first().fill(DICE_EMAIL);
  await page.locator(PASS_SEL).first().fill(DICE_PASSWORD);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  console.log(`   Credentials submitted — waiting for redirect...`);

  // ── 7. Confirm success ─────────────────────────────────────────────────────
  try {
    await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 15000 });
    await page.waitForFunction(() => {
      function s(root) {
        for (const el of root.querySelectorAll('button,a,span')) {
          if ((el.innerText || '').includes('Nikhil')) return true;
        }
        for (const el of root.querySelectorAll('*')) { if (el.shadowRoot && s(el.shadowRoot)) return true; }
        return false;
      }
      return s(document);
    }, { timeout: 8000 }).catch(() => {});
    console.log(`   ✅ Auto-login successful — starting bot\n`);
  } catch {
    console.log(`\n⚠️  Login redirect not detected. Check the browser window.`);
    console.log(`   Press ENTER to continue, or Ctrl+C to abort...`);
    process.stdin.resume();
    await new Promise(resolve => process.stdin.once('data', resolve));
    process.stdin.pause();
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function runBot() {
  const startTime = Date.now();

  initLogFile();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🤖 Dice Bot — ${NUM_WORKERS} Parallel Workers`);
  console.log(`📂 Profile  : ${PROFILE_DIR}`);
  console.log(`📊 Status   : ${STATUS_FILE}`);
  console.log(`${'═'.repeat(60)}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const pages = context.pages();
  const scanPage = pages.length > 0 ? pages[0] : await context.newPage();

  await promptLogin(scanPage);

  let appliedJobs = loadAppliedJobs();
  console.log(`\n📂 Loaded ${appliedJobs.size} previously applied jobs`);

  let locMode  = false;
  let locIndex = 0;

  // Dashboard printer — runs every 30 seconds
  const dashInterval = setInterval(printDashboard, 30000);

  try {
    while (!_shouldStop) {
      // ── Determine scan URLs for this round ──────────────────────────────────
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

      // ── Scan ────────────────────────────────────────────────────────────────
      const newJobs = await scanForJobs(scanPage, appliedJobs, scanUrls);

      if (newJobs.length === 0) {
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

      // ── Found jobs — run workers ─────────────────────────────────────────────
      jobQueue   = newJobs;
      queueIndex = 0;
      console.log(`\n🎯 ${newJobs.length} jobs queued — launching ${NUM_WORKERS} workers\n`);
      initAppliedFile(newJobs.length);
      printDashboard();

      await Promise.all(
        Array.from({ length: NUM_WORKERS }, (_, i) =>
          runWorker(`W${i + 1}`, context, appliedJobs, i * 2000)
        )
      );

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
    writeSessionSummary();
    await context.close().catch(e => console.error('Failed to close context:', e.message));
  }

  const ran = Math.floor((Date.now() - startTime) / 60000);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🏁 Session Complete — ran ${ran} min`);
  console.log(`✅ Applied: ${stats.applied} | ⏭️ Skipped: ${stats.skipped} | ❌ Failed: ${stats.failed} | ❓ Uncertain: ${stats.uncertain}`);
  console.log(`Scanned log  → ${SCANNED_FILE}`);
  console.log(`Applied log  → ${APPLIED_FILE}`);
  console.log(`${'═'.repeat(60)}\n`);
}

// ─── LOGIN MODE ───────────────────────────────────────────────────────────────

async function loginMode() {
  console.log(`\n🔐 LOGIN MODE — Profile: ${PROFILE_DIR}`);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  await promptLogin(page);
  await ctx.close();
  console.log(`\n✅ Session saved. Run: node dice-bot.js 30\n`);
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
} else if (arg === 'test') {
  MAX_JOBS = 1;
  console.log('[test] Single-job test mode — will stop after 1 application attempt.');
  runBot(null).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'formtest') {
  const url = process.argv[3];
  if (!url) { console.error('[err] Usage: node dice-bot.js formtest <applyUrl>'); process.exit(1); }
  formTestMode(url).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else {
  runBot().catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
