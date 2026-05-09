#!/usr/bin/env node
/**
 * Indeed Job Application Bot — 2 Parallel Workers
 *
 * FIRST TIME:  node Indeed/indeed-bot.js login
 * RUN:         node Indeed/indeed-bot.js [minutes]
 * PROBE:       node Indeed/indeed-bot.js probe
 */

'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const http = require('http');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const HOME_DIR      = process.env.HOME || process.env.USERPROFILE || '';
const PROFILE_DIR   = process.env.INDEED_PROFILE_PATH || path.join(HOME_DIR, 'indeed-bot-profile');
const WORKSPACE_DIR = path.join(HOME_DIR, '.openclaw', 'workspace');
const LOG_FILE      = path.join(WORKSPACE_DIR, 'indeed_applications_log.md');
const APPLIED_IDS   = path.join(WORKSPACE_DIR, 'indeed_applied_ids.txt');
const STATUS_FILE   = path.join(WORKSPACE_DIR, 'indeed_worker_status.json');
const SCANNED_FILE  = path.join(__dirname, 'scanned_jobs.txt');
const APPLIED_FILE  = path.join(__dirname, 'applied_jobs.txt');
const FAILED_FILE   = path.join(__dirname, 'failed_jobs.txt');

const RATE_LIMIT_MS  = 10000;  // ms between applications
const PAGE_TIMEOUT   = 30000;
const RESCAN_WAIT_MS = 120000; // 2 min between scan rounds

// ─── LOCAL LLM (Ollama) ───────────────────────────────────────────────────────

const LLM_HOST  = '127.0.0.1';
const LLM_PORT  = 11434;
const LLM_MODEL = process.env.LLM_MODEL || 'qwen2.5:7b';

// ─── SEARCH CONFIG ────────────────────────────────────────────────────────────

// sc=0kf:attr(DSQF7);  →  Indeed "Easily apply" filter
// fromage=1            →  posted within last 24 hours
const EASY_APPLY_SC = 'sc=0kf%3Aattr%28DSQF7%29%3B';

const SEARCH_QUERIES = [
  'Data Scientist',
  'Machine Learning Engineer',
  'ML Engineer',
  'Applied Scientist',
  'NLP Engineer',
  'Data Science',
];

const SEARCH_URLS = SEARCH_QUERIES.map(q =>
  `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&fromage=1&${EASY_APPLY_SC}&sort=date`
);

// ─── USER PROFILE ─────────────────────────────────────────────────────────────

const USER_PROFILE = {
  firstName:        'Nikhil',
  lastName:         'Rao',
  fullName:         'Nikhil Rao',
  email:            'nikhilprao9066@gmail.com',
  phone:            process.env.INDEED_PHONE || '7052369066',  // set INDEED_PHONE env or update here
  city:             'Atlanta',
  state:            'Georgia',
  country:          'United States',
  zipCode:          '30301',
  linkedin:         '',  // add LinkedIn profile URL if desired
  yearsExperience:  '3',
  workAuthorized:   true,   // authorized to work in the US
  needsSponsorship: false,  // does NOT need visa sponsorship
  resumePath: (() => {
    const candidates = [
      path.join(__dirname, 'Nikhil_Resume.pdf'),
      path.join(__dirname, '..', 'Nikhil_Resume.pdf'),
      path.join(HOME_DIR, 'Desktop', 'Jobs', 'Nikhil_Resume.pdf'),
    ];
    return candidates.find(p => { try { return fs.existsSync(p); } catch (_) {} }) || candidates[candidates.length - 1];
  })(),
  // Background used by the LLM to answer unknown screening questions
  llmContext: `
Nikhil Rao is a Data Scientist and Machine Learning Engineer with 3+ years of experience.
Technical skills: Python, SQL, R, TensorFlow, PyTorch, scikit-learn, Keras, Pandas, NumPy, Spark.
Cloud: AWS (SageMaker, S3, EC2, Lambda), GCP (BigQuery, Vertex AI), Azure ML.
Tools: Docker, Git, Jupyter, MLflow, Airflow, FastAPI, REST APIs.
Domains: ML model development and deployment, NLP, deep learning, computer vision, recommendation systems, A/B testing, data pipelines.
Education: Master's degree in Computer Science / Data Science.
Soft skills: Strong communicator, cross-functional collaborator, fast learner.
US-based. Authorized to work in the US without visa sponsorship.
Available immediately. Open to remote, hybrid, or onsite positions.
  `.trim(),
};

// ─── SHARED STATE ─────────────────────────────────────────────────────────────

let _shouldStop = false;
let _sigintCount = 0;

process.on('SIGINT', () => {
  _sigintCount++;
  if (_sigintCount >= 2) { console.log('\nForce exiting.'); process.exit(1); }
  _shouldStop = true;
  console.log('\n⚠️  Stopping after current job. (Ctrl+C again to force quit)');
});

const stats = { applied: 0, skipped: 0, failed: 0, uncertain: 0, total: 0 };
let currentJob = '';

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

