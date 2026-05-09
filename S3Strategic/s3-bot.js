#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const HOME_DIR      = process.env.HOME || process.env.USERPROFILE || '';
const APPLIED_IDS   = path.join(__dirname, 'applied_ids.txt');
const APPLIED_FILE  = path.join(__dirname, 'applied_jobs.txt');
const FAILED_FILE   = path.join(__dirname, 'failed_jobs.txt');
const SCANNED_FILE  = path.join(__dirname, 'scanned_jobs.txt');

const USER_FIRST_NAME = 'Nikhil';
const USER_LAST_NAME  = 'Premachandra Rao';
const USER_EMAIL      = 'npraou@gmail.com';
const RESUME_PATH     = (() => {
  const candidates = [
    path.join(__dirname, 'resume.pdf'),
    path.join(__dirname, 'Nikhil_Resume.pdf'),
    path.join(__dirname, '..', 'Nikhil_Resume.pdf'),
    path.join(HOME_DIR, 'Desktop', 'Jobs', 'Nikhil_Resume.pdf'),
  ];
  return candidates.find(p => { try { return fs.existsSync(p); } catch(_){} }) || candidates[0];
})();
const COVER_LETTER_PATH = path.join(__dirname, '..', 'Nikhil_Rao_Cover_Letter.pdf');

const SCAN_URLS = [
  'https://careers.strategicstaff.com/',
  'https://careers.strategicstaff.com/jobs/',
];
const NUM_WORKERS    = 2;
const PAGE_TIMEOUT   = 30000;
const POST_SUBMIT_WAIT = 6000;
const RATE_LIMIT_MS  = 6000;

const TITLE_ALLOW_RE = /data\s*scientist|machine\s*learning|ml\s+engineer|data\s+engineer|data\s+analyst|ai\s+engineer|nlp|mlops|analytics\s+engineer|applied\s+scientist/i;

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

function log(msg)  { console.log(`[s3] ${msg}`); }
function warn(msg) { console.warn(`[s3] WARN: ${msg}`); }

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

function writeResult(job, result) {
  ensureDir(APPLIED_FILE);
  const ts   = new Date().toLocaleString('en-US', { hour12: false });
  const line = `[${ts}] ${result.padEnd(9)} — ${job.title}\n  ID: ${job.id} | ${job.url}\n  Posted: ${job.posted || 'unknown'}\n\n`;
  fs.appendFileSync(result === 'APPLIED' ? APPLIED_FILE : FAILED_FILE, line);
}

// ─── DATE FILTER ──────────────────────────────────────────────────────────────

function isWithin1Day(postedText) {
  if (!postedText) return true;
  const t = postedText.toLowerCase().trim();
  if (/just now|today|hour|minute/.test(t)) return true;
  if (/1 day|yesterday/.test(t)) return true;
  if (/\b[2-9] days?\b|\b[1-9]\d+ days?\b|week|month|year/.test(t)) return false;
  const m = postedText.match(/([A-Za-z]+ \d{1,2},?\s*\d{4})/);
  if (m) {
    const parsed = new Date(m[1]);
    if (!isNaN(parsed.getTime())) return (Date.now() - parsed.getTime()) / 86400000 <= 1;
  }
  return true;
}

// ─── EXTRACT JOBS FROM PAGE DOM ──────────────────────────────────────────────

function extractJobsFromDOM(page) {
  return page.evaluate(() => {
    const results = [];
    const seen    = new Set();
    const links   = Array.from(document.querySelectorAll('a[href*="/jobs/"]'));
    for (const a of links) {
      const href = (a.href || '').split('?')[0].replace(/\/$/, '') + '/';
      if (!/\/jobs\/[a-z0-9][a-z0-9-]+-\d{4,}\//.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      const idMatch = href.match(/-(\d{4,})\/$/) || href.match(/(\d{4,})\/?$/);
      const id      = idMatch ? idMatch[1] : href;

      const card = a.closest('.job-listing, .job-card, article, li, [class*="job"], [class*="listing"], [class*="result"]');
      let title = '';
      if (card) {
        const heading = card.querySelector('h2, h3, h1, .job-title, [class*="title"]');
        title = heading ? heading.textContent.trim() : a.textContent.trim();
      } else {
        title = a.textContent.trim();
      }

      let posted = '';
      if (card) {
        const dateEl = card.querySelector('time, .date, [class*="date"], [class*="posted"], [class*="published"]');
        if (dateEl) posted = dateEl.getAttribute('datetime') || dateEl.textContent.trim();
        if (!posted) {
          const dm = (card.innerText || '').match(/([A-Za-z]+ \d{1,2},?\s*\d{4}|\d+\s+(?:hour|minute|day|week|month)s?\s+ago|today|just now|yesterday)/i);
          if (dm) posted = dm[0];
        }
      }

      let location = '';
      if (card) {
        const locEl = card.querySelector('.location, [class*="location"], [class*="city"]');
        if (locEl) location = locEl.textContent.trim();
      }

      results.push({ id, title, url: href, posted, location });
    }
    return results;
  });
}

// ─── SCRAPE JOB LISTINGS ─────────────────────────────────────────────────────

async function scrapeJobListings(page) {
  const allSeen = new Map();

  for (const scanUrl of SCAN_URLS) {
    log(`Scanning ${scanUrl}`);
    await page.goto(scanUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await page.waitForTimeout(2500);

    // Click "Load More" up to 4 times
    for (let i = 0; i < 4; i++) {
      const loadMoreClicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, a')).find(el =>
          /load more|show more|view more/i.test((el.textContent || '').trim()) && el.offsetParent !== null
        );
        if (btn) { btn.click(); return true; }
        return false;
      }).catch(() => false);

      if (!loadMoreClicked) break;
      log(`   Clicked Load More (${i + 1}/4)`);
      await page.waitForTimeout(2000);
    }

    const jobs = await extractJobsFromDOM(page);
    log(`   Found ${jobs.length} listing(s) on ${scanUrl}`);
    jobs.forEach(j => { if (!allSeen.has(j.id)) allSeen.set(j.id, j); });
  }

  const total = [...allSeen.values()];
  log(`Total unique listings: ${total.length}`);
  return total;
}

