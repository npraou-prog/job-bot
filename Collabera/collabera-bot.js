#!/usr/bin/env node
/**
 * Collabera Job Application Bot
 *
 * ATS: Custom WordPress — static server-rendered HTML with inline apply section.
 * No login required — guest apply works.
 *
 * Apply flow:
 *   1. Navigate to job detail page.
 *   2. Click "Apply Now" / "Apply" button to reveal the inline form.
 *   3. Fill name, email, phone; check ToS checkbox; upload resume; submit.
 *
 * USAGE:
 *   node collabera-bot.js [minutes]     ← run for N minutes (default: unlimited)
 *   node collabera-bot.js formtest <url>
 */

'use strict';

const { chromium } = require('playwright');
const fs            = require('fs');
const path          = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const HOME_DIR        = process.env.HOME || process.env.USERPROFILE || '';
const WORKSPACE_DIR   = path.join(HOME_DIR, '.openclaw', 'workspace');
const APPLIED_IDS     = path.join(__dirname, 'applied_ids.txt');
const APPLIED_FILE    = path.join(__dirname, 'applied_jobs.txt');
const FAILED_FILE     = path.join(__dirname, 'failed_jobs.txt');
const SCANNED_FILE    = path.join(__dirname, 'scanned_jobs.txt');

const USER_FULL_NAME  = 'Nikhil Premachandra Rao';
const USER_FIRST_NAME = 'Nikhil';
const USER_LAST_NAME  = 'Premachandra Rao';
const USER_EMAIL      = 'npraou@gmail.com';
const USER_PHONE      = '7746368916';
const RESUME_PATH     = (() => {
  const candidates = [
    path.join(__dirname, 'resume.pdf'),
    path.join(__dirname, 'Nikhil_Resume.pdf'),
    path.join(__dirname, '..', 'resume.pdf'),
    path.join(__dirname, '..', 'Nikhil_Resume.pdf'),
    path.join(HOME_DIR, 'Desktop', 'Jobs', 'Nikhil_Resume.pdf'),
  ];
  return candidates.find(p => { try { return fs.existsSync(p); } catch(_){} }) || candidates[0];
})();

const NUM_WORKERS       = 2;
const PAGE_TIMEOUT      = 30000;
const APPLY_EXPAND_WAIT = 2000;
const POST_SUBMIT_WAIT  = 5000;
const RATE_LIMIT_MS     = 5000;

const SEARCH_QUERIES = [
  'data+scientist',
  'machine+learning',
  'ML+engineer',
  'applied+scientist',
  'nlp+engineer',
  'AI+engineer',
  'data+science',
];

const TITLE_ALLOW_RE = /data\s*scientist|machine\s*learning|ml\s+engineer|data\s+engineer|data\s+analyst|ai\s+engineer|nlp|mlops|analytics\s+engineer|applied\s+scientist/i;

function buildSearchUrl(query) {
  return `https://collabera.com/job-search/?sort_by=&industry=&keyword=${query}&location=&Posteddays=1`;
}

// ─── DATE FILTER ──────────────────────────────────────────────────────────────

function isWithin1Day(postedText) {
  if (!postedText) return true;
  const t = postedText.toLowerCase().trim();
  if (/just now|today|hour|minute|yesterday|1 day/.test(t)) return true;
  if (/\b[2-9] days?\b|\b[1-9]\d+ days?\b|week|month|year/.test(t)) return false;
  const m = postedText.match(/([A-Za-z]+ \d{1,2},?\s*\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
  if (m) {
    const parsed = new Date(m[1]);
    if (!isNaN(parsed.getTime())) return (Date.now() - parsed.getTime()) / 86400000 <= 1;
  }
  return true;
}

// ─── RUNTIME STATE ────────────────────────────────────────────────────────────

let _shouldStop  = false;
let _sigintCount = 0;
const stats = { applied: 0, skipped: 0, failed: 0, uncertain: 0 };

process.on('SIGINT', () => {
  _sigintCount++;
  if (_sigintCount >= 2) { console.log('\nForce exiting.'); process.exit(1); }
  _shouldStop = true;
  console.log('\n[!] Stopping after current job. (Ctrl+C again to force quit)');
});

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`[collabera] ${msg}`); }
function warn(msg) { console.warn(`[collabera] WARN: ${msg}`); }