function writeScannedJobs(allJobs, queuedIds, appliedJobs) {
  ensureDir(SCANNED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  const lines = [
    '='.repeat(80),
    `INDEED SCAN  —  ${ts}`,
    `${allJobs.length} found  |  ${queuedIds.size} new  |  ${allJobs.length - queuedIds.size} already applied / filtered`,
    '='.repeat(80), '',
  ];
  allJobs.forEach((j, i) => {
    const already = appliedJobs.has(j.id);
    const badge   = already ? '[ALREADY APPLIED]' : (queuedIds.has(j.id) ? '[QUEUED          ]' : '[FILTERED        ]');
    lines.push(`${String(i + 1).padStart(3)}.  ${badge}  ${j.title || '(no title)'}`);
    if (j.company)  lines.push(`       Company : ${j.company}`);
    if (j.location) lines.push(`       Location: ${j.location}`);
    lines.push(`       Posted  : ${j.posted || 'unknown'}`);
    lines.push(`       Link    : https://www.indeed.com/viewjob?jk=${j.id}`);
    lines.push('');
  });
  fs.writeFileSync(SCANNED_FILE, lines.join('\n'));
}

function writeAppliedEntry(title, company, jobId, status) {
  ensureDir(APPLIED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  fs.appendFileSync(APPLIED_FILE,
    `[${ts}] [${status}] ${title} | ${company} | ID: ${jobId}\n` +
    `   https://www.indeed.com/viewjob?jk=${jobId}\n`
  );
}

function writeFailedEntry(title, company, jobId, status, reason) {
  ensureDir(FAILED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  fs.appendFileSync(FAILED_FILE,
    `[${ts}] [${status}] ${title} | ${company} | ID: ${jobId}\n` +
    `   Reason: ${reason}\n` +
    `   URL: https://www.indeed.com/viewjob?jk=${jobId}\n\n`
  );
}

function initLogFile() {
  ensureDir(LOG_FILE);
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE,
      `# Indeed Job Applications Log\n\n` +
      `| # | Time | Title | Company | Job ID | Status | URL |\n` +
      `|---|------|-------|---------|--------|--------|-----|\n`
    );
  }
}

function logJob(jobNumber, title, company, jobId, status) {
  ensureDir(LOG_FILE);
  const ts  = new Date().toLocaleTimeString('en-US', { hour12: false });
  const url = `https://www.indeed.com/viewjob?jk=${jobId}`;
  fs.appendFileSync(LOG_FILE,
    `| ${jobNumber} | ${ts} | ${title} | ${company} | ${jobId} | ${status} | ${url} |\n`
  );
}

// ─── WORKER LOGGING / STATUS ──────────────────────────────────────────────────

function wlog(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function updateStatus(state, job = '') {
  currentJob = job.slice(0, 60);
  ensureDir(STATUS_FILE);
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      timestamp: new Date().toISOString(), state, job: currentJob, stats,
    }, null, 2));
  } catch (_) {}
}

function printDashboard() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 INDEED BOT  —  ${new Date().toLocaleString('en-US', { hour12: false })}`);
  console.log(`   ✅ Applied: ${stats.applied}   ⏭️  Skipped: ${stats.skipped}`);
  console.log(`   ❌ Failed:  ${stats.failed}   ❓ Uncertain: ${stats.uncertain}`);
  console.log(`   📋 Total:   ${stats.total}`);
  if (currentJob) console.log(`   🔄 Current: ${currentJob}`);
  console.log(`${'─'.repeat(60)}\n`);
}

// ─── LOCAL LLM ────────────────────────────────────────────────────────────────

async function askLLM(question, options = []) {
  return new Promise((resolve) => {
    const optText = options.length ? `\nOptions to choose from: ${options.join(' | ')}` : '';
    const prompt = [
      `You are answering job application questions on behalf of Nikhil Rao.`,
      ``,
      `Candidate background:`,
      USER_PROFILE.llmContext,
      ``,
      `Rules:`,
      `- For Yes/No questions: reply with ONLY "Yes" or "No"`,
      `- If options are listed: pick the single best-fit option, reply with ONLY that option text exactly as written`,
      `- For open-ended text: 1-2 sentences, professional, first-person voice`,
      `- Do NOT use markdown, bullet points, or formatting`,
      `- Do NOT say you are an AI or mention you are helping someone`,
      ``,
      `Question: ${question}${optText}`,
      `Answer:`,
    ].join('\n');

    const body = JSON.stringify({
      model: LLM_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.2, num_predict: 120 },
    });

    const req = http.request({
      hostname: LLM_HOST, port: LLM_PORT,
      path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve((JSON.parse(raw).response || '').trim()); }
        catch { resolve(''); }
      });
    });

    req.on('error', () => resolve(''));
    req.setTimeout(20000, () => { req.destroy(); resolve(''); });
    req.write(body);
    req.end();
  });
}

// ─── SCROLL HELPER ────────────────────────────────────────────────────────────

async function scrollToLoadAll(page) {
  try {
    let prev = 0;
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(700);
      const cur = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
      if (cur === prev) break;
      prev = cur;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch (_) {}
}

// ─── JOB EXTRACTION ───────────────────────────────────────────────────────────

async function extractJobsFromPage(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const jobs = [];

    // Primary: elements carrying data-jk directly
    const jkEls = Array.from(document.querySelectorAll('[data-jk]'));

    // Secondary fallback: anchor hrefs with jk=
    const linkEls = Array.from(document.querySelectorAll('a[href*="jk="]'));

    const allEls = [...jkEls, ...linkEls];

    for (const el of allEls) {
      let jk = el.getAttribute('data-jk');
      if (!jk) {
        const m = (el.getAttribute('href') || '').match(/jk=([a-f0-9]+)/i);
        if (!m) continue;
        jk = m[1];
      }
      if (!jk || seen.has(jk)) continue;
      seen.add(jk);

      // Walk up to find the card container
      const card = el.closest(
        'li[class*="job"], div[class*="job_seen"], div[class*="tapItem"], ' +
        'div[class*="jobCard"], article, [class*="resultCard"]'
      ) || el.parentElement;

      const cardText = card ? card.innerText : '';

      // "Easily apply" badge detection
      const hasEasyApply = /easily apply/i.test(cardText) ||
        !!(card && card.querySelector('[class*="iaLabel"], [class*="indeedApply"], [aria-label*="easily" i]'));

      // Title
      const titleEl = card && (
        card.querySelector('h2.jobTitle span[title], h2[class*="jobTitle"] span, h2 a span, ' +
          '[data-testid="jobTitle"], .jobTitle a span, h2 span')
      );
      const title = (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim();

      // Company
      const companyEl = card && card.querySelector(
        '[data-testid="company-name"], span.companyName, [class*="companyName"] span, ' +
        'span[class*="company"]'
      );
      const company = (companyEl?.textContent || '').trim();

      // Location
      const locEl = card && card.querySelector(
        '[data-testid="text-location"], div.companyLocation, [class*="companyLocation"]'
      );
      const location = (locEl?.textContent || '').trim();

      // Posted date
      const dateEl = card && card.querySelector(
        '[data-testid="myJobsStateDate"], span.date, [class*="date"], ' +
        'span[class*="posted"]'
      );
      // Also check card text for date patterns
      const dateText = dateEl?.textContent?.trim() ||
        (cardText.match(/(\d+\s+(?:minute|hour|day)s?\s+ago|just posted|today)/i) || [])[0] || '';

      jobs.push({ id: jk, title, company, location, posted: dateText, hasEasyApply });
    }

    return jobs;
  });
}

// ─── DATE FILTER ──────────────────────────────────────────────────────────────

function isWithin24Hours(postedText) {
  if (!postedText) return true; // if no date, assume new (fromage=1 already filtered)
  const t = postedText.toLowerCase();
  if (/just posted|just now|today|moment|active/i.test(t)) return true;
  const mins = t.match(/(\d+)\s*min/);
  if (mins) return true;
  const hours = t.match(/(\d+)\s*hour/);
  if (hours) return parseInt(hours[1]) <= 24;
  const days = t.match(/(\d+)\s*day/);
  if (days) return parseInt(days[1]) <= 1;
  return true; // unknown format — trust the fromage=1 URL param
}

// ─── JOB SCANNING ─────────────────────────────────────────────────────────────

async function scanForJobs(page, appliedJobs) {
  const found   = [];
  const allSeen = [];
  const seenIds = new Set();

  for (const searchUrl of SEARCH_URLS) {
    const qMatch = searchUrl.match(/q=([^&]+)/);
    const keyword = qMatch ? decodeURIComponent(qMatch[1]) : 'unknown';
    console.log(`\n🔍 Scanning: ${keyword}`);

    // Indeed paginates via start=0, start=10, start=20, ...
    let startOffset = 0;
    let totalAdded  = 0;
    let totalOld    = 0;

    while (true) {
      const pagedUrl = startOffset === 0 ? searchUrl : `${searchUrl}&start=${startOffset}`;
      try {
        await page.goto(pagedUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        await page.waitForTimeout(2500);
        await scrollToLoadAll(page);

        // Detect no-results state
        const noResults = await page.evaluate(() => {
          const t = (document.body.innerText || '').toLowerCase();
          return t.includes('did not match any jobs') ||
                 t.includes('no jobs found') ||
                 t.includes('0 jobs for');
        }).catch(() => false);

        if (noResults) {
          console.log(`   ⛔ [${keyword}] No results at offset ${startOffset}`);
          break;
        }

        const jobs = await extractJobsFromPage(page);
        if (jobs.length === 0) {
          if (startOffset > 0) console.log(`   ⛔ [${keyword}] End of results at offset ${startOffset}`);
          break;
        }

        const freshOnPage = jobs.filter(j => !seenIds.has(j.id));
        if (startOffset > 0 && freshOnPage.length === 0) break; // pagination loop, no new cards

        let addedThisPage = 0;
        for (const job of jobs) {
          if (seenIds.has(job.id)) continue;
          seenIds.add(job.id);
          allSeen.push(job);

          if (!job.hasEasyApply)          continue;
          if (appliedJobs.has(job.id))    continue;
          if (!isWithin24Hours(job.posted)) { totalOld++; continue; }

          found.push({
            id:      job.id,
            url:     `https://www.indeed.com/viewjob?jk=${job.id}`,
            title:   job.title   || job.id,
            company: job.company || '',
            posted:  job.posted,
          });
          totalAdded++;
          addedThisPage++;
        }

        const easyOnPage = freshOnPage.filter(j => j.hasEasyApply).length;
        console.log(`   offset=${startOffset}: ${jobs.length} cards | ${easyOnPage} easy apply new | ${addedThisPage} queued`);
        startOffset += 10;

      } catch (err) {
        console.error(`   ⚠️  [${keyword}] Error at offset ${startOffset}: ${err.message}`);
        break;
      }
    }

    console.log(`   ✅ [${keyword}] Done: ${totalAdded} queued | ${totalOld} >24h skipped`);
  }

  const queuedIds = new Set(found.map(j => j.id));
  writeScannedJobs(allSeen, queuedIds, appliedJobs);
  return found;
}

