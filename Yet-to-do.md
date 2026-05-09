# Yet-to-do.md — Job Application Automation Expansion Plan

## Status Legend
- ✅ Bot exists and working
- 🔬 Researched, ready to build
- ⚠️ Researched, has constraints
- ❓ Not yet researched
- 🚫 Not recommended for automation

---

## Platform Inventory

| Platform | URL | Status | Automation Tier | ATS |
|---|---|---|---|---|
| RobertHalf | roberthalf.com | ✅ Done | — | Custom |
| Dice | dice.com | ✅ Done | — | Custom |
| TekSystems | careers.teksystems.com | 🔬 Researched | Medium | Phenom People |
| Matlen Silver | matlensilver.com | 🔬 Easy | 1 – Easiest | WPJobBoard (WordPress) |
| Collabera | collabera.com | 🔬 Easy | 1 – Easiest | Custom WordPress |
| S3 Strategic Staffing | careers.strategicstaff.com | 🔬 Easy | 1 – Easiest | SmartRecruiters + Bullhorn |
| Vaco | jobs.vaco.com | 🔬 Easy | 2 – Easy | Custom + Bullhorn |
| Yoh | jobs.yoh.com | 🔬 Medium | 2 – Medium | Shazamme + Bullhorn |
| Hays | hays.com | ⚠️ Login | 3 – Needs Account | Proprietary |
| Insight Global | jobs.insightglobal.com | 🚫 Hard | 4 – Skip for now | Custom ASP.NET |
| Apex Systems | itcareers.apexsystems.com | ⚠️ WAF | 4 – Hard | Phenom People |
| Experis | experis.com | ⚠️ Login | 3 – Needs Account | ManpowerGroup/WebSphere |
| Modis | modis.com | ❓ Not researched | — | — |
| Kforce | kforce.com | ❓ Not researched | — | — |
| Randstad Tech | randstadusa.com | ❓ Not researched | — | — |

---

## Tier 1 — Build First (No Login, No CAPTCHA, Date Filter Exists)

### Matlen Silver — matlensilver.com/it-jobs/
- **ATS:** WPJobBoard (WordPress plugin)
- **Job loading:** Static server-rendered HTML — no JS needed
- **Job URL:** `matlensilver.com/job/[title-slug]-[id]/`
- **Search URL:** `matlensilver.com/jobs/advanced-search/?keyword=data+scientist&date=0`
- **Date filter:** `date=0` = since yesterday ✅
- **Login required:** No
- **Apply form:** Inline on same page — Name, Email, Message, Resume upload (3MB limit)
- **CAPTCHA:** None detected
- **Strategy:** HTTP GET search page → parse job links → Playwright fill inline form → upload resume → submit
- **Similarity to existing bots:** Very similar to RobertHalf pattern; simplest form possible

### Collabera — collabera.com/job-search/
- **ATS:** Custom WordPress
- **Job loading:** Static server-rendered HTML
- **Job URL:** `collabera.com/job-description/?post=[id]`
- **Search URL:** `collabera.com/job-search/?sort_by=dateposted&keyword=data+scientist&Posteddays=1`
- **Date filter:** `Posteddays=1` = last 24 hours ✅
- **Login required:** No
- **Apply form:** JS modal (triggered by "Apply" button) or redirect to `/submit-resume/` — minimal fields
- **CAPTCHA:** None detected
- **Strategy:** Playwright loads search page (static) → collect job links → navigate each → click Apply → handle modal → upload resume

### S3 Strategic Staffing — careers.strategicstaff.com
- **ATS:** SmartRecruiters (front-end) + Bullhorn (back-end)
- **Job loading:** Two options:
  1. Static HTML at careers.strategicstaff.com (server-rendered, 4-field form)
  2. **SmartRecruiters public REST API** (best for discovery):
     `https://api.smartrecruiters.com/v1/companies/StrategicStaffingSolutionsS3/postings?limit=100&updatedAfter=2026-04-19T00:00:00Z`
- **Date filter:** SmartRecruiters API has `updatedAfter` ISO 8601 param ✅
- **Login required:** No (careers.strategicstaff.com path)
- **Apply form:** Name, Email, Resume only — 4 fields total (3MB limit)
- **CAPTCHA:** None detected
- **Strategy:** Hit SmartRecruiters API to get fresh job IDs → navigate individual job pages on careers.strategicstaff.com → fill 4-field inline form

---

## Tier 2 — Build Second (Slightly Harder but Doable)

### Vaco — jobs.vaco.com
- **ATS:** Custom front-end over Bullhorn
- **Job loading:** JS-rendered but has REST API: `jobs.vaco.com/api/requisitions/search?page=1&keyword=data+scientist&category=Technology`
- **Job URL:** `jobs.vaco.com/job/[id]/[title-slug]/en`
- **Date filter:** No UI filter, but jobs have posted dates — filter client-side
- **Login required:** No
- **Apply form:** Inline on page — Name, Last Name, Email, Phone, Resume (⚠️ **512KB limit**)
- **CAPTCHA:** None detected
- **Key constraint:** 512KB resume limit — resume must be kept minimal/compressed
- **Strategy:** Playwright renders page → API call to get jobs → filter by date on client side → apply inline form