function ensureDir(p) {
  const d = path.dirname(p);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function loadAppliedIds() {
  try {
    if (fs.existsSync(APPLIED_IDS))
      return new Set(fs.readFileSync(APPLIED_IDS, 'utf8').split('\n').map(l => l.trim()).filter(Boolean));
  } catch(_) {}
  return new Set();
}

function saveAppliedId(id) {
  ensureDir(APPLIED_IDS);
  fs.appendFileSync(APPLIED_IDS, id + '\n');
}

function writeApplied(job, result) {
  ensureDir(APPLIED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  const line = `[${ts}] ${result.padEnd(9)} — ${job.title}\n  ID: ${job.id} | ${job.url}\n  Posted: ${job.posted || 'unknown'}\n\n`;
  fs.appendFileSync(result === 'APPLIED' ? APPLIED_FILE : FAILED_FILE, line);
}

// ─── EXTRACT JOBS FROM SEARCH PAGE ───────────────────────────────────────────

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    const results = [];
    const seen    = new Set();

    // Strategy: find title links — job titles live in headings that link to job-description pages
    const titleLinks = Array.from(document.querySelectorAll(
      'h2 a[href*="job-description"], h3 a[href*="job-description"], ' +
      'h4 a[href*="job-description"], h5 a[href*="job-description"], ' +
      'h6 a[href*="job-description"], [class*="title"] a[href*="job-description"], ' +
      '[class*="job-title"] a, [class*="jobtitle"] a'
    ));

    for (const a of titleLinks) {
      const href = a.href || '';
      const m    = href.match(/[?&]post=(\d+)/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);

      const title = (a.closest('h2,h3,h4,h5,h6') || a).textContent.trim();
      if (!title || title.length < 3) continue;

      const card = a.closest(
        'article, li, [class*="job"], [class*="listing"], [class*="result"], [class*="card"], div.post'
      ) || a.closest('div') || a.parentElement;

      let posted = '';
      if (card) {
        const dateEl = card.querySelector('[class*="date"], [class*="posted"], [class*="time"], time');
        if (dateEl) posted = dateEl.getAttribute('datetime') || dateEl.getAttribute('title') || dateEl.textContent.trim();
        if (!posted) {
          const dm = (card.innerText || '').match(/(\d+\s+(?:hour|minute|day|week|month)s?\s+ago|today|yesterday|just now)/i);
          if (dm) posted = dm[0];
        }
      }

      results.push({ id, url: `https://collabera.com/job-description/?post=${id}`, title, posted });
    }

    // Fallback: if no title-link strategy worked, collect IDs from any job-description link
    if (results.length === 0) {
      for (const a of document.querySelectorAll('a[href*="job-description/?post="]')) {
        const m = (a.href || '').match(/[?&]post=(\d+)/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        results.push({ id: m[1], url: `https://collabera.com/job-description/?post=${m[1]}`, title: '', posted: '' });
      }
    }

    return results;
  });
}

// ─── FILL ONE FIELD ───────────────────────────────────────────────────────────

async function fillField(page, selectors, value, label) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible({ timeout: 2000 })) {
        await loc.fill(value);
        return true;
      }
    } catch (_) {}
  }
  await page.evaluate(({ selectors, value }) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        el.focus(); el.value = value;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
  }, { selectors, value }).catch(() => {});
  warn(`   Could not fill "${label}"`);
  return false;
}

// ─── CLICK APPLY BUTTON ───────────────────────────────────────────────────────

async function clickApplyAndExpandForm(page) {
  const applySels = [
    'a:has-text("Apply Now")', 'button:has-text("Apply Now")',
    'a:has-text("Apply")',     'button:has-text("Apply")',
    '[class*="apply-now"]', '[id*="apply-now"]',
    '[class*="apply_now"]', '[id*="apply_now"]',
    '[class*="applyNow"]',  '[class*="apply"]:not(div):not(section)',
    'a[href*="apply"]',     'a[href*="#apply"]',
  ];
  for (const sel of applySels) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible({ timeout: 2000 })) {
        await loc.click();
        await page.waitForTimeout(APPLY_EXPAND_WAIT);
        return true;
      }
    } catch (_) {}
  }
  const clicked = await page.evaluate(() => {
    for (const re of [/apply now/i, /apply/i]) {
      for (const el of document.querySelectorAll('a, button, [class*="apply"]')) {
        const txt = (el.textContent || '').trim();
        if (re.test(txt) && el.offsetParent !== null) { el.click(); return true; }
      }
    }
    return false;
  }).catch(() => false);
  if (clicked) await page.waitForTimeout(APPLY_EXPAND_WAIT);
  return clicked;
}