// ─── FORM HELPERS ─────────────────────────────────────────────────────────────

// Select "Use your Indeed Resume" radio if it appears on the first step
async function selectProfileResume(page) {
  const clicked = await page.evaluate(() => {
    const pattern = /use.*indeed.*resume|use.*existing.*resume|indeed resume|resume on file|your resume/i;
    for (const radio of document.querySelectorAll('input[type="radio"]')) {
      if (radio.checked) continue;
      const lbl = (radio.labels?.[0]?.textContent || radio.getAttribute('aria-label') || '').trim();
      if (pattern.test(lbl)) {
        radio.click();
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        return lbl;
      }
    }
    // Also try buttons/labels that select the profile resume
    for (const el of document.querySelectorAll('button, [role="button"], label, div[tabindex]')) {
      if (pattern.test(el.textContent) && el.offsetParent !== null) {
        el.click();
        return el.textContent.trim().slice(0, 50);
      }
    }
    return null;
  }).catch(() => null);

  if (clicked) wlog(`   📄 Selected profile resume: "${clicked}"`);
}

// Upload resume file as a fallback when the profile resume is not auto-selected
async function uploadResumeFile(page) {
  if (!USER_PROFILE.resumePath || !fs.existsSync(USER_PROFILE.resumePath)) return;
  try {
    const fileInputs = page.locator('input[type="file"]');
    const n = await fileInputs.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const inp = fileInputs.nth(i);
      const ctx = await inp.evaluate(el => {
        const parts = [el.id, el.name, el.getAttribute('aria-label') || ''];
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) parts.push(lbl.textContent);
        }
        let node = el.parentElement;
        for (let k = 0; k < 3 && node; k++, node = node.parentElement) parts.push(node.textContent || '');
        return parts.join(' ').toLowerCase();
      }).catch(() => '');

      if (/resume|cv/i.test(ctx) && !/cover/i.test(ctx)) {
        const hasFiles = await inp.evaluate(el => (el.files?.length || 0) > 0).catch(() => false);
        if (!hasFiles) {
          await inp.setInputFiles(USER_PROFILE.resumePath);
          wlog(`   📄 Uploaded resume file`);
          await page.waitForTimeout(1500);
        }
      }
    }
  } catch (err) {
    wlog(`   ⚠️  Resume upload error: ${err.message}`);
  }
}

