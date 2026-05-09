#!/usr/bin/env node
/**
 * S3 Strategic Staffing Job Application Bot — DRY RUN (1 job, browser stays open)
 *
 * ATS: careers.strategicstaff.com (WordPress + custom form)
 * No login required — guest apply works.
 * Discovery: scrape careers.strategicstaff.com/jobs/ listing page
 *
 * RUN:  node s3-bot.js
 *
 * DRY RUN mode:
 *   - Applies to exactly ONE matching DS/ML/AI job posted within 1 day
 *   - Does NOT fall back to non-matching titles — exits if none found
 *   - Does NOT close the browser — prints a prompt and waits for ENTER
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const readline = require('readline');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const USER_FIRST_NAME  = 'Nikhil';
const USER_LAST_NAME   = 'Premachandra rao';
const USER_EMAIL       = 'Npraou@gmail.com';
const RESUME_PATH      = (() => {
  const candidates = [
    path.join(__dirname, 'resume.pdf'),
    path.join(__dirname, 'Nikhil_Resume.pdf'),
    path.join(__dirname, '..', 'resume.pdf'),
    path.join(__dirname, '..', 'Nikhil_Resume.pdf'),
    path.join(process.env.HOME || '', 'Desktop', 'Jobs', 'Nikhil_Resume.pdf'),
  ];
  return candidates.find(p => { try { return require('fs').existsSync(p); } catch(_){} }) || candidates[0];
})();
const COVER_LETTER_PATH = path.join(__dirname, '..', 'Nikhil_Rao_Cover_Letter.pdf');

const JOBS_LIST_URL  = 'https://careers.strategicstaff.com/jobs/';
const PAGE_TIMEOUT   = 30000;
const CONFIRM_WAIT   = 8000;   // ms to wait after submit before checking confirmation

// Title keywords that qualify as matching roles (case-insensitive substring match)
const TITLE_KEYWORDS = [
  'data scientist',
  'machine learning',
  'ml engineer',
  'data engineer',
  'data analyst',
  'ai engineer',
  'nlp',
  'mlops',
  'analytics engineer',
];

// ─── SHARED STATE ─────────────────────────────────────────────────────────────

let _shouldStop = false;
let MAX_JOBS = Infinity;

const stats = { applied: 0, failed: 0, uncertain: 0 };

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function isMatchingTitle(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return TITLE_KEYWORDS.some(kw => t.includes(kw));
}

/**
 * Parse posted-date text — return true if within 1 day.
 * careers.strategicstaff.com shows dates like "April 20, 2026".
 */
function isWithin1Day(postedText) {
  if (!postedText) return true; // unknown — let through
  const t = postedText.toLowerCase().trim();
  // Relative dates
  if (t.includes('just now') || t.includes('today') || t.includes('hour') || t.includes('minute')) return true;
  if (t.includes('1 day') || t.includes('yesterday')) return true;
  if (t.includes('2 days') || /\b[3-9] days?\b/.test(t)) return false;
  if (/\b[1-9]\d+ days?\b/.test(t)) return false;
  if (t.includes('week') || t.includes('month') || t.includes('year')) return false;
  // Absolute date: "April 20, 2026"
  const m = postedText.match(/([A-Za-z]+ \d{1,2},?\s*\d{4})/);
  if (m) {
    const parsed = new Date(m[1]);
    if (!isNaN(parsed.getTime())) {
      const diffDays = (Date.now() - parsed.getTime()) / 86400000;
      return diffDays <= 1;
    }
  }
  return true; // can't parse — let through
}

/**
 * Attempt to fill a field using a list of selectors.
 * Tries Playwright locator first, then JS fallback.
 * Returns the selector that worked, or null.
 */
async function fillField(page, selectors, value, label) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible({ timeout: 2000 })) {
        await loc.click();
        await loc.fill('');
        await loc.type(value, { delay: 40 });
        console.log(`   [form] ${label} filled via selector: ${sel}`);
        return sel;
      }
    } catch (e) {
      // try next selector
    }
  }

  // JS fallback — set value directly
  const filled = await page.evaluate(({ selectors, value }) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur',   { bubbles: true }));
        return sel;
      }
    }
    return null;
  }, { selectors, value }).catch(() => null);

  if (filled) {
    console.log(`   [form] ${label} filled via JS fallback (${filled})`);
    return filled;
  }

  console.warn(`   [!] Could not fill "${label}" — no matching field found`);
  return null;
}

/**
 * Log all visible form inputs for debugging.
 */
