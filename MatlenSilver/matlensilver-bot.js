#!/usr/bin/env node
/**
 * Matlen Silver Job Application Bot — 4 Parallel Workers
 *
 * ATS: WPJobBoard (WordPress plugin) — static server-rendered HTML
 * No login required — guest apply works.
 *
 * RUN:  node matlensilver-bot.js
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const HOME_DIR      = process.env.HOME || process.env.USERPROFILE || '';
const WORKSPACE_DIR = path.join(HOME_DIR, '.openclaw', 'workspace');
const LOG_FILE      = path.join(WORKSPACE_DIR, 'ms_applications_log.md');
const APPLIED_IDS   = path.join(WORKSPACE_DIR, 'ms_applied_ids.txt');    // persistent dedup guard
const STATUS_FILE   = path.join(WORKSPACE_DIR, 'ms_worker_status.json'); // live status
const SCANNED_FILE  = path.join(__dirname, 'scanned_jobs.txt');
const APPLIED_FILE  = path.join(__dirname, 'applied_jobs.txt');
const FAILED_FILE   = path.join(__dirname, 'failed_jobs.txt');

const NUM_WORKERS    = 4;
const RATE_LIMIT_MS  = 8000;   // ms between applications per worker
const PAGE_TIMEOUT   = 25000;
const BATCH_SIZE     = 200;
const RESCAN_WAIT_MS = 90000;  // wait between full scans (ms)
const MAX_RETRIES    = 2;

// User details
const USER_NAME          = 'Nikhil Rao';
const USER_EMAIL         = 'nikhilprao9066@gmail.com';
const RESUME_PATH        = path.join(__dirname, '..', 'Nikhil_Resume.pdf');
const COVER_LETTER_PATH  = path.join(__dirname, '..', 'Nikhil_Rao_Cover_Letter.pdf');

const COVER_LETTER_TEXT = `Dear Hiring Manager,

I am writing to express my interest in this position. I am a Data Scientist and Machine Learning Engineer with strong expertise in Python, statistical modeling, NLP, and deploying production ML systems. Please find my resume attached for your review.

I would welcome the opportunity to discuss how my skills align with your needs.

Best regards,
Nikhil Rao`;

// Matlen Silver search — keyword param, national (no location filter)
// date=1 = posted less than 7 days ago; we additionally filter to ≤2 days client-side
const SEARCH_QUERIES = [
  'data+scientist',
  'data+science',
  'machine+learning+engineer',
  'machine+learning',
  'artificial+intelligence',
  'nlp+engineer',
  'applied+scientist',
];

// Block non-DS/ML titles that appear due to broad WPJobBoard keyword matching
const TITLE_BLOCK_RE = /\b(java\s*(developer|engineer|lead)|\.net\s*(developer|engineer|architect)|android\s*(developer|engineer)|ios\s*(developer|engineer)|sales\s*(rep|consultant|coordinator|associate|director)|graphic\s*designer|receptionist|office\s*(clerk|assistant)|windows\s*engineer|sharepoint|mulesoft|scrum\s*master|project\s*manager|program\s*manager|camunda|oracle\s*(developer|dba|fccs|etl)|devops\s*(engineer|admin)|sre\s*engineer|site\s*reliability|linux\s*platform|cybersecurity|cyber\s*security|endpoint\s*security|firewall|network\s*(analyst|engineer)|kms\s*operations|pl\/sql|etl\s*(developer|engineer|automation)|devsecos|ddi\s*engineer|ansible|terraform|kdb\+|starburst|full\s*stack\s*\.net|full\s*stack\s*java|kanban|mortgage|supply\s*chain\s*analyst|talent\s*acquisition|communications\s*coordinator|marketing\s*(ops|channel|manager)|email\s*marketing|motion\s*graphic|administrative\s*assistant|business\s*development|municipal\s*business|government\s*sales|outside\s*sales|territory\s*sales)\b/i;

const TITLE_ALLOW_RE = /data\s*scien|machine\s*learn|ml\s*(engineer|scientist|developer)|applied\s*scien|ai\s*(engineer|scientist|developer|advisor|architect|platform)|nlp|natural\s*language|analytics\s*engineer|data\s*science|deep\s*learn|computer\s*vision|llm|generative\s*ai|gen\s*ai|python\s*(developer|engineer)|data\s*(analyst|architect|engineer)|big\s*data/i;

const BASE_SEARCH = 'https://www.matlensilver.com/jobs/advanced-search/';

function buildSearchUrl(query, page = 1) {
  const paged = page > 1 ? `&paged=${page}` : '';
  return `${BASE_SEARCH}?keyword=${query}&date=1${paged}`;
}

// ─── SHARED STATE ─────────────────────────────────────────────────────────────

let _shouldStop  = false;
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
    `MATLEN SILVER SCAN  —  ${ts}`,
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
    `MATLEN SILVER SESSION  —  ${ts}`,
    `${queueSize} jobs queued for application`,
    '='.repeat(80),
    '',
  ].join('\n'));
}

function writeAppliedEntry(workerId, title, jobId, status, jobUrl) {
  const time      = new Date().toLocaleTimeString('en-US', { hour12: false });
  const statusPad = status.padEnd(9);
  fs.appendFileSync(APPLIED_FILE, [
    `[${time}] [${workerId}]  ${statusPad}  —  ${title}`,
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

function writeFailedEntry(workerId, title, jobId, status, reason, jobUrl) {
  ensureDir(FAILED_FILE);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const note = reason ? `  Reason  : ${reason}` : '';
  const url  = jobUrl || `https://www.matlensilver.com (ID: ${jobId})`;
  sessionFailedUrls.add(url);
  fs.appendFileSync(FAILED_FILE, [
    `[${time}] [${workerId}]  ${status.padEnd(9)}  —  ${title}`,
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
      '# Matlen Silver Job Applications Log\n\n' +
      '| Worker | # | Time | Job Title | Job ID | Status |\n' +
      '|--------|---|------|-----------|--------|--------|\n'
    );
  }
}

function logJob(workerId, num, title, jobId, status) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `| ${workerId} | ${num} | ${time} | ${title} | ${jobId} | ${status} |\n`;
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
    console.warn(`   [!] Status file write error: ${e.message}`);
  }
}

// ─── LOGGING WITH WORKER PREFIX ───────────────────────────────────────────────

function wlog(workerId, msg) {
  const colors = { W1: '\x1b[36m', W2: '\x1b[33m', W3: '\x1b[35m', W4: '\x1b[32m' };
  const reset  = '\x1b[0m';
  const color  = colors[workerId] || '';
  console.log(`${color}[${workerId}]${reset} ${msg}`);
}

// ─── DATE FILTER — only jobs posted within 2 days (48 hours) ─────────────────

function isWithin2Days(postedText) {
  if (!postedText) return true; // unknown — let through
  const t = postedText.toLowerCase();
  // Relative dates
  if (t.includes('just now') || t.includes('today') || t.includes('hour') || t.includes('minute')) return true;
  if (t.includes('1 day') || t.includes('2 days') || t.includes('yesterday')) return true;
  if (/\b[3-9] days?\b/.test(t)) return false;
  if (/\b[1-9]\d+ days?\b/.test(t)) return false;
  if (t.includes('week') || t.includes('month') || t.includes('year')) return false;
  // Absolute date: "Published April 20, 2026" or "April 20, 2026"
  const m = postedText.match(/([A-Za-z]+ \d{1,2},?\s*\d{4})/);
  if (m) {
    const parsed = new Date(m[1]);
    if (!isNaN(parsed.getTime())) {
      const diffDays = (Date.now() - parsed.getTime()) / 86400000;
      return diffDays <= 2;
    }
  }
  return true;
}

// ─── EXTRACT JOBS FROM PAGE ───────────────────────────────────────────────────
// Matlen Silver uses WPJobBoard — static server-rendered HTML.
// Job URL pattern: https://www.matlensilver.com/job/[title-slug]-[numeric-id]/
// We extract the trailing numeric segment as the job ID.

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    const map = {};

    // Grab every link pointing to a /job/ path
    const links = Array.from(document.querySelectorAll('a[href*="/job/"]'));

    for (const a of links) {
      const href = a.href || '';
      // Must be a matlensilver.com job URL
      if (!href.includes('matlensilver.com/job/')) continue;

      // Extract the trailing numeric ID from the slug, e.g. /job/python-developer-59718905/
      const m = href.match(/\/job\/[^/]+-(\d{5,})\/?/);
      if (!m) continue;
      const id  = m[1];
      const url = href.split('?')[0].replace(/\/$/, '') + '/'; // normalise trailing slash

      if (!map[id]) {
        map[id] = { id, title: '', posted: '', url };
      }

      // Prefer text from h2 / h3 inside the card, otherwise use link text
      const card = a.closest(
        '.wpjb-grid-row, .wpjb-job, article, li, [class*="job"], [class*="result"]'
      );

      // Try to get title
      if (!map[id].title) {
        const heading = card
          ? card.querySelector('h2, h3, h1, .wpjb-grid-col-title, [class*="title"]')
          : null;
        const titleText = heading
          ? heading.textContent.trim()
          : a.textContent.trim();
        if (titleText && titleText.length > 3) map[id].title = titleText;
      }

      // Try to get posted date
      if (!map[id].posted && card) {
        // WPJobBoard date element
        const dateEl = card.querySelector(
          '.wpjb-col-date, [class*="date"], [class*="posted"], time'
        );
        if (dateEl) {
          const dateText = dateEl.getAttribute('datetime') || dateEl.textContent.trim();
          if (dateText) map[id].posted = dateText;
        }
        // Fallback: regex scan card text
        if (!map[id].posted) {
          const cardText = card.innerText || '';
          const dm = cardText.match(/(\d+\s+(?:hour|minute|day|week|month)s?\s+ago|today|just now|yesterday|\d+\s+days?\s+ago)/i);
          if (dm) map[id].posted = dm[0];
        }
      }
    }

    return Object.values(map).filter(j => j.url);
  });
}

// ─── SCAN FOR JOBS ────────────────────────────────────────────────────────────

async function scanForJobs(page, appliedJobs) {
  const found   = [];
  const allSeen = [];
  const seenIds = new Set();

  for (const query of SEARCH_QUERIES) {
    const keyword = query.replace(/\+/g, ' ');
    console.log(`\n[S] Scanning: ${keyword}`);

    let pageNum    = 1;
    let totalAdded = 0;
    let totalOld   = 0;

    while (found.length < BATCH_SIZE) {
      const searchUrl = buildSearchUrl(query, pageNum);
      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        await page.waitForTimeout(2000);

        // Check for "no results" signals
        const noJobs = await page.evaluate(() => {
          const body = document.body.innerText.toLowerCase();
          return (
            body.includes('no jobs found') ||
            body.includes('no results') ||
            body.includes('0 jobs') ||
            body.includes('sorry, no listings')
          );
        }).catch(() => false);

        if (noJobs) {
          if (pageNum === 1) {
            console.log(`   [x] No results for "${keyword}" — skipping`);
          } else {
            console.log(`   [x] Page ${pageNum}: end of pagination`);
          }
          break;
        }

        const jobs = await extractJobsFromPage(page);

        if (jobs.length === 0) {
          if (pageNum > 1) {
            console.log(`   [x] Page ${pageNum}: no job cards found — stopping`);
          }
          break;
        }

        const newOnPage = jobs.filter(j => !seenIds.has(j.id));
        // If page 2+ brings nothing new, we've hit the end
        if (pageNum > 1 && newOnPage.length === 0) break;

        for (const job of jobs) {
          if (seenIds.has(job.id)) continue;
          seenIds.add(job.id);
          allSeen.push(job);

          if (appliedJobs.has(job.id)) { console.log(`   [dup] Already applied — skipping ID ${job.id}`); continue; }
          if (!isWithin2Days(job.posted)) { totalOld++; continue; }

          // Title filter: skip clearly off-target roles unless they match DS/ML keywords
          if (job.title && TITLE_BLOCK_RE.test(job.title) && !TITLE_ALLOW_RE.test(job.title)) {
            console.log(`   [-] Filtered title: ${job.title}`);
            continue;
          }

          found.push({
            id: job.id,
            url: job.url,
            title: job.title || job.id,
            posted: job.posted,
          });
          totalAdded++;
        }

        console.log(`   Page ${pageNum}: ${jobs.length} cards | ${newOnPage.length} new | running total: ${totalAdded} to apply`);
        pageNum++;

      } catch (err) {
        console.error(`   [!] Page ${pageNum} error: ${err.message}`);
        break;
      }
    }

    console.log(`   [ok] Done: ${totalAdded} queued | ${totalOld} >2d skipped`);
  }

  const queuedIds = new Set(found.map(j => j.id));
  writeScannedJobs(allSeen, queuedIds, appliedJobs);

  return found;
}

// ─── FILL FORM FIELD WITH FALLBACK SELECTORS ─────────────────────────────────

async function fillField(page, selectors, value, workerId, label) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible({ timeout: 3000 })) {
        await loc.fill(value);
        wlog(workerId, `   [form] ${label} filled (${sel})`);
        return true;
      }
    } catch (e) {
      // try next selector
    }
  }
  // JS fallback
  const filled = await page.evaluate(({ selectors, value }) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return sel;
      }
    }
    return null;
  }, { selectors, value }).catch(() => null);

  if (filled) {
    wlog(workerId, `   [form] ${label} filled via JS (${filled})`);
    return true;
  }

  wlog(workerId, `   [!] Could not fill ${label} — no matching field found`);
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
      // ── 1. Navigate to the job detail page with ?form=apply to pre-reveal form
      const applyUrl = job.url.replace(/\/?$/, '/') + '?form=apply';
      await jobPage.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await jobPage.waitForTimeout(2500);

      // ── 2. Extract actual title from h1 ─────────────────────────────────────
      let title = job.title;
      try {
        const h1 = await jobPage.$('h1');
        if (h1) {
          const h1Text = (await h1.textContent()).trim();
          if (h1Text.length > 3) title = h1Text;
        }
      } catch (e) { /* use job.title */ }

      // ── 2b. Date check on detail page ───────────────────────────────────────
      const detailDate = await jobPage.evaluate(() => {
        const candidates = [
          '.wpjb-col-date', '[class*="date"]', '[class*="posted"]', 'time',
          '.entry-meta', '.job-posted',
        ];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (el) {
            const txt = el.getAttribute('datetime') || el.textContent.trim();
            if (txt) return txt;
          }
        }
        // Fallback: scan body text for "Published Month DD, YYYY"
        const m = document.body.innerText.match(/Published\s+([A-Za-z]+ \d{1,2},?\s*\d{4})/i);
        return m ? m[1] : '';
      }).catch(() => '');

      if (detailDate && !isWithin2Days(detailDate)) {
        wlog(workerId, `   [-] Job older than 2 days (${detailDate}) — SKIPPED`);
        logJob(workerId, jobNumber, title, job.id, 'SKIPPED');
        writeAppliedEntry(workerId, title, job.id, 'SKIPPED', job.url);
        stats.skipped++;
        markApplied(job.id); // prevent re-scan
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      // ── 3. Check the apply form anchor exists ────────────────────────────────
      const hasForm = await jobPage.evaluate(() => {
        return !!(
          document.querySelector('#wpjb-scroll') ||
          document.querySelector('form[id*="apply"], form[class*="apply"], .wpjb-form, #wpjb-form') ||
          document.querySelector('input[name="your_name"], input[name*="applicant"], input[name*="name"]')
        );
      }).catch(() => false);

      if (!hasForm) {
        wlog(workerId, `   [-] No apply form found on page — SKIPPED`);
        logJob(workerId, jobNumber, title, job.id, 'SKIPPED');
        writeAppliedEntry(workerId, title, job.id, 'SKIPPED', job.url);
        stats.skipped++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'SKIPPED';
      }

      // ── 4. Scroll to apply form ──────────────────────────────────────────────
      await jobPage.evaluate(() => {
        const anchor = document.querySelector('#wpjb-scroll');
        if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
        else {
          const form = document.querySelector(
            'form[id*="apply"], form[class*="apply"], .wpjb-form, #wpjb-form'
          );
          if (form) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }).catch(() => {});
      await jobPage.waitForTimeout(1000);

      // ── 5. Fill Name ─────────────────────────────────────────────────────────
      const nameSelectors = [
        'input[name="your_name"]',          // WPJobBoard CF7 form
        'input[name*="applicant_name"]',
        'input[name*="name"]',
        'input[id*="applicant_name"]',
        'input[id*="name"]',
        'input[placeholder*="name" i]',
        'input[placeholder*="full name" i]',
        '.wpjb-field-name input',
        'input[type="text"]:first-of-type',
      ];
      await fillField(jobPage, nameSelectors, USER_NAME, workerId, 'Name');

      // ── 6. Fill Email ────────────────────────────────────────────────────────
      const emailSelectors = [
        'input[name="your_email"]',          // WPJobBoard CF7 form
        'input[type="email"]',
        'input[name*="email"]',
        'input[id*="email"]',
        'input[placeholder*="email" i]',
        '.wpjb-field-email input',
      ];
      await fillField(jobPage, emailSelectors, USER_EMAIL, workerId, 'Email');

      // ── 7. Fill Message / Cover Letter ───────────────────────────────────────
      const messageSelectors = [
        'textarea[name*="message"]',
        'textarea[id*="message"]',
        'textarea[name*="cover"]',
        'textarea[id*="cover"]',
        'textarea[placeholder*="message" i]',
        'textarea[placeholder*="cover" i]',
        'textarea[placeholder*="letter" i]',
        '.wpjb-field-message textarea',
        'textarea',
      ];
      await fillField(jobPage, messageSelectors, COVER_LETTER_TEXT, workerId, 'Message');

      // ── 8. Upload Resume (and Cover Letter if separate input exists) ──────────
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
                const parts = [el.id, el.name, el.getAttribute('aria-label') || ''];
                let node = el.parentElement;
                for (let n = 0; n < 3 && node; n++, node = node.parentElement) {
                  parts.push(node.textContent || '');
                }
                return parts.join(' ').toLowerCase();
              }).catch(() => '');

              if (/cover/i.test(ctx)) {
                coverInput = coverInput || inp;
              } else {
                resumeInput = resumeInput || inp;
              }
            }

            // Fallback: use first input for resume if none clearly labelled
            if (!resumeInput) resumeInput = fileInputs.first();

            await resumeInput.setInputFiles(RESUME_PATH);
            wlog(workerId, `   [resume] Resume uploaded`);

            if (coverInput && fs.existsSync(COVER_LETTER_PATH)) {
              await coverInput.setInputFiles(COVER_LETTER_PATH);
              wlog(workerId, `   [cover]  Cover letter uploaded`);
            }

            await jobPage.waitForTimeout(1000);
          } else {
            wlog(workerId, `   [!] No file input found — skipping resume upload`);
          }
        } catch (e) {
          wlog(workerId, `   [!] Resume upload error: ${e.message}`);
        }
      } else {
        wlog(workerId, `   [!] Resume file not found at ${RESUME_PATH}`);
      }

      // ── 9. Click Submit ──────────────────────────────────────────────────────
      const submitSelectors = [
        'input[type="submit"][value*="Submit application" i]',
        'button:has-text("Submit application")',
        'input[type="submit"][value*="Submit" i]',
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Apply")',
        'button:has-text("Send")',
        'button:has-text("Submit")',
        '.wpjb-submit',
        '[class*="submit"]',
        '[id*="submit"]',
      ];

      let submitted = false;
      for (const sel of submitSelectors) {
        try {
          const loc = jobPage.locator(sel).first();
          if (await loc.count() > 0 && await loc.isVisible({ timeout: 2000 })) {
            wlog(workerId, `   [click] Submit button (${sel})`);
            await loc.click();
            submitted = true;
            break;
          }
        } catch (e) {
          // try next
        }
      }

      if (!submitted) {
        // JS fallback — prioritise "Submit application" text
        submitted = await jobPage.evaluate(() => {
          const candidates = document.querySelectorAll(
            'input[type="submit"], button[type="submit"], button, input[type="button"]'
          );
          // Two passes: first exact phrase, then broad match
          for (const pass of [/submit application/i, /apply|send|submit/i]) {
            for (const el of candidates) {
              const txt = el.textContent.trim();
              const val = (el.value || '');
              if ((pass.test(txt) || pass.test(val)) && el.offsetParent !== null) {
                el.click(); return txt || val;
              }
            }
          }
          return null;
        }).catch(() => null);
        if (submitted) wlog(workerId, `   [click] Submit via JS fallback ("${submitted}")`);
      }

      if (!submitted) {
        wlog(workerId, `   [!] No submit button found — UNCERTAIN`);
        logJob(workerId, jobNumber, title, job.id, 'UNCERTAIN');
        writeAppliedEntry(workerId, title, job.id, 'UNCERTAIN', job.url);
        writeFailedEntry(workerId, title, job.id, 'UNCERTAIN', 'no submit button found', job.url);
        stats.uncertain++;
        markApplied(job.id);
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'UNCERTAIN';
      }

      // ── 10. Wait 12s then check for confirmation ────────────────────────────
      await jobPage.waitForTimeout(12000);

      const CONFIRM_RE = /your application has been sent|your resume is on its way|successfully applied|thank you for applying|we have received your application|application.*received|application.*submitted|thank you.*application|application.*thank you|message.*sent|your message has been sent|email.*sent|resume.*received|we.ll (be in touch|review|contact)/i;

      const bodyText = await jobPage.evaluate(() => document.body.innerText).catch(() => '');
      let result = CONFIRM_RE.test(bodyText) ? 'APPLIED' : 'UNCERTAIN';

      if (result === 'APPLIED') {
        wlog(workerId, `   [ok] Confirmed: "Your application has been sent."`);
      } else {
        wlog(workerId, `   [?] No confirmation text found — UNCERTAIN`);
      }

      logJob(workerId, jobNumber, title, job.id, result);

      if (result === 'APPLIED') {
        wlog(workerId, `   [+] APPLIED — ${title}`);
        markApplied(job.id);
        writeAppliedEntry(workerId, title, job.id, 'APPLIED', job.url);
        stats.applied++;
        await jobPage.close().catch(() => {});
        updateStatus(workerId, 'IDLE');
        return 'APPLIED';
      }

      // UNCERTAIN
      wlog(workerId, `   [?] UNCERTAIN — ${title}`);
      markApplied(job.id);
      writeAppliedEntry(workerId, title, job.id, 'UNCERTAIN', job.url);
      writeFailedEntry(workerId, title, job.id, 'UNCERTAIN', 'submitted but no confirmation detected', job.url);
      stats.uncertain++;
      await jobPage.close().catch(() => {});
      updateStatus(workerId, 'IDLE');
      return 'UNCERTAIN';

    } catch (err) {
      wlog(workerId, `   [x] Error (attempt ${attempt}): ${err.stack || err.message}`);
      await jobPage.close().catch(() => {});
      // If context was destroyed (e.g. Ctrl+C), bail immediately
      if (/closed|destroyed|Target page/i.test(err.message)) {
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }
      if (attempt === MAX_RETRIES) {
        markApplied(job.id);
        logJob(workerId, jobNumber, job.title, job.id, 'FAILED');
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
      updateStatus(workerId, 'WAITING');
      break;
    }

    stats.total++;
    const jobNumber = stats.total;
    appliedJobs.add(job.id); // claim immediately so other workers skip it

    await applyToJob(context, job, workerId, jobNumber);
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  wlog(workerId, `[done] Worker done — queue exhausted`);
  updateStatus(workerId, 'DONE');
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
      console.warn(`  Could not open ${url}: ${e.message}`);
    }
  }
  return true;
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function printDashboard() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`DASHBOARD — ${new Date().toLocaleTimeString()}`);
  console.log(`   Applied: ${stats.applied}  Skipped: ${stats.skipped}  Failed: ${stats.failed}  Uncertain: ${stats.uncertain}`);
  console.log(`   Queue: ${queueIndex}/${jobQueue.length} processed`);
  for (const [id, s] of Object.entries(workerStatus)) {
    console.log(`   ${id}: [${s.state}] ${s.job || '-'}`);
  }
  console.log(`${'─'.repeat(60)}\n`);
}