// Fill contact-info fields we know (name, email, phone, etc.) using Playwright fill()
// which properly triggers React/Vue state updates via native input value setter.
async function fillKnownFields(page) {
  const fieldMap = [
    { re: /first.?name|given.?name/i,                    val: USER_PROFILE.firstName },
    { re: /last.?name|family.?name|surname/i,             val: USER_PROFILE.lastName  },
    { re: /\bfull.?name\b|\byour.?name\b|^name$/i,        val: USER_PROFILE.fullName  },
    { re: /\bemail\b/i,                                    val: USER_PROFILE.email     },
    { re: /phone|mobile|cell/i,                            val: USER_PROFILE.phone     },
    { re: /\bcity\b/i,                                     val: USER_PROFILE.city      },
    { re: /\bstate\b/i,                                    val: USER_PROFILE.state     },
    { re: /zip|postal/i,                                   val: USER_PROFILE.zipCode   },
    { re: /linkedin/i,                                     val: USER_PROFILE.linkedin  },
    { re: /years?.*(of\s*)?experience|(experience|exp).*years?/i, val: USER_PROFILE.yearsExperience },
  ];

  const sel = 'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input:not([type])';
  const inputs = page.locator(sel);
  const total  = await inputs.count().catch(() => 0);
  let filled = 0;

  for (let i = 0; i < total; i++) {
    const inp = inputs.nth(i);
    try {
      if (!(await inp.isVisible().catch(() => false))) continue;
      if (!(await inp.isEnabled().catch(() => false))) continue;
      const val = await inp.inputValue().catch(() => null);
      if (val === null || val.trim()) continue; // already filled or inaccessible

      // Build label text from multiple sources
      const labelText = await inp.evaluate(el => {
        const parts = [];
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) parts.push(lbl.textContent);
        }
        const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        if (aria) {
          const ariaEl = document.getElementById(aria);
          parts.push(ariaEl ? ariaEl.textContent : aria);
        }
        if (el.placeholder) parts.push(el.placeholder);
        if (el.name) parts.push(el.name);
        const pLbl = el.closest('label');
        if (pLbl) parts.push(pLbl.textContent);
        return parts.join(' ');
      }).catch(() => '');

      const match = fieldMap.find(f => f.re.test(labelText));
      if (match && match.val) {
        await inp.fill(match.val);
        filled++;
      }
    } catch (_) {}
  }

  if (filled > 0) wlog(`   ✏️  Filled ${filled} contact field(s)`);
}

// Answer all radio groups and select dropdowns on the current step.
// Simple yes/no questions are handled locally; anything with non-trivial options
// (years of experience, proficiency level, tech-specific choices) goes to the LLM.
async function answerKnownQuestions(page) {
  const SKIP_VAL = /^(select|choose|please\s*select|--|none)$/i;
  const NO_KW    = /sponsor|visa\s*sponsor|security\s*clearance|clearance\s*required/i;

  // ── Collect all unanswered question groups from the page ─────────────────────
  const groups = await page.evaluate(() => {
    const SKIP_VAL = /^(select|choose|please\s*select|--|none)$/i;
    const result   = [];

    // Radio groups
    const seenKeys = new Set();
    for (const r of document.querySelectorAll('input[type="radio"]')) {
      const key = r.name ||
        r.closest('fieldset')?.id ||
        r.closest('[role="group"]')?.id ||
        '';
      if (!key || seenKeys.has(key)) continue;
      const groupRadios = Array.from(
        document.querySelectorAll(`input[type="radio"][name="${key}"]`)
      );
      if (groupRadios.some(x => x.checked)) continue; // already answered
      seenKeys.add(key);

      // Find the question label
      const container = r.closest('fieldset, [role="group"], [class*="question"], div') || r.parentElement;
      const labelEl   = container?.querySelector('legend, [class*="label"], p, b, span');
      const question  = (labelEl?.textContent || container?.innerText || '').trim().slice(0, 200);

      const options = groupRadios.map(x => {
        const lbl = (x.labels?.[0]?.textContent || x.nextElementSibling?.textContent || x.value || '').trim();
        return { value: x.value, label: lbl };
      }).filter(o => o.label);

      result.push({ type: 'radio', key, question, options });
    }

    // Select / dropdown
    for (const sel of document.querySelectorAll('select')) {
      if (sel.value && !SKIP_VAL.test(sel.value.trim())) continue;
      const opts = Array.from(sel.options)
        .filter(o => o.value && !SKIP_VAL.test(o.value) && !SKIP_VAL.test(o.text))
        .map(o => ({ value: o.value, label: o.text.trim() }));
      if (!opts.length) continue;

      const labelEl = sel.id ? document.querySelector(`label[for="${sel.id}"]`) : null;
      const question = (
        labelEl?.textContent ||
        sel.getAttribute('aria-label') ||
        sel.name || ''
      ).trim();

      result.push({ type: 'select', selId: sel.id || sel.name, question, options: opts });
    }

    return result;
  }).catch(() => []);

  if (groups.length === 0) return;

  // ── Answer each group ────────────────────────────────────────────────────────
  for (const g of groups) {
    const optLabels = g.options.map(o => o.label).filter(Boolean);
    const allYesNo  = optLabels.every(l => /^(yes|no)$/i.test(l));
    const wantNo    = NO_KW.test(g.question);

    let chosen; // the label string we want to select

    if (allYesNo) {
      // Fast path — no LLM needed
      chosen = wantNo ? 'No' : 'Yes';
    } else {
      // Non-trivial options (experience tiers, proficiency, tech-specific) → LLM
      wlog(`   🤖 LLM screening: "${g.question.slice(0, 70)}"`);
      const llmRaw = await askLLM(g.question, optLabels);

      // Match LLM response back to an actual option label
      chosen = optLabels.find(l =>
        l.toLowerCase() === llmRaw.toLowerCase() ||
        l.toLowerCase().includes(llmRaw.toLowerCase()) ||
        llmRaw.toLowerCase().includes(l.toLowerCase())
      );

      // Fallback: for "years of experience" pick the tier matching ~3 years
      if (!chosen) {
        if (/years?.*(of\s*)?experience|(experience|exp).*years?/i.test(g.question)) {
          chosen = optLabels.find(l => /3[^0-9]|4[^0-9]|2[^0-9]/i.test(l)) ||
                   optLabels[Math.min(2, optLabels.length - 1)];
        } else {
          chosen = optLabels[0];
        }
      }
    }

    wlog(`   ✅ "${g.question.slice(0, 55)}" → "${chosen}"`);

    if (g.type === 'radio') {
      await page.evaluate(({ key, chosen }) => {
        const radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${key}"]`));
        const pick   = radios.find(r => {
          const lbl = (r.labels?.[0]?.textContent || r.nextElementSibling?.textContent || r.value || '').trim();
          return lbl.toLowerCase().includes(chosen.toLowerCase()) ||
                 chosen.toLowerCase().includes(lbl.toLowerCase());
        }) || radios[0];
        if (pick) { pick.click(); pick.dispatchEvent(new Event('change', { bubbles: true })); }
      }, { key: g.key, chosen }).catch(() => {});

    } else {
      await page.evaluate(({ selId, chosen }) => {
        const sel = document.getElementById(selId) || document.querySelector(`select[name="${selId}"]`);
        if (!sel) return;
        const opt = Array.from(sel.options).find(o =>
          o.text.toLowerCase().includes(chosen.toLowerCase()) ||
          chosen.toLowerCase().includes(o.text.toLowerCase())
        ) || (sel.options.length > 1 ? sel.options[1] : null);
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      }, { selId: g.selId, chosen }).catch(() => {});
    }

    await page.waitForTimeout(200).catch(() => {});
  }
}

