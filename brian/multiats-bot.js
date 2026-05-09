#!/usr/bin/env node
/**
 * Multi-ATS Job Application Bot
 * Supports: Greenhouse.io · Lever.co · Ashby HQ
 *
 * Place resume.pdf in this directory before running.
 *
 * RUN:  node multiats-bot.js [minutes]        (default: 60 min)
 * e.g.  node multiats-bot.js 120
 */

'use strict';
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const http = require('http');

// ─── USER PROFILE ─────────────────────────────────────────────────────────────

const PROFILE = {
  firstName:     'Nikhil',
  lastName:      'Premachandra Rao',
  fullName:      'Nikhil Premachandra Rao',
  email:         'nikhilprao9066@gmail.com',
  phone:         '7746368916',
  city:          'Atlanta',
  state:         'GA',
  stateFullName: 'Georgia',
  zip:           '30519',
  country:       'United States',
  street:        '4188 woodfern ln',
  linkedin:      'https://linkedin.com/in/nikhil-p-rao',
  portfolio:     'https://nikprao.vercel.app',
  github:        '',
  yearsExp:      '5',
  salary:        '100000',
  noticeDays:    '14',
  sponsorship:   false,
  citizenStatus: 'Non-citizen allowed to work for any employer',
  ethnicity:     'Asian',
  gender:        'Male',
  disability:    false,
  veteran:       false,
  resumePath:    path.join(__dirname, 'resume.pdf'),
};

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const OUT_DIR     = __dirname;
const APPLIED_IDS  = path.join(OUT_DIR, 'applied_ids.txt');
const APPLIED_FILE = path.join(OUT_DIR, 'applied_jobs.txt');
const FAILED_FILE  = path.join(OUT_DIR, 'failed_jobs.txt');
const QA_FILE      = path.join(OUT_DIR, 'qa_log.txt');

const PAGE_TIMEOUT  = 30_000;
const RATE_LIMIT_MS = 6_000;

// Google search URLs — last 24 hours
const SEARCH_URLS = [
  'https://www.google.com/search?q=%22Data+Science%22+site%3Agreenhouse.io&tbs=qdr%3Ad&num=50',
  'https://www.google.com/search?q=%22Data+Science%22+site%3Alever.co&tbs=qdr%3Ad&num=50',
  'https://www.google.com/search?q=%22Data+Science%22+site%3Aashbyhq.com&tbs=qdr%3Ad&num=50',
  'https://www.google.com/search?q=%22Machine+Learning%22+site%3Agreenhouse.io&tbs=qdr%3Ad&num=50',
  'https://www.google.com/search?q=%22Machine+Learning%22+site%3Alever.co&tbs=qdr%3Ad&num=50',
  'https://www.google.com/search?q=%22Data+Scientist%22+site%3Aashbyhq.com&tbs=qdr%3Ad&num=50',
];