async function debugLogInputs(page, label) {
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, textarea, select')).map(el => {
      const rect = el.getBoundingClientRect();
      return {
        tag:         el.tagName.toLowerCase(),
        type:        el.type || '',
        name:        el.name || '',
        id:          el.id || '',
        placeholder: el.placeholder || '',
        ariaLabel:   el.getAttribute('aria-label') || '',
        value:       el.type === 'password' ? '***' : (el.value || ''),
        visible:     el.offsetParent !== null && rect.width > 0 && rect.height > 0,
        className:   (el.className || '').substring(0, 60),
      };
    });
  }).catch(() => []);

  const visible = inputs.filter(i => i.visible);
  const hidden  = inputs.filter(i => !i.visible);

  console.log(`\n   [debug] ${label} — ${visible.length} visible / ${hidden.length} hidden inputs:`);
  visible.forEach((i, idx) =>
    console.log(`     [${idx}] <${i.tag} type="${i.type}" name="${i.name}" id="${i.id}" placeholder="${i.placeholder}" aria-label="${i.ariaLabel}" value="${i.value}" class="${i.className}">`));
  if (hidden.length > 0) {
    console.log(`   [debug] Hidden inputs (not shown to user):`);
    hidden.forEach(i =>
      console.log(`     <${i.tag} type="${i.type}" name="${i.name}" id="${i.id}" value="${i.value}">`));
  }

  return visible;
}

// ─── SCRAPE JOB LISTINGS ─────────────────────────────────────────────────────

