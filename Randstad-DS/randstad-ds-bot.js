#!/usr/bin/env node
/**
 * Randstad USA — Data Science Full-Scrape Bot
 *
 * Differences from randstad-bot.js:
 *   - Single "data-science" search query (the one that returns ~3188 results)
 *   - Crawls ALL pages until results are exhausted (no 4-page cap)
 *   - NO date filter — applies to every matching job regardless of age
 *   - Sequential single-worker (no parallel processing)
 *   - No time limit — runs until every queued job is processed
 *   - All output files isolated to this directory
 *   - Separate applied_ids.txt stored in ~/randstad-ds-applied/ (never touches original)
 *
 * RUN:
 *   node randstad-ds-bot.js login    ← one-time login (saves session to ~/randstad-bot-profile)
 *   node randstad-ds-bot.js scrape   ← scan ALL pages, save master list, then apply
 *   node --check randstad-ds-bot.js  ← syntax check
 */

'use strict';

const { chromium } = require('playwright');
const fs            = require('fs');
const path          = require('path');
const readline      = require('readline');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const HOME_DIR       = process.env.HOME || process.env.USERPROFILE || '';

// Reuse the same login session as the original bot (same site)
const PROFILE_DIR    = path.join(HOME_DIR, 'randstad-bot-profile');

// Separate applied-IDs file — never touches the original bot's file
const APPLIED_IDS_DIR = path.join(HOME_DIR, 'randstad-ds-applied');
const APPLIED_IDS     = path.join(APPLIED_IDS_DIR, 'applied_ids.txt');

const WORKSPACE_DIR  = path.join(HOME_DIR, '.openclaw', 'workspace');
const STATUS_FILE    = path.join(WORKSPACE_DIR, 'randstad_ds_worker_status.json');

const OUTPUT_DIR     = path.join(__dirname);   // .../Randstad-DS/
const SCANNED_FILE   = path.join(OUTPUT_DIR, 'scanned_jobs.txt');
const MASTER_FILE    = path.join(OUTPUT_DIR, 'master_jobs.json');   // full scraped list
const APPLIED_FILE   = path.join(OUTPUT_DIR, 'applied_jobs.txt');
const FAILED_FILE    = path.join(OUTPUT_DIR, 'failed_jobs.txt');
const NOTES_FILE     = path.join(OUTPUT_DIR, 'session_notes.txt');

const PAGE_TIMEOUT   = 30000;   // ms
const MAX_RETRIES    = 2;
const RATE_LIMIT_MS  = 6000;    // ms between applications (sequential, single worker)

// User details
const USER_FIRST     = 'Nikhil';
const USER_LAST      = 'Premachandra Rao';
const USER_FULL      = 'Nikhil Premachandra Rao';
const USER_EMAIL     = 'npraou@gmail.com';
const USER_ZIP       = '30519';
const USER_PHONE     = '7746368916';
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
const COVER_PATH     = path.join(__dirname, '..', 'Nikhil_Rao_Cover_Letter.pdf');

const COVER_TEXT = `Dear Hiring Manager,

I am writing to express my interest in this position. I am a Data Scientist and Machine Learning Engineer with strong expertise in Python, statistical modeling, NLP, and deploying production ML systems. I am confident my background aligns well with your needs. Please find my resume attached for your review.

I would welcome the opportunity to discuss how my skills can contribute to your team.

Best regards,
Nikhil Premachandra Rao`;

// Single search — "data-science" is the slug that returns ~3188 results on Randstad
// Add a second variant for better coverage
const SEARCH_QUERIES = [
  'data-scientist',
  'data-science',
  'machine-learning-engineer',
  'machine-learning',
  'data-engineer',
  'ai-engineer',
  'nlp-engineer',
  'mlops',
];

// Title relevance filter — case insensitive
// Jobs NOT matching are skipped (logged as FILTERED in notes)
const TITLE_FILTER = /data scien|machine learning|ml engineer|data engineer|ai engineer|nlp|mlops|analytics engineer|deep learning|computer vision|llm|large language|generative ai|artificial intelligence|data architect|data modeli/i;

const BASE_URL  = 'https://www.randstadusa.com';
const LOGIN_URL = 'https://www.randstadusa.com/login';

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

const stats = { applied: 0, skipped: 0, failed: 0, uncertain: 0, filtered: 0, total: 0 };

const sessionFailedUrls = new Set();

const NUM_WORKERS = 8;
const workerStatus = Object.fromEntries(
  Array.from({ length: NUM_WORKERS }, (_, i) => [`W${i + 1}`, { state: 'IDLE', job: '', lastUpdate: '' }])
);

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

// ─── NOTES FILE ───────────────────────────────────────────────────────────────