// ─── FILL IFRAME FORM (Collabera apply_newv2) ────────────────────────────────

async function fillIframeForm(workerId, frame) {
  try {
    // Exact field IDs confirmed from probe: txtName, txtEmail, txtPhone, fuResume
    await frame.locator('#txtName').fill(USER_FULL_NAME);
    log(`[${workerId}]    Name filled`);

    await frame.locator('#txtEmail').fill(USER_EMAIL);
    log(`[${workerId}]    Email filled`);

    await frame.locator('#txtPhone').fill(USER_PHONE);
    log(`[${workerId}]    Phone filled`);

    // Resume upload
    if (fs.existsSync(RESUME_PATH)) {
      await frame.locator('#fuResume').setInputFiles(RESUME_PATH);
      log(`[${workerId}]    Resume uploaded`);
      await new Promise(r => setTimeout(r, 1000));
    }

    // Check ToS checkbox (#myCheckbox), skip job alert (#chk_alert)
    const tosBox = frame.locator('#myCheckbox');
    if (!await tosBox.isChecked().catch(() => false)) await tosBox.check().catch(() => {});
    log(`[${workerId}]    ToS checkbox checked`);

    // Submit
    const submitBtn = frame.locator('input[type="submit"], button[type="submit"]').first();
    await submitBtn.click();
    log(`[${workerId}]    Submitted`);

    await new Promise(r => setTimeout(r, POST_SUBMIT_WAIT));

    // Button disappearing = submitted successfully
    const btnGone = !(await submitBtn.isVisible({ timeout: 2000 }).catch(() => false));
    const bodyText = await frame.locator('body').innerText().catch(() => '');
    const confirmed = btnGone ||
      /thank you|application.*received|successfully applied|resume.*received|submitted|confirmation|applied|success|we.ve received|on its way/i.test(bodyText);

    if (confirmed) return 'APPLIED';

    // Retry once — re-click submit if button is still visible
    log(`[${workerId}]    Retrying submit...`);
    const btnStillThere = await submitBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (btnStillThere) {
      await submitBtn.click();
      await new Promise(r => setTimeout(r, POST_SUBMIT_WAIT));
      const btnGone2 = !(await submitBtn.isVisible({ timeout: 2000 }).catch(() => false));
      const body2    = await frame.locator('body').innerText().catch(() => '');
      const ok2      = btnGone2 || /thank you|application.*received|successfully applied|submitted|applied|success/i.test(body2);
      return ok2 ? 'APPLIED' : 'UNCERTAIN';
    }

    return 'UNCERTAIN';

  } catch (e) {
    warn(`[${workerId}] iframe form error: ${e.message}`);
    return 'FAILED';
  }
}

// ─── FILL AND SUBMIT FORM ─────────────────────────────────────────────────────