async function scrapeJobListings(page) {
  console.log(`\n[S] Fetching job listings from ${JOBS_LIST_URL}`);
  await page.goto(JOBS_LIST_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  await page.waitForTimeout(2500);

  const jobs = await page.evaluate(() => {
    const results = [];
    const seen    = new Set();

    // Find all <a> tags linking to /jobs/slug/ pattern
    const links = Array.from(document.querySelectorAll('a[href*="/jobs/"]'));

    for (const a of links) {
      const href = (a.href || '').split('?')[0].replace(/\/$/, '') + '/';
      // Must match /jobs/[slug]/ where slug contains a dash-number at end
      if (!/\/jobs\/[a-z0-9][a-z0-9-]+-\d{4,}\//.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);

      // Extract numeric job ID from slug (last numeric segment)
      const idMatch = href.match(/-(\d{4,})\/$/) || href.match(/(\d{4,})\/?$/);
      const id      = idMatch ? idMatch[1] : href;

      // Title: look in parent card container
      let title = '';
      const card = a.closest(
        '.job-listing, .job-card, article, li, [class*="job"], [class*="listing"], [class*="result"]'
      );
      if (card) {
        const heading = card.querySelector('h2, h3, h1, .job-title, [class*="title"]');
        title = heading ? heading.textContent.trim() : a.textContent.trim();
      } else {
        title = a.textContent.trim();
      }

      // Posted date
      let posted = '';
      if (card) {
        const dateEl = card.querySelector(
          'time, .date, [class*="date"], [class*="posted"], [class*="published"]'
        );
        if (dateEl) {
          posted = dateEl.getAttribute('datetime') || dateEl.textContent.trim();
        }
        // Regex fallback on card text
        if (!posted) {
          const cardText = card.innerText || '';
          const dm = cardText.match(
            /([A-Za-z]+ \d{1,2},?\s*\d{4}|\d+\s+(?:hour|minute|day|week|month)s?\s+ago|today|just now|yesterday)/i
          );
          if (dm) posted = dm[0];
        }
      }

      // Location
      let location = '';
      if (card) {
        const locEl = card.querySelector(
          '.location, [class*="location"], [class*="city"], [class*="place"]'
        );
        if (locEl) location = locEl.textContent.trim();
      }

      results.push({ id, title, url: href, posted, location });
    }

    return results;
  });

  console.log(`   Found ${jobs.length} job listings`);
  if (jobs.length > 0) {
    jobs.slice(0, 10).forEach((j, i) =>
      console.log(`   ${i + 1}. [${j.posted || 'no date'}] ${j.title} — ${j.location || 'no loc'}`));
    if (jobs.length > 10) console.log(`   ... and ${jobs.length - 10} more`);
  }

  return jobs;
}

// ─── SELECT TARGET JOB ───────────────────────────────────────────────────────

function selectTargetJob(jobs) {
  // Only matching DS/ML/AI/etc titles within 1 day — NO fallback
  const matching = jobs.filter(j => isMatchingTitle(j.title) && isWithin1Day(j.posted));

  if (matching.length > 0) {
    console.log(`\n[>] Found ${matching.length} matching DS/ML/AI/etc job(s) within 1 day:`);
    matching.forEach((j, i) => console.log(`    ${i + 1}. ${j.title} [${j.posted}]`));
    return matching[0];
  }

  // Check if there are matching titles but outside 1 day
  const matchingOld = jobs.filter(j => isMatchingTitle(j.title) && !isWithin1Day(j.posted));
  if (matchingOld.length > 0) {
    console.log(`\n[!] Found ${matchingOld.length} matching title(s) but they are older than 1 day:`);
    matchingOld.forEach(j => console.log(`    - ${j.title} [${j.posted}]`));
  }

  console.log(`\n[!] No matching DS/ML/AI jobs found within 1 day — exiting without applying.`);
  console.log(`    Matching keywords: ${TITLE_KEYWORDS.join(', ')}`);
  return null;
}

// ─── APPLY TO ONE JOB ────────────────────────────────────────────────────────

async function applyToJob(context, job) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[>] Applying to: ${job.title}`);
  console.log(`    URL     : ${job.url}`);
  console.log(`    Posted  : ${job.posted || 'unknown'}`);
  console.log(`    Location: ${job.location || 'unknown'}`);
  console.log(`${'─'.repeat(60)}`);

  const jobPage = await context.newPage();

  try {
    await jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await jobPage.waitForTimeout(3000);

    // ── Extract real title from h1 ────────────────────────────────────────────
    let realTitle = job.title;
    try {
      const h1 = await jobPage.$('h1');
      if (h1) {
        const h1Text = (await h1.textContent()).trim();
        if (h1Text.length > 3) realTitle = h1Text;
      }
    } catch (e) { /* use job.title */ }
    console.log(`   [i] Page title: ${realTitle}`);

    // ── Check for iframes ─────────────────────────────────────────────────────
    const iframeSrc = await jobPage.evaluate(() => {
      const frames = Array.from(document.querySelectorAll('iframe'));
      for (const f of frames) {
        const src = f.src || '';
        if (src.includes('smartrecruiters') || src.includes('apply') || src.includes('form')) {
          return src;
        }
      }
      return null;
    }).catch(() => null);

    let targetPage = jobPage;

    if (iframeSrc) {
      console.log(`   [i] Found iframe: ${iframeSrc}`);
      const frames = jobPage.frames();
      for (const f of frames) {
        const url = f.url();
        if (url.includes('smartrecruiters') || url.includes('apply') || url !== jobPage.url()) {
          if (url !== 'about:blank' && url !== '') {
            console.log(`   [i] Targeting iframe frame: ${url}`);
            targetPage = f;
            break;
          }
        }
      }
    }

    // ── Scroll to form area ───────────────────────────────────────────────────
    await jobPage.evaluate(() => {
      const candidates = [
        '#apply', '#application', '#apply-form', '#apply-now',
        'form', '.apply-form', '[class*="apply"]', '[id*="apply"]',
        'input[type="text"]', 'input[type="email"]',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
      }
    }).catch(() => {});
    await jobPage.waitForTimeout(1500);

    // ── Wait for form fields to appear ────────────────────────────────────────
    const formAppeared = await jobPage.waitForSelector(
      'input[type="text"], input[type="email"], input[name*="name" i], input[id*="name" i], input[placeholder*="name" i]',
      { timeout: 10000, state: 'visible' }
    ).then(() => true).catch(() => false);

    if (!formAppeared) {
      // Try clicking an "Apply" or "Apply Now" button to reveal the form
      console.log(`   [i] Form not immediately visible — looking for Apply button`);
      const applyBtnSelectors = [
        'a:has-text("Apply Now")',
        'a:has-text("Apply now")',
        'a:has-text("Apply")',
        'button:has-text("Apply")',
        '[class*="apply-btn"]',
        '[id*="apply-btn"]',
        'a[href*="apply"]',
      ];
      for (const sel of applyBtnSelectors) {
        try {
          const loc = jobPage.locator(sel).first();
          if (await loc.count() > 0 && await loc.isVisible({ timeout: 2000 })) {
            console.log(`   [i] Clicking apply button: ${sel}`);
            await loc.click();
            await jobPage.waitForTimeout(2500);
            break;
          }
        } catch (e) {
          // try next
        }
      }

      await jobPage.waitForSelector(
        'input[type="text"], input[type="email"]',
        { timeout: 8000, state: 'visible' }
      ).catch(() => {});
    }

    await jobPage.waitForTimeout(1000);

    // ── DEBUG: log all inputs BEFORE filling ─────────────────────────────────
    await debugLogInputs(jobPage, 'Before filling');

    // ── Fill: First Name ──────────────────────────────────────────────────────
    // Strategy: try by name/id/placeholder. Also try positional (first text input).
    const firstNameSelectors = [
      'input[name="first_name"]',
      'input[name="firstname"]',
      'input[name="fname"]',
      'input[name*="first" i]',
      'input[id="first_name"]',
      'input[id="firstname"]',
      'input[id*="first" i]',
      'input[placeholder*="first name" i]',
      'input[placeholder*="first" i]',
      'input[aria-label*="first" i]',
      // Gravity Forms field IDs
      '#input_1_3',
      '#input_1_1',
      '#input_2_3',
      '#input_2_1',
    ];
    const firstFilled = await fillField(targetPage, firstNameSelectors, USER_FIRST_NAME, 'First Name');

    // ── Fill: Last Name ───────────────────────────────────────────────────────
    // Comprehensive list — try every plausible selector
    const lastNameSelectors = [
      'input[name="last_name"]',
      'input[name="lastname"]',
      'input[name="lname"]',
      'input[name="surname"]',
      'input[name*="last" i]',
      'input[id="last_name"]',
      'input[id="lastname"]',
      'input[id="lname"]',
      'input[id*="last" i]',
      'input[placeholder*="last name" i]',
      'input[placeholder*="last" i]',
      'input[placeholder*="surname" i]',
      'input[aria-label*="last" i]',
      'input[aria-label*="surname" i]',
      // Gravity Forms common field IDs
      '#input_1_4',
      '#input_1_2',
      '#input_1_6',
      '#input_2_4',
      '#input_2_2',
      '#field_last_name',
      '#last_name',
    ];
    const lastFilled = await fillField(targetPage, lastNameSelectors, USER_LAST_NAME, 'Last Name');

    // ── Positional fallback: if last name didn't fill, use 2nd visible text input ──
    if (!lastFilled) {
      console.log(`   [!] Last name selectors all failed — trying positional fallback (2nd text input)`);
      const positioned = await targetPage.evaluate((lastName) => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
          .filter(el => el.offsetParent !== null);
        if (inputs.length >= 2) {
          const el = inputs[1];
          el.focus();
          el.value = lastName;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur',   { bubbles: true }));
          return `positional[1]: name="${el.name}" id="${el.id}" placeholder="${el.placeholder}"`;
        }
        return null;
      }, USER_LAST_NAME).catch(() => null);

      if (positioned) {
        console.log(`   [form] Last Name filled via positional fallback: ${positioned}`);
      } else {
        console.warn(`   [!!] Last Name could NOT be filled by any method — form will likely fail`);
      }
    }

    // ── Fill: Email ───────────────────────────────────────────────────────────
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="email_address"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[placeholder*="email" i]',
      'input[aria-label*="email" i]',
    ];
    await fillField(targetPage, emailSelectors, USER_EMAIL, 'Email');

    // ── Upload Resume ─────────────────────────────────────────────────────────
    if (fs.existsSync(RESUME_PATH)) {
      try {
        const fileInputs = targetPage.locator('input[type="file"]');
        const fileCount  = await fileInputs.count();
        console.log(`   [i] File inputs found: ${fileCount}`);

        if (fileCount > 0) {
          let resumeInput  = null;
          let coverInput   = null;

          for (let fi = 0; fi < fileCount; fi++) {
            const inp = fileInputs.nth(fi);
            const ctx = await inp.evaluate(el => {
              const parts = [el.id, el.name, el.accept || '', el.getAttribute('aria-label') || ''];
              let node = el.parentElement;
              for (let n = 0; n < 4 && node; n++, node = node.parentElement) {
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

          if (!resumeInput) resumeInput = fileInputs.first();

          await resumeInput.setInputFiles(RESUME_PATH);
          console.log(`   [resume] Resume uploaded: ${path.basename(RESUME_PATH)}`);

          if (coverInput && fs.existsSync(COVER_LETTER_PATH)) {
            await coverInput.setInputFiles(COVER_LETTER_PATH);
            console.log(`   [cover]  Cover letter uploaded: ${path.basename(COVER_LETTER_PATH)}`);
          } else if (fileCount >= 2 && !coverInput && fs.existsSync(COVER_LETTER_PATH)) {
            await fileInputs.nth(1).setInputFiles(COVER_LETTER_PATH);
            console.log(`   [cover]  Cover letter uploaded to 2nd file input`);
          }

          await jobPage.waitForTimeout(1500);
        } else {
          console.warn(`   [!] No file input found — skipping resume upload`);
        }
      } catch (e) {
        console.warn(`   [!] Resume upload error: ${e.message}`);
      }
    } else {
      console.error(`   [!] FATAL: Resume not found at ${RESUME_PATH}`);
    }

    // ── DEBUG: log all inputs AFTER filling (shows current values) ────────────
    await debugLogInputs(jobPage, 'After filling — pre-submit state');

    // ── Screenshot before submit ──────────────────────────────────────────────
    const screenshotPath = path.join(__dirname, 'pre_submit_screenshot.png');
    await jobPage.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    console.log(`   [i] Screenshot saved: ${screenshotPath}`);

    // ── Click Submit ──────────────────────────────────────────────────────────
    const submitSelectors = [
      'input[type="submit"]',
      'button[type="submit"]',
      'button:has-text("Submit")',
      'button:has-text("Apply")',
      'button:has-text("Send")',
      'input[value*="Submit" i]',
      'input[value*="Apply" i]',
      'input[value*="Send" i]',
      '.gform_button',
      '#gform_submit_button_1',
      '[class*="submit"]',
      '[id*="submit"]',
    ];

    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const loc = jobPage.locator(sel).first();
        if (await loc.count() > 0 && await loc.isVisible({ timeout: 2000 })) {
          const btnText = await loc.textContent().catch(() => sel);
          console.log(`   [click] Submit button: "${(btnText || sel).trim()}" (${sel})`);
          await loc.click();
          submitted = true;
          break;
        }
      } catch (e) {
        // try next
      }
    }

    if (!submitted) {
      // JS fallback
      const jsResult = await jobPage.evaluate(() => {
        const candidates = document.querySelectorAll(
          'input[type="submit"], button[type="submit"], button, input[type="button"]'
        );
        for (const pass of [/submit|apply/i, /send/i]) {
          for (const el of candidates) {
            const txt = (el.textContent || '').trim();
            const val = el.value || '';
            if ((pass.test(txt) || pass.test(val)) && el.offsetParent !== null) {
              el.click();
              return txt || val;
            }
          }
        }
        return null;
      }).catch(() => null);

      if (jsResult) {
        console.log(`   [click] Submit via JS fallback: "${jsResult}"`);
        submitted = true;
      }
    }

    if (!submitted) {
      console.error(`\n   [!] No submit button found — could not submit application`);
      return { status: 'NO_SUBMIT', title: realTitle };
    }

    // ── Wait and check confirmation ───────────────────────────────────────────
    console.log(`\n   [i] Submitted — waiting ${CONFIRM_WAIT / 1000}s for confirmation...`);
    await jobPage.waitForTimeout(CONFIRM_WAIT);

    await jobPage.waitForLoadState('domcontentloaded').catch(() => {});
    await jobPage.waitForTimeout(1000);

    const bodyText = await jobPage.evaluate(() => document.body.innerText).catch(() => '');

    const CONFIRM_RE = /thank you|application.*received|application.*sent|successfully applied|we.*received.*application|application.*submitted|your.*resume.*on its way/i;
    const ERROR_RE   = /problem with your submission|error|please fill|required field|invalid/i;

    const confirmed  = CONFIRM_RE.test(bodyText);
    const hasError   = ERROR_RE.test(bodyText);

    const status = confirmed ? 'APPLIED' : (hasError ? 'ERROR' : 'UNCERTAIN');

    console.log(`\n${'═'.repeat(60)}`);
    if (confirmed) {
      console.log(`   RESULT: APPLIED — Confirmation message detected`);
    } else if (hasError) {
      console.log(`   RESULT: ERROR — Error message detected`);
      console.log(`   Body snippet (first 800 chars):`);
      console.log(`   ${bodyText.substring(0, 800).replace(/\n/g, ' ')}`);
      // Log inputs again after error to see what's on the page
      await debugLogInputs(jobPage, 'After submission error');
    } else {
      console.log(`   RESULT: UNCERTAIN — No confirmation or error text detected`);
      console.log(`   Body snippet (first 500 chars):`);
      console.log(`   ${bodyText.substring(0, 500).replace(/\n/g, ' ')}`);
    }
    console.log(`${'═'.repeat(60)}`);

    return { status, title: realTitle, url: job.url };

  } catch (err) {
    console.error(`\n   [x] Error during application: ${err.message}`);
    return { status: 'FAILED', title: job.title, error: err.message };
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`S3 Strategic Staffing Bot — DRY RUN (1 job)`);
  console.log(`User     : ${USER_FIRST_NAME} ${USER_LAST_NAME}`);
  console.log(`Email    : ${USER_EMAIL}`);
  console.log(`Resume   : ${RESUME_PATH}`);
  console.log(`Filter   : titles matching DS/ML/AI keywords, posted within 1 day`);
  console.log(`${'═'.repeat(60)}`);

  // Verify resume exists
  if (!fs.existsSync(RESUME_PATH)) {
    console.error(`\n[!] FATAL: Resume not found at ${RESUME_PATH}`);
    process.exit(1);
  }

  // Launch browser — headed, non-sandboxed
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const scanPage = await context.newPage();

  let result;

  try {
    // 1. Scrape job listings
    const jobs = await scrapeJobListings(scanPage);

    if (jobs.length === 0) {
      console.error(`\n[!] No jobs found on ${JOBS_LIST_URL}`);
      console.log(`    Browser left open for manual inspection.`);
      await waitForEnter();
      await browser.close();
      return;
    }

    // 2. Select target job — DS/ML/AI only, within 1 day, no fallback
    const targetJob = selectTargetJob(jobs);
    if (!targetJob) {
      // selectTargetJob already logged the reason
      await waitForEnter();
      await browser.close();
      return;
    }

    // 3. Apply
    result = await applyToJob(context, targetJob);

    if (result) {
      if (result.status === 'APPLIED') stats.applied++;
      else if (result.status === 'FAILED' || result.status === 'FATAL') stats.failed++;
      else stats.uncertain++;
    }
    if (stats.applied + stats.failed + stats.uncertain >= MAX_JOBS) {
      _shouldStop = true;
    }

  } catch (err) {
    console.error(`\n[x] Fatal error: ${err.stack || err.message}`);
    result = { status: 'FATAL', error: err.message };
  }

  // ── Final report ────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`DRY RUN COMPLETE`);
  console.log(`Status   : ${result ? result.status : 'UNKNOWN'}`);
  if (result && result.title) console.log(`Job      : ${result.title}`);
  if (result && result.url)   console.log(`URL      : ${result.url}`);
  if (result && result.error) console.log(`Error    : ${result.error}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`\nBrowser left open for review.`);
  console.log(`Press ENTER to close the browser and exit...`);

  await waitForEnter();

  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  console.log(`\n[done] Exiting.`);
}

