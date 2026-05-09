#!/usr/bin/env node
/**
 * Insight Global Job Application Bot — 2 Parallel Workers
 *
 * FIRST TIME:  node insightglobal-bot.js login
 * RUN:         node insightglobal-bot.js 240
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const HOME_DIR       = process.env.HOME || process.env.USERPROFILE || '';
const PROFILE_DIR    = process.env.IG_PROFILE_PATH || path.join(HOME_DIR, 'insightglobal-bot-profile');
const IG_EMAIL       = process.env.IG_EMAIL    || 'npraou@gmail.com';
const IG_PASSWORD    = process.env.IG_PASSWORD || 'w@dqC73EhUw!g$W';
const BASE_URL       = 'https://jobs.insightglobal.com';
const IG_LOGIN_URL   = `${BASE_URL}/users/login.aspx`;
const WORKSPACE_DIR  = path.join(HOME_DIR, '.openclaw', 'workspace');
const APPLIED_IDS    = path.join(WORKSPACE_DIR, 'ig_applied_ids.txt');
const STATUS_FILE    = path.join(WORKSPACE_DIR, 'ig_worker_status.json');
const SCANNED_FILE   = path.join(__dirname, 'scanned_jobs.txt');
const APPLIED_FILE   = path.join(__dirname, 'applied_jobs.txt');
const FAILED_FILE    = path.join(__dirname, 'failed_jobs.txt');
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

const NUM_WORKERS       = 2;
const RATE_LIMIT_MS     = 8000;
const PAGE_TIMEOUT      = 30000;
const RESCAN_WAIT_MS    = 90000;
const MAX_JOB_AGE_HOURS = 24;

const SEARCH_QUERIES = [
  'data+scientist',
  'machine+learning+engineer',
  'data+science',
  'ML+engineer',
  'applied+scientist',
  'nlp+engineer',
  'AI+engineer',
];

// ─── SHARED STATE ─────────────────────────────────────────────────────────────

let _shouldStop  = false;
let MAX_JOBS = Infinity;
let _sigintCount = 0;

process.on('SIGINT', () => {
  _sigintCount++;
  if (_sigintCount >= 2) { console.log('\nForce exiting.'); process.exit(1); }
  _shouldStop = true;
  console.log('\n⚠️  Stopping after current job. (Ctrl+C again to force quit)');
});

const stats = { applied: 0, skipped: 0, failed: 0, uncertain: 0, total: 0 };

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

// ─── HELPERS ──────────────────────────────────────────────────────────────────

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

function wlog(workerId, msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[${ts}] [${workerId}] ${msg}`);
}

function updateStatus(workerId, state, job = '') {
  workerStatus[workerId] = { state, job, lastUpdate: new Date().toISOString() };
  ensureDir(STATUS_FILE);
  fs.writeFileSync(STATUS_FILE, JSON.stringify({ workers: workerStatus, stats }, null, 2));
}

function isWithinMaxAge(dateStr) {
  if (!dateStr) return true;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return true;
  return (Date.now() - d.getTime()) / 3600000 <= MAX_JOB_AGE_HOURS;
}

// ─── OUTPUT FILES ─────────────────────────────────────────────────────────────

function initAppliedFile(queueSize) {
  ensureDir(APPLIED_FILE);
  const ts = new Date().toLocaleString('en-US', { hour12: false });
  fs.appendFileSync(APPLIED_FILE, [
    '='.repeat(80),
    `INSIGHT GLOBAL SESSION  —  ${ts}`,
    `${queueSize} jobs queued for application`,
    '='.repeat(80), '',
  ].join('\n'));
}

function writeAppliedEntry(workerId, title, company, jobId, status, jobUrl) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  fs.appendFileSync(APPLIED_FILE, [
    `[${time}] [${workerId}]  ${status.padEnd(9)}  —  ${title}`,
    `  Company : ${company || '-'}`,
    `  Link    : ${jobUrl || `${BASE_URL}/users/jobapply.aspx?jobid=${jobId}`}`,
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
    '='.repeat(80), '',
  ].join('\n'));
}

function writeFailedEntry(workerId, title, company, jobId, status, reason, jobUrl) {
  ensureDir(FAILED_FILE);
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const url  = jobUrl || `${BASE_URL}/users/jobapply.aspx?jobid=${jobId}`;
  fs.appendFileSync(FAILED_FILE, [
    `[${time}] [${workerId}]  ${status.padEnd(9)}  —  ${title}`,
    `  Company : ${company || '-'}`,
    `  Link    : ${url}`,
    `  ID      : ${jobId}`,
    ...(reason ? [`  Reason  : ${reason}`] : []),
    '',
  ].join('\n'));
}

function writeScannedJobs(allJobs, queuedIds, appliedJobs) {
  ensureDir(SCANNED_FILE);
  const ts       = new Date().toLocaleString('en-US', { hour12: false });
  const newCount = queuedIds.size;
  const lines    = [
    '='.repeat(80),
    `INSIGHT GLOBAL SCAN  —  ${ts}`,
    `${allJobs.length} jobs found  |  ${newCount} new  |  ${allJobs.length - newCount} already applied / filtered`,
    '='.repeat(80), '',
  ];
  allJobs.forEach((j, i) => {
    const badge = appliedJobs.has(j.id)
      ? '[ALREADY APPLIED]'
      : queuedIds.has(j.id) ? '[QUEUED          ]' : '[FILTERED        ]';
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

// ─── LOGIN ────────────────────────────────────────────────────────────────────

async function ensureLoggedIn(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(1500);

  const loggedIn = await page.evaluate(() =>
    /sign\s*out|log\s*out|my\s*profile|my\s*account/i.test(document.body.innerText)
  );

  if (loggedIn) {
    console.log('   ✅ Already logged in');
    await page.goto(`${BASE_URL}/find_a_job/`, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT }).catch(() => {});
    return;
  }

  console.log('   🔐 Not logged in — attempting auto-login...');
  await page.goto(IG_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT }).catch(() => {});
  await page.waitForTimeout(2000);

  // Try to fill credentials
  const emailSel = '#txtEmail, input[name*="Email"], input[type="email"]';
  const passSel  = '#txtPassword, input[name*="Password"], input[type="password"]';

  const emailInput = await page.$(emailSel);
  const passInput  = await page.$(passSel);

  if (emailInput && passInput) {
    await emailInput.fill(IG_EMAIL);
    await passInput.fill(IG_PASSWORD);
    const btn = await page.$('#ContentPlaceHolder1_cmdLogin, input[type="submit"], button[type="submit"]');
    if (btn) await btn.click();
    await page.waitForTimeout(3000);

    const ok = await page.evaluate(() =>
      /sign\s*out|log\s*out|my\s*profile|my\s*account/i.test(document.body.innerText)
    );
    if (ok) {
      console.log('   ✅ Logged in successfully');
      await page.goto(`${BASE_URL}/find_a_job/`, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT }).catch(() => {});
      return;
    }
  }

  // Fallback: wait 10 seconds then proceed
  console.log('   ⚠️  Auto-login did not complete — waiting 10s then continuing...');
  await page.waitForTimeout(10000);
}

// ─── SCAN JOBS ────────────────────────────────────────────────────────────────

async function scanAllJobs(page) {
  const seen = new Map(); // id → job (dedup across queries)

  for (const query of SEARCH_QUERIES) {
    if (_shouldStop) break;
    console.log(`\n🔍 Scanning: ${decodeURIComponent(query.replace(/\+/g, ' '))}`);

    let pageNum = 1;

    while (!_shouldStop) {
      const url = pageNum === 1
        ? `${BASE_URL}/find_a_job/?srch=${query}&orderby=recent&filterby=&filterbyremote=0`
        : `${BASE_URL}/jobs/find_a_job/${pageNum}/?srch=${query}&orderby=recent&filterby=&filterbyremote=0`;

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        await page.waitForTimeout(1500);

        const jobs = await page.evaluate((baseUrl) => {
          const cards = [...document.querySelectorAll('div.job-listing, div.result, li.job-result')];
          return cards.map(card => {
            // Job ID and detail URL from title link href: /jobs/.../job-527407/
            const titleLink = card.querySelector('h3 a, .job-title a, a[href*="/job-"]');
            if (!titleLink) return null;
            const href     = titleLink.getAttribute('href') || '';
            const idMatch  = href.match(/job-(\d+)/i);
            if (!idMatch) return null;

            const id        = idMatch[1];
            const title     = titleLink.textContent.trim();
            const detailUrl = href.startsWith('http') ? href : `${baseUrl}${href}`;
            const location  = (card.querySelector('.location, .job-location') || {}).textContent?.trim() || '';

            // Detect already-applied — logged-in IG shows "Applied" button/badge
            const applyBtn     = card.querySelector('a.apply-btn, button.apply-btn, .apply-button, a[class*="apply"]');
            const btnText      = applyBtn ? applyBtn.textContent.trim() : '';
            const hasAppliedEl = !!card.querySelector('.applied, [class*="already-applied"]');
            const alreadyApplied = /\bapplied\b/i.test(btnText) || hasAppliedEl;

            let posted = (card.querySelector('.posted-date, .date') || {}).textContent?.trim() || '';
            try {
              // JSON embedded in <script type="application/json"> or hidden div
              const scriptTag = card.querySelector('script[type="application/json"]');
              const jsonDiv   = card.querySelector('div[style*="display:none"]');
              const raw       = scriptTag ? scriptTag.textContent : (jsonDiv ? jsonDiv.textContent : '');
              const data      = raw ? JSON.parse(raw) : {};
              if (data.PostedDate) {
                const ms = parseInt((data.PostedDate.match(/\d+/) || [])[0]);
                if (!isNaN(ms)) posted = new Date(ms).toISOString();
              }
            } catch (_) {}

            return { id, title, company: 'Insight Global', location, posted, url: detailUrl };
          }).filter(Boolean);
        }, BASE_URL);

        if (jobs.length === 0) break;

        // Mark already-applied jobs in local DB (must be done outside page.evaluate)
        jobs.filter(j => j.alreadyApplied).forEach(j => appliedJobs.add(j.id));

        const validJobs = jobs.filter(j => !j.alreadyApplied);
        const freshJobs = validJobs.filter(j => isWithinMaxAge(j.posted));
        console.log(`   Page ${pageNum}: ${jobs.length} jobs | ${jobs.length - validJobs.length} already applied | ${freshJobs.length} fresh`);

        for (const j of validJobs) {
          if (!seen.has(j.id)) seen.set(j.id, j);
        }

        // Stop paginating if no fresh jobs — IG sorts newest first
        if (freshJobs.length === 0) break;

        const hasNext = await page.$('a.page-link[title="Page Forward"]');
        if (!hasNext) break;

        pageNum++;
      } catch (e) {
        console.warn(`   ⚠️  Page ${pageNum} error: ${e.message}`);
        break;
      }
    }
  }

  return [...seen.values()];
}

// ─── APPLY ────────────────────────────────────────────────────────────────────

async function applyToJob(workerId, page, job) {
  const applyUrl = `${BASE_URL}/users/jobapply.aspx?jobid=${job.id}`;
  wlog(workerId, `→ ${job.title} — ID ${job.id}`);

  try {
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await page.waitForTimeout(2000);

    if (!page.url().includes('jobapply')) {
      wlog(workerId, `⚠️  Redirected away (${page.url()})`);
      return 'FAILED';
    }

    // Select pre-loaded resume radio button (first radio in resume section)
    const resumeRadio = await page.$('input[type="radio"][name*="esume"], input[type="radio"][id*="esume"]');
    if (resumeRadio) {
      await resumeRadio.check();
      wlog(workerId, `📄 Resume selected`);
      await page.waitForTimeout(500);
    } else {
      wlog(workerId, `⚠️  Resume radio not found`);
    }

    // Click "Yes" for minimum requirements
    const yesRadio = await page.$(
      '#ContentPlaceHolder1_chkMinReq_0, input[type="radio"][value="1"], input[type="radio"][id*="MinReq_0"]'
    );
    if (yesRadio) {
      await yesRadio.check();
      wlog(workerId, `✅ Min requirements → Yes`);
      await page.waitForTimeout(500);
    }

    // Submit
    const submitBtn = await page.$(
      '#ContentPlaceHolder1_cmdApply, input[type="submit"][value*="Apply" i], button[type="submit"]'
    );
    if (!submitBtn) {
      wlog(workerId, `❌ Submit button not found`);
      return 'FAILED';
    }

    await submitBtn.click();
    await page.waitForTimeout(3000);

    const bodyText = await page.evaluate(() => document.body.innerText);
    if (/thank you|application submitted|successfully applied|application received|we.ve received/i.test(bodyText)) {
      wlog(workerId, `✅ Applied successfully`);
      return 'APPLIED';
    }
    if (/error|invalid|required field/i.test(bodyText)) {
      wlog(workerId, `❌ Form error`);
      return 'FAILED';
    }

    wlog(workerId, `❓ No clear confirmation — UNCERTAIN`);
    return 'UNCERTAIN';

  } catch (e) {
    wlog(workerId, `❌ Exception: ${e.message}`);
    return 'FAILED';
  }
}

// ─── WORKER ───────────────────────────────────────────────────────────────────

async function runWorker(workerId, context, appliedJobs, startDelay) {
  await new Promise(r => setTimeout(r, startDelay));
  updateStatus(workerId, 'STARTING');

  const page = await context.newPage();

  while (!_shouldStop) {
    const job = getNextJob();
    if (!job) break;

    updateStatus(workerId, 'APPLYING', job.title);

    const result = await applyToJob(workerId, page, job);

    markApplied(job.id);
    appliedJobs.add(job.id);
    stats.total++;

    if (result === 'APPLIED') {
      stats.applied++;
      writeAppliedEntry(workerId, job.title, job.company, job.id, 'APPLIED', job.url);
    } else if (result === 'UNCERTAIN') {
      stats.uncertain++;
      writeAppliedEntry(workerId, job.title, job.company, job.id, 'UNCERTAIN', job.url);
      writeFailedEntry(workerId, job.title, job.company, job.id, 'UNCERTAIN', '', job.url);
    } else {
      stats.failed++;
      writeAppliedEntry(workerId, job.title, job.company, job.id, 'FAILED', job.url);
      writeFailedEntry(workerId, job.title, job.company, job.id, 'FAILED', '', job.url);
    }

    if (stats.applied + stats.failed + stats.uncertain >= MAX_JOBS) {
      _shouldStop = true;
      break;
    }

    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  await page.close().catch(() => {});
  updateStatus(workerId, 'DONE');
  wlog(workerId, `Worker done`);
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

function printDashboard() {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 DASHBOARD — ${new Date().toLocaleTimeString()}`);
  console.log(`   ✅ Applied: ${stats.applied}  ⏭️  Skipped: ${stats.skipped}  ❌ Failed: ${stats.failed}  ❓ Uncertain: ${stats.uncertain}`);
  console.log(`   📋 Queue: ${queueIndex}/${jobQueue.length} processed`);
  for (const [id, s] of Object.entries(workerStatus)) {
    console.log(`   ${id}: [${s.state}] ${s.job || '-'}`);
  }
  console.log(`${'─'.repeat(60)}\n`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function runBot(durationMinutes) {
  const startTime = Date.now();
  const endTime   = startTime + durationMinutes * 60 * 1000;

  ensureDir(APPLIED_FILE);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🤖 Insight Global Bot — ${NUM_WORKERS} Workers`);
  console.log(`⏱️  Duration: ${durationMinutes} min | Stop at: ${new Date(endTime).toLocaleTimeString()}`);
  console.log(`📂 Profile : ${PROFILE_DIR}`);
  console.log(`${'═'.repeat(60)}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const pages    = context.pages();
  const mainPage = pages.length > 0 ? pages[0] : await context.newPage();

  await ensureLoggedIn(mainPage);

  let appliedJobs = loadAppliedJobs();
  console.log(`\n📂 Loaded ${appliedJobs.size} previously applied jobs`);

  const dashInterval = setInterval(printDashboard, 30000);

  try {
    while (Date.now() < endTime && !_shouldStop) {
      jobQueue   = [];
      queueIndex = 0;

      const allJobs  = await scanAllJobs(mainPage);
      const queuedIds = new Set();

      for (const job of allJobs) {
        if (appliedJobs.has(job.id))    continue;
        if (!isWithinMaxAge(job.posted)) { stats.skipped++; continue; }
        if (queuedIds.has(job.id))      continue;
        jobQueue.push(job);
        queuedIds.add(job.id);
      }

      writeScannedJobs(allJobs, queuedIds, appliedJobs);
      console.log(`\n📋 ${jobQueue.length} new jobs to apply | ${allJobs.length - jobQueue.length} skipped`);

      if (jobQueue.length === 0) {
        console.log(`   ⏸️  Nothing new — rescanning in ${RESCAN_WAIT_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, RESCAN_WAIT_MS));
        continue;
      }

      initAppliedFile(jobQueue.length);

      await Promise.all(
        Array.from({ length: NUM_WORKERS }, (_, i) =>
          runWorker(`W${i + 1}`, context, appliedJobs, i * 2000)
        )
      );

      printDashboard();

      console.log(`\n✅ All workers done. Exiting.`);
      break;
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
  console.log(`Scanned → ${SCANNED_FILE}`);
  console.log(`Applied → ${APPLIED_FILE}`);
  console.log(`${'═'.repeat(60)}\n`);
}

// ─── LOGIN MODE ───────────────────────────────────────────────────────────────

async function loginMode() {
  console.log(`\n🔐 LOGIN MODE — Profile: ${PROFILE_DIR}`);
  console.log(`   Opening browser — log in to jobs.insightglobal.com, then press ENTER here\n`);
  const ctx  = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(IG_LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  process.stdin.resume();
  await new Promise(r => process.stdin.once('data', r));
  await ctx.close();
  console.log(`\n✅ Session saved. Run: node insightglobal-bot.js 240\n`);
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
      const btn = document.querySelector('button[type="submit"], input[type="submit"]');
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
  loginMode().catch(e => { console.error(e); process.exit(1); });
} else if (arg === 'test') {
  MAX_JOBS = 1;
  console.log('[test] Single-job test mode — will stop after 1 application attempt.');
  runBot(null).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else if (arg === 'formtest') {
  const url = process.argv[3];
  if (!url) { console.error('[err] Usage: node insightglobal-bot.js formtest <applyUrl>'); process.exit(1); }
  formTestMode(url).catch(e => { console.error(e.stack || e.message); process.exit(1); });
} else {
  const minutes = parseInt(arg, 10);
  if (!minutes || minutes < 1) {
    console.log('Usage:');
    console.log('  node insightglobal-bot.js login     ← save session once');
    console.log('  node insightglobal-bot.js 240       ← run for 240 minutes');
    console.log('  node insightglobal-bot.js test      ← single-job test');
    console.log('  node insightglobal-bot.js formtest <url>  ← form inspector');
    process.exit(1);
  }
  runBot(minutes).catch(e => { console.error(e); process.exit(1); });
}