// For unanswered free-text/textarea fields, call the LLM
async function answerOpenQuestions(page) {
  const taLoc = page.locator('textarea');
  const taCount = await taLoc.count().catch(() => 0);

  for (let i = 0; i < taCount; i++) {
    const ta = taLoc.nth(i);
    try {
      if (!(await ta.isVisible().catch(() => false))) continue;
      if (!(await ta.isEnabled().catch(() => false))) continue;
      const val = await ta.inputValue().catch(() => null);
      if (val === null || val.trim()) continue;

      const question = await ta.evaluate(el => {
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) return lbl.textContent.trim();
        }
        const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '';
        if (aria) {
          const ariaEl = document.getElementById(aria);
          return (ariaEl ? ariaEl.textContent : aria).trim();
        }
        const parent = el.closest('div, section, fieldset');
        return (parent?.querySelector('label, legend, p, span')?.textContent || '').trim();
      }).catch(() => '');

      if (!question) continue;
      wlog(`   🤖 LLM: "${question.slice(0, 70)}"`);
      const answer = await askLLM(question);
      if (answer) {
        await ta.fill(answer);
        wlog(`   ✏️  → "${answer.slice(0, 70)}"`);
      }
    } catch (_) {}
  }

  // Text inputs that fillKnownFields didn't handle
  const inpLoc = page.locator('input[type="text"]');
  const inpCount = await inpLoc.count().catch(() => 0);

  for (let i = 0; i < inpCount; i++) {
    const inp = inpLoc.nth(i);
    try {
      if (!(await inp.isVisible().catch(() => false))) continue;
      if (!(await inp.isEnabled().catch(() => false))) continue;
      const val = await inp.inputValue().catch(() => null);
      if (val === null || val.trim()) continue;

      const question = await inp.evaluate(el => {
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) return lbl.textContent.trim();
        }
        return (el.getAttribute('aria-label') || el.placeholder || el.name || '').trim();
      }).catch(() => '');

      if (!question || question.length < 4) continue;
      // Skip fields that fillKnownFields should have handled
      if (/^(name|first|last|email|phone|city|state|zip|location|linkedin)/i.test(question)) continue;

      wlog(`   🤖 LLM text: "${question.slice(0, 70)}"`);
      const answer = await askLLM(question);
      if (answer) {
        await inp.fill(answer);
        wlog(`   ✏️  → "${answer.slice(0, 70)}"`);
      }
    } catch (_) {}
  }
}

// ─── STEP PROGRESS DETECTION ─────────────────────────────────────────────────

async function getStepInfo(page) {
  return page.evaluate(() => {
    const text = document.body.innerText;
    // "Step 2 of 4" / "2 of 5" / "2/5"
    const m = text.match(/\bstep\s*(\d+)\s*(?:of|\/)\s*(\d+)\b/i) ||
              text.match(/\b(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:step|page)/i);
    if (m) return { current: parseInt(m[1]), total: parseInt(m[2]) };
    // Progress dots / stepper tabs
    const dots = document.querySelectorAll(
      '[class*="progress"] [class*="step"], [class*="Stepper"] li, ' +
      '[class*="ia-BasePage-header"] [class*="step"], [role="tab"]'
    );
    if (dots.length > 1) {
      const active = Array.from(dots).findIndex(d =>
        /active|current|selected/i.test(d.className) ||
        d.getAttribute('aria-selected') === 'true' ||
        d.getAttribute('aria-current') === 'step'
      );
      return { current: active >= 0 ? active + 1 : 1, total: dots.length };
    }
    return null;
  }).catch(() => null);
}

// ─── VALIDATION ERROR RECOVERY ────────────────────────────────────────────────
// After a failed Continue click, detect required fields with visible errors
// and attempt to fill them via LLM before retrying the step.

