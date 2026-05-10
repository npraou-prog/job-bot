# Graph Report - .  (2026-05-03)

## Corpus Check
- 72 files · ~378,528 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 603 nodes · 1072 edges · 43 communities detected
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 53 edges (avg confidence: 0.85)
- Token cost: 97,000 input · 7,700 output

## Community Hubs (Navigation)
- [[_COMMUNITY_April 2026 Cross-Platform Campaign|April 2026 Cross-Platform Campaign]]
- [[_COMMUNITY_Candidate Profile & Materials|Candidate Profile & Materials]]
- [[_COMMUNITY_Dice Bot & Output Infrastructure|Dice Bot & Output Infrastructure]]
- [[_COMMUNITY_ATS Platform Research|ATS Platform Research]]
- [[_COMMUNITY_RobertHalf Bot Functions|RobertHalf Bot Functions]]
- [[_COMMUNITY_Randstad Bot Functions|Randstad Bot Functions]]
- [[_COMMUNITY_Collabera Bot Functions|Collabera Bot Functions]]
- [[_COMMUNITY_Kforce Bot Apply Flow|Kforce Bot Apply Flow]]
- [[_COMMUNITY_InsightGlobal Bot Functions|InsightGlobal Bot Functions]]
- [[_COMMUNITY_Vaco Bot REST API Apply|Vaco Bot REST API Apply]]
- [[_COMMUNITY_S3Strategic Bot Functions|S3Strategic Bot Functions]]
- [[_COMMUNITY_MatlenSilver Bot Functions|MatlenSilver Bot Functions]]
- [[_COMMUNITY_Yoh Bot Functions|Yoh Bot Functions]]
- [[_COMMUNITY_Bot Expansion Planning|Bot Expansion Planning]]
- [[_COMMUNITY_TekSystems Bot Functions|TekSystems Bot Functions]]
- [[_COMMUNITY_Randstad Session Logs|Randstad Session Logs]]
- [[_COMMUNITY_CollaberaS3 Slim Functions|Collabera/S3 Slim Functions]]
- [[_COMMUNITY_Randstad-DS Bot Functions|Randstad-DS Bot Functions]]
- [[_COMMUNITY_Job Application Form UI|Job Application Form UI]]
- [[_COMMUNITY_Application Failure Patterns|Application Failure Patterns]]
- [[_COMMUNITY_RobertHalf Empty Sessions|RobertHalf Empty Sessions]]
- [[_COMMUNITY_RobertHalf Uncertain Sessions|RobertHalf Uncertain Sessions]]
- [[_COMMUNITY_Randstad-DS Skip Pattern|Randstad-DS Skip Pattern]]
- [[_COMMUNITY_Job Title Variants|Job Title Variants]]
- [[_COMMUNITY_RobertHalf Live Reports|RobertHalf Live Reports]]
- [[_COMMUNITY_RobertHalf Live Reports|RobertHalf Live Reports]]
- [[_COMMUNITY_RobertHalf Live Reports|RobertHalf Live Reports]]
- [[_COMMUNITY_RobertHalf Live Reports|RobertHalf Live Reports]]
- [[_COMMUNITY_RobertHalf Live Reports|RobertHalf Live Reports]]
- [[_COMMUNITY_Generic Job Titles|Generic Job Titles]]
- [[_COMMUNITY_Generic Job Titles|Generic Job Titles]]
- [[_COMMUNITY_Generic Job Titles|Generic Job Titles]]
- [[_COMMUNITY_Generic Job Titles|Generic Job Titles]]
- [[_COMMUNITY_RobertHalf Session Logs|RobertHalf Session Logs]]
- [[_COMMUNITY_RobertHalf Session Logs|RobertHalf Session Logs]]
- [[_COMMUNITY_Application Outcomes|Application Outcomes]]
- [[_COMMUNITY_RobertHalf Live Reports|RobertHalf Live Reports]]
- [[_COMMUNITY_RobertHalf Live Reports|RobertHalf Live Reports]]
- [[_COMMUNITY_RobertHalf Live Reports|RobertHalf Live Reports]]
- [[_COMMUNITY_RobertHalf Live Reports|RobertHalf Live Reports]]
- [[_COMMUNITY_Kforce Session Logs|Kforce Session Logs]]
- [[_COMMUNITY_Kforce Session Logs|Kforce Session Logs]]
- [[_COMMUNITY_Kforce Session Logs|Kforce Session Logs]]