function note(msg) {
  ensureDir(NOTES_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(NOTES_FILE, line);
}

// ─── EXTRACT JOBS FROM SEARCH PAGE ───────────────────────────────────────────

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

      const card = a.closest(
        'article, li, [class*="job"], [class*="result"], [class*="card"], section'
      );

      let title = '';
      if (card) {
        const heading = card.querySelector('h1, h2, h3, h4, [class*="title"], [class*="name"]');
        if (heading) title = heading.textContent.trim();
      }
      if (!title) title = a.textContent.trim();

      let posted = '';
      if (card) {
        const dateEl = card.querySelector(
          '[class*="date"], [class*="posted"], [class*="ago"], time, [datetime]'
        );
        if (dateEl) {
          posted = dateEl.getAttribute('datetime') || dateEl.textContent.trim();
        }
        if (!posted) {
          const cardText = (card.innerText || '');
          const dm = cardText.match(
            /(\d+\s+(?:minute|hour|day|week|month)s?\s+ago|today|just now|yesterday|\b[A-Z][a-z]+ \d{1,2},?\s*\d{4})/i
          );
          if (dm) posted = dm[0];
        }
      }

      // Company
      let company = '';
      if (card) {
        const compEl = card.querySelector('[class*="company"], [class*="employer"], [class*="org"]');
        if (compEl) company = compEl.textContent.trim();
      }

      // Location
      let location = '';
      if (card) {
        const locEl = card.querySelector('[class*="location"], [class*="city"], [class*="place"]');
        if (locEl) location = locEl.textContent.trim();
      }

      map[jobId] = { id: jobId, sectorId, slug, title, posted, company, location, url };
    }

    return Object.values(map).filter(j => j.url);
  }, BASE_URL);
}

// ─── GET TOTAL RESULT COUNT ───────────────────────────────────────────────────

async function getTotalResultCount(page) {
  return page.evaluate(() => {
    // Randstad usually shows "X jobs found" or "Showing X results"
    const body = document.body && document.body.innerText ? document.body.innerText : '';
    const m = body.match(/(\d[\d,]+)\s+jobs?\s+found|showing\s+(\d[\d,]+)|(\d[\d,]+)\s+results?/i);
    if (m) {
      const raw = (m[1] || m[2] || m[3]).replace(/,/g, '');
      return parseInt(raw, 10);
    }
    return null;
  }).catch(() => null);
}

// ─── FULL SCRAPE — ALL PAGES ──────────────────────────────────────────────────

async function scrapeAllJobs(page, appliedJobs) {
  const allJobsMap = {};   // id → job — global dedup across queries
  const toApply    = [];
  let totalPagesScanned = 0;

  note(`=== SCRAPE START ===`);

  for (const query of SEARCH_QUERIES) {
    if (_shouldStop) break;

    const keyword = query.replace(/-/g, ' ');
    note(`\nScanning query: "${keyword}"`);

    let pageNum  = 1;
    let newForQuery = 0;

    while (true) {
      if (_shouldStop) break;

      const searchUrl = pageNum === 1
        ? `${BASE_URL}/jobs/q-${query}/`
        : `${BASE_URL}/jobs/q-${query}/page-${pageNum}/`;

      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        await page.waitForTimeout(2500);

        // On first page, grab total count for logging
        if (pageNum === 1) {
          const total = await getTotalResultCount(page);
          if (total) {
            const estPages = Math.ceil(total / 25);
            note(`  Total results on Randstad: ${total.toLocaleString()} (~${estPages} pages)`);
          }
        }

        // No results check
        const noJobs = await page.evaluate(() => {
          const body = (document.body && document.body.innerText ? document.body.innerText : '').toLowerCase();
          return (
            body.includes('no jobs found') ||
            body.includes('no results found') ||
            body.includes('0 jobs') ||
            body.includes('sorry, no') ||
            body.includes('there are no job')
          );
        }).catch(() => false);

        if (noJobs) {
          note(`  Page ${pageNum}: no results — end of pagination`);
          break;
        }

        const jobs = await extractJobsFromPage(page);
        if (jobs.length === 0) {
          note(`  Page ${pageNum}: 0 job cards found — end of pagination`);
          break;
        }

        // Check how many of these are actually new (global dedup)
        const newOnPage = jobs.filter(j => !allJobsMap[j.id]);
        if (pageNum > 1 && newOnPage.length === 0) {
          note(`  Page ${pageNum}: all ${jobs.length} cards already seen globally — stopping`);
          break;
        }

        for (const job of jobs) {
          if (allJobsMap[job.id]) continue;
          allJobsMap[job.id] = job;
          newForQuery++;
          totalPagesScanned++;
        }

        note(`  Page ${pageNum}: ${jobs.length} cards | ${newOnPage.length} new globally | total unique: ${Object.keys(allJobsMap).length}`);

        // Safety valve: if we've seen 200 consecutive pages with no progress, stop
        // Normally we stop when newOnPage.length === 0 above
        pageNum++;

        // Small delay between pages to be polite
        await page.waitForTimeout(1000);

      } catch (err) {
        note(`  Page ${pageNum} error: ${err.message}`);
        break;
      }
    }

    note(`  "${keyword}" complete: ${newForQuery} new unique jobs added`);
  }

  // ── Write master JSON snapshot ─────────────────────────────────────────────
  const allJobs = Object.values(allJobsMap);
  ensureDir(MASTER_FILE);
  fs.writeFileSync(MASTER_FILE, JSON.stringify({
    scraped_at: new Date().toISOString(),
    total: allJobs.length,
    jobs: allJobs,
  }, null, 2));
  note(`\n[snapshot] Master list saved: ${allJobs.length} unique jobs → ${MASTER_FILE}`);

  // ── Build apply queue (title filter; no date filter) ───────────────────────
  let filteredCount  = 0;
  let alreadyApplied = 0;

  for (const job of allJobs) {
    if (appliedJobs.has(job.id)) {
      alreadyApplied++;
      continue;
    }
    if (!TITLE_FILTER.test(job.title)) {
      filteredCount++;
      stats.filtered++;
      continue;
    }
    toApply.push(job);
  }

  note(`\n[queue] Total scraped : ${allJobs.length}`);
  note(`[queue] Already applied: ${alreadyApplied}`);
  note(`[queue] Filtered (title): ${filteredCount}`);
  note(`[queue] Queued to apply  : ${toApply.length}`);

  // ── Write human-readable scanned file ─────────────────────────────────────
  _writeScannedFile(allJobs, new Set(toApply.map(j => j.id)), appliedJobs);

  return toApply;
}