async function fixValidationErrors(page) {
  const errorFields = await page.evaluate(() => {
    const results = [];
    const errorInputs = document.querySelectorAll(
      '[aria-invalid="true"], ' +
      '.ia-Questions-inputError input, .ia-Questions-inputError textarea, ' +
      '[class*="errorMessage"] ~ input, [class*="errorMessage"] ~ textarea, ' +
      'input:required:invalid:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), ' +
      'textarea:required:invalid'
    );
    for (const inp of errorInputs) {
      if (inp.offsetParent === null || inp.value.trim()) continue;
      const label = (() => {
        if (inp.id) {
          const lbl = document.querySelector(`label[for="${inp.id}"]`);
          if (lbl) return lbl.textContent.trim();
        }
        return (inp.getAttribute('aria-label') || inp.placeholder || inp.name || '').trim();
      })();
      if (label) results.push({ label, id: inp.id || inp.name, tag: inp.tagName.toLowerCase() });
    }
    return results;
  }).catch(() => []);

  if (errorFields.length === 0) return 0;
  wlog(`   ⚠️  ${errorFields.length} required field(s) missing — asking LLM`);

  let fixed = 0;
  for (const field of errorFields) {
    const answer = await askLLM(field.label);
    if (!answer) continue;
    try {
      const sel = field.id
        ? `#${CSS.escape ? CSS.escape(field.id) : field.id}`
        : `[name="${field.id}"]`;
      const loc = page.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
        await loc.fill(answer);
        fixed++;
        wlog(`   ✏️  Fixed: "${field.label.slice(0, 50)}" → "${answer.slice(0, 50)}"`);
      }
    } catch (_) {}
  }
  return fixed;
}

// ─── NAVIGATE MULTI-STEP INDEED FORM ─────────────────────────────────────────

async function navigateIndeedForm(page) {
  const maxSteps = 15;
  const CONFIRM_RE = /your application has been submitted|application submitted|thank you for applying|you.ve applied|we received your application|application was sent/i;
  const SUBMIT_RE  = /submitted|thank you|application received|you.ve applied|application.*sent/i;

  const modalSel = [
    '[role="dialog"]', '[aria-modal="true"]', '#ia-container',
    '[class*="ia-Modal"]', '[class*="IndeedApply"]',
    '[class*="JobApply"]', '[class*="applyModal"]', '[class*="ApplicationModal"]',
  ].join(', ');

  await page.waitForSelector(modalSel, { timeout: 10000 }).catch(() => {
    wlog(`   ⚠️  No modal — proceeding with page-level form`);
  });

  let lastBodySnapshot = '';
  let samePageCount    = 0;

  for (let step = 0; step < maxSteps; step++) {
    await page.waitForTimeout(1200).catch(() => {});

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');

    // ── Confirmation ────────────────────────────────────────────────────────────
    if (CONFIRM_RE.test(bodyText)) {
      wlog(`   🎉 Confirmed on step ${step + 1}`);
      return 'APPLIED';
    }

    // ── Step progress label ─────────────────────────────────────────────────────
    const stepInfo = await getStepInfo(page);
    const stepLabel = stepInfo ? ` (${stepInfo.current}/${stepInfo.total})` : '';
    wlog(`   📋 Step ${step + 1}${stepLabel}`);

    // ── Fill fields — resume only on early steps to avoid false file-input hits ──
    if (step <= 1) {
      await selectProfileResume(page);
      await uploadResumeFile(page);
    }
    await fillKnownFields(page);
    await answerKnownQuestions(page);
    await answerOpenQuestions(page);
    await page.waitForTimeout(350).catch(() => {});

    // ── Try Submit ──────────────────────────────────────────────────────────────
    for (const txt of ['Submit your application', 'Submit Application', 'Submit']) {
      try {
        const btn = page.locator(`button:has-text("${txt}")`).first();
        if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
          wlog(`   🖱️  Submit: "${txt}"`);
          await btn.click();
          await page.waitForTimeout(4000);
          const afterText = await page.evaluate(() => document.body.innerText).catch(() => '');
          if (SUBMIT_RE.test(afterText)) return 'APPLIED';
          if (!await btn.isVisible().catch(() => false)) return 'APPLIED';
          return 'UNCERTAIN';
        }
      } catch (_) {}
    }

    // ── Try Continue / Next / Review ────────────────────────────────────────────
    const continueTexts = ['Continue', 'Next', 'Next Step', 'Review your application', 'Review'];
    let advanced = false;

    for (const txt of continueTexts) {
      try {
        const btn = page.locator(`button:has-text("${txt}")`).first();
        if (await btn.count() > 0 && await btn.isVisible() && await btn.isEnabled()) {
          const label = (await btn.textContent().catch(() => txt)).trim();
          wlog(`   🖱️  Continue: "${label}"`);
          await btn.click();
          advanced = true;
          break;
        }
      } catch (_) {}
    }

    // ── JS fallback ─────────────────────────────────────────────────────────────
    if (!advanced) {
      const clicked = await page.evaluate(() => {
        const patterns = ['Continue', 'Next', 'Next Step', 'Review',
          'Submit your application', 'Submit Application', 'Submit'];
        for (const el of document.querySelectorAll('button, [role="button"]')) {
          const txt = el.textContent.trim();
          if (patterns.some(p => txt === p || txt.startsWith(p)) &&
              el.offsetParent !== null && !el.disabled) {
            el.click();
            return txt;
          }
        }
        return null;
      }).catch(() => null);

      if (clicked) {
        wlog(`   🖱️  Fallback: "${clicked}"`);
        if (/submit/i.test(clicked)) {
          await page.waitForTimeout(4000);
          const after = await page.evaluate(() => document.body.innerText).catch(() => '');
          if (SUBMIT_RE.test(after)) return 'APPLIED';
          return 'UNCERTAIN';
        }
        advanced = true;
      }
    }

    // ── Stuck — try validation error recovery ───────────────────────────────────
    if (!advanced) {
      await page.waitForTimeout(800);
      const fixed = await fixValidationErrors(page);
      if (fixed > 0) {
        wlog(`   🔄 Fixed ${fixed} field(s) — retrying step`);
        samePageCount = 0;
        continue; // retry this step without incrementing the step counter
      }

      const visible = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter(b => b.offsetParent !== null && !b.disabled)
          .map(b => b.textContent.trim()).filter(Boolean)
      ).catch(() => []);
      wlog(`   ⛔ Stuck — buttons: [${visible.slice(0, 10).join(' | ')}]`);
      break;
    }

    // ── Detect page-didn't-change (form rejected Continue silently) ─────────────
    await page.waitForTimeout(800);
    const newBody = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (newBody === lastBodySnapshot && step > 0) {
      samePageCount++;
      if (samePageCount >= 2) {
        wlog(`   ⚠️  Page unchanged after ${samePageCount} clicks — checking for errors`);
        const fixed = await fixValidationErrors(page);
        if (fixed === 0) break;
        samePageCount = 0;
      }
    } else {
      samePageCount = 0;
    }
    lastBodySnapshot = newBody;
  }

  return 'UNCERTAIN';
}