async function fillAndSubmitForm(page) {
  await page.waitForTimeout(1500);

  // Collabera iframe form uses placeholder text as the main identifier
  await fillField(page, [
    'input[placeholder*="enter your name" i]', 'input[placeholder*="full name" i]',
    'input[placeholder*="your name" i]',        'input[name*="name" i]',
    'input[id*="name" i]',                      'form input[type="text"]:first-of-type',
  ], USER_FULL_NAME, 'Full Name');

  await fillField(page, [
    'input[placeholder*="email" i]', 'input[type="email"]',
    'input[name*="email" i]',        'input[id*="email" i]',
  ], USER_EMAIL, 'Email');

  await fillField(page, [
    'input[placeholder*="phone" i]', 'input[type="tel"]',
    'input[name*="phone" i]',        'input[id*="phone" i]',
    'input[placeholder*="mobile" i]',
  ], USER_PHONE, 'Phone');

  // Resume upload
  if (fs.existsSync(RESUME_PATH)) {
    try {
      const fileInputs = page.locator('input[type="file"]');
      const count = await fileInputs.count();
      if (count > 0) {
        let resumeInput = null;
        for (let i = 0; i < count; i++) {
          const inp = fileInputs.nth(i);
          const ctx = await inp.evaluate(el => {
            const parts = [el.id || '', el.name || '', el.getAttribute('aria-label') || ''];
            let node = el.parentElement;
            for (let n = 0; n < 4 && node; n++, node = node.parentElement) parts.push(node.textContent || '');
            return parts.join(' ').toLowerCase();
          }).catch(() => '');
          if (!/cover/i.test(ctx)) { resumeInput = inp; break; }
        }
        if (!resumeInput) resumeInput = fileInputs.first();
        await resumeInput.setInputFiles(RESUME_PATH);
        await page.waitForTimeout(1500);
      }
    } catch (e) { warn(`Resume upload error: ${e.message}`); }
  }

  // Check visible checkboxes — skip the LAST one (job alert / advertisement)
  try {
    const checkboxes  = page.locator('input[type="checkbox"]');
    const cbCount     = await checkboxes.count();
    const visibleIdxs = [];
    for (let i = 0; i < cbCount; i++) {
      if (await checkboxes.nth(i).isVisible({ timeout: 1000 }).catch(() => false))
        visibleIdxs.push(i);
    }
    for (let k = 0; k < visibleIdxs.length - 1; k++) {
      const cb = checkboxes.nth(visibleIdxs[k]);
      if (!await cb.isChecked().catch(() => false)) await cb.check();
    }
  } catch (_) {}

  // Submit
  const submitSels = [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Submit")', 'button:has-text("Apply")',
    'button:has-text("Send")',   'button:has-text("Upload")',
    '[class*="submit"]', '[id*="submit"]',
  ];
  let submitted = false;
  for (const sel of submitSels) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible({ timeout: 2000 })) {
        await loc.click();
        submitted = true;
        break;
      }
    } catch (_) {}
  }
  if (!submitted) {
    submitted = await page.evaluate(() => {
      for (const re of [/submit/i, /apply/i, /send/i, /upload/i]) {
        for (const el of document.querySelectorAll('button, input[type="submit"], input[type="button"]')) {
          const txt = (el.textContent || el.value || '').trim();
          if (re.test(txt) && el.offsetParent !== null) { el.click(); return true; }
        }
      }
      return false;
    }).catch(() => false);
  }
  if (!submitted) return 'NO_SUBMIT';

  await page.waitForTimeout(POST_SUBMIT_WAIT);
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  const confirmed = /thank you|application.*received|successfully applied|resume.*received|application.*submitted|we.*received|on its way|confirmation/i.test(bodyText);
  return confirmed ? 'APPLIED' : 'UNCERTAIN';
}

// ─── APPLY TO ONE JOB ─────────────────────────────────────────────────────────

async function applyToJob(workerId, context, job) {
  log(`[${workerId}] → ${job.title || job.id}`);
  const jobPage = await context.newPage();
  try {
    log(`[${workerId}]    Loading job page...`);
    await jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    // Wait for the apply iframe to appear (injected by JS — page is fully rendered by then)
    log(`[${workerId}]    Waiting for apply iframe...`);
    try {
      await jobPage.waitForSelector('iframe[src*="apply_newv2"]', { timeout: 15000 });
    } catch (_) {
      warn(`[${workerId}] Apply iframe did not appear for ${job.id}`);
      await jobPage.close().catch(() => {});
      return 'FAILED';
    }

    // Extract title now — page is JS-rendered since iframe is visible
    const titleText = await jobPage.evaluate(() => {
      const m = document.body.innerText.match(/^Title:\s*(.+)$/m);
      if (m && m[1].trim().length > 3) return m[1].trim();
      return document.title.replace(/\s*[-|]\s*(?:collabera|job desc).*/i, '').trim();
    }).catch(() => '');
    if (titleText.length > 3) job.title = titleText;
    log(`[${workerId}]    Title: "${job.title}"`);
    if (job.title && !TITLE_ALLOW_RE.test(job.title)) {
      log(`[${workerId}]    Skipped — title not relevant`);
      await jobPage.close().catch(() => {});
      return 'SKIPPED_TITLE';
    }

    // Date check
    const detailDate = await jobPage.evaluate(() => {
      const m = document.body.innerText.match(/(\d+\s+(?:hour|minute|day|week|month)s?\s+ago|today|yesterday|just now|[A-Za-z]+ \d{1,2},?\s*\d{4})/i);
      return m ? m[0] : '';
    }).catch(() => '');
    if (detailDate && !isWithin1Day(detailDate)) {
      log(`[${workerId}]    Skipped — too old (${detailDate})`);
      await jobPage.close().catch(() => {});
      return 'SKIPPED_OLD';
    }

    const frameLocator = jobPage.frameLocator('iframe[src*="apply_newv2"]').first();
    try {
      await frameLocator.locator('input').first().waitFor({ timeout: 15000 });
      log(`[${workerId}]    Iframe loaded`);
    } catch (_) {
      warn(`[${workerId}] Iframe inputs not ready for ${job.id}`);
      await jobPage.close().catch(() => {});
      return 'FAILED';
    }

    const result = await fillIframeForm(workerId, frameLocator);
    await jobPage.close().catch(() => {});
    return result;

  } catch (e) {
    warn(`[${workerId}] Exception: ${e.message}`);
    await jobPage.close().catch(() => {});
    return 'FAILED';
  }
}