function waitForEnter() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

// ─── FORM TEST MODE ───────────────────────────────────────────────────────────

async function formTestMode(applyUrl) {
  console.log(`\n[formtest] URL: ${applyUrl}`);
  console.log(`[formtest] Resume: ${RESUME_PATH} (exists: ${fs.existsSync(RESUME_PATH)})\n`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
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

  await fillField(page, [
    'input[name="first_name"]', 'input[name*="first" i]', 'input[placeholder*="first" i]',
  ], USER_FIRST_NAME, 'First Name');
  await fillField(page, [
    'input[name="last_name"]', 'input[name*="last" i]', 'input[placeholder*="last" i]',
  ], USER_LAST_NAME, 'Last Name');
  await fillField(page, [
    'input[type="email"]', 'input[name*="email" i]', 'input[placeholder*="email" i]',
  ], USER_EMAIL, 'Email');

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
  await browser.close();
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

const arg = process.argv[2];

if (!arg) {
  main().catch(err => {
    console.error(`\n[x] Unhandled error: ${err.stack || err.message}`);
    process.exit(1);
  });
} else if (arg === 'test') {
  MAX_JOBS = 1;
  console.log('[test] Single-job test mode — will stop after 1 application attempt.');
  main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'formtest') {
  const url = process.argv[3];
  if (!url) { console.error('[err] Usage: node s3-bot.js formtest <applyUrl>'); process.exit(1); }
  formTestMode(url).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else {
  console.log('\nUsage:');
  console.log('  node s3-bot.js                    ← run the bot (1 job dry run)');
  console.log('  node s3-bot.js test               ← single-job test mode');
  console.log('  node s3-bot.js formtest <url>     ← inspect and interactively fill one form\n');
  process.exit(1);
}