// ─── APPLY TO ONE JOB ─────────────────────────────────────────────────────────

async function applyToJob(context, job, jobNumber) {
  wlog(`📝 #${jobNumber} — ${job.title} @ ${job.company} | ${job.posted || 'no date'}`);
  updateStatus('APPLYING', job.title);

  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (_shouldStop) { updateStatus('IDLE'); return 'SKIPPED'; }
    if (attempt > 1) {
      wlog(`   🔄 Retry ${attempt}/${MAX_RETRIES}`);
      await new Promise(r => setTimeout(r, 5000));
    }

    let jobPage;
    try {
      jobPage = await context.newPage();
      await jobPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await jobPage.waitForTimeout(3000).catch(() => {});

      // Grab title + company from the detail page
      let title = job.title, company = job.company || '-';
      try {
        const h1 = await jobPage.$('h1.jobsearch-JobInfoHeader-title, h1[class*="JobInfoHeader"], h1');
        if (h1) title = (await h1.textContent()).trim().replace(/\s+/g, ' ');
      } catch (_) {}
      try {
        const c = await jobPage.$('[data-company-name="true"] a, [class*="companyName"] a, [data-testid="inlineHeader-companyName"] a');
        if (c) company = (await c.textContent()).trim();
      } catch (_) {}

      // Detect whether an "Apply now" / "Easily apply" button exists
      const applySelectors = [
        'button:has-text("Apply now")',
        'button:has-text("Easily apply")',
        '[id*="apply-button" i]',
        '[class*="applyButton"]',
        '[data-testid="applyButton"]',
        'a:has-text("Apply now")',
      ];

      let applyBtn = null;
      for (const sel of applySelectors) {
        try {
          const loc = jobPage.locator(sel).first();
          if (await loc.count() > 0 && await loc.isVisible()) {
            applyBtn = loc;
            break;
          }
        } catch (_) {}
      }

      if (!applyBtn) {
        // Check for "Apply on company site" — external application, skip
        const pageText = await jobPage.evaluate(() => document.body.innerText).catch(() => '');
        const reason = /apply on company site|apply externally|apply at employer/i.test(pageText)
          ? 'external apply' : 'no apply button';
        wlog(`   ⏭️  SKIPPED — ${reason}`);
        logJob(jobNumber, title, company, job.id, 'SKIPPED');
        writeAppliedEntry(title, company, job.id, 'SKIPPED');
        stats.skipped++;
        await jobPage.close().catch(() => {});
        updateStatus('IDLE');
        return 'SKIPPED';
      }

      wlog(`   🖱️  Clicking Apply now`);

      // Listen for a new tab that might open after clicking apply
      const newTabPromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
      await applyBtn.click();
      await jobPage.waitForTimeout(1500);

      const newTab = await newTabPromise;
      let applyPage;

      if (newTab) {
        await newTab.waitForLoadState('domcontentloaded').catch(() => {});
        await newTab.waitForTimeout(1500);
        const tabUrl = newTab.url();
        wlog(`   📂 New tab: ${tabUrl}`);

        if (!tabUrl || tabUrl === 'about:blank') {
          await newTab.close().catch(() => {});
          applyPage = jobPage; // fall back to modal on same page
        } else {
          applyPage = newTab;
        }
      } else {
        applyPage = jobPage;
        wlog(`   📂 Modal on same page`);
      }

      const result = await navigateIndeedForm(applyPage);

      if (applyPage !== jobPage) await applyPage.close().catch(() => {});
      await jobPage.close().catch(() => {});

      logJob(jobNumber, title, company, job.id, result);

      if (result === 'APPLIED') {
        wlog(`   ✅ APPLIED — ${title}`);
        markApplied(job.id);
        writeAppliedEntry(title, company, job.id, 'APPLIED');
        stats.applied++;
        updateStatus('IDLE');
        return 'APPLIED';
      }

      if (result === 'UNCERTAIN') {
        wlog(`   ❓ UNCERTAIN — ${title}`);
        markApplied(job.id);
        writeAppliedEntry(title, company, job.id, 'UNCERTAIN');
        writeFailedEntry(title, company, job.id, 'UNCERTAIN', 'submitted but no confirmation detected');
        stats.uncertain++;
        updateStatus('IDLE');
        return 'UNCERTAIN';
      }

    } catch (err) {
      wlog(`   ❌ Error (attempt ${attempt}): ${err.message}`);
      await jobPage?.close().catch(() => {});

      if (/closed|destroyed|Target page/i.test(err.message)) {
        updateStatus('IDLE');
        return 'FAILED';
      }

      if (attempt === MAX_RETRIES) {
        markApplied(job.id);
        logJob(jobNumber, job.title, '-', job.id, 'FAILED');
        writeAppliedEntry(job.title, '-', job.id, 'FAILED');
        writeFailedEntry(job.title, '-', job.id, 'FAILED', err.message);
        stats.failed++;
        updateStatus('IDLE');
        return 'FAILED';
      }
    }
  }

  updateStatus('IDLE');
  return 'FAILED';
}

// ─── MAIN BOT — Sequential apply ─────────────────────────────────────────────