// ─── FILL FIELD ───────────────────────────────────────────────────────────────

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
  warn(`Could not fill "${label}"`);
  return false;
}

// ─── APPLY TO ONE JOB ─────────────────────────────────────────────────────────

async function applyToJob(workerId, context, job) {
  log(`[${workerId}] → ${job.title || job.id}`);
  const jobPage = await context.newPage();
  try {
    await jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await jobPage.waitForTimeout(2000);

    // Extract real title from h1
    const realTitle = await jobPage.evaluate(() => {
      const h1 = document.querySelector('h1');
      return h1 && h1.textContent.trim().length > 3 ? h1.textContent.trim() : '';
    }).catch(() => '');
    if (realTitle.length > 3) job.title = realTitle;
    log(`[${workerId}]    Title: "${job.title}"`);

    if (job.title && !TITLE_ALLOW_RE.test(job.title)) {
      log(`[${workerId}]    Skipped — title not relevant`);
      await jobPage.close().catch(() => {});
      return 'SKIPPED_TITLE';
    }

    if (job.posted && !isWithin1Day(job.posted)) {
      log(`[${workerId}]    Skipped — too old (${job.posted})`);
      await jobPage.close().catch(() => {});
      return 'SKIPPED_OLD';
    }

    // Wait for form to appear
    const formReady = await jobPage.waitForSelector(
      'input[type="text"], input[type="email"], input[name*="name" i]',
      { timeout: 10000, state: 'visible' }
    ).then(() => true).catch(() => false);

    if (!formReady) {
      // Try clicking an Apply button to reveal the form
      const applyClicked = await jobPage.evaluate(() => {
        for (const re of [/apply now/i, /apply/i]) {
          for (const el of document.querySelectorAll('a, button')) {
            if (re.test((el.textContent || '').trim()) && el.offsetParent !== null) {
              el.click(); return true;
            }
          }
        }
        return false;
      }).catch(() => false);
      if (applyClicked) await jobPage.waitForTimeout(2500);
    }

    // Fill by label text — finds the <label> whose text matches, then fills its associated input
    await jobPage.evaluate(({ firstName, lastName, email }) => {
      function fillByLabel(labelRe, value) {
        for (const label of document.querySelectorAll('label')) {
          if (!labelRe.test(label.textContent.trim())) continue;
          const input = label.htmlFor
            ? document.getElementById(label.htmlFor)
            : label.querySelector('input, textarea');
          if (input && input.type !== 'file' && input.type !== 'checkbox' && input.type !== 'radio') {
            input.focus(); input.value = value;
            input.dispatchEvent(new Event('input',  { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }

      // Try label-based fill
      const filledFirst = fillByLabel(/^first\s*name/i, firstName);
      const filledLast  = fillByLabel(/^last\s*name/i,  lastName);
      const filledEmail = fillByLabel(/^email/i,         email);

      // Positional fallback: fill visible text inputs in order (first, last)
      if (!filledFirst || !filledLast) {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
          .filter(el => el.offsetParent !== null);
        if (!filledFirst && inputs[0]) {
          inputs[0].focus(); inputs[0].value = firstName;
          inputs[0].dispatchEvent(new Event('input',  { bubbles: true }));
          inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (!filledLast && inputs[1]) {
          inputs[1].focus(); inputs[1].value = lastName;
          inputs[1].dispatchEvent(new Event('input',  { bubbles: true }));
          inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      // Email fallback
      if (!filledEmail) {
        const emailEl = document.querySelector('input[type="email"], input[name*="email" i], input[id*="email" i]');
        if (emailEl) {
          emailEl.focus(); emailEl.value = email;
          emailEl.dispatchEvent(new Event('input',  { bubbles: true }));
          emailEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }, { firstName: USER_FIRST_NAME, lastName: USER_LAST_NAME, email: USER_EMAIL });

    log(`[${workerId}]    Name + email filled`);

    // Resume upload
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
              for (let n = 0; n < 4 && node; n++, node = node.parentElement) parts.push(node.textContent || '');
              return parts.join(' ').toLowerCase();
            }).catch(() => '');
            if (/cover/i.test(ctx)) coverInput = coverInput || inp;
            else resumeInput = resumeInput || inp;
          }
          if (!resumeInput) resumeInput = fileInputs.first();
          await resumeInput.setInputFiles(RESUME_PATH);
          log(`[${workerId}]    Resume uploaded`);
          if (coverInput && fs.existsSync(COVER_LETTER_PATH)) {
            await coverInput.setInputFiles(COVER_LETTER_PATH);
            log(`[${workerId}]    Cover letter uploaded`);
          }
          await jobPage.waitForTimeout(1000);
        }
      } catch (e) { warn(`[${workerId}] Resume upload error: ${e.message}`); }
    }

    // Submit
    const submitSels = [
      'button:has-text("Apply for this Role")', 'a:has-text("Apply for this Role")',
      'input[type="submit"]', 'button[type="submit"]',
      'button:has-text("Submit")', 'button:has-text("Apply")',
      '.gform_button', '#gform_submit_button_1',
      'input[value*="Submit" i]', 'input[value*="Apply" i]',
    ];
    let submitted = false;
    for (const sel of submitSels) {
      try {
        const loc = jobPage.locator(sel).first();
        if (await loc.count() > 0 && await loc.isVisible({ timeout: 2000 })) {
          await loc.click();
          submitted = true;
          break;
        }
      } catch (_) {}
    }
    if (!submitted) {
      submitted = await jobPage.evaluate(() => {
        for (const el of document.querySelectorAll('button, a, input[type="submit"]')) {
          if (/apply for this role|submit|apply/i.test((el.textContent || el.value || '').trim()) && el.offsetParent !== null) {
            el.click(); return true;
          }
        }
        return false;
      }).catch(() => false);
    }
    if (!submitted) {
      await jobPage.close().catch(() => {});
      return 'FAILED';
    }

    await jobPage.waitForTimeout(POST_SUBMIT_WAIT);
    const bodyText = await jobPage.evaluate(() => document.body.innerText).catch(() => '');
    const confirmed = /thank you|application.*received|successfully applied|application.*submitted|we.*received/i.test(bodyText);
    const hasError  = /error|required field|invalid|please fill/i.test(bodyText);

    await jobPage.close().catch(() => {});
    return confirmed ? 'APPLIED' : (hasError ? 'FAILED' : 'UNCERTAIN');

  } catch (e) {
    warn(`[${workerId}] Exception: ${e.message}`);
    await jobPage.close().catch(() => {});
    return 'FAILED';
  }
}

// ─── WORKER ───────────────────────────────────────────────────────────────────

async function runWorker(workerId, context, queue, appliedIds, startDelay) {
  if (startDelay) await new Promise(r => setTimeout(r, startDelay));

  while (!_shouldStop) {
    const job = queue.shift();
    if (!job) break;
    if (appliedIds.has(job.id)) continue;

    const result = await applyToJob(workerId, context, job);

    if (result !== 'SKIPPED_TITLE' && result !== 'SKIPPED_OLD') writeResult(job, result);

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
  console.log('S3 Strategic Bot');
  console.log(`User   : ${USER_FIRST_NAME} ${USER_LAST_NAME} <${USER_EMAIL}>`);
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
      const scanPage = await context.newPage();
      const allJobs  = await scrapeJobListings(scanPage);
      await scanPage.close().catch(() => {});

      const queue = allJobs.filter(j => {
        if (appliedIds.has(j.id)) return false;
        if (j.title && !TITLE_ALLOW_RE.test(j.title)) { log(`[-] Filtered: "${j.title}"`); stats.skipped++; return false; }
        if (!isWithin1Day(j.posted)) { log(`[-] Too old: "${j.title}" (${j.posted})`); stats.skipped++; return false; }
        return true;
      });

      log(`\n${queue.length} new job(s) to apply`);
      if (queue.length === 0) {
        log('No new jobs. Exiting.');
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

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

const arg     = process.argv[2];
const minutes = arg ? parseInt(arg) : null;
if (arg && isNaN(minutes)) { console.error(`Unknown argument: ${arg}`); process.exit(1); }
runBot(minutes).catch(e => { console.error(e.stack || e.message); process.exit(1); });