### Yoh — jobs.yoh.com
- **ATS:** Shazamme + Bullhorn
- **Job loading:** SPA with hash routing (`/#/jobs`) — JS-only, no static HTML
- **Job URL:** `jobs.yoh.com/#/jobs/[id]` (hash-based)
- **Search:** `jobs.yoh.com/#/jobs?keyword=data+scientist`
- **Date filter:** No date filter in UI
- **Login required:** Unclear — guest apply may work
- **Apply form:** On-page after clicking Apply Now — Name, Email, Phone, Resume, optional self-ID fields
- **CAPTCHA:** None detected
- **Strategy:** Playwright must fully render SPA → wait for job list → collect job links → navigate each → fill form → need to probe whether guest apply works without account

### TekSystems — careers.teksystems.com
- **ATS:** Phenom People
- **Research:** See `TekSystems/RESEARCH.md` for full details
- **Strategy:** Phenom People pattern similar to research notes; direct apply URL bypass being investigated

---

## Tier 3 — Needs Pre-Created Accounts

### Hays — hays.com/job-search/
- **ATS:** Proprietary
- **Job URL:** `hays.com/job-detail/[title-location]_[id]`
- **Search URL:** `hays.com/job-search/?q=data+scientist&countryCode=US`
- **Date filter:** Sort by date only (no granular 24h filter)
- **Login required:** Yes — "Apply with Hays" needs account; "Apply with LinkedIn" alternative
- **Apply form:** Unknown (behind auth)
- **CAPTCHA:** None detected
- **What's needed:** Create a Hays account manually once → save session/cookies → bot reuses session
- **LinkedIn path:** Could use LinkedIn Easy Apply but requires managing LinkedIn OAuth

### Experis — experis.com/en/search
- **ATS:** ManpowerGroup/IBM WebSphere
- **Job URL:** `experis.com/en/job/[id]/[slug]`
- **Search URL:** `experis.com/en/search?searchKeyword=data+scientist`
- **Date filter:** None in URL params — date shown on detail page as `MM/DD/YYYY`, must parse
- **Login required:** Yes — "My Experis" account mandatory
- **Apply form:** Behind WebSphere Portal auth (complex session tokens)
- **What's needed:** Create account manually → save session → bot applies via authenticated session
- **Risk:** WebSphere Portal session management is fragile for automation

---

## Tier 4 — Skip for Now

### Insight Global — jobs.insightglobal.com
- **Why skip:** ASP.NET WebForms (hidden ViewState tokens), recruiter-mediated (no self-service apply), login mandatory, URL patterns opaque
- **Revisit if:** They add a self-service apply option

### Apex Systems — itcareers.apexsystems.com
- **Why skip:** Cloudflare WAF blocks all headless requests (returns 403), Phenom People with encrypted apply tokens, no date filter confirmed
- **Revisit with:** `playwright-extra` stealth plugin + residential proxy

---

## Not Yet Researched

| Platform | URL | Notes |
|---|---|---|
| Modis | modis.com/en-us/job-seekers/search-jobs/ | Adecco group brand |
| Kforce | kforce.com/find-work/search-jobs/ | Major tech staffing firm |
| Randstad Tech | randstadusa.com/jobs/ | Large staffing, likely iCIMS or Workday |

---

## Architecture Plan for New Bots

All new bots should follow the same architecture as the existing RobertHalf/Dice bots:

```
1. Session login (one-time, saves ~/.{platform}-bot-profile)
2. Run mode:
   ├── 4 parallel Playwright workers
   ├── Shared job queue
   ├── applied_ids.txt for deduplication
   ├── 8-second rate limit between applications per worker
   ├── Rescan search every 90 seconds for new jobs
   └── Graceful Ctrl+C shutdown
3. Output files per bot directory:
   ├── applied_jobs.txt
   ├── scanned_jobs.txt
   ├── failed_jobs.txt
   └── applied_ids.txt
```

For Tier 1 platforms (Matlen Silver, Collabera, S3): can skip login step — guest apply works.

### Local LLM Usage
For sites that have open-ended questions or cover letter fields, pipe them through the local LLM (Ollama) to generate tailored responses. The LLM should receive: job title, job description, question text → return a concise answer. Keep responses under 200 words for text fields.

---

## Open Questions (Need Answers Before Building)

1. **Resume format:** What format and file size is your resume? (PDF preferred; Vaco hard-limits at 512KB)
2. **Geographic preference:** Remote only? Open to hybrid/onsite in specific cities?
3. **Job titles to search:** Beyond "Data Scientist" and "ML Engineer" — include "Data Engineer", "AI Engineer", "NLP Engineer", "MLOps", "Analytics Engineer"?
4. **Local LLM setup:** What's running on Ollama? (model name + is it fast enough for real-time answers during apply?)
5. **Cover letter:** Use a generic one for all applications, or have the LLM customize per job description?
6. **Accounts to create:** For Hays and Experis, will you create accounts manually and let the bot reuse sessions? (Same flow as existing bots — `node bot.js login` once)
7. **Priority order:** Should Tier 1 bots (Matlen, Collabera, S3) be built before finishing TekSystems?
8. **Failed job handling:** Same as current bots — open in browser for manual review at session end?

---

## Suggested Build Order

1. **S3 Bot** — SmartRecruiters API makes job discovery trivial; 4-field apply form; builds confidence
2. **Matlen Silver Bot** — Static HTML + date=0 filter + inline form; almost identical to RobertHalf in complexity
3. **Collabera Bot** — Same static HTML approach; just need to confirm the apply modal behavior
4. **TekSystems Bot** — Phenom People; RESEARCH.md already exists; just needs implementation
5. **Vaco Bot** — REST API discovery + inline form; watch the 512KB resume constraint
6. **Yoh Bot** — SPA needs Playwright; probe guest apply first
7. **Hays Bot** — After account creation
8. **Experis Bot** — After account creation; more fragile due to WebSphere