## God Nodes (most connected - your core abstractions)
1. `Robert Half Job Platform` - 22 edges
2. `Candidate: Nikhil Premachandra Rao` - 18 edges
3. `RobertHalf.com Bot (roberthalf-bot.js)` - 16 edges
4. `Dice Job Automation Agent Spec` - 14 edges
5. `Randstad USA Job Platform` - 13 edges
6. `applyToJob()` - 12 edges
7. `Matlen Silver Job Platform` - 12 edges
8. `runBot()` - 11 edges
9. `applyToJob()` - 11 edges
10. `ensureDir()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `Skill: Generative AI and LLM Engineering (RAG, Prompt Engineering, LLM Agents, Embeddings)` --semantically_similar_to--> `Kforce Job: Data Scientist`  [INFERRED] [semantically similar]
  Nikhil_Resume.pdf → Kforce/scanned_jobs 2.txt
- `Skill: Machine Learning and AI Engineering (Deep Learning, NLP, Forecasting, Anomaly Detection)` --semantically_similar_to--> `Kforce Job: Data Scientist`  [INFERRED] [semantically similar]
  Nikhil_Resume.pdf → Kforce/scanned_jobs 2.txt
- `Cover Letter Target Role: Data Scientist` --semantically_similar_to--> `Kforce Job: Data Scientist`  [INFERRED] [semantically similar]
  Nikhil_Rao_Cover_Letter.pdf → Kforce/scanned_jobs 2.txt
- `Skill: Machine Learning and AI Engineering (Deep Learning, NLP, Forecasting, Anomaly Detection)` --semantically_similar_to--> `Kforce Job: Senior Data Scientist`  [INFERRED] [semantically similar]
  Nikhil_Resume.pdf → Kforce/scanned_jobs 2.txt
- `Skill: Generative AI and LLM Engineering (RAG, Prompt Engineering, LLM Agents, Embeddings)` --semantically_similar_to--> `Kforce Job: AI Engineer / Applied Data Scientist`  [INFERRED] [semantically similar]
  Nikhil_Resume.pdf → Kforce/scanned_jobs 2.txt

## Hyperedges (group relationships)
- **All Bot Output File Logs (Applied, Scanned, Failed across RobertHalf, Dice, MatlenSilver)** — roberthalf_applied_jobs, dice_applied_jobs, matlensilver_applied_jobs, roberthalf_scanned_jobs, dice_scanned_jobs, matlensilver_scanned_jobs [EXTRACTED 1.00]
- **Tier 1 Build Candidates (Matlen Silver, Collabera, S3 - No Login Required)** — yet_to_do_matlen_silver_spec, yet_to_do_collabera_spec, yet_to_do_s3_spec [EXTRACTED 1.00]
- **Bullhorn-Integrated Platforms (S3, Vaco, Yoh share Bullhorn backend)** — yet_to_do_s3_spec, yet_to_do_vaco_spec, yet_to_do_yoh_spec [EXTRACTED 1.00]
- **Bot Output File System (applied, scanned, failed logs shared by both bots)** — claude_md_applied_jobs_txt, claude_md_scanned_jobs_txt, claude_md_failed_jobs_txt [EXTRACTED 1.00]
- **Three-Platform Job Application Automation Suite (Dice, RobertHalf, TekSystems)** — claude_md_dice_bot, claude_md_roberthalf_bot, claude_md_teksystems_bot [EXTRACTED 1.00]
- **Randstad Bot Output Files: Applied + Scanned + Failed Logs** — randstad_applied_jobs, randstad_scanned_jobs, randstad_failed_jobs [EXTRACTED 0.95]
- **Session Tally Integrity: All Outcomes Sum to Scanned Total** — session_tally_check, roberthalf_session_20260423_stats, roberthalf_session_20260421_stats, roberthalf_worker_pool [INFERRED 0.82]
- **Cross-Platform UNCERTAIN Status Pattern (submitted but no confirmation detected on RobertHalf, MatlenSilver, Dice)** — roberthalf_report_20260422_uncertain_confirmation, matlensilver_uncertain_status, dice_failed_jobs_log_uncertain [INFERRED 0.88]
- **Cross-Platform UNCERTAIN Status Pattern (RobertHalf Apr 24 + Dice Apr 10 — submitted but no confirmation detected)** — roberthalf_uncertain_status, dice_uncertain_status, roberthalf_report_20260424, dice_failed_jobs_log [INFERRED 0.88]
- **Dice Sub-Agent Processing Pipeline (Scanner to Handler to Logger)** — dice_sub_agent_scanner, dice_sub_agent_handler, dice_sub_agent_logger [EXTRACTED 1.00]
- **Job Application Submission Flow** — pre_submit_screenshot_apply_now_form, pre_submit_screenshot_applicant_nikhil, pre_submit_screenshot_nikhil_resume, pre_submit_screenshot_apply_for_role_button [INFERRED 0.85]
- **Job Listing Content** — pre_submit_screenshot_hybrid_working_conditions, pre_submit_screenshot_job_skills, pre_submit_screenshot_microsoft_products_skill, pre_submit_screenshot_strategic_staff [EXTRACTED 1.00]
- **Parallel 4-Worker Apply Pattern Fleet** — dice_bot, roberthalf_bot, randstad_bot, vaco_bot, matlensilver_bot, kforce_bot, teksystems_bot, yoh_bot, parallel_worker_loop, job_queue_dedup [EXTRACTED 1.00]
- **Bullhorn-Backed Staffing Bot Integration** — vaco_bot, yoh_bot, ats_bullhorn, vaco_rest_api [EXTRACTED 1.00]
- **Multi-Step Form Navigation Pattern Cluster** — roberthalf_bot, vaco_bot, kforce_bot, teksystems_bot, yoh_bot, navigate_apply_form, answer_screening_questions [EXTRACTED 1.00]
- **Data Scientist Applications Across Multiple Platforms** — jobtitle_data_scientist, platform_roberthalf, platform_dice, platform_randstad [EXTRACTED 1.00]
- **Data Engineer Applications Across Multiple Platforms** — jobtitle_data_engineer, platform_roberthalf, platform_randstad, platform_matlensilver [EXTRACTED 1.00]
- **April 2026 Job Application Campaign Across All Platforms** — activity_date_range_april2026, platform_roberthalf, platform_matlensilver, platform_randstad, platform_dice [EXTRACTED 1.00]
- **Kforce Session Output File Trio (Applied, Scanned, Failed logs)** — kforce_applied_jobs_log, kforce_scanned_jobs_log_2, kforce_failed_jobs_log [EXTRACTED 1.00]
- **Kforce Cross-Session Error Pattern (Apply button not found + No confirmation across sessions 21:11, 21:18, 21:25)** — kforce_session_2111, kforce_session_2118, kforce_session_2125, kforce_error_apply_button_not_found, kforce_error_no_confirmation [EXTRACTED 0.95]
- **Candidate Profile to Kforce Target Role Alignment (Resume + Cover Letter + Kforce Data Scientist jobs)** — resume_candidate_nikhil, cover_letter_target_role, kforce_job_data_scientist, kforce_job_ai_engineer_applied_ds, kforce_job_mlops_engineer [INFERRED 0.87]

## Communities

### Community 0 - "April 2026 Cross-Platform Campaign"
Cohesion: 0.04
Nodes (71): Primary Activity Window: April 2026, Dice Applied Jobs Log, Dice Scanned Jobs Log, Already-Applied Deduplication Filter, AI/ML Engineer, Business Intelligence Analyst, Business Analyst, Cloud Data Engineer (+63 more)

### Community 1 - "Candidate Profile & Materials"
Cohesion: 0.05
Nodes (58): Cover Letter Theme: Cross-Functional Collaboration and Outcomes Focus, Cover Letter Domain Focus: FinTech and Healthcare AI, Nikhil Rao Cover Letter PDF, Cover Letter Target Role: Data Scientist, Cover Letter Value Proposition: Production AI Engineering, RAG, LLM Agents, Business Impact, Community: Bot Expansion Planning, Community: Dice Bot Core Architecture, Community: Resume and Candidate Profile (+50 more)

### Community 2 - "Dice Bot & Output Infrastructure"
Cohesion: 0.07
Nodes (43): applied_ids.txt Deduplication File, applied_jobs.txt Output Log, Dice.com Bot (dice-bot.js), failed_jobs.txt Output Log, Job Application Automation Suite, Shared Job Queue, 4 Parallel Playwright Workers, Persistent Browser Session (+35 more)

### Community 3 - "ATS Platform Research"
Cohesion: 0.15
Nodes (35): Auto-Answer Screening Questions Pattern, Bullhorn ATS Platform, Phenom People ATS Platform, SmartRecruiters ATS Platform, WPJobBoard ATS (WordPress Plugin), Brian Multi-ATS Bot (multiats-bot.js), Collabera Bot, CONFIRM_RE Post-Submit Confirmation Detection (+27 more)

### Community 4 - "RobertHalf Bot Functions"
Cohesion: 0.14
Nodes (33): answerQuestions(), applyToJob(), buildLocationUrls(), checkJobSuitability(), ensureDir(), extractJobsFromPage(), findAndClickApply(), formTestMode() (+25 more)

### Community 5 - "Randstad Bot Functions"
Cohesion: 0.13
Nodes (31): answerQuestions(), applyToJob(), buildLocationUrls(), checkJobSuitability(), ensureDir(), extractJobsFromPage(), findAndClickEasyApply(), formTestMode() (+23 more)

### Community 6 - "Collabera Bot Functions"
Cohesion: 0.16
Nodes (31): answerScreeningQuestions(), applyToJob(), buildApplyUrl(), buildSearchUrl(), ensureDir(), extractJobsFromPage(), fillInput(), fillPersonalInfo() (+23 more)

### Community 7 - "Kforce Bot Apply Flow"
Cohesion: 0.15
Nodes (26): applyToJob(), clickApplyWithKforce(), decodeSlug(), ensureDir(), extractJobsFromPage(), fillApplyForm(), formTestMode(), getNextJob() (+18 more)

### Community 8 - "InsightGlobal Bot Functions"
Cohesion: 0.16
Nodes (26): applyToJob(), buildSearchUrl(), ensureDir(), extractJobsFromPage(), fillApplyForm(), fillEEO(), findAndClickApply(), formTestMode() (+18 more)

### Community 9 - "Vaco Bot REST API Apply"
Cohesion: 0.17
Nodes (26): answerQuestions(), applyToJob(), buildJobUrl(), ensureDir(), fetchVacoJobsPage(), fillApplyForm(), findAndClickApply(), formTestMode() (+18 more)

### Community 10 - "S3Strategic Bot Functions"
Cohesion: 0.17
Nodes (22): applyToJob(), clickButton(), ensureDir(), extractJobsFromPage(), fillField(), formTestMode(), getTotalResultCount(), initAppliedFile() (+14 more)

### Community 11 - "MatlenSilver Bot Functions"
Cohesion: 0.19
Nodes (23): applyToJob(), buildSearchUrl(), ensureDir(), extractJobsFromPage(), fillField(), getNextJob(), initAppliedFile(), initLogFile() (+15 more)

### Community 12 - "Yoh Bot Functions"
Cohesion: 0.21
Nodes (22): applyToJob(), clickButton(), ensureDir(), extractJobsFromPage(), fillField(), getNextJob(), initAppliedFile(), isWithin24Hours() (+14 more)

### Community 13 - "Bot Expansion Planning"
Cohesion: 0.11
Nodes (23): Apex Systems Skip Rationale (Cloudflare WAF 403, Encrypted Apply Tokens), Architecture Plan for New Bots (4 Workers, Shared Queue, Output Files), Suggested Build Order: S3, Matlen, Collabera, TekSystems, Vaco, Yoh, Hays, Experis, Bullhorn Backend ATS (S3, Vaco, Yoh), Collabera Bot Spec (Custom WordPress, JS Modal Apply), Yet-to-do: Job Application Automation Expansion Plan, Experis Bot Spec (ManpowerGroup WebSphere, Fragile Sessions), Hays Bot Spec (Proprietary ATS, Login Required) (+15 more)

### Community 14 - "TekSystems Bot Functions"
Cohesion: 0.2
Nodes (18): applyToJob(), ensureDir(), ensureLoggedIn(), getNextJob(), initAppliedFile(), isWithinMaxAge(), loadAppliedJobs(), markApplied() (+10 more)

### Community 15 - "Randstad Session Logs"
Cohesion: 0.12
Nodes (18): Randstad Applied Jobs Log, Randstad Bot Session, Randstad Failed Jobs Log, Randstad Job Title Filter (FILTERED vs QUEUED), Randstad Uncertain Error: No Submit Button Found, Randstad Scan: 303 Jobs Found (290 Filtered, 13 Queued), Randstad Scanned Jobs Log, Randstad Session Stats 2026-04-21 (+10 more)

### Community 16 - "Collabera/S3 Slim Functions"
Cohesion: 0.41
Nodes (13): applyToJob(), buildSearchUrl(), clickApplyAndExpandForm(), err(), extractJobsFromPage(), fillAndSubmitForm(), fillField(), formTestMode() (+5 more)

### Community 17 - "Randstad-DS Bot Functions"
Cohesion: 0.31
Nodes (8): applyToJob(), debugLogInputs(), fillField(), formTestMode(), main(), scrapeJobListings(), selectTargetJob(), waitForEnter()

### Community 18 - "Job Application Form UI"
Cohesion: 0.31
Nodes (9): Applicant Nikhil, Apply For Role Button, Apply Now Form, Hybrid Working Conditions, Job Skills Requirements, Microsoft Products Skill (Excel, SharePoint, Power BI, PowerPoint), Nikhil Resume PDF, S3Strategic Job Application Page (+1 more)

### Community 19 - "Application Failure Patterns"
Cohesion: 0.25
Nodes (8): Dice Failed Jobs Log, Browser/Page Closed Error, Submitted but No Confirmation Detected, Matlen Silver Failed Jobs Log, Failed Outcome (Browser/Page Error), Uncertain Outcome (Submitted No Confirmation), RobertHalf Failed Jobs Log, RobertHalf Zero-Applied Pattern

### Community 20 - "RobertHalf Empty Sessions"
Cohesion: 0.4
Nodes (6): RobertHalf 4 Workers All DONE Apr 24, RobertHalf 4 Workers All IDLE Apr 25 (empty session, 0 scanned), RobertHalf Live Report 2026-04-24 (26 scanned, 0 applied, 15 uncertain), RobertHalf Live Report 2026-04-25 (0 scanned, empty session), RobertHalf UNCERTAIN Application Status (submitted but no confirmation detected, Apr 24), Session Tally Integrity Check Apr 24 (26 scanned = 0+3+0+15+8 verified)

### Community 21 - "RobertHalf Uncertain Sessions"
Cohesion: 0.5
Nodes (4): RobertHalf Live Report 2026-04-22 13:42 (20 min, 28 scanned, 0 applied, 18 uncertain), RobertHalf 4 Workers All DONE Apr 22, RobertHalf Session Tally Apr 22 (28 scanned, 0 applied, 2 skipped, 18 uncertain, 8 pending), RobertHalf UNCERTAIN Status: submitted but no confirmation detected (18 jobs)

### Community 22 - "Randstad-DS Skip Pattern"
Cohesion: 1.0
Nodes (2): Randstad-DS Failed Jobs Log (1 SKIPPED: information data architect - no apply button found), Randstad-DS SKIPPED: no apply button found (information data architect)

### Community 23 - "Job Title Variants"
Cohesion: 1.0
Nodes (2): Software Engineer, Senior/Sr. Software Engineer

### Community 24 - "RobertHalf Live Reports"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 2026-04-23 01:20:34

### Community 25 - "RobertHalf Live Reports"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 2026-04-23 01:12:43

### Community 26 - "RobertHalf Live Reports"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 2026-04-23 01:21:04

### Community 27 - "RobertHalf Live Reports"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 2026-04-23 01:20:15

### Community 28 - "RobertHalf Live Reports"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 2026-04-20 (6 scanned, 0 applied, 4 uncertain)

### Community 29 - "Generic Job Titles"
Cohesion: 1.0
Nodes (1): Cloud Engineer

### Community 30 - "Generic Job Titles"
Cohesion: 1.0
Nodes (1): Systems Engineer

### Community 31 - "Generic Job Titles"
Cohesion: 1.0
Nodes (1): DevOps Engineer

### Community 32 - "Generic Job Titles"
Cohesion: 1.0
Nodes (1): Platform Engineer

### Community 33 - "RobertHalf Session Logs"
Cohesion: 1.0
Nodes (1): RobertHalf Session 4/21/2026

### Community 34 - "RobertHalf Session Logs"
Cohesion: 1.0
Nodes (1): RobertHalf Session 5/3/2026

### Community 35 - "Application Outcomes"
Cohesion: 1.0
Nodes (1): Skipped Outcome (Filtered)

### Community 36 - "RobertHalf Live Reports"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 04/25/2026

### Community 37 - "RobertHalf Live Reports"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 04/27/2026 06:00

### Community 38 - "RobertHalf Live Reports"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 04/27/2026 10:00

### Community 39 - "RobertHalf Live Reports"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 05/03/2026

### Community 40 - "Kforce Session Logs"
Cohesion: 1.0
Nodes (1): Kforce Bot Session May 2 2026 (Multiple Runs)

### Community 41 - "Kforce Session Logs"
Cohesion: 1.0
Nodes (1): Kforce Session 20:53 (0 jobs found)

### Community 42 - "Kforce Session Logs"
Cohesion: 1.0
Nodes (1): Kforce Applied IDs 3 (empty)

## Knowledge Gaps
- **117 isolated node(s):** `Brian Multi-ATS Bot (multiats-bot.js)`, `Platform Inventory (14 Staffing Sites)`, `Collabera Bot Spec (Custom WordPress, JS Modal Apply)`, `Hays Bot Spec (Proprietary ATS, Login Required)`, `Experis Bot Spec (ManpowerGroup WebSphere, Fragile Sessions)` (+112 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Randstad-DS Skip Pattern`** (2 nodes): `Randstad-DS Failed Jobs Log (1 SKIPPED: information data architect - no apply button found)`, `Randstad-DS SKIPPED: no apply button found (information data architect)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Job Title Variants`** (2 nodes): `Software Engineer`, `Senior/Sr. Software Engineer`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Live Reports`** (1 nodes): `RobertHalf Live Report 2026-04-23 01:20:34`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Live Reports`** (1 nodes): `RobertHalf Live Report 2026-04-23 01:12:43`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Live Reports`** (1 nodes): `RobertHalf Live Report 2026-04-23 01:21:04`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Live Reports`** (1 nodes): `RobertHalf Live Report 2026-04-23 01:20:15`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Live Reports`** (1 nodes): `RobertHalf Live Report 2026-04-20 (6 scanned, 0 applied, 4 uncertain)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Generic Job Titles`** (1 nodes): `Cloud Engineer`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Generic Job Titles`** (1 nodes): `Systems Engineer`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Generic Job Titles`** (1 nodes): `DevOps Engineer`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Generic Job Titles`** (1 nodes): `Platform Engineer`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Logs`** (1 nodes): `RobertHalf Session 4/21/2026`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Logs`** (1 nodes): `RobertHalf Session 5/3/2026`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Application Outcomes`** (1 nodes): `Skipped Outcome (Filtered)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Live Reports`** (1 nodes): `RobertHalf Live Report 04/25/2026`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Live Reports`** (1 nodes): `RobertHalf Live Report 04/27/2026 06:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Live Reports`** (1 nodes): `RobertHalf Live Report 04/27/2026 10:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Live Reports`** (1 nodes): `RobertHalf Live Report 05/03/2026`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Kforce Session Logs`** (1 nodes): `Kforce Bot Session May 2 2026 (Multiple Runs)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Kforce Session Logs`** (1 nodes): `Kforce Session 20:53 (0 jobs found)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Kforce Session Logs`** (1 nodes): `Kforce Applied IDs 3 (empty)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Robert Half Job Platform` connect `April 2026 Cross-Platform Campaign` to `Application Failure Patterns`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **What connects `Brian Multi-ATS Bot (multiats-bot.js)`, `Platform Inventory (14 Staffing Sites)`, `Collabera Bot Spec (Custom WordPress, JS Modal Apply)` to the rest of the system?**
  _117 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `April 2026 Cross-Platform Campaign` be split into smaller, more focused modules?**
  _Cohesion score 0.04 - nodes in this community are weakly interconnected._
- **Should `Candidate Profile & Materials` be split into smaller, more focused modules?**
  _Cohesion score 0.05 - nodes in this community are weakly interconnected._
- **Should `Dice Bot & Output Infrastructure` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._
- **Should `RobertHalf Bot Functions` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._
- **Should `Randstad Bot Functions` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._