async function runBot(runtimeMinutes) {
  const stopTime = runtimeMinutes === Infinity ? Infinity : Date.now() + runtimeMinutes * 60_000;

  initLogFile();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🤖 Indeed Bot — Sequential`);
  console.log(`📂 Profile  : ${PROFILE_DIR}`);
  console.log(`🤖 LLM      : ${LLM_MODEL} @ ${LLM_HOST}:${LLM_PORT}`);
  console.log(`⏱️  Runtime  : ${runtimeMinutes === Infinity ? 'unlimited (Ctrl+C to stop)' : runtimeMinutes + ' min'}`);
  console.log(`${'═'.repeat(60)}\n`);

  if (!fs.existsSync(PROFILE_DIR)) {
    console.error(`❌ Profile not found: ${PROFILE_DIR}`);
    console.error(`   Run first: node Indeed/indeed-bot.js login`);
    process.exit(1);
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  });

  const existingPages = context.pages();
  const scanPage = existingPages.length > 0 ? existingPages[0] : await context.newPage();

  const appliedJobs = loadAppliedJobs();
  console.log(`📂 Loaded ${appliedJobs.size} previously applied job IDs\n`);

  const dashInterval = setInterval(printDashboard, 30000);

  try {
    while (!_shouldStop && Date.now() < stopTime) {
      console.log(`\n🔍 Scanning all Easy Apply jobs...`);
      const newJobs = await scanForJobs(scanPage, appliedJobs);

      if (newJobs.length === 0) {
        console.log(`\n😴 No new Easy Apply jobs found. Waiting ${RESCAN_WAIT_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, RESCAN_WAIT_MS));
        continue;
      }

      console.log(`\n🎯 ${newJobs.length} Easy Apply jobs found — applying sequentially\n`);
      printDashboard();

      // ── Sequential apply loop ──────────────────────────────────────────────────
      for (const job of newJobs) {
        if (_shouldStop || Date.now() >= stopTime) break;

        stats.total++;
        appliedJobs.add(job.id); // optimistic dedup before page loads

        await applyToJob(context, job, stats.total);

        // Brief pause between applications
        if (!_shouldStop) await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      }

      printDashboard();

      if (_shouldStop || Date.now() >= stopTime) break;

      console.log(`\n⏳ Round complete. Waiting ${RESCAN_WAIT_MS / 1000}s before next scan...`);
      await new Promise(r => setTimeout(r, RESCAN_WAIT_MS));
    }

  } catch (err) {
    console.error(`\n❌ Fatal error:`, err.stack || err.message);
  } finally {
    clearInterval(dashInterval);
    await scanPage.close().catch(() => {});
    await context.close().catch(() => {});
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🏁 Indeed Bot stopped`);
  console.log(`✅ Applied: ${stats.applied}  ⏭️  Skipped: ${stats.skipped}  ❌ Failed: ${stats.failed}  ❓ Uncertain: ${stats.uncertain}`);
  console.log(`📄 Applied log : ${APPLIED_FILE}`);
  console.log(`📄 Scanned log : ${SCANNED_FILE}`);
  console.log(`${'═'.repeat(60)}\n`);
}

// ─── LOGIN MODE ───────────────────────────────────────────────────────────────

async function loginMode() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔐 Indeed Login Mode`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`\nSteps:`);
  console.log(`  1. A browser window will open`);
  console.log(`  2. Click "Sign in" on Indeed`);
  console.log(`  3. Choose "Continue with Google"`);
  console.log(`  4. Sign in with: nikhilprao9066@gmail.com`);
  console.log(`  5. Once you can see the Indeed job listings, press Enter here\n`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.indeed.com/account/login', { waitUntil: 'domcontentloaded' }).catch(() =>
    page.goto('https://www.indeed.com', { waitUntil: 'domcontentloaded' })
  );

  console.log('Browser open. Sign in with Google, then press Enter...');
  await new Promise(resolve => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });

  await context.close();
  console.log(`\n✅ Session saved to: ${PROFILE_DIR}`);
  console.log(`   Run: node Indeed/indeed-bot.js 240\n`);
}

// ─── PROBE MODE ───────────────────────────────────────────────────────────────

async function probeMode() {
  console.log('\n🔬 Probe Mode — inspect job cards and apply modal\n');

  if (!fs.existsSync(PROFILE_DIR)) {
    console.error('Profile not found. Run: node Indeed/indeed-bot.js login');
    process.exit(1);
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox'],
  });
  const page = context.pages()[0] || await context.newPage();

  const url = SEARCH_URLS[0];
  console.log(`Opening: ${url}\n`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  await page.waitForTimeout(3000);

  const jobs = await extractJobsFromPage(page);
  console.log(`Found ${jobs.length} job cards on page:`);
  jobs.slice(0, 10).forEach((j, i) => {
    const ea = j.hasEasyApply ? '✅ EA' : '   --';
    console.log(`  ${i + 1}. [${ea}] ${j.title || '?'} @ ${j.company || '?'} | ${j.posted || '?'}`);
    console.log(`        https://www.indeed.com/viewjob?jk=${j.id}`);
  });

  const eaJob = jobs.find(j => j.hasEasyApply);
  if (eaJob) {
    console.log(`\nOpening Easy Apply job: ${eaJob.title}`);
    await page.goto(`https://www.indeed.com/viewjob?jk=${eaJob.id}`, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await page.waitForTimeout(3000);

    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a'))
        .filter(el => el.offsetParent !== null)
        .map(el => el.textContent.trim())
        .filter(Boolean)
        .slice(0, 20)
    );
    console.log('\nVisible buttons:', buttons);
  }

  console.log('\nPress Enter to close...');
  await new Promise(r => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); r(); });
  });

  await context.close();
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

(async () => {
  const arg = process.argv[2] || '';

  if (arg === 'login') {
    await loginMode();
  } else if (arg === 'probe') {
    await probeMode();
  } else {
    const minutes = parseInt(arg);
    await runBot(isNaN(minutes) ? Infinity : minutes);
  }
})().catch(err => {
  console.error('\n❌ Fatal:', err.stack || err.message);
  process.exit(1);
});