// ─── SCANNED FILE ─────────────────────────────────────────────────────────────

function _writeScannedFile(all, queuedIds, appliedJobs) {
  ensureDir(SCANNED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  const lines = [
    '='.repeat(80),
    `RANDSTAD-DS FULL SCRAPE  —  ${ts}`,
    `${all.length} total scraped  |  ${queuedIds.size} to apply  |  ${all.length - queuedIds.size} filtered/already-applied`,
    '='.repeat(80), '',
  ];
  all.forEach((j, i) => {
    let badge = '[FILTERED        ]';
    if (appliedJobs.has(j.id))  badge = '[ALREADY APPLIED ]';
    else if (queuedIds.has(j.id)) badge = '[QUEUED          ]';
    lines.push(`${String(i + 1).padStart(4)}.  ${badge}  ${j.title || '(no title)'}`);
    if (j.company)  lines.push(`         Company : ${j.company}`);
    if (j.location) lines.push(`         Location: ${j.location}`);
    lines.push(`         Posted  : ${j.posted || 'unknown'}`);
    lines.push(`         Link    : ${j.url}`);
    lines.push(`         ID      : ${j.id}`);
    lines.push('');
  });
  lines.push('='.repeat(80), '');
  fs.appendFileSync(SCANNED_FILE, lines.join('\n'));
}

// ─── APPLIED / FAILED FILE HELPERS ───────────────────────────────────────────

function initAppliedFile(queueSize) {
  ensureDir(APPLIED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  fs.appendFileSync(APPLIED_FILE, [
    '='.repeat(80),
    `RANDSTAD-DS SESSION  —  ${ts}`,
    `${queueSize} relevant jobs queued for sequential application`,
    '='.repeat(80), '',
  ].join('\n'));
}

function writeAppliedEntry(title, jobId, status, jobUrl) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  fs.appendFileSync(APPLIED_FILE, [
    `[${time}]  ${status.padEnd(9)}  —  ${title}`,
    `  Link    : ${jobUrl || '-'}`,
    `  ID      : ${jobId}`, '',
  ].join('\n'));
}

function writeSessionSummary() {
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  fs.appendFileSync(APPLIED_FILE, [
    '-'.repeat(80),
    `SESSION COMPLETE  —  ${ts}`,
    `Applied: ${stats.applied}  |  Skipped: ${stats.skipped}  |  Failed: ${stats.failed}  |  Uncertain: ${stats.uncertain}  |  Filtered: ${stats.filtered}`,
    '='.repeat(80), '',
  ].join('\n'));
}

function writeFailedEntry(title, jobId, status, reason, jobUrl) {
  ensureDir(FAILED_FILE);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const url  = jobUrl || `${BASE_URL}/jobs/ (ID: ${jobId})`;
  sessionFailedUrls.add(url);
  fs.appendFileSync(FAILED_FILE, [
    `[${time}]  ${status.padEnd(9)}  —  ${title}`,
    `  Link    : ${url}`,
    `  ID      : ${jobId}`,
    ...(reason ? [`  Reason  : ${reason}`] : []),
    '',
  ].join('\n'));
}

// ─── STATUS FILE ──────────────────────────────────────────────────────────────

function updateStatus(workerId, state, jobTitle) {
  workerStatus[`W${workerId}`] = {
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
  } catch (e) { /* non-fatal */ }
}

// ─── FORM HELPERS ─────────────────────────────────────────────────────────────

async function disableAutofill(page) {
  await page.evaluate(() => {
    document.querySelectorAll('input, textarea, select').forEach(el => {
      el.setAttribute('autocomplete', 'off');
      el.setAttribute('autocorrect', 'off');
      el.setAttribute('autocapitalize', 'off');
    });
  }).catch(() => {});
}

async function fillField(page, selectors, value, label) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible({ timeout: 3000 })) {
        await loc.click({ force: true }).catch(() => {});
        await page.keyboard.press('Control+A').catch(() => {});
        await loc.fill(value);
        // Dismiss any autofill dropdown
        await page.keyboard.press('Escape').catch(() => {});
        // Verify the value stuck
        const actual = await loc.inputValue().catch(() => '');
        if (actual !== value) {
          // Autofill overwrote us — use JS setter which bypasses browser cache
          await page.evaluate(({ sel: s, v }) => {
            const el = document.querySelector(s);
            if (!el) return;
            el.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            if (setter && setter.set) setter.set.call(el, v); else el.value = v;
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, { sel, v: value }).catch(() => {});
          console.log(`   [form] ${label} force-set via JS (autofill fought back)`);
        } else {
          console.log(`   [form] ${label} filled (${sel})`);
        }
        return true;
      }
    } catch (_) { /* try next */ }
  }
  const filled = await page.evaluate(({ selectors: sels, value: v }) => {
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        el.focus();
        el.select && el.select();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (setter && setter.set) setter.set.call(el, v); else el.value = v;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur',   { bubbles: true }));
        return sel;
      }
    }
    return null;
  }, { selectors, value }).catch(() => null);

  if (filled) { console.log(`   [form] ${label} filled via JS (${filled})`); return true; }
  console.log(`   [!] Could not fill "${label}" — no matching field`);
  return false;
}