// ─── MAIN ORCHESTRATOR ────────────────────────────────────────────────────────

async function runBot() {
  const startTime = Date.now();

  initLogFile();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Matlen Silver Bot — ${NUM_WORKERS} Parallel Workers`);
  console.log(`Resume   : ${RESUME_PATH}`);
  console.log(`Cover    : ${COVER_LETTER_PATH}`);
  console.log(`Status   : ${STATUS_FILE}`);
  console.log(`${'='.repeat(60)}`);

  // Verify resume exists before starting
  if (!fs.existsSync(RESUME_PATH)) {
    console.error(`[!] FATAL: Resume not found at ${RESUME_PATH}`);
    console.error(`    Please check the path and try again.`);
    process.exit(1);
  }

  // Launch browser — no persistent profile needed (guest apply)
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });

  // Single shared page for scanning
  const scanPage = await context.newPage();

  let appliedJobs = loadAppliedJobs();
  console.log(`\n[i] Loaded ${appliedJobs.size} previously applied jobs`);

  const dashInterval = setInterval(printDashboard, 30000);

  try {
    while (!_shouldStop) {
      // ── Scan ────────────────────────────────────────────────────────────────
      const newJobs = await scanForJobs(scanPage, appliedJobs);

      if (newJobs.length === 0) {
        console.log(`[z] No new jobs found — exiting.`);
        break;
      }

      jobQueue   = newJobs;
      queueIndex = 0;

      console.log(`\n[>] ${newJobs.length} jobs queued — launching ${NUM_WORKERS} workers\n`);
      initAppliedFile(newJobs.length);
      printDashboard();

      // ── Apply workers ────────────────────────────────────────────────────────
      await Promise.all(
        Array.from({ length: NUM_WORKERS }, (_, i) =>
          runWorker(`W${i + 1}`, context, appliedJobs, i * 2000)
        )
      );

      printDashboard();

      console.log(`\n[z] All workers done — exiting.`);
      break;
    }

  } catch (err) {
    console.error(`\n[x] Fatal:`, err.stack || err.message);
  } finally {
    clearInterval(dashInterval);
    writeSessionSummary();
    const hadFailed = await openFailedJobs(context).catch(() => false);
    if (hadFailed) {
      console.log(`\n[>] Failed/uncertain jobs are open in browser. Review them, then press ENTER to exit...`);
      process.stdin.resume();
      await new Promise(r => process.stdin.once('data', r));
      process.stdin.pause();
    }
    await context.close().catch(e => console.error('Failed to close context:', e.message));
    await browser.close().catch(e => console.error('Failed to close browser:', e.message));
  }

  const ran = Math.floor((Date.now() - startTime) / 60000);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Session Complete — ran ${ran} min`);
  console.log(`Applied: ${stats.applied} | Skipped: ${stats.skipped} | Failed: ${stats.failed} | Uncertain: ${stats.uncertain}`);
  console.log(`Scanned log  -> ${SCANNED_FILE}`);
  console.log(`Applied log  -> ${APPLIED_FILE}`);
  console.log(`${'='.repeat(60)}\n`);
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

runBot().catch(e => { console.error(e.stack || e.message); process.exit(1); });
