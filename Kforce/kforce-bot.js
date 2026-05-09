#!/usr/bin/env node
/**
 * Kforce Job Application Bot — 4 Parallel Workers
 *
 * USAGE:
 *   node kforce-bot.js login      ← opens headed browser, user logs in manually (saves session)
 *   node kforce-bot.js [minutes]  ← run mode: scan + apply for N minutes (default: unlimited)
 *   node kforce-bot.js probe      ← inspect search page DOM and print job cards
 *
 * PLATFORM NOTES (from research):
 *   - Job search: SPA at kforce.com/find-work/search-jobs/#/  (JavaScript-rendered, Angular/React)
 *   - Job detail URL: https://www.kforce.com/jobs/{jobId}/
 *     Job ID format examples: 1696~EQG~2146372T1~99,  1696~JAX~2141294T1~99
 *   - Apply URL: https://www.kforce.com/Jobs/{jobId}/ApplyOnline/
 *     (Also redirects to apps2.kforce.com/index.cfm?event=candidate.apply&id={jobId})
 *   - NO login required for guest apply
 *   - NO CAPTCHA detected on the apply form
 *   - Apply form fields: State (dropdown), Resume upload (PDF/DOC/DOCX ≤2MB),
 *     Specialty (dropdown), Employment Eligibility (radio, 3 options),
 *     2 consent checkboxes
 *   - No date-posted URL filter; recency must be inferred from page text
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const HOME_DIR      = process.env.HOME || process.env.USERPROFILE || '';
const PROFILE_DIR   = process.env.KFORCE_PROFILE_PATH || path.join(HOME_DIR, 'kforce-bot-profile');
const WORKSPACE_DIR = path.join(HOME_DIR, '.openclaw', 'workspace');
const STATUS_FILE   = path.join(WORKSPACE_DIR, 'kforce_worker_status.json');
const APPLIED_IDS   = path.join(__dirname, 'applied_ids.txt');
const SCANNED_FILE  = path.join(__dirname, 'scanned_jobs.txt');
const APPLIED_FILE  = path.join(__dirname, 'applied_jobs.txt');
const FAILED_FILE   = path.join(__dirname, 'failed_jobs.txt');

const NUM_WORKERS   = 4;
const RATE_LIMIT_MS = 8000;   // ms between applications per worker
const PAGE_TIMEOUT  = 30000;
const RESCAN_WAIT_MS = 90000; // ms between full rescans
const BATCH_SIZE    = 200;

// Kforce search — SPA with hash routing; keyword goes in ?q= after the hash
// Base: https://www.kforce.com/find-work/search-jobs/#/search?q={keyword}&remote=true
const SEARCH_KEYWORDS = [
  'data scientist',
  'machine learning engineer',
  'data science',
  'ML engineer',
  'applied scientist',
  'nlp engineer',
  'AI engineer',
];

const BASE_SEARCH = 'https://www.kforce.com/find-work/search-jobs/';

// Kforce SPA hash routing: l=[] = no location filter; sorted client-side after extraction
function buildSearchUrls() {
  return SEARCH_KEYWORDS.map(kw =>
    `${BASE_SEARCH}#/?t=${encodeURIComponent(kw)}&l=%5B%5D`
  );
}

const SEARCH_URLS = buildSearchUrls();

// ─── USER PROFILE (hardcoded) ─────────────────────────────────────────────────

const PROFILE = {
  firstName: 'Nikhil',
  lastName: 'Premachandra Rao',
  fullName: 'Nikhil Premachandra Rao',
  email: 'npraou@gmail.com',
  phone: '7746368916',
  city: 'Atlanta', state: 'GA', stateFullName: 'Georgia',
  zip: '30519', country: 'United States',
  street: '4188 woodfern ln',
  linkedin: 'https://linkedin.com/in/nikhil-p-rao',
  portfolio: 'https://nikprao.vercel.app',
  github: '',
  yearsExp: '5', salary: '100000', noticeDays: '14',
  sponsorship: false,
  citizenStatus: 'Non-citizen allowed to work for any employer',
  ethnicity: 'Asian', gender: 'Male', disability: false, veteran: false,
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

// ─── TITLE FILTERS ────────────────────────────────────────────────────────────

// Block non-matching roles that sometimes appear in DS search results
const TITLE_BLOCK_RE = /\b(data\s*engineer(?:ing)?|database\s*(developer|admin|architect|engineer)|etl\s*(developer|engineer)?|(?:^|\s)data\s*analyst(?:\s|$)|pipeline\s*engineer|bi\s*(developer|engineer)|reporting\s*(developer|analyst)|qa\s*(engineer|analyst)|(?:^|\s)software\s*engineer(?!\s*(ml|machine|ai|nlp|learning)))\b/i;

const TITLE_ALLOW_RE = /data\s*scien|machine\s*learn|ml\s*(engineer|scientist|developer)|applied\s*scien|ai\s*(engineer|scientist|developer)|nlp|natural\s*language|analytics\s*engineer|data\s*science|deep\s*learn|computer\s*vision/i;

// ─── SHARED STATE ─────────────────────────────────────────────────────────────

let _shouldStop = false;
let _sigintCount = 0;
let MAX_JOBS = Infinity;

process.on('SIGINT', () => {
  _sigintCount++;
  if (_sigintCount >= 2) { console.log('\nForce exiting.'); process.exit(1); }
  _shouldStop = true;
  console.log('\n[!] Stopping after current job. (Ctrl+C again to force quit)');
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
  return new Set(fs.readFileSync(APPLIED_IDS, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
}

function markApplied(jobId) {
  ensureDir(APPLIED_IDS);
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
    `KFORCE SCAN  —  ${ts}`,
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
  ensureDir(SCANNED_FILE);
  fs.appendFileSync(SCANNED_FILE, lines.join('\n'));
}

// ─── APPLIED JOBS FILE ────────────────────────────────────────────────────────

function initAppliedFile(queueSize) {
  ensureDir(APPLIED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  fs.appendFileSync(APPLIED_FILE, [
    '='.repeat(80),
    `KFORCE SESSION  —  ${ts}`,
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
  const url  = jobUrl || `https://www.kforce.com/jobs/${jobId}/`;
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

function updateStatus(workerId, state, jobTitle = '') {
  workerStatus[workerId] = {
    state,
    job: jobTitle.slice(0, 50),
    lastUpdate: new Date().toLocaleTimeString('en-US', { hour12: false }),
  };
  try {
    ensureDir(STATUS_FILE);
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      bot: 'kforce',
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
  const reset = '\x1b[0m';
  const color = colors[workerId] || '';
  console.log(`${color}[${workerId}]${reset} ${msg}`);
}

// ─── DATE FILTER — only jobs posted within 24 hours ─────────────────────────

function isRecentJob(postedText) {
  if (!postedText) return true;
  const t = postedText.toLowerCase();

  // Relative strings
  if (/just now|today|hour|minute/i.test(t)) return true;
  if (/\b1\s*d(ay)?\b|yesterday/i.test(t)) return true;
  if (/\b[2-9]\s*d(ays?)?\b|\bweek|\bmonth/i.test(t)) return false;

  // MM/DD/YYYY — accept if posted today or yesterday (calendar-day comparison)
  const m = postedText.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const posted  = new Date(+m[3], +m[1] - 1, +m[2]);
    const now     = new Date();
    const diffDays = Math.floor((now - posted) / (24 * 60 * 60 * 1000));
    return diffDays >= 0 && diffDays <= 1;
  }

  return true;
}

// ─── SCROLL TO LOAD LAZY CONTENT ─────────────────────────────────────────────

async function scrollToLoadAll(page) {
  let prev = 0;
  for (let i = 0; i < 20; i++) {
    try {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      // Count job links — Kforce job detail URLs match /jobs/{id}/
      const count = await page.evaluate(() =>
        document.querySelectorAll('a[href*="/jobs/"]').length
      );
      if (count === prev && i > 3) break;
      prev = count;
    } catch (e) {
      break;
    }
  }
  try { await page.evaluate(() => window.scrollTo(0, 0)); } catch (_) {}
}

// ─── DECODE DETAIL SLUG → REAL JOB ID ────────────────────────────────────────
// Detail URL slug is base64url-encoded job ID: MTY5Nn5FUUd-MjE3NTg1OVQxfjk5 → 1696~EQG~2175859T1~99
// Apply URL: https://www.kforce.com/Jobs/{jobId}/ApplyOnline/

function decodeSlug(slug) {
  try {
    const b64 = slug.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch (_) {
    return slug; // fallback: use slug as-is
  }
}

// ─── EXTRACT JOBS FROM PAGE ───────────────────────────────────────────────────
// Kforce SPA: jobs live in <ul class="data-jobs"><li>...</li>
// Each li has an <a href="#/detail/BASE64SLUG"> where the slug is a base64url-
// encoded version of the actual job ID (e.g. "1696~EQG~2175859T1~99").
// We use the slug as the dedup ID and store the full detail URL for navigation.

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    const results = [];
    const seen    = new Set();

    // Extract the base64 slug from a href like "#/detail/MTY5Nn5FUUd-..."
    // or "/find-work/search-jobs/#/detail/MTY5Nn5..."
    function detailSlug(href) {
      if (!href) return null;
      const m = href.match(/[#/]detail\/([A-Za-z0-9_-]{8,})/);
      return m ? m[1] : null;
    }

    const items = document.querySelectorAll('ul.data-jobs li, ul[class*="data-jobs"] li');

    for (const li of items) {
      const anchors = Array.from(li.querySelectorAll('a'));
      let slug = '';
      let detailUrl = '';

      for (const a of anchors) {
        const raw = a.getAttribute('href') || '';
        const s   = detailSlug(raw) || detailSlug(a.href || '');
        if (s) {
          slug      = s;
          // Build the full SPA detail URL
          detailUrl = `https://www.kforce.com/find-work/search-jobs/#/detail/${s}`;
          break;
        }
      }

      // Fallback: data attribute on the li
      if (!slug) {
        slug = li.getAttribute('data-id') || li.getAttribute('data-job-id') || '';
        if (slug) detailUrl = `https://www.kforce.com/find-work/search-jobs/#/detail/${slug}`;
      }

      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      // Title: anchor text is cleanest — li.innerText has "Title | date | desc"
      const rawText = (li.innerText || '').trim();
      let title = '';
      // Prefer the anchor text (already clean)
      for (const a of anchors) {
        const t = a.textContent.trim();
        if (t.length > 3 && !/^(apply|view|more|save|alert)$/i.test(t)) { title = t; break; }
      }
      // Fallback: text before the first | separator or date
      if (!title) title = rawText.split('|')[0].trim();
      if (!title) title = rawText.replace(/\s*\d{1,2}\/\d{1,2}\/\d{2,4}[\s\S]*$/, '').trim();
      if (!title) title = rawText.slice(0, 80);

      // Posted date (MM/DD/YYYY or relative)
      const dateM = rawText.match(/(\d{1,2}\/\d{1,2}\/\d{2,4}|\d+\s+(?:hour|minute|day|week|month)s?\s+ago|today|just now|yesterday)/i);
      const posted = dateM ? dateM[0] : '';

      results.push({ id: slug, title: title.trim(), company: 'Kforce Client', posted, url: detailUrl });
    }

    return results;
  });
}

// ─── SCAN SINGLE KEYWORD ──────────────────────────────────────────────────────

async function scanKeyword(context, baseUrl, appliedJobs) {
  const kwMatch = decodeURIComponent(baseUrl).match(/[?&]t=([^&]+)/);
  const keyword = kwMatch ? kwMatch[1] : baseUrl;
  console.log(`\n[scan] Scanning: "${keyword}"`);

  const page = await context.newPage();
  const found     = [];
  const allSeen   = [];
  const seenIds   = new Set();
  let totalAdded  = 0;
  let totalOld    = 0;
  let pageNum     = 1;

  try {
    while (found.length < BATCH_SIZE) {
      // Kforce SPA: pagination is typically done by appending &page=N after the hash
      const pagedUrl = pageNum === 1
        ? baseUrl
        : `${baseUrl}&page=${pageNum}`;

      try {
        // SPA needs networkidle or domcontentloaded + wait for JS to render
        await page.goto(pagedUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
          page.goto(pagedUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
        );

        // Wait extra time for Angular/React SPA to render job cards
        await page.waitForTimeout(4000);

        // Wait for job cards to appear (up to 10s)
        await page.waitForSelector(
          'a[href*="/jobs/"], [class*="job-card"], [class*="job-listing"], [class*="result"]',
          { timeout: 10000 }
        ).catch(() => {});

        // Sort by Newest Jobs First — only needed on first page
        if (pageNum === 1) {
          try {
            // Try native <select> first
            const sorted = await page.evaluate(() => {
              const sel = Array.from(document.querySelectorAll('select'))
                .find(s => s.innerText.toLowerCase().includes('newest') || s.innerText.toLowerCase().includes('sort'));
              if (sel) {
                const opt = Array.from(sel.options).find(o => /newest/i.test(o.text));
                if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
              }
              return false;
            });
            if (!sorted) {
              // Fallback: click the dropdown label then the "Newest Jobs First" option
              const trigger = page.locator('text=/Sort By/i').first();
              await trigger.click({ timeout: 5000 }).catch(() => {});
              await page.waitForTimeout(500);
              await page.locator('text=/Newest Jobs First/i').first().click({ timeout: 5000 }).catch(() => {});
            }
            await page.waitForTimeout(2000);
          } catch (_) {}
        }

        await scrollToLoadAll(page);

        // Check for empty state
        const noJobs = await page.evaluate(() => {
          const body = document.body.innerText.toLowerCase();
          return body.includes('no jobs found') ||
                 body.includes('no results found') ||
                 body.includes('0 results') ||
                 body.includes('0 jobs') ||
                 body.includes("we couldn't find") ||
                 body.includes("no matching jobs");
        }).catch(() => false);

        if (noJobs) {
          if (pageNum === 1) {
            console.log(`   [x] "${keyword}" — no results`);
          } else {
            console.log(`   [x] "${keyword}" — page ${pageNum}: end of pagination`);
          }
          break;
        }

        const jobs = await extractJobsFromPage(page);

        if (jobs.length === 0) {
          if (pageNum === 1) {
            // SPA may still be loading — try alternative selector approach
            const rawLinks = await page.evaluate(() =>
              Array.from(document.querySelectorAll('a'))
                .filter(a => a.href && a.href.includes('/jobs/') && !a.href.includes('ApplyOnline'))
                .map(a => ({ href: a.href, text: a.textContent.trim() }))
                .slice(0, 5)
            );
            console.log(`   [!] No job cards extracted. Raw /jobs/ links: ${JSON.stringify(rawLinks.slice(0, 3))}`);
          } else {
            console.log(`   [x] "${keyword}" — page ${pageNum}: no cards`);
          }
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
          if (job.title && TITLE_BLOCK_RE.test(job.title) && !TITLE_ALLOW_RE.test(job.title)) {
            console.log(`   [-] Blocked title: ${job.title}`);
            continue;
          }

          found.push({ id: job.id, url: job.url, title: job.title || job.id, company: job.company || '', posted: job.posted });
          totalAdded++;
        }

        console.log(`   [${keyword}] Page ${pageNum}: ${jobs.length} cards | ${newOnPage.length} new | running: ${totalAdded}`);
        pageNum++;

      } catch (err) {
        console.error(`   [!] "${keyword}" page ${pageNum} error: ${err.message}`);
        break;
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  console.log(`   [+] "${keyword}": ${totalAdded} queued | ${totalOld} >24h skipped`);
  return { found, allSeen };
}

// ─── SCAN ALL KEYWORDS IN PARALLEL ───────────────────────────────────────────

async function scanAllKeywords(context, appliedJobs) {
  console.log(`\n[*] Launching ${SEARCH_URLS.length} parallel keyword scans...`);

  const scanResults = await Promise.all(
    SEARCH_URLS.map(url => scanKeyword(context, url, appliedJobs))
  );

  // Deduplicate across keywords by job ID
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

  // Sort newest first by parsed MM/DD/YYYY date
  mergedJobs.sort((a, b) => {
    const parse = s => {
      if (!s) return 0;
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      return m ? new Date(+m[3], +m[1] - 1, +m[2]).getTime() : 0;
    };
    return parse(b.posted) - parse(a.posted);
  });

  const queuedIds = new Set(mergedJobs.map(j => j.id));
  writeScannedJobs(allSeen, queuedIds, appliedJobs);

  return mergedJobs;
}

// ─── FILL APPLY FORM ─────────────────────────────────────────────────────────
// Kforce guest apply form fields (confirmed from live form):
//   First Name*, Last Name*, Primary Email*, Verify Email*, Phone,
//   State dropdown, Zip*, Country, Resume upload (PDF/DOC/DOCX ≤ 2MB),
//   Employment Eligibility radio (any employer / present employer / sponsorship),
//   Privacy/consent checkbox, Submit

async function fillApplyForm(page, workerId) {
  try {
    await page.waitForSelector('form, input, select', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Helper: fill an input by trying multiple selectors, then label-text fallback
    async function fill(fieldLabel, selectors, value) {
      for (const sel of selectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.count() > 0 && await el.isVisible({ timeout: 1500 })) {
            await el.fill(value);
            wlog(workerId, `   [+] ${fieldLabel}: filled`);
            return true;
          }
        } catch (_) {}
      }
      try {
        const lbl = page.locator('label').filter({ hasText: new RegExp(fieldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
        if (await lbl.count() > 0) {
          const forId = await lbl.getAttribute('for').catch(() => null);
          if (forId) {
            const inp = page.locator(`#${forId}`).first();
            if (await inp.count() > 0 && await inp.isVisible({ timeout: 1000 })) {
              await inp.fill(value);
              wlog(workerId, `   [+] ${fieldLabel}: filled via label`);
              return true;
            }
          }
        }
      } catch (_) {}
      wlog(workerId, `   [?] ${fieldLabel}: field not found`);
      return false;
    }

    // ── Personal info — exact field names confirmed from live form ──────────
    await fill('First Name',    ['#firstName',          'input[name="firstName"]'],  PROFILE.firstName);
    await fill('Last Name',     ['#lastName',           'input[name="lastName"]'],   PROFILE.lastName);
    await fill('Primary Email', ['#emailAddress',       'input[name="emailAddress"]'],      PROFILE.email);
    await fill('Verify Email',  ['#emailAddressVerify', 'input[name="emailAddressVerify"]'], PROFILE.email);
    await fill('Phone',         ['#phoneNumberAll',     'input[name="phoneNumberAll"]'],     PROFILE.phone);

    // ── State dropdown (name="state") ───────────────────────────────────────
    try {
      const stateEl = page.locator('#state, select[name="state"]').first();
      if (await stateEl.count() > 0 && await stateEl.isVisible({ timeout: 2000 })) {
        await stateEl.selectOption({ value: 'GA' }).catch(() =>
          stateEl.selectOption({ label: 'Georgia' })
        );
        wlog(workerId, `   [+] State: GA`);
      }
    } catch (_) {}

    // ── Zip (name="postalCode") ──────────────────────────────────────────────
    await fill('Zip', ['#postalCode', 'input[name="postalCode"]'], PROFILE.zip);

    // ── Country (name="countryID") — leave default "United States" ──────────
    try {
      const cntryEl = page.locator('#countryID, select[name="countryID"]').first();
      if (await cntryEl.count() > 0 && await cntryEl.isVisible({ timeout: 1500 })) {
        await cntryEl.selectOption({ label: 'United States of America' }).catch(() =>
          cntryEl.selectOption({ label: 'United States' }).catch(() => {})
        );
      }
    } catch (_) {}

    // ── Resume upload ────────────────────────────────────────────────────────
    if (!fs.existsSync(PROFILE.resumePath)) {
      wlog(workerId, `   [!] Resume not found at ${PROFILE.resumePath}`);
    } else {
      const resumeSize = fs.statSync(PROFILE.resumePath).size;
      if (resumeSize > 2 * 1024 * 1024) {
        wlog(workerId, `   [!] WARNING: resume is ${(resumeSize / 1024 / 1024).toFixed(1)}MB — Kforce limit is 2MB`);
      }

      // Click "From this computer" button if it exists before the file input appears
      try {
        const fromComputer = page.locator('button, a, label', { hasText: /from this computer/i }).first();
        if (await fromComputer.count() > 0 && await fromComputer.isVisible({ timeout: 2000 })) {
          await fromComputer.click();
          await page.waitForTimeout(1000);
        }
      } catch (_) {}

      let uploaded = false;
      for (const sel of ['input[type="file"]', 'input[name*="resume" i]', 'input[id*="resume" i]', 'input[accept*=".pdf"]', 'input[accept*=".doc"]']) {
        try {
          const el = page.locator(sel).first();
          if (await el.count() > 0) {
            await el.setInputFiles(PROFILE.resumePath);
            wlog(workerId, `   [+] Resume uploaded: ${path.basename(PROFILE.resumePath)}`);
            uploaded = true;
            break;
          }
        } catch (_) {}
      }
      if (!uploaded) wlog(workerId, `   [!] Could not upload resume`);
    }

    await page.waitForTimeout(1500);

    // ── Employment Eligibility (exact field: name="eligibility") ────────────
    // value="AuthorizedForAny"  → "any employer"   ← we want this
    // value="AuthorizedForCurrent" / "NeedsSponsorship"
    try {
      const targetValue = PROFILE.sponsorship ? 'NeedsSponsorship' : 'AuthorizedForAny';
      const radio = page.locator(`input[name="eligibility"][value="${targetValue}"]`).first();
      if (await radio.count() > 0) {
        await radio.check();
        wlog(workerId, `   [+] Eligibility: ${targetValue}`);
      }
    } catch (_) {}

    // ── Privacy consent — the form has no explicit consent checkbox to tick;
    // submission itself constitutes agreement per the form text. Skip. ───────

    await page.waitForTimeout(800);
    return true;

  } catch (err) {
    wlog(workerId, `   [!] fillApplyForm error: ${err.message}`);
    return false;
  }
}

// ─── FIND AND CLICK APPLY BUTTON ─────────────────────────────────────────────
// Clicks "Apply Today" / "Apply Now" — never "Apply with Indeed" or other 3rd-party flows.

async function findAndClickApply(page) {
  for (const text of ['Apply Today', 'Apply Now', 'Apply', 'Submit Application', 'Quick Apply']) {
    const loc = page.locator('button, a', { hasText: new RegExp(text, 'i') });
    try {
      const count = await loc.count();
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        if (!await el.isVisible()) continue;

        const fullText = await el.textContent().catch(() => '');
        const href     = await el.getAttribute('href').catch(() => '');

        // Skip any Indeed / LinkedIn / 3rd-party apply buttons
        if (/indeed|linkedin|glassdoor|ziprecruiter/i.test(fullText)) continue;
        if (/indeed\.com|linkedin\.com/i.test(href || '')) continue;

        if (href && href.includes('ApplyOnline')) return { method: 'link', href };
        await el.click();
        return { method: 'click' };
      }
    } catch (_) {}
  }

  // JS fallback
  const result = await page.evaluate(() => {
    for (const el of document.querySelectorAll('button, a')) {
      const txt  = el.textContent.trim();
      const href = el.getAttribute('href') || '';
      if (!/apply today|apply now|apply|quick apply|submit application/i.test(txt)) continue;
      if (/indeed|linkedin/i.test(txt) || /indeed\.com|linkedin\.com/i.test(href)) continue;
      if (el.offsetParent === null) continue;
      if (href.includes('ApplyOnline')) return { method: 'link', href };
      el.click();
      return { method: 'click' };
    }
    return null;
  }).catch(() => null);

  return result;
}

// ─── CONFIRMATION DETECTION ───────────────────────────────────────────────────

const CONFIRM_RE = /thank you for (applying|submitting)|application.*submitted|application.*received|successfully (applied|submitted)|you.ve applied|we.ve received|application is on its way|application complete|resume.*submitted|your (resume|application) has been/i;

// ─── NAVIGATE APPLY FORM ─────────────────────────────────────────────────────

async function navigateApplyForm(page, workerId, alreadyFilled = false) {
  const maxSteps = 12;

  for (let step = 0; step < maxSteps; step++) {
    if (_shouldStop) return 'UNCERTAIN';
    await page.waitForTimeout(2000);

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

    if (CONFIRM_RE.test(bodyText) || /submitted|thank you|successfully/i.test(bodyText)) {
      return 'APPLIED';
    }

    // Fill on step 0 only if not already filled by the caller
    if (!alreadyFilled && step === 0) {
      const hasForm = await page.evaluate(() =>
        document.querySelectorAll('input[type="file"], select, input[type="radio"]').length > 0
      ).catch(() => false);
      if (hasForm) await fillApplyForm(page, workerId);
    }

    // Submit button — use exact id first, fall back to generic selectors
    // Exclude the search bar submit (#search-button)
    const submitLoc = page.locator([
      '#SubmitButton',
      'input[name=""][id="SubmitButton"]',
      'button:has-text("Submit")',
      'button[type="submit"]',
      'input[type="submit"]:not(#search-button)',
    ].join(', ')).first();

    try {
      if (await submitLoc.count() > 0 && await submitLoc.isVisible()) {
        const btnText = await submitLoc.textContent().catch(() => 'submit');
        wlog(workerId, `   [>] Step ${step + 1}: "${btnText.trim()}"`);
        await submitLoc.click();

        // Wait for confirmation (up to 15s per spec)
        try {
          await page.waitForFunction(
            () => /submitted|thank you|successfully|application.*received/i.test(document.body.innerText),
            { timeout: 15000 }
          );
          return 'APPLIED';
        } catch {
          const afterText = await page.evaluate(() => document.body.innerText).catch(() => '');
          if (CONFIRM_RE.test(afterText)) return 'APPLIED';
          if (/error|invalid|required/i.test(afterText)) {
            wlog(workerId, `   [!] Form validation error detected`);
            return 'FAILED';
          }
          return 'UNCERTAIN';
        }
      }
    } catch (e) {
      wlog(workerId, `   [!] Submit error: ${e.message}`);
    }

    // Next / Continue button (multi-step forms)
    const nextLoc = page.locator([
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Next Step")',
      '[data-automation="next-button"]',
    ].join(', ')).first();

    try {
      if (await nextLoc.count() > 0 && await nextLoc.isVisible() && await nextLoc.isEnabled()) {
        wlog(workerId, `   [>] Step ${step + 1}: Next/Continue`);
        await nextLoc.click();
        continue;
      }
    } catch (_) {}

    // Log visible buttons for debugging
    const visible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a[role="button"], input[type="submit"]'))
        .filter(b => b.offsetParent !== null)
        .map(b => (b.textContent || b.value || '').trim())
        .filter(Boolean)
    ).catch(() => []);
    wlog(workerId, `   [?] Step ${step + 1}: No submit/next found. Visible: [${visible.slice(0, 8).join(' | ')}]`);
    break;
  }

  return 'UNCERTAIN';
}

// ─── CLICK "APPLY TODAY" → "APPLY WITH KFORCE" ───────────────────────────────

async function clickApplyWithKforce(page, workerId) {
  // Step 1: click the main "Apply Today" / "Apply Now" button
  const mainBtnSels = [
    'button:has-text("Apply Today")',
    'a:has-text("Apply Today")',
    'button:has-text("Apply Now")',
    'a:has-text("Apply Now")',
    '[class*="apply-btn"]',
    'button:has-text("Apply")',
  ];
  let clickedMain = false;
  for (const sel of mainBtnSels) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible({ timeout: 2000 })) {
        await el.click();
        clickedMain = true;
        wlog(workerId, `   [+] Clicked Apply Today`);
        break;
      }
    } catch (_) {}
  }
  if (!clickedMain) {
    // JS fallback
    clickedMain = await page.evaluate(() => {
      for (const el of document.querySelectorAll('button, a')) {
        const t = el.textContent.trim();
        if (/apply today|apply now/i.test(t) && el.offsetParent !== null) { el.click(); return true; }
      }
      return false;
    }).catch(() => false);
  }
  if (!clickedMain) { wlog(workerId, `   [?] Apply Today button not found`); return false; }

  // Step 2: wait for the dropdown/menu to render
  await page.waitForTimeout(2000);

  // Strategy: find "Apply With Indeed" in the dropdown, then click its SIBLING
  // that has "apply" in the text but isn't Indeed/LinkedIn.
  const kforceText = await page.evaluate(() => {
    for (const indeedEl of document.querySelectorAll('a, button, [role="menuitem"], li')) {
      if (!/apply with indeed/i.test(indeedEl.textContent.trim())) continue;
      if (indeedEl.offsetParent === null) continue;

      // Walk up to the dropdown container
      const container = indeedEl.closest(
        '[class*="dropdown"], [class*="menu"], [role="menu"], ul, ol'
      ) || indeedEl.parentElement;

      const candidates = Array.from(container.querySelectorAll('a, button, [role="menuitem"]'));
      for (const c of candidates) {
        if (c === indeedEl) continue;
        const t = c.textContent.trim();
        if (!t || t.length > 60) continue;
        if (/indeed|linkedin|glassdoor/i.test(t)) continue;
        if (c.offsetParent === null) continue;
        c.click();
        return t;
      }
    }
    return null;
  }).catch(() => null);

  if (kforceText) {
    wlog(workerId, `   [+] Clicked Kforce apply option: "${kforceText}"`);
    return true;
  }

  // Log what apply-related items are visible so we can diagnose failures
  const applyRelated = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a, button, li'))
      .filter(el => el.offsetParent !== null && /apply|kforce|indeed/i.test(el.textContent))
      .map(el => el.textContent.trim().slice(0, 60))
  ).catch(() => []);
  wlog(workerId, `   [?] "Apply with Kforce" sibling not found. Apply-related: ${JSON.stringify(applyRelated.slice(0, 6))}`);
  return false;
}

// ─── APPLY TO ONE JOB ─────────────────────────────────────────────────────────

async function applyToJob(context, job, workerId, jobNumber) {
  wlog(workerId, `[apply] #${jobNumber} — ${job.title} | ${job.posted || 'no date'}`);
  updateStatus(workerId, 'APPLYING', job.title);

  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (_shouldStop) { updateStatus(workerId, 'IDLE'); return 'SKIPPED'; }
    if (attempt > 1) {
      wlog(workerId, `   [~] Retry ${attempt}/${MAX_RETRIES}`);
      await new Promise(r => setTimeout(r, 5000));
    }

    const jobPage = await context.newPage();
    try {
      // Decode the base64url slug → real job ID → direct apply URL
      const jobId   = decodeSlug(job.id);
      const applyUrl = `https://www.kforce.com/Jobs/${encodeURIComponent(jobId)}/ApplyOnline/`;
      wlog(workerId, `   [->] ${applyUrl}`);

      await jobPage.goto(applyUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
        jobPage.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
      );
      await jobPage.waitForTimeout(3000);

      let title = job.title, company = job.company || 'Kforce Client';

      // Handle possible new tab (some apply forms open in a new window)
      const newTabPromise = context.waitForEvent('page', { timeout: 4000 }).catch(() => null);
      await jobPage.waitForTimeout(500);
      const newTab = await newTabPromise;
      let applyPage = newTab || jobPage;
      if (newTab) {
        await applyPage.waitForLoadState('domcontentloaded').catch(() => {});
        await applyPage.waitForTimeout(2000);
        if (!applyPage.url() || applyPage.url() === 'about:blank') {
          await applyPage.close().catch(() => {});
          applyPage = jobPage;
        } else {
          wlog(workerId, `   [tab] ${applyPage.url()}`);
        }
      }

      const currentUrl = applyPage.url();
      wlog(workerId, `   [url] ${currentUrl}`);

      const result = await navigateApplyForm(applyPage, workerId);

      if (newTab && applyPage !== jobPage) await applyPage.close().catch(() => {});
      await jobPage.close().catch(() => {});

      if (result === 'APPLIED') {
        wlog(workerId, `   [+] APPLIED — ${title}`);
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
        writeFailedEntry(workerId, title, company, job.id, 'UNCERTAIN', 'no confirmation detected', job.url);
        stats.uncertain++;
        updateStatus(workerId, 'IDLE');
        return 'UNCERTAIN';
      }

      // FAILED — retry
      if (attempt === MAX_RETRIES) {
        markApplied(job.id);
        writeAppliedEntry(workerId, title, company, job.id, 'FAILED', job.url);
        writeFailedEntry(workerId, title, company, job.id, 'FAILED', 'max retries reached', job.url);
        stats.failed++;
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }

    } catch (err) {
      wlog(workerId, `   [x] Error (attempt ${attempt}): ${err.message}`);
      await jobPage.close().catch(() => {});

      if (/closed|destroyed|Target page/i.test(err.message)) {
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }

      if (attempt === MAX_RETRIES) {
        markApplied(job.id);
        writeAppliedEntry(workerId, '-', '-', job.id, 'FAILED', job.url);
        writeFailedEntry(workerId, job.title, '-', job.id, 'FAILED', err.message, job.url);
        stats.failed++;
        updateStatus(workerId, 'IDLE');
        return 'FAILED';
      }
    }
  }

  markApplied(job.id);
  updateStatus(workerId, 'IDLE');
  writeFailedEntry('--', job.title, '-', job.id, 'FAILED', 'exhausted retries', job.url);
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

    if (stats.applied + stats.failed + stats.uncertain >= MAX_JOBS) {
      _shouldStop = true;
      wlog(workerId, `[limit] MAX_JOBS (${MAX_JOBS}) reached — stopping`);
      break;
    }

    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  wlog(workerId, `[done] Worker done`);
  updateStatus(workerId, 'DONE');
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function printDashboard() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[DASHBOARD] — ${new Date().toLocaleTimeString()}`);
  console.log(`   Applied: ${stats.applied}  Skipped: ${stats.skipped}  Failed: ${stats.failed}  Uncertain: ${stats.uncertain}`);
  console.log(`   Queue: ${queueIndex}/${jobQueue.length} processed`);
  for (const [id, s] of Object.entries(workerStatus)) {
    console.log(`   ${id}: [${s.state}] ${s.job || '-'}`);
  }
  console.log(`${'─'.repeat(60)}\n`);
}

// ─── MAIN RUN LOOP ────────────────────────────────────────────────────────────

async function runBot(runtimeMinutes) {
  const startTime = Date.now();
  const endTime   = runtimeMinutes ? startTime + runtimeMinutes * 60000 : Infinity;

  // Ensure output dirs exist
  ensureDir(APPLIED_FILE);
  ensureDir(SCANNED_FILE);
  ensureDir(FAILED_FILE);
  ensureDir(STATUS_FILE);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[*] Kforce Bot — ${NUM_WORKERS} Parallel Workers`);
  console.log(`[*] Profile   : ${PROFILE_DIR}`);
  console.log(`[*] Status    : ${STATUS_FILE}`);
  if (runtimeMinutes) console.log(`[*] Runtime   : ${runtimeMinutes} minutes`);
  console.log(`[*] Resume    : ${PROFILE.resumePath}`);
  if (!fs.existsSync(PROFILE.resumePath)) {
    console.warn(`[!] WARNING: resume.pdf not found at ${PROFILE.resumePath}`);
    console.warn(`[!] Please copy your resume.pdf to /Users/nikhil/Desktop/Jobs/Kforce/resume.pdf`);
  }
  console.log(`${'═'.repeat(60)}\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const pages    = context.pages();
  const holdPage = pages.length > 0 ? pages[0] : await context.newPage();

  // Load the Kforce search page once to warm up the session / accept cookies
  await holdPage.goto('https://www.kforce.com/find-work/search-jobs/', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  }).catch(() => {});
  await holdPage.waitForTimeout(2000);

  // Dismiss cookie consent if present
  for (const txt of ['Accept All', 'Accept', 'Accept Cookies', 'I Accept', 'OK', 'Agree']) {
    await holdPage.locator(`button:has-text("${txt}")`).first().click({ timeout: 1500 }).catch(() => {});
  }

  let appliedJobs = loadAppliedJobs();
  console.log(`[*] Loaded ${appliedJobs.size} previously applied job IDs`);

  const dashInterval = setInterval(printDashboard, 30000);

  try {
    while (!_shouldStop && Date.now() < endTime) {
      console.log(`\n[scan] Starting new scan round...`);

      const newJobs = await scanAllKeywords(context, appliedJobs);

      if (newJobs.length === 0) {
        console.log(`[sleep] No new jobs found. Waiting ${RESCAN_WAIT_MS / 1000}s before rescan...`);
        const waitEnd = Date.now() + RESCAN_WAIT_MS;
        while (!_shouldStop && Date.now() < waitEnd && Date.now() < endTime) {
          await new Promise(r => setTimeout(r, 5000));
        }
        continue;
      }

      jobQueue   = newJobs;
      queueIndex = 0;

      console.log(`\n[*] ${newJobs.length} jobs queued — launching ${NUM_WORKERS} workers\n`);
      initAppliedFile(newJobs.length);
      printDashboard();

      // 4 apply workers drain the queue in parallel
      await Promise.all(
        Array.from({ length: NUM_WORKERS }, (_, i) =>
          runWorker(`W${i + 1}`, context, appliedJobs, i * 2000)
        )
      );

      printDashboard();

      console.log(`[done] Queue exhausted. Exiting.`);
      break;
    }

  } catch (err) {
    console.error(`\n[FATAL]`, err.stack || err.message);
  } finally {
    clearInterval(dashInterval);
    writeSessionSummary();
    await context.close().catch(e => console.error('Failed to close context:', e.message));
  }

  const ran = Math.floor((Date.now() - startTime) / 60000);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[done] Session Complete — ran ${ran} min`);
  console.log(`[+] Applied: ${stats.applied} | Skipped: ${stats.skipped} | Failed: ${stats.failed} | Uncertain: ${stats.uncertain}`);
  console.log(`  Scanned log  -> ${SCANNED_FILE}`);
  console.log(`  Applied log  -> ${APPLIED_FILE}`);
  console.log(`  Failed log   -> ${FAILED_FILE}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Open failed job URLs in browser for manual review
  if (sessionFailedUrls.size > 0) {
    console.log(`[!] ${sessionFailedUrls.size} failed/uncertain job(s) in ${FAILED_FILE}`);
  }
}

// ─── LOGIN MODE ───────────────────────────────────────────────────────────────
// Kforce guest apply doesn't require login, but we keep this for session warmup
// and for users who want to pre-login to their Kforce consultant account.

async function loginMode() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[login] Opening headed browser — please log in to Kforce`);
  console.log(`[login] Login URL: https://myhiring.kforce.com/careersection/iam/accessmanagement/login.jsf`);
  console.log(`[login] Session will be saved to: ${PROFILE_DIR}`);
  console.log(`[login] NOTE: Login is NOT required for guest job applications.`);
  console.log(`[login] This saves a session for future use / consultant portal access.`);
  console.log(`${'═'.repeat(60)}\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const pages = context.pages();
  const page  = pages.length > 0 ? pages[0] : await context.newPage();

  await page.goto(
    'https://myhiring.kforce.com/careersection/iam/accessmanagement/login.jsf',
    { waitUntil: 'domcontentloaded', timeout: 30000 }
  ).catch(() => {});

  console.log('[login] Browser is open. Log in manually, then press ENTER here to save session and exit.');
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();

  console.log(`[login] Session saved to ${PROFILE_DIR}. Closing.`);
  await context.close();
}

// ─── PROBE MODE ───────────────────────────────────────────────────────────────

async function probeMode() {
  console.log(`\n[probe] Opening Kforce search page to inspect DOM\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  for (const p of context.pages()) await p.close().catch(() => {});
  const page = await context.newPage();

  const testUrl = `${BASE_SEARCH}#/?t=Data%20Scientist&l=%5B%5D`;
  console.log(`[probe] Loading: ${testUrl}`);

  await page.goto(testUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
    page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
  );

  await page.waitForTimeout(5000);

  console.log(`\n[probe] Page loaded. Press ENTER to extract jobs (or dismiss popups first)...`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();

  await scrollToLoadAll(page);
  const jobs = await extractJobsFromPage(page);
  console.log(`\n[probe] Found ${jobs.length} jobs:`);
  jobs.slice(0, 10).forEach((j, i) =>
    console.log(`   ${i + 1}. [${j.id}] "${j.title}" | posted: ${j.posted || '?'} | ${j.url}`)
  );

  // Always dump ul.data-jobs structure so we can see real link hrefs
  const dataJobsInfo = await page.evaluate(() => {
    const ul = document.querySelector('ul.data-jobs, ul[class*="data-jobs"]');
    if (!ul) return { found: false, count: 0, items: [] };

    const items = Array.from(ul.querySelectorAll('li')).slice(0, 5);
    return {
      found: true,
      count: ul.querySelectorAll('li').length,
      items: items.map(li => ({
        text:    (li.innerText || '').trim().slice(0, 120).replace(/\n/g, ' | '),
        attrs:   `id="${li.id}" data-id="${li.getAttribute('data-id') || ''}" data-job-id="${li.getAttribute('data-job-id') || ''}"`,
        links:   Array.from(li.querySelectorAll('a')).map(a => ({
          text: a.textContent.trim().slice(0, 60),
          href: a.getAttribute('href') || '',
          full: a.href || '',
        })),
      })),
    };
  });

  console.log(`\n[probe] ul.data-jobs: found=${dataJobsInfo.found}, count=${dataJobsInfo.count}`);
  if (dataJobsInfo.found) {
    dataJobsInfo.items.forEach((item, i) => {
      console.log(`   LI ${i + 1}: ${item.text}`);
      console.log(`          attrs: ${item.attrs}`);
      item.links.forEach(l => console.log(`          a href="${l.href}" full="${l.full}" text="${l.text}"`));
    });
  }

  if (jobs.length === 0) {
    // Dump all <a> tags on the page for diagnosis
    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .filter(a => a.href && !a.href.startsWith('javascript'))
        .map(a => ({ href: a.getAttribute('href') || '', full: a.href, text: a.textContent.trim().slice(0, 60) }))
        .slice(0, 30)
    );
    console.log(`\n[probe] All <a> links on page (first 30):`);
    allLinks.forEach(l => console.log(`   href="${l.href}"  full="${l.full}"  text="${l.text}"`));
  }

  // If a specific URL was passed as third arg, use that instead of first found job
  const overrideUrl = process.argv[3];
  if (jobs.length > 0 || overrideUrl) {
    const testJob = overrideUrl ? { url: overrideUrl, id: 'manual', title: 'manual' } : jobs[0];
    console.log(`\n[probe] Opening detail page: ${testJob.url}`);
    await page.goto(testJob.url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
      page.goto(testJob.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
    );
    await page.waitForTimeout(3000);
    console.log(`[probe] Detail page URL: ${page.url()}`);

    // Show buttons visible on the detail page
    const btns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a[role="button"], a'))
        .filter(el => el.offsetParent !== null)
        .map(el => ({ text: el.textContent.trim().slice(0, 60), href: el.getAttribute('href') || '' }))
        .filter(b => b.text.length > 1)
        .slice(0, 20)
    );
    console.log(`\n[probe] Visible buttons/links on detail page:`);
    btns.forEach(b => console.log(`   "${b.text}"  href="${b.href}"`));

    console.log(`\n[probe] Press ENTER to click Apply Today → Apply with Kforce...`);
    process.stdin.resume();
    await new Promise(resolve => process.stdin.once('data', resolve));
    process.stdin.pause();

    const newTabPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await clickApplyWithKforce(page, 'probe');
    await page.waitForTimeout(2000);
    const newTab = await newTabPromise;
    const applyPage = (newTab && newTab.url() !== 'about:blank') ? newTab : page;
    if (newTab) { await applyPage.waitForLoadState('domcontentloaded').catch(() => {}); await applyPage.waitForTimeout(2000); }

    console.log(`[probe] Apply page URL: ${applyPage.url()}`);

    const fields = await applyPage.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
      return inputs.map(el => ({
        tag: el.tagName, type: el.type || '', name: el.name || '', id: el.id || '',
        placeholder: el.placeholder || '',
        label: (() => { const lbl = el.id && document.querySelector(`label[for="${el.id}"]`); return lbl ? lbl.textContent.trim() : ''; })(),
      }));
    });
    console.log(`\n[probe] Apply form fields:`);
    fields.forEach(f => console.log(`   <${f.tag} type="${f.type}" name="${f.name}" id="${f.id}" label="${f.label}"> placeholder="${f.placeholder}"`));
  }

  console.log(`\n[probe] Done. Press ENTER to close.`);
  process.stdin.resume();
  await new Promise(resolve => process.stdin.once('data', resolve));
  process.stdin.pause();

  await context.close();
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

// ─── FORMTEST MODE ────────────────────────────────────────────────────────────
// node kforce-bot.js formtest <applyUrl>
// Navigates directly to an apply URL, dumps all form fields, fills them,
// then pauses so you can inspect before hitting Enter to submit.

async function formTestMode(applyUrl) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[formtest] URL: ${applyUrl}`);
  console.log(`[formtest] Resume: ${PROFILE.resumePath} (exists: ${fs.existsSync(PROFILE.resumePath)})`);
  console.log(`${'═'.repeat(60)}\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const pages = context.pages();
  const page  = pages.length > 0 ? pages[0] : await context.newPage();

  await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
    page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
  );
  await page.waitForTimeout(3000);
  console.log(`[formtest] Landed: ${page.url()}`);

  // Dump every form field with name, id, type, label
  const fields = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, select, textarea')).map(el => {
      const labelEl = el.id && document.querySelector(`label[for="${el.id}"]`);
      const nearText = el.closest('div,p,li,td')?.innerText?.trim().split('\n')[0] || '';
      return {
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        name: el.name || '',
        id: el.id || '',
        value: (el.type === 'radio' || el.type === 'checkbox') ? el.value : '',
        label: labelEl ? labelEl.textContent.trim() : '',
        near: nearText.slice(0, 60),
        required: el.required,
      };
    });
  });

  console.log('\n[formtest] ── Form fields ──────────────────────────────');
  fields.forEach(f => {
    console.log(`  <${f.tag} type="${f.type}" name="${f.name}" id="${f.id}" ${f.required?'required':''}`);
    if (f.label) console.log(`      label="${f.label}"`);
    if (f.value) console.log(`      value="${f.value}"`);
    if (!f.label && f.near) console.log(`      near="${f.near}"`);
  });
  console.log('[formtest] ────────────────────────────────────────────\n');

  console.log('[formtest] Press ENTER to fill the form...');
  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();

  await fillApplyForm(page, 'FT');

  console.log('\n[formtest] Form filled. Browser is open — inspect it.');
  console.log('[formtest] Press ENTER to SUBMIT, or Ctrl+C to abort.');
  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();

  const result = await navigateApplyForm(page, 'FT', true);
  console.log(`\n[formtest] Result: ${result}`);

  console.log('[formtest] Press ENTER to close.');
  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();

  await context.close();
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

const arg = process.argv[2];

if (arg === 'login') {
  loginMode().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'probe') {
  probeMode().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'formtest') {
  const url = process.argv[3];
  if (!url) { console.error('[err] Usage: node kforce-bot.js formtest <applyUrl>'); process.exit(1); }
  formTestMode(url).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'test') {
  MAX_JOBS = 1;
  console.log('[test] Single-job test mode — will stop after 1 application attempt.');
  runBot(null).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else {
  const minutes = arg ? parseInt(arg, 10) : 0;
  if (arg && isNaN(minutes)) {
    console.error(`[err] Unknown argument: "${arg}". Use: login | probe | formtest | test | [minutes]`);
    process.exit(1);
  }
  runBot(minutes || null).catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