// URL patterns to recognise each ATS
const ATS = {
  greenhouse: /boards\.greenhouse\.io\/[^/?#]+\/jobs\/\d+/,
  lever:      /jobs\.lever\.co\/[^/?#]+\/[0-9a-f-]{36}/,
  ashby:      /jobs\.ashbyhq\.com\/[^/?#]+\/[0-9a-f-]{36}/,
};

// Ollama settings
const LLM_HOST   = '127.0.0.1';
const LLM_PORT   = 11434;
const LLM_MODELS = ['llama3.2', 'llama3', 'qwen2.5', 'mistral', 'phi3', 'gemma2'];

// ─── RUNTIME STATE ────────────────────────────────────────────────────────────

const stats = { applied: 0, failed: 0, skipped: 0 };
const failedPages = [];   // pages kept open for human review

let _shouldStop = false;
process.on('SIGINT', () => { _shouldStop = true; console.log('\n⚠️  Stopping after current job…'); });

// ─── FILE HELPERS ─────────────────────────────────────────────────────────────

function ensureDir(p) {
  const d = path.dirname(p);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function loadAppliedIds() {
  ensureDir(APPLIED_IDS);
  if (!fs.existsSync(APPLIED_IDS)) { fs.writeFileSync(APPLIED_IDS, ''); return new Set(); }
  return new Set(
    fs.readFileSync(APPLIED_IDS, 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
  );
}

function markApplied(id) { fs.appendFileSync(APPLIED_IDS, id + '\n'); }

function logApplied(job, qa) {
  ensureDir(APPLIED_FILE);
  const ts = new Date().toLocaleString();
  const qaLines = qa.map(q =>
    `  [${(q.source || 'hardcoded').toUpperCase().padEnd(9)}]  Q: ${q.question.trim()}\n                    A: ${q.answer}`
  );
  fs.appendFileSync(APPLIED_FILE, [
    '='.repeat(80),
    `APPLIED  —  ${ts}`,
    `Title   : ${job.title || 'Unknown'}`,
    `Company : ${job.company || 'Unknown'}`,
    `ATS     : ${job.ats}`,
    `URL     : ${job.url}`,
    '',
    'FORM Q&A:',
    ...qaLines,
    '='.repeat(80),
    '',
  ].join('\n'));
}

function logFailed(job, reason) {
  ensureDir(FAILED_FILE);
  const ts = new Date().toLocaleString();
  fs.appendFileSync(FAILED_FILE, [
    `[${ts}]  FAILED`,
    `Title   : ${job.title || 'Unknown'}`,
    `Company : ${job.company || 'Unknown'}`,
    `ATS     : ${job.ats}`,
    `URL     : ${job.url}`,
    `Reason  : ${reason}`,
    '',
  ].join('\n'));
}

// ─── LLM (OLLAMA) ─────────────────────────────────────────────────────────────

let _llmModel = null;   // null = not yet checked, 'NONE' = unavailable

async function detectLLM() {
  return new Promise(resolve => {
    const req = http.get(`http://${LLM_HOST}:${LLM_PORT}/api/tags`, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const names = (JSON.parse(buf).models || []).map(m => m.name.split(':')[0]);
          for (const pref of LLM_MODELS) {
            if (names.some(n => n.includes(pref))) { resolve(pref); return; }
          }
          resolve(names[0] || 'NONE');
        } catch { resolve('NONE'); }
      });
    });
    req.on('error', () => resolve('NONE'));
    req.setTimeout(3000, () => { req.destroy(); resolve('NONE'); });
  });
}

async function askLLM(question, jobContext = '') {
  if (_llmModel === null) {
    _llmModel = await detectLLM();
    if (_llmModel === 'NONE') return null;
  }
  if (_llmModel === 'NONE') return null;

  const prompt = `You are filling out a job application for a senior Data Scientist / ML Engineer role.
Answer ONLY the question below — one to three short sentences, no fluff, no preamble.

Fixed facts about the applicant:
- Name: Nikhil Premachandra Rao
- Years of experience: 5+
- Current city: Atlanta, GA
- Desired salary: $100,000
- Notice period: 2 weeks (14 days)
- Requires visa sponsorship: No
- Authorized to work in US: Yes
- LinkedIn: https://linkedin.com/in/nikhil-p-rao
- Portfolio: https://nikprao.vercel.app

${jobContext ? `Job context: ${jobContext}\n` : ''}
Question: "${question}"
Answer:`;

  return new Promise(resolve => {
    const body = JSON.stringify({ model: _llmModel, prompt, stream: false });
    const opts = {
      hostname: LLM_HOST, port: LLM_PORT, path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve((JSON.parse(buf).response || '').trim()); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30_000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── ANSWER MAPPER ────────────────────────────────────────────────────────────
// Returns hardcoded answer for known question patterns, or null to trigger LLM.

function mapField(label) {
  const l = label.toLowerCase();
  if (/^first.?name$/.test(l))                      return PROFILE.firstName;
  if (/^last.?name$/.test(l))                       return PROFILE.lastName;
  if (/full.?name|your name/.test(l))               return PROFILE.fullName;
  if (/email/.test(l))                              return PROFILE.email;
  if (/phone|mobile|telephone/.test(l))             return PROFILE.phone;
  if (/street|address\s*1/.test(l))                 return PROFILE.street;
  if (/city/.test(l) && !/state|zip/.test(l))       return PROFILE.city;
  if (/^state$/.test(l))                            return PROFILE.state;
  if (/zip|postal/.test(l))                         return PROFILE.zip;
  if (/country/.test(l))                            return PROFILE.country;
  if (/city.*state|location/.test(l))               return `${PROFILE.city}, ${PROFILE.state}`;
  if (/linkedin/.test(l))                           return PROFILE.linkedin;
  if (/portfolio|personal.?site|website/.test(l))   return PROFILE.portfolio;
  if (/github/.test(l))                             return PROFILE.github || '';
  if (/twitter|x\.com/.test(l))                     return '';
  if (/years.?of?.?exp|experience.?years/.test(l))  return PROFILE.yearsExp;
  if (/salary|compensation|expected.?pay/.test(l))  return PROFILE.salary;
  if (/notice.?period/.test(l))                     return PROFILE.noticeDays + ' days';
  if (/sponsor|visa/.test(l))                       return 'No';
  if (/authorized|eligible.?to.?work|citizen/.test(l)) return 'Yes';
  if (/willing.?to.?relocat/.test(l))               return 'No';
  if (/work.?remote|open.?to.?remote/.test(l))      return 'Yes';
  if (/how.?did.?you.?hear|referr|source/.test(l))  return 'LinkedIn';
  if (/cover.?letter/.test(l))                      return [
    'I am excited to apply for this Data Science / ML Engineering role.',
    `With 5+ years of experience building production ML systems and data pipelines,`,
    `I am confident I can make an immediate impact. You can explore my work at ${PROFILE.portfolio}.`,
  ].join(' ');
  return null;  // LLM handles everything else
}

function mapDropdown(label, options) {
  const l = label.toLowerCase();
  const filtered = options.filter(o => o && o.toLowerCase() !== 'prefer not to say' && o !== '--');

  let target = null;
  if (/gender/.test(l))              target = 'male';
  else if (/race|ethnic/.test(l))    target = 'asian';
  else if (/veteran/.test(l))        target = 'not a protected';
  else if (/disabilit/.test(l))      target = 'no';
  else if (/sponsor|visa/.test(l))   target = 'no';
  else if (/authorized|citizen/.test(l)) target = 'yes';
  else if (/relocat/.test(l))        target = 'no';
  else if (/remote/.test(l))         target = 'yes';
  else if (/pronouns/.test(l))       target = 'he/him';

  if (!target) return null;
  const hit = filtered.find(o => o.toLowerCase().includes(target));
  return hit || null;
}

// ─── GENERIC FORM FILL ────────────────────────────────────────────────────────
// Walks all visible label→input pairs, fills what it can, asks LLM for the rest.

async function fillByLabels(page, jobCtx) {
  const qa = [];

  // Resume upload — do this once up front
  if (fs.existsSync(PROFILE.resumePath)) {
    try {
      const fileInputs = await page.locator('input[type="file"]').all();
      for (const fi of fileInputs) {
        if (await fi.isVisible({ timeout: 1000 }).catch(() => false)) {
          await fi.setInputFiles(PROFILE.resumePath);
          qa.push({ question: 'Resume', answer: PROFILE.resumePath, source: 'hardcoded' });
          break;
        }
      }
    } catch {}
  } else {
    console.log(`   ⚠️  resume.pdf missing — upload skipped`);
  }

  // Walk every label on the page
  const labels = await page.locator('label').all();

  for (const labelEl of labels) {
    const rawText = await labelEl.textContent().catch(() => '');
    const cleanLabel = rawText.replace(/[*\n]/g, '').trim();
    if (!cleanLabel || cleanLabel.length < 2) continue;

    // Resolve the associated control
    const forAttr = await labelEl.getAttribute('for').catch(() => null);
    let ctrl = null;

    if (forAttr) {
      ctrl = page.locator(`[id="${forAttr}"]`).first();
    }
    if (!ctrl || !(await ctrl.count())) {
      ctrl = labelEl.locator('+ input, + textarea, + select, ~ input, ~ textarea, ~ select').first();
    }
    if (!ctrl || !(await ctrl.count())) continue;
    if (!await ctrl.isVisible({ timeout: 500 }).catch(() => false)) continue;

    const tag = await ctrl.evaluate(el => el.tagName.toLowerCase()).catch(() => '');

    // ── SELECT ──
    if (tag === 'select') {
      const opts = await ctrl.locator('option').allTextContents();
      const answer = mapDropdown(cleanLabel, opts);
      if (answer) {
        await ctrl.selectOption({ label: answer }).catch(() => ctrl.selectOption(answer));
        qa.push({ question: cleanLabel, answer, source: 'hardcoded' });
      }
      continue;
    }

    // ── TEXT / TEXTAREA ──
    if (tag === 'input' || tag === 'textarea') {
      const inputType = await ctrl.getAttribute('type').catch(() => 'text') || 'text';
      if (['file', 'checkbox', 'radio', 'hidden', 'submit', 'button'].includes(inputType)) continue;

      const known = mapField(cleanLabel);
      if (known !== null) {
        await ctrl.fill(String(known));
        if (known) qa.push({ question: cleanLabel, answer: String(known), source: 'hardcoded' });
      } else {
        const llmAns = await askLLM(cleanLabel, jobCtx);
        if (llmAns) {
          await ctrl.fill(llmAns);
          qa.push({ question: cleanLabel, answer: llmAns, source: 'llm' });
        } else {
          console.log(`   ❓ Unanswered: "${cleanLabel}"`);
        }
      }
    }
  }

  // ── Checkbox / radio groups (Yes/No questions) ──
  const radioGroups = await page.locator('fieldset, .radio-group, .checkbox-group').all();
  for (const group of radioGroups) {
    const legendText = await group.locator('legend, .group-label').first().textContent().catch(() => '');
    const cleanLabel = legendText.replace(/[*\n]/g, '').trim();
    if (!cleanLabel) continue;

    const l = cleanLabel.toLowerCase();
    let targetText = null;
    if (/sponsor|visa/.test(l))              targetText = 'no';
    else if (/authorized|citizen/.test(l))   targetText = 'yes';
    else if (/willing.?relocat/.test(l))     targetText = 'no';
    else if (/disabilit/.test(l))            targetText = 'no';

    if (!targetText) continue;
    const radio = group.locator(`input[type="radio"]`).filter({ has: page.locator(`~ * >> text=${targetText}`) }).first();
    if (await radio.count()) {
      await radio.check().catch(() => {});
      qa.push({ question: cleanLabel, answer: targetText, source: 'hardcoded' });
    }
  }

  return qa;
}

// ─── ATS-SPECIFIC NAVIGATORS ──────────────────────────────────────────────────

async function navigateToGreenhouseForm(page, url) {
  await page.goto(url, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
  // Click "Apply" button if present (some boards show a listing page first)
  const applyBtn = page.locator('a:has-text("Apply for this Job"), a:has-text("Apply Now"), #apply_button').first();
  if (await applyBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await applyBtn.click();
    await page.waitForTimeout(2000);
  }
  await page.waitForSelector('form, #application', { timeout: PAGE_TIMEOUT }).catch(() => {});
}

async function navigateToLeverForm(page, url) {
  // Lever apply page is the base URL + /apply
  const applyUrl = url.replace(/\/$/, '').split('/apply')[0] + '/apply';
  await page.goto(applyUrl, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.application-form, form', { timeout: PAGE_TIMEOUT }).catch(() => {});
}

async function navigateToAshbyForm(page, url) {
  const applyUrl = url.replace(/\/$/, '').split('/application')[0] + '/application';
  await page.goto(applyUrl, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form, [data-ui="Application"]', { timeout: PAGE_TIMEOUT }).catch(() => {});
}

// ─── SUBMIT ───────────────────────────────────────────────────────────────────

async function submitForm(page) {
  const submitSels = [
    '#submit_app',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit Application")',
    'button:has-text("Submit")',
    'button:has-text("Apply")',
    '.submit-app-btn',
    '[data-qa="btn-submit"]',
  ];

  for (const sel of submitSels) {
    const btn = page.locator(sel).last();
    if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click();
      await page.waitForTimeout(4000);

      // Check success
      const successTexts = [
        'Thank you',
        'application has been received',
        'Application submitted',
        'We received your application',
        'successfully submitted',
      ];
      for (const t of successTexts) {
        if (await page.locator(`text=${t}`).first().isVisible({ timeout: 3000 }).catch(() => false)) {
          return { success: true };
        }
      }
      // Check URL change (common success indicator)
      if (page.url().includes('confirmation') || page.url().includes('thank')) {
        return { success: true };
      }
      // Check for inline errors
      const errors = await page.locator('.error-message, .field-error, [class*="error"]')
        .allTextContents().catch(() => []);
      const errorText = errors.filter(Boolean).join(' | ').slice(0, 300);
      if (errorText) {
        return { success: false, reason: `Form errors: ${errorText}` };
      }
      // Assume success if none of the above
      return { success: true };
    }
  }

  return { success: false, reason: 'Submit button not found' };
}

// ─── JOB DISCOVERY ────────────────────────────────────────────────────────────

async function discoverJobs(browser) {
  const jobs = [];
  const seen = new Set();

  const ctx  = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  for (const url of SEARCH_URLS) {
    if (_shouldStop) break;
    const label = url.match(/q=([^&]+)/)?.[1].replace(/%22/g, '"').replace(/\+/g, ' ') || url.slice(0, 60);
    console.log(`\n🔍  ${label}`);

    try {
      await page.goto(url, { timeout: PAGE_TIMEOUT, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);

      // Google may show CAPTCHA
      const blocked = await page.locator('text=unusual traffic').or(page.locator('text=not a robot')).first()
        .isVisible({ timeout: 1500 }).catch(() => false);
      if (blocked) {
        console.log('   ⚠️  Google CAPTCHA — solve it in the browser then press Enter here…');
        await new Promise(r => process.stdin.once('data', r));
      }

      // Collect all ATS links
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]')).map(a => a.href)
      );

      let added = 0;
      for (const link of links) {
        const bare = link.split(/[?#]/)[0].replace(/\/$/, '');
        if (seen.has(bare)) continue;

        let ats = null;
        if (ATS.greenhouse.test(link)) ats = 'greenhouse';
        else if (ATS.lever.test(link)) ats = 'lever';
        else if (ATS.ashby.test(link)) ats = 'ashby';
        if (!ats) continue;

        seen.add(bare);
        jobs.push({ url: bare, ats, id: bare, title: '', company: '' });
        added++;
      }
      console.log(`   +${added} jobs  (${jobs.length} total)`);
    } catch (err) {
      console.log(`   ❌ search failed: ${err.message}`);
    }

    await page.waitForTimeout(2000);
  }

  await ctx.close();
  return jobs;
}

// ─── PROCESS ONE JOB ──────────────────────────────────────────────────────────

async function processJob(browser, job, appliedIds) {
  if (appliedIds.has(job.id)) {
    stats.skipped++;
    return 'skipped';
  }

  const ctx  = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();

  try {
    console.log(`\n📋  [${job.ats.toUpperCase()}]  ${job.url}`);

    // Navigate to application form
    if (job.ats === 'greenhouse')     await navigateToGreenhouseForm(page, job.url);
    else if (job.ats === 'lever')     await navigateToLeverForm(page, job.url);
    else                              await navigateToAshbyForm(page, job.url);

    // Grab page title / company
    job.title   = await page.locator('h1').first().textContent().catch(() => '').then(t => t.trim()).catch(() => '');
    job.company = await page.locator('.company-name, .employer, [class*="company-name"]').first()
      .textContent().catch(() => '').then(t => t.trim()).catch(() => '');
    if (!job.company) {
      job.company = page.url().match(/\/\/[^/]*\.(?:greenhouse|lever|ashbyhq)\.(?:io|co|com)\/([^/?#]+)/)?.[1] || '';
    }
    console.log(`   "${job.title}" @ ${job.company || '?'}`);

    const jobCtx = `${job.title} at ${job.company} (${job.ats})`;
    const qa     = await fillByLabels(page, jobCtx);
    const result = await submitForm(page);

    if (result.success) {
      stats.applied++;
      markApplied(job.id);
      appliedIds.add(job.id);
      logApplied(job, qa);
      console.log(`   ✅  Applied (${qa.length} fields filled)`);
      await ctx.close();
      return 'applied';
    } else {
      stats.failed++;
      logFailed(job, result.reason || 'Unknown error');
      failedPages.push({ page, ctx, job, reason: result.reason });
      console.log(`   ❌  Failed — ${result.reason}`);
      // intentionally do NOT close ctx — keep tab open for human review
      return 'failed';
    }
  } catch (err) {
    stats.failed++;
    logFailed(job, err.message);
    failedPages.push({ page, ctx, job, reason: err.message });
    console.log(`   ❌  Error — ${err.message}`);
    return 'failed';
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const minutes = parseInt(process.argv[2], 10) || 60;
  const stopAt  = Date.now() + minutes * 60_000;

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     Multi-ATS Job Application Bot            ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Runtime  : ${minutes} min`);
  console.log(`ATS      : Greenhouse · Lever · Ashby HQ`);
  console.log(`Resume   : ${PROFILE.resumePath}`);
  if (!fs.existsSync(PROFILE.resumePath)) {
    console.log('\n⚠️  WARNING: resume.pdf not found.');
    console.log('   Place your resume PDF at: ' + PROFILE.resumePath);
    console.log('   Continuing without resume upload.\n');
  }

  // LLM check
  process.stdout.write('\n🧠 Checking local LLM (ollama)… ');
  _llmModel = await detectLLM();
  if (_llmModel && _llmModel !== 'NONE') {
    console.log(`✅  ${_llmModel}`);
  } else {
    _llmModel = 'NONE';
    console.log('⚠️  Not found — only hardcoded answers will be used');
  }

  // Load previously applied IDs
  const appliedIds = loadAppliedIds();
  console.log(`\n📂  ${appliedIds.size} jobs already applied (loaded from applied_ids.txt)`);

  // Launch browser
  const browser = await chromium.launch({ headless: false, slowMo: 150 });

  try {
    // ── Phase 1: Discover jobs ──
    console.log('\n━━━━━━  Phase 1: Discovering Jobs  ━━━━━━');
    const allJobs = await discoverJobs(browser);
    const newJobs = allJobs.filter(j => !appliedIds.has(j.id));
    console.log(`\n📊  ${allJobs.length} total  |  ${newJobs.length} new  |  ${allJobs.length - newJobs.length} already applied`);

    if (newJobs.length === 0) {
      console.log('\nNo new jobs found. Try again later.');
      await browser.close();
      return;
    }

    // ── Phase 2: Apply ──
    console.log('\n━━━━━━  Phase 2: Applying  ━━━━━━');
    for (const job of newJobs) {
      if (_shouldStop || Date.now() > stopAt) {
        console.log('\n⏰  Time/stop limit reached.');
        break;
      }
      await processJob(browser, job, appliedIds);
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }

    // ── Summary ──
    console.log('\n' + '═'.repeat(60));
    console.log('SESSION COMPLETE');
    console.log(`  Applied  : ${stats.applied}`);
    console.log(`  Failed   : ${stats.failed}`);
    console.log(`  Skipped  : ${stats.skipped}`);
    console.log('');
    console.log(`  Applied log : ${APPLIED_FILE}`);
    console.log(`  Failed  log : ${FAILED_FILE}`);
    console.log(`  Q&A     log : ${QA_FILE}`);

    if (failedPages.length > 0) {
      console.log(`\n⚠️   ${failedPages.length} failed tabs are open for human review.`);
      console.log('    Reasons:');
      failedPages.forEach(({ job, reason }) =>
        console.log(`    • ${job.title || job.url} — ${reason}`)
      );
      console.log('\n    Close the browser window when done reviewing.');
      // Wait up to 30 min for human review
      await new Promise(r => setTimeout(r, 30 * 60_000));
    }
  } finally {
    // Only close if no failed pages waiting for review
    if (failedPages.length === 0) {
      await browser.close();
    }
  }
}

main().catch(err => {
  console.error('\n💥 Fatal:', err.message);
  process.exit(1);
});