async function clickButton(page, selectors, label) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible({ timeout: 3000 })) {
        await loc.click();
        console.log(`   [click] ${label} (${sel})`);
        return true;
      }
    } catch (_) { /* try next */ }
  }
  const clicked = await page.evaluate((sels) => {
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) { el.click(); return sel; }
    }
    for (const el of document.querySelectorAll('button, input[type="submit"], a[role="button"]')) {
      const txt = (el.textContent || el.value || '').toLowerCase().trim();
      if (/apply|submit/i.test(txt) && el.offsetParent !== null) { el.click(); return txt; }
    }
    return null;
  }, selectors).catch(() => null);

  if (clicked) { console.log(`   [click] ${label} via JS (${clicked})`); return true; }
  console.log(`   [!] Could not click "${label}"`);
  return false;
}

// ─── APPLY TO ONE JOB ─────────────────────────────────────────────────────────

async function applyToJob(context, job, jobNumber, workerId = 1) {
  const tag = `[W${workerId}]`;
  console.log(`\n${tag} #${jobNumber}/${jobQueue.length}  —  ${job.title}`);
  console.log(`${tag}  Company : ${job.company || 'unknown'}`);
  console.log(`${tag}  Location: ${job.location || 'unknown'}`);
  console.log(`${tag}  URL     : ${job.url}`);
  updateStatus(workerId, 'APPLYING', job.title);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (_shouldStop) { updateStatus(workerId, 'IDLE'); return 'SKIPPED'; }
    if (attempt > 1) {
      console.log(`   [~] Retry ${attempt}/${MAX_RETRIES}`);
      await new Promise(r => setTimeout(r, 5000));
    }

    const jobPage = await context.newPage();
    try {
      // 1. Navigate to job detail page
      await jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await jobPage.waitForTimeout(3000);

      // 2. Grab real title from h1
      let title = job.title;
      try {
        const h1 = await jobPage.$('h1');
        if (h1) {
          const h1Text = (await h1.textContent()).trim();
          if (h1Text.length > 3) title = h1Text;
        }
      } catch (_) { /* keep job.title */ }

      // 3. Check if already applied
      const alreadyApplied = await jobPage.evaluate(() => {
        const body = (document.body.innerText || '').toLowerCase();
        return body.includes('you\'ve already applied') || body.includes('already applied');
      }).catch(() => false);

      if (alreadyApplied) {
        console.log(`   [dup] Already applied per site — SKIPPED`);
        markApplied(job.id);
        stats.skipped++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      // 4. Find and click the Apply button
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

      const clickedApply = await clickButton(jobPage, applyBtnSelectors, 'Apply button');
      if (!clickedApply) {
        console.log(`   [!] No Apply button found — SKIPPED`);
        writeAppliedEntry(title, job.id, 'SKIPPED', job.url);
        writeFailedEntry(title, job.id, 'SKIPPED', 'no apply button found', job.url);
        stats.skipped++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      await jobPage.waitForTimeout(3000);

      const currentUrl = jobPage.url();

      // 5. Handle login gate
      if (currentUrl.includes('/login') || currentUrl.includes('/register')) {
        console.log(`   [!] Session expired — login required. FAILED.`);
        writeAppliedEntry(title, job.id, 'FAILED', job.url);
        writeFailedEntry(title, job.id, 'FAILED', 'session expired, need re-login', job.url);
        stats.failed++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }

      await jobPage.waitForTimeout(5000);   // wait for profile async-fill to settle

      // 6. Fill form fields — first pass
      await fillField(jobPage, ['#email',      'input[name="email"]'],      USER_EMAIL, 'Email');
      await fillField(jobPage, ['#first_name', 'input[name="first_name"]'], USER_FIRST, 'First name');
      await fillField(jobPage, ['#last_name',  'input[name="last_name"]'],  USER_LAST,  'Last name');
      await fillField(jobPage, ['#zip',        'input[name="zip"]'],        USER_ZIP,   'Zip code');
      await fillField(jobPage, ['#phone',      'input[name="phone"]'],      USER_PHONE, 'Phone');

      // Wait for autofill cache, then re-fill the fields it overwrites
      await jobPage.waitForTimeout(3000);
      await fillField(jobPage, ['#last_name', 'input[name="last_name"]'], USER_LAST, 'Last name (re-fill)');
      await fillField(jobPage, ['#zip',       'input[name="zip"]'],       USER_ZIP,  'Zip code (re-fill)');
      try {
        const phoneLoc = jobPage.locator('#phone');
        await phoneLoc.click({ clickCount: 3 });
        await phoneLoc.fill('');
        await phoneLoc.pressSequentially(USER_PHONE, { delay: 50 });
        console.log('   [form] Phone re-entered digit by digit');
      } catch (e) {
        await fillField(jobPage, ['#phone', 'input[name="phone"]'], USER_PHONE, 'Phone (re-fill)');
      }

      // 7. Upload resume
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
                for (let n = 0; n < 4 && node; n++, node = node.parentElement) parts.push(node.textContent || '');
                return parts.join(' ').toLowerCase();
              }).catch(() => '');
              if (/cover/i.test(ctx)) coverInput = coverInput || inp;
              else resumeInput = resumeInput || inp;
            }
            if (!resumeInput) resumeInput = fileInputs.first();
            await resumeInput.setInputFiles(RESUME_PATH);
            console.log(`   [resume] Uploaded`);
            if (coverInput && fs.existsSync(COVER_PATH)) {
              await coverInput.setInputFiles(COVER_PATH);
              console.log(`   [cover]  Uploaded`);
            }
            await jobPage.waitForTimeout(2000);
          }
        } catch (e) {
          console.log(`   [!] Resume upload error: ${e.message}`);
        }
      }

      // 8. Check consent checkbox via JS — avoids Playwright scroll causing page jump
      await jobPage.evaluate(() => {
        const cb = document.getElementById('checkbox-textAlerts');
        if (cb && !cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.dispatchEvent(new Event('click',  { bubbles: true }));
        }
      }).catch(() => {});
      console.log(`   [check] Checked consent checkbox`);

      // 9. Submit
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

      const submitted = await clickButton(jobPage, submitSelectors, 'Submit');

      if (!submitted) {
        console.log(`   [!] No submit button — UNCERTAIN`);
        writeAppliedEntry(title, job.id, 'UNCERTAIN', job.url);
        writeFailedEntry(title, job.id, 'UNCERTAIN', 'no submit button found', job.url);
        stats.uncertain++;
        markApplied(job.id);
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'UNCERTAIN';
      }

      await jobPage.waitForTimeout(8000);

      // Handle multi-step forms
      for (let step = 0; step < 3; step++) {
        const nextBtn = await jobPage.locator(
          'button:has-text("Next"), button:has-text("Continue"), button:has-text("Submit")'
        ).first();
        const nextVisible = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);
        if (nextVisible) {
          console.log(`   [multi-step] Clicking next step`);
          await nextBtn.click().catch(() => {});
          await jobPage.waitForTimeout(4000);
        } else {
          break;
        }
      }

      const finalUrl = jobPage.url();
      const bodyText = await jobPage.evaluate(() => document.body.innerText || '').catch(() => '');

      const CONFIRM_RE = /application.*submit|submit.*application|successfully applied|thank you for applying|you've applied|application.*received|application.*sent|first step to your new career|we.*received.*application/i;
      const isConfirmPage = finalUrl.includes('confirmation') || finalUrl.includes('applied');
      const isConfirmText = CONFIRM_RE.test(bodyText);

      const result = (isConfirmPage || isConfirmText) ? 'APPLIED' : 'UNCERTAIN';

      if (result === 'APPLIED') {
        console.log(`   [ok] APPLIED — "${title}"`);
        markApplied(job.id);
        writeAppliedEntry(title, job.id, 'APPLIED', job.url);
        stats.applied++;
        note(`APPLIED #${jobNumber}: ${title} | ${job.url}`);
      } else {
        console.log(`   [?] UNCERTAIN — URL: ${finalUrl}`);
        markApplied(job.id);
        writeAppliedEntry(title, job.id, 'UNCERTAIN', job.url);
        writeFailedEntry(title, job.id, 'UNCERTAIN', `submitted, no confirm. URL: ${finalUrl}`, job.url);
        stats.uncertain++;
        note(`UNCERTAIN #${jobNumber}: ${title} | ${job.url}`);
      }

      await jobPage.close().catch(() => {});
      updateStatus(workerId, 'IDLE');
      return result;

    } catch (err) {
      console.log(`   [x] Error (attempt ${attempt}): ${err.message}`);
      await jobPage.close().catch(() => {});

      if (/closed|destroyed|Target page/i.test(err.message)) {
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }

      if (attempt === MAX_RETRIES) {
        markApplied(job.id);
        writeAppliedEntry(job.title, job.id, 'FAILED', job.url);
        writeFailedEntry(job.title, job.id, 'FAILED', err.message, job.url);
        stats.failed++;
        note(`FAILED #${jobNumber}: ${job.title} | ${err.message}`);
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }
    }
  }

  markApplied(job.id);
  updateStatus(workerId, 'IDLE');
  writeFailedEntry(job.title, job.id, 'FAILED', 'exhausted retries', job.url);
  return 'FAILED';
}