// ─── SCAN ALL KEYWORDS ────────────────────────────────────────────────────────

async function scanAllJobs(context, appliedIds) {
  const scanPage = await context.newPage();
  const seen     = new Map();

  for (const query of SEARCH_QUERIES) {
    if (_shouldStop) break;
    const keyword = query.replace(/\+/g, ' ');
    log(`Scanning: "${keyword}"`);

    try {
      await scanPage.goto(buildSearchUrl(query), { waitUntil: 'networkidle', timeout: 45000 });
      await scanPage.waitForTimeout(2000);

      const jobs = await extractJobsFromPage(scanPage);
      log(`   Found ${jobs.length} job(s)`);
      jobs.forEach(j => log(`   [title] "${j.title}" | posted: "${j.posted}"`));

      for (const job of jobs) {
        if (seen.has(job.id) || appliedIds.has(job.id)) continue;
        if (job.title && !TITLE_ALLOW_RE.test(job.title)) { log(`   [-] Filtered: "${job.title}"`); stats.skipped++; continue; }
        if (!isWithin1Day(job.posted)) { log(`   [-] Too old: "${job.title}" (${job.posted})`); stats.skipped++; continue; }
        seen.set(job.id, job);
      }
    } catch (e) {
      warn(`Scan error for "${keyword}": ${e.message}`);
    }
  }

  await scanPage.close().catch(() => {});
  return [...seen.values()];
}

// ─── WORKER ───────────────────────────────────────────────────────────────────