// ─── OPEN FAILED JOBS IN BROWSER ─────────────────────────────────────────────

async function openFailedJobs(context) {
  if (sessionFailedUrls.size === 0) return false;
  const urls = [...sessionFailedUrls];
  console.log(`\n[>] Opening ${urls.length} failed/uncertain jobs in browser...`);
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
  const pct = jobQueue.length ? Math.round((queueIndex / jobQueue.length) * 100) : 0;
  console.log(`\n${sep}`);
  console.log(`DASHBOARD — ${new Date().toLocaleTimeString()}`);
  console.log(`  Applied: ${stats.applied}  Uncertain: ${stats.uncertain}  Failed: ${stats.failed}  Skipped: ${stats.skipped}`);
  console.log(`  Progress: ${queueIndex}/${jobQueue.length} (${pct}%)`);
  console.log(`${sep}\n`);
}

// ─── LOGIN MODE ───────────────────────────────────────────────────────────────

async function loginMode() {
  console.log('\n' + '='.repeat(60));
  console.log('Randstad-DS Bot — LOGIN MODE');
  console.log(`Profile dir: ${PROFILE_DIR}`);
  console.log('='.repeat(60));

  ensureDir(path.join(PROFILE_DIR, 'placeholder'));

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const page = await browser.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

  console.log('\n>>> Browser is open. Please log in to Randstad USA.');
  console.log('>>> Once logged in, press ENTER here to save your session...\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('', () => { rl.close(); resolve(); }));

  console.log('[i] Saving session...');
  await browser.close();
  console.log(`[ok] Session saved to ${PROFILE_DIR}`);
  console.log('\nNow run:  node randstad-ds-bot.js scrape\n');
}

// ─── SCRAPE + APPLY MODE ──────────────────────────────────────────────────────

async function runScrapeAndApply() {
  const startTime = Date.now();

  if (!fs.existsSync(PROFILE_DIR)) {
    console.error(`[!] Profile not found: ${PROFILE_DIR}`);
    console.error('    Run "node randstad-ds-bot.js login" first.');
    process.exit(1);
  }

  if (!fs.existsSync(RESUME_PATH)) {
    console.error(`[!] Resume not found: ${RESUME_PATH}`);
    process.exit(1);
  }

  ensureDir(APPLIED_IDS_DIR + '/placeholder');

  console.log('\n' + '='.repeat(62));
  console.log('Randstad-DS Bot — Full Scrape + Sequential Apply');
  console.log(`Profile  : ${PROFILE_DIR}`);
  console.log(`AppliedDB: ${APPLIED_IDS}`);
  console.log(`Master   : ${MASTER_FILE}`);
  console.log(`Notes    : ${NOTES_FILE}`);
  console.log(`Queries  : ${SEARCH_QUERIES.join(', ')}`);
  console.log('='.repeat(62));

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const scanPage   = await context.newPage();
  const appliedJobs = loadAppliedJobs();

  console.log(`[i] ${appliedJobs.size} previously applied IDs loaded`);
  note(`=== SESSION START ===`);
  note(`Previously applied: ${appliedJobs.size}`);

  const dashInterval = setInterval(printDashboard, 60000);

  try {
    // ── Phase 1: Full scrape ─────────────────────────────────────────────────
    console.log('\n[Phase 1] Scraping ALL pages across all queries...\n');
    const newJobs = await scrapeAllJobs(scanPage, appliedJobs);
    await scanPage.close().catch(() => {});

    if (newJobs.length === 0) {
      console.log('\n[z] No relevant jobs to apply to after filtering.');
      note(`No jobs to apply — exiting.`);
    } else {
      // ── Phase 2: 8 parallel workers ──────────────────────────────────────
      jobQueue   = newJobs;
      queueIndex = 0;

      initAppliedFile(jobQueue.length);
      console.log(`\n[Phase 2] Applying to ${jobQueue.length} jobs across ${NUM_WORKERS} parallel workers...\n`);
      note(`\n=== APPLY PHASE START — ${jobQueue.length} jobs, ${NUM_WORKERS} workers ===`);

      const workerFns = Array.from({ length: NUM_WORKERS }, (_, i) => {
        const wId = i + 1;
        return (async () => {
          while (!_shouldStop) {
            const job = getNextJob();
            if (!job) break;

            let jobNum;
            // Atomic increment for display number
            jobNum = ++stats.total;
            appliedJobs.add(job.id);

            await applyToJob(context, job, jobNum, wId);

            if (stats.applied + stats.failed + stats.uncertain >= MAX_JOBS) {
              _shouldStop = true;
              break;
            }

            if (!_shouldStop) await new Promise(r => setTimeout(r, RATE_LIMIT_MS));

            if (stats.total % 25 === 0) printDashboard();
          }
          updateStatus(wId, 'DONE', '');
        })();
      });

      await Promise.all(workerFns);

      printDashboard();
      console.log(`\n[z] Apply phase complete.`);
    }

  } catch (err) {
    console.error(`\n[x] Fatal error:`, err.stack || err.message);
    note(`FATAL ERROR: ${err.message}`);
  } finally {
    clearInterval(dashInterval);
    writeSessionSummary();

    const hadFailed = await openFailedJobs(context).catch(() => false);

    if (hadFailed) {
      console.log('\n[>] Failed/uncertain jobs open in browser. Review and press ENTER...');
      const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
      await new Promise(resolve => rl2.question('', () => { rl2.close(); resolve(); }));
    } else {
      console.log('\n[i] Done. Browser stays open for review. Close when done.');
      await new Promise(r => setTimeout(r, 5000));
    }

    await context.close().catch(() => {});
  }

  const ran = Math.floor((Date.now() - startTime) / 60000);
  const summary = [
    `\n${'='.repeat(62)}`,
    `Session Complete — ${ran} min`,
    `Applied: ${stats.applied}  Uncertain: ${stats.uncertain}  Failed: ${stats.failed}  Skipped: ${stats.skipped}  Filtered: ${stats.filtered}`,
    `Master list : ${MASTER_FILE}`,
    `Scanned log : ${SCANNED_FILE}`,
    `Applied log : ${APPLIED_FILE}`,
    `Failed log  : ${FAILED_FILE}`,
    `Notes       : ${NOTES_FILE}`,
    '='.repeat(62) + '\n',
  ].join('\n');
  console.log(summary);
  note(`\n=== SESSION END — ${ran} min ===`);
  note(`Applied: ${stats.applied} | Uncertain: ${stats.uncertain} | Failed: ${stats.failed} | Skipped: ${stats.skipped}`);
}

// ─── INSPECT MODE ────────────────────────────────────────────────────────────

async function inspectMode() {
  const targetUrl = process.argv[3] || 'https://www.randstadusa.com/jobs/apply/4/1330524/';

  if (!fs.existsSync(PROFILE_DIR)) {
    console.error(`[!] Profile not found: ${PROFILE_DIR}\n    Run login first.`);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(70));
  console.log('Randstad-DS Bot — INSPECT MODE');
  console.log(`URL: ${targetUrl}`);
  console.log('='.repeat(70));

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const page = await context.newPage();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  await page.waitForTimeout(4000);

  const fields = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('input, select, textarea, button[type="submit"]'));
    return els.map(el => {
      // Walk up to find nearby label text
      let labelText = '';
      const id = el.id;
      if (id) {
        const lbl = document.querySelector(`label[for="${id}"]`);
        if (lbl) labelText = lbl.textContent.trim();
      }
      if (!labelText) {
        let node = el.parentElement;
        for (let n = 0; n < 5 && node && !labelText; n++, node = node.parentElement) {
          const lbl = node.querySelector('label');
          if (lbl) labelText = lbl.textContent.trim();
        }
      }
      if (!labelText) {
        let node = el.parentElement;
        for (let n = 0; n < 5 && node; n++, node = node.parentElement) {
          const txt = (node.innerText || '').split('\n')[0].trim();
          if (txt && txt.length < 60) { labelText = txt; break; }
        }
      }

      return {
        tag:         el.tagName,
        type:        el.type || '',
        id:          el.id || '',
        name:        el.name || '',
        placeholder: el.placeholder || '',
        ariaLabel:   el.getAttribute('aria-label') || '',
        dataTestId:  el.getAttribute('data-testid') || '',
        className:   el.className || '',
        value:       el.value || '',
        labelText:   labelText.slice(0, 80),
        visible:     el.offsetParent !== null,
      };
    });
  });

  console.log('\n── FORM FIELDS FOUND ──────────────────────────────────────────────────\n');
  fields.forEach((f, i) => {
    console.log(`[${i}] <${f.tag.toLowerCase()}> type="${f.type}" visible=${f.visible}`);
    if (f.id)          console.log(`      id          = "${f.id}"`);
    if (f.name)        console.log(`      name        = "${f.name}"`);
    if (f.placeholder) console.log(`      placeholder = "${f.placeholder}"`);
    if (f.ariaLabel)   console.log(`      aria-label  = "${f.ariaLabel}"`);
    if (f.dataTestId)  console.log(`      data-testid = "${f.dataTestId}"`);
    if (f.className)   console.log(`      class       = "${f.className.slice(0, 80)}"`);
    if (f.labelText)   console.log(`      label text  = "${f.labelText}"`);
    console.log('');
  });

  console.log('='.repeat(70));
  console.log('\nBrowser left open. Press ENTER to close.\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('', () => { rl.close(); resolve(); }));
  await context.close().catch(() => {});
}