async function runWorker(workerId, context, queue, appliedIds, startDelay) {
  if (startDelay) await new Promise(r => setTimeout(r, startDelay));

  while (!_shouldStop) {
    const job = queue.shift();
    if (!job) break;

    if (appliedIds.has(job.id)) continue;

    const result = await applyToJob(workerId, context, job);
    if (result !== 'SKIPPED_TITLE' && result !== 'SKIPPED_OLD') writeApplied(job, result);

    if (result === 'APPLIED') {
      stats.applied++;
      appliedIds.add(job.id);
      saveAppliedId(job.id);
      log(`[${workerId}] ✅ Applied — ${job.title}`);
    } else if (result === 'UNCERTAIN') {
      stats.uncertain++;
      log(`[${workerId}] ❓ Uncertain — ${job.title}`);
    } else if (result === 'SKIPPED_OLD' || result === 'SKIPPED_TITLE') {
      stats.skipped++;
    } else {
      stats.failed++;
      log(`[${workerId}] ❌ Failed — ${job.title}`);
    }

    if (queue.length > 0 && !_shouldStop) await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function runBot(durationMinutes) {
  const endTime = durationMinutes ? Date.now() + durationMinutes * 60000 : Infinity;

  console.log('\n' + '='.repeat(60));
  console.log('Collabera Bot');
  console.log(`User   : ${USER_FULL_NAME} <${USER_EMAIL}>`);
  console.log(`Resume : ${RESUME_PATH}`);
  console.log(`Duration: ${durationMinutes ? durationMinutes + ' min' : 'unlimited'}`);
  console.log('='.repeat(60) + '\n');

  if (!fs.existsSync(RESUME_PATH)) {
    warn(`Resume not found: ${RESUME_PATH}`);
    process.exit(1);
  }

  const appliedIds = loadAppliedIds();
  log(`Loaded ${appliedIds.size} previously applied job(s)`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  const context = await browser.newContext({
    viewport: null,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  try {
    while (!_shouldStop && Date.now() < endTime) {
      const queue = await scanAllJobs(context, appliedIds);
      log(`\n${queue.length} new job(s) to apply`);

      if (queue.length === 0) {
        log('No new jobs found. Exiting.');
        break;
      }

      await Promise.all(
        Array.from({ length: Math.min(NUM_WORKERS, queue.length) }, (_, i) =>
          runWorker(`W${i + 1}`, context, queue, appliedIds, i * 2000)
        )
      );

      log(`\nDone. Applied: ${stats.applied} | Uncertain: ${stats.uncertain} | Failed: ${stats.failed} | Skipped: ${stats.skipped}`);
      log('Queue exhausted. Exiting.');
      break;
    }
  } catch (e) {
    warn(`Fatal: ${e.stack || e.message}`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  log('Finished.');
  process.exit(0);
}

// ─── FORM TEST MODE ───────────────────────────────────────────────────────────

async function formTestMode(applyUrl) {
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled', '--start-maximized'] });
  const context = await browser.newContext({ viewport: null });
  const page    = await context.newPage();
  await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
    page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  );
  await page.waitForTimeout(3000);
  await clickApplyAndExpandForm(page);
  const result = await fillAndSubmitForm(page);
  log(`Form result: ${result}`);
  await new Promise(r => setTimeout(r, 10000));
  await context.close();
  await browser.close();
}

// ─── PROBE MODE ───────────────────────────────────────────────────────────────

async function probeMode(jobUrl) {
  console.log(`\n[probe] URL: ${jobUrl}`);
  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled', '--start-maximized'] });
  const context = await browser.newContext({ viewport: null });
  const page    = await context.newPage();

  await page.goto(jobUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
    page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  );
  await page.waitForTimeout(3000);

  // Print page title and all buttons/links
  const title = await page.title();
  console.log(`[probe] Page title: ${title}`);

  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'))
      .filter(el => el.offsetParent !== null)
      .map(el => ({ tag: el.tagName, text: (el.textContent || el.value || '').trim().slice(0, 60), href: el.getAttribute('href') || '', class: el.className.slice(0, 60) }))
      .filter(el => el.text)
  );
  console.log('\n[probe] Visible buttons/links:');
  buttons.forEach(b => console.log(`   <${b.tag}> "${b.text}" href="${b.href}" class="${b.class}"`));

  console.log('\n[probe] Press ENTER to click Apply and inspect form...');
  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();

  const newTabPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  await clickApplyAndExpandForm(page);
  const newTab = await newTabPromise;
  const activePage = newTab || page;
  if (newTab) { await newTab.waitForLoadState('domcontentloaded').catch(() => {}); await newTab.waitForTimeout(2000); }

  await activePage.waitForTimeout(2000);
  console.log(`\n[probe] Active page URL: ${activePage.url()}`);

  const fields = await activePage.evaluate(() =>
    Array.from(document.querySelectorAll('input, textarea, select'))
      .filter(el => el.offsetParent !== null)
      .map(el => {
        const labelEl = el.id && document.querySelector(`label[for="${el.id}"]`);
        return { tag: el.tagName, type: el.type || '', name: el.name || '', id: el.id || '', placeholder: el.placeholder || '', label: labelEl ? labelEl.textContent.trim() : '' };
      })
  ).catch(() => []);

  console.log('\n[probe] Visible form fields after Apply click:');
  fields.forEach(f => console.log(`   <${f.tag} type="${f.type}" name="${f.name}" id="${f.id}" placeholder="${f.placeholder}"> label="${f.label}"`));

  const iframes = await activePage.evaluate(() =>
    Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id, name: f.name }))
  ).catch(() => []);
  if (iframes.length) { console.log('\n[probe] Iframes found:'); iframes.forEach(f => console.log(`   ${JSON.stringify(f)}`)); }

  console.log('\n[probe] Browser left open. Close manually when done.');
  await new Promise(() => {}); // keep open
}

// ─── TEST1 MODE — single job, full verbose apply ──────────────────────────────

async function test1Mode(jobUrl) {
  const postMatch = jobUrl.match(/post=(\d+)/);
  if (!postMatch) { console.error('URL must contain ?post=ID'); process.exit(1); }
  const id = postMatch[1];

  console.log(`\n[test1] Job URL : ${jobUrl}`);
  console.log(`[test1] Post ID  : ${id}`);
  console.log(`[test1] Resume   : ${RESUME_PATH}\n`);

  const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled', '--start-maximized'] });
  const context = await browser.newContext({ viewport: null });
  const page    = await context.newPage();

  // ── Step 1: Load the job detail page ──
  console.log('[test1] Step 1 — Loading job detail page (networkidle)...');
  await page.goto(jobUrl, { waitUntil: 'networkidle', timeout: 45000 }).catch(() =>
    page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT })
  );
  await page.waitForTimeout(3000);
  console.log(`[test1]   Landed: ${page.url()}`);

  // ── Step 2: Extract title ──
  const titleText = await page.evaluate(() => {
    for (const sel of ['h1', 'h2', '.job-title', '.entry-title', '[class*="job-title"]', '[class*="position"]', 'h3']) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 3) return el.textContent.trim();
    }
    return document.title.replace(/[-|].*$/, '').trim();
  }).catch(() => '');
  console.log(`[test1] Step 2 — Title: "${titleText}"`);
  console.log(`[test1]   Title filter: ${TITLE_ALLOW_RE.test(titleText) ? 'PASS' : 'FAIL (would skip)'}`);

  // ── Step 3: Find iframe ──
  console.log('[test1] Step 3 — Looking for apply iframe...');
  const iframes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id }))
  ).catch(() => []);
  console.log(`[test1]   Iframes on page: ${JSON.stringify(iframes)}`);

  const iframeEl = await page.waitForSelector('iframe[src*="apply_newv2"]', { timeout: 10000 }).catch(() => null);
  if (!iframeEl) {
    console.log('[test1]   ❌ apply_newv2 iframe NOT found — cannot proceed');
    console.log('\n[test1] Browser left open for manual inspection. Ctrl+C to exit.');
    await new Promise(() => {});
  }
  console.log('[test1]   ✅ apply_newv2 iframe found');

  // ── Step 4: Inspect iframe fields ──
  console.log('[test1] Step 4 — Inspecting iframe fields...');
  const frame = page.frameLocator('iframe[src*="apply_newv2"]').first();
  await frame.locator('input').first().waitFor({ timeout: 15000 }).catch(() => {});

  // Inspect fields via the underlying frame object
  const frameObj = page.frames().find(f => f.url().includes('apply_newv2'));
  if (frameObj) {
    const fields = await frameObj.evaluate(() =>
      Array.from(document.querySelectorAll('input, textarea, select')).map(el => {
        const lbl = el.id && document.querySelector(`label[for="${el.id}"]`);
        return { tag: el.tagName, type: el.type || '', name: el.name || '', id: el.id || '', placeholder: el.placeholder || '', label: lbl ? lbl.textContent.trim() : '' };
      })
    ).catch(() => []);
    fields.forEach(f => console.log(`[test1]   <${f.tag} type="${f.type}" name="${f.name}" id="${f.id}" placeholder="${f.placeholder}"> label="${f.label}"`));
  } else {
    console.log('[test1]   (frame object not found — iframe may be cross-origin)');
  }

  console.log('\n[test1] Press ENTER to fill and submit the form (or Ctrl+C to abort)...');
  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  process.stdin.pause();

  // ── Step 5: Fill and submit ──
  console.log('[test1] Step 5 — Filling form...');
  const result = await fillIframeForm('T1', frame);
  console.log(`\n[test1] Result: ${result}`);

  console.log('\n[test1] Browser left open for review. Ctrl+C to exit.');
  await new Promise(() => {});
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

const arg = process.argv[2];
if (arg === 'test1') {
  const url = process.argv[3];
  if (!url) { console.error('Usage: node collabera-bot.js test1 <job-url>'); process.exit(1); }
  test1Mode(url).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'probe') {
  const url = process.argv[3] || 'https://collabera.com/job-description/?post=369103';
  probeMode(url).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'formtest') {
  const url = process.argv[3];
  if (!url) { console.error('Usage: node collabera-bot.js formtest <url>'); process.exit(1); }
  formTestMode(url).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else {
  const minutes = arg ? parseInt(arg) : null;
  if (arg && isNaN(minutes)) { console.error(`Unknown argument: ${arg}`); process.exit(1); }
  runBot(minutes).catch(e => { console.error(e.stack || e.message); process.exit(1); });
}