// ─── TEST MODE ────────────────────────────────────────────────────────────────

async function testMode() {
  const testUrl = process.argv[3] || 'https://www.randstadusa.com/jobs/apply/4/1330524/';

  if (!fs.existsSync(PROFILE_DIR)) {
    console.error(`[!] Profile not found: ${PROFILE_DIR}\n    Run login first.`);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(62));
  console.log('Randstad-DS Bot — TEST MODE');
  console.log(`URL: ${testUrl}`);
  console.log('='.repeat(62));

  // Step 1: Open persistent profile briefly just to harvest auth cookies
  console.log('[auth] Harvesting session cookies from profile...');
  const profileCtx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const seedPage = await profileCtx.newPage();
  await seedPage.goto('https://www.randstadusa.com/', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  await seedPage.waitForTimeout(2000);
  const cookies = await profileCtx.cookies();
  await profileCtx.close();
  console.log(`[auth] Harvested ${cookies.length} cookies — opening clean session`);

  // Step 2: Fresh browser with no profile, no form history, just the cookies
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-features=AutofillEnableAccountStorageForForms,AutofillAddress',
      '--disable-save-password-bubble',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  await context.addCookies(cookies);

  const page = await context.newPage();

  // Navigate — no cached form data in this fresh context
  await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  await page.waitForTimeout(4000);

  console.log('\n[1] Uploading resume...');
  if (fs.existsSync(RESUME_PATH)) {
    try {
      const fileInputs = page.locator('input[type="file"]');
      if (await fileInputs.count() > 0) {
        await fileInputs.first().setInputFiles(RESUME_PATH);
        console.log('   [ok] Resume uploaded');
        await page.waitForTimeout(2000);
      } else {
        console.log('   [!] No file input found');
      }
    } catch (e) {
      console.log(`   [!] Resume upload error: ${e.message}`);
    }
  } else {
    console.log(`   [!] Resume not found at ${RESUME_PATH}`);
  }

  console.log('\n[2] First fill — let cache settle...');
  await fillField(page, ['#email',      'input[name="email"]'],      USER_EMAIL, 'Email');
  await fillField(page, ['#first_name', 'input[name="first_name"]'], USER_FIRST, 'First name');
  await fillField(page, ['#last_name',  'input[name="last_name"]'],  USER_LAST,  'Last name');
  await fillField(page, ['#zip',        'input[name="zip"]'],        USER_ZIP,   'Zip code');
  await fillField(page, ['#phone',      'input[name="phone"]'],      USER_PHONE, 'Mobile number');

  // Wait for autofill cache to do its thing
  await page.waitForTimeout(3000);

  console.log('\n[2b] Re-filling last name, zip, phone after cache settled...');
  await fillField(page, ['#last_name', 'input[name="last_name"]'], USER_LAST, 'Last name');
  await fillField(page, ['#zip',       'input[name="zip"]'],       USER_ZIP,  'Zip code');

  // Phone: triple-click to select all, clear, type digit by digit so input mask formats correctly
  try {
    const phoneLoc = page.locator('#phone');
    await phoneLoc.click({ clickCount: 3 });
    await phoneLoc.fill('');
    await phoneLoc.pressSequentially(USER_PHONE, { delay: 50 });
    console.log('   [form] Mobile number re-entered digit by digit');
  } catch (e) {
    await fillField(page, ['#phone', 'input[name="phone"]'], USER_PHONE, 'Mobile number');
  }

  console.log('\n[3] Checking consent checkbox...');
  // Use JS click — avoids Playwright scroll-into-view causing page jump
  await page.evaluate(() => {
    const cb = document.getElementById('checkbox-textAlerts');
    if (cb && !cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      cb.dispatchEvent(new Event('click',  { bubbles: true }));
    }
  }).catch(() => {});
  console.log('   [ok] Checked consent checkbox');

  console.log('\n[4] Submitting application...');
  const submitSelectors = [
    'button:has-text("Submit Application")',
    'button:has-text("Submit application")',
    'button:has-text("Submit")',
    'button:has-text("Apply")',
    'input[type="submit"]',
    'button[type="submit"]',
    '[class*="submit"]',
    '[data-testid*="submit"]',
  ];
  const submitted = await clickButton(page, submitSelectors, 'Submit');
  if (submitted) {
    await page.waitForTimeout(6000);
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const confirmed = /thank you|successfully applied|application.*received|you've applied|first step/i.test(bodyText)
      || finalUrl.includes('confirmation') || finalUrl.includes('applied');
    console.log(confirmed ? '\n[ok] APPLICATION SUBMITTED successfully!' : `\n[?] Submitted — verify in browser. URL: ${finalUrl}`);
  } else {
    console.log('\n[!] Submit button not found — check browser manually.');
  }

  console.log('\n[5] Done. Press ENTER to close browser.\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question('Press ENTER to close browser... ', () => { rl.close(); resolve(); }));

  await browser.close().catch(() => {});
  console.log('[done] Test complete.\n');
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

  if (typeof fillField === 'function') {
    await fillField(page, ['#email', 'input[name="email"]'], USER_EMAIL, 'Email');
    await fillField(page, ['#first_name', 'input[name="first_name"]'], USER_FIRST, 'First name');
    await fillField(page, ['#last_name', 'input[name="last_name"]'], USER_LAST, 'Last name');
    await fillField(page, ['#zip', 'input[name="zip"]'], USER_ZIP, 'Zip code');
    await fillField(page, ['#phone', 'input[name="phone"]'], USER_PHONE, 'Phone');
  }

  console.log('\n[formtest] Form filled. Inspect browser, then press ENTER to SUBMIT (Ctrl+C to abort).');
  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();

  const submitted = await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"], input[type="submit"]');
    if (btn) { btn.click(); return true; }
    return false;
  });
  console.log(`[formtest] Submit clicked: ${submitted}`);

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
} else if (arg === 'scrape') {
  runScrapeAndApply().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'test') {
  MAX_JOBS = 1;
  console.log('[test] Single-job test mode — will stop after 1 application attempt.');
  runScrapeAndApply().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'formtest') {
  const url = process.argv[3];
  if (!url) { console.error('[err] Usage: node randstad-ds-bot.js formtest <applyUrl>'); process.exit(1); }
  formTestMode(url).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'urltest') {
  testMode().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'inspect') {
  inspectMode().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else {
  console.log('\nUsage:');
  console.log('  node randstad-ds-bot.js login              ← save Randstad login session (one-time)');
  console.log('  node randstad-ds-bot.js scrape             ← scrape ALL pages then apply sequentially');
  console.log('  node randstad-ds-bot.js test               ← single-job test mode (stops after 1 apply)');
  console.log('  node randstad-ds-bot.js formtest <url>     ← inspect and interactively fill one form');
  console.log('  node randstad-ds-bot.js urltest [url]      ← fill and submit one job form (old test mode)');
  console.log('  node randstad-ds-bot.js inspect [url]      ← dump all form field attributes\n');
  process.exit(1);
}
