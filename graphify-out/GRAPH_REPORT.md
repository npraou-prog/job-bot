# Graph Report - .  (2026-05-10)

## Corpus Check
- Large corpus: 93 files · ~619,885 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder, or use --no-semantic to run AST-only.

## Summary
- 653 nodes · 1179 edges · 50 communities detected
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 60 edges (avg confidence: 0.83)
- Token cost: 45,000 input · 3,200 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Collabera & Cross-Platform Failures|Collabera & Cross-Platform Failures]]
- [[_COMMUNITY_Multi-ATS Bot Architecture|Multi-ATS Bot Architecture]]
- [[_COMMUNITY_Dice Bot & Shared Infrastructure|Dice Bot & Shared Infrastructure]]
- [[_COMMUNITY_Cover Letters & Resume|Cover Letters & Resume]]
- [[_COMMUNITY_InsightGlobal Bot Functions|InsightGlobal Bot Functions]]
- [[_COMMUNITY_MatlenSilver Bot Functions|MatlenSilver Bot Functions]]
- [[_COMMUNITY_S3Strategic Bot Functions|S3Strategic Bot Functions]]
- [[_COMMUNITY_Kforce Bot Functions|Kforce Bot Functions]]
- [[_COMMUNITY_Randstad Bot Functions|Randstad Bot Functions]]
- [[_COMMUNITY_Indeed Bot (LLM Screening)|Indeed Bot (LLM Screening)]]
- [[_COMMUNITY_Vaco Bot Functions|Vaco Bot Functions]]
- [[_COMMUNITY_RobertHalf Bot Functions|RobertHalf Bot Functions]]
- [[_COMMUNITY_Generic Apply Form Pipeline|Generic Apply Form Pipeline]]
- [[_COMMUNITY_Collabera Bot Functions|Collabera Bot Functions]]
- [[_COMMUNITY_Architecture & Expansion Plans|Architecture & Expansion Plans]]
- [[_COMMUNITY_InsightGlobal Apply Flow|InsightGlobal Apply Flow]]
- [[_COMMUNITY_MatlenSilver Login & Test Mode|MatlenSilver Login & Test Mode]]
- [[_COMMUNITY_Randstad Session Output|Randstad Session Output]]
- [[_COMMUNITY_Date-Filtered Bot Functions|Date-Filtered Bot Functions]]
- [[_COMMUNITY_Job Form Fields Metadata|Job Form Fields Metadata]]
- [[_COMMUNITY_RobertHalf Reports (May 2026)|RobertHalf Reports (May 2026)]]
- [[_COMMUNITY_RobertHalf Sessions (Apr 24-25)|RobertHalf Sessions (Apr 24-25)]]
- [[_COMMUNITY_RobertHalf Sessions (Apr 22)|RobertHalf Sessions (Apr 22)]]
- [[_COMMUNITY_RobertHalf Session Apr 23a|RobertHalf Session Apr 23a]]
- [[_COMMUNITY_RobertHalf Session Apr 28a|RobertHalf Session Apr 28a]]
- [[_COMMUNITY_RobertHalf Zero-Applied Pattern|RobertHalf Zero-Applied Pattern]]
- [[_COMMUNITY_RobertHalf Session Apr 27a|RobertHalf Session Apr 27a]]
- [[_COMMUNITY_RobertHalf Session Apr 29a|RobertHalf Session Apr 29a]]
- [[_COMMUNITY_RobertHalf Session Apr 23b|RobertHalf Session Apr 23b]]
- [[_COMMUNITY_RobertHalf Session Apr 23c|RobertHalf Session Apr 23c]]
- [[_COMMUNITY_RobertHalf Session May 03|RobertHalf Session May 03]]
- [[_COMMUNITY_RobertHalf Session Apr 27b|RobertHalf Session Apr 27b]]
- [[_COMMUNITY_RobertHalf Session Apr 29b|RobertHalf Session Apr 29b]]
- [[_COMMUNITY_RobertHalf Session Apr 28b|RobertHalf Session Apr 28b]]
- [[_COMMUNITY_RobertHalf Session Apr 23d|RobertHalf Session Apr 23d]]
- [[_COMMUNITY_RobertHalf Session Apr 25|RobertHalf Session Apr 25]]
- [[_COMMUNITY_RobertHalf Session Apr 20|RobertHalf Session Apr 20]]
- [[_COMMUNITY_Kforce Empty Session|Kforce Empty Session]]
- [[_COMMUNITY_Kforce Empty Applied IDs|Kforce Empty Applied IDs]]
- [[_COMMUNITY_RobertHalf Report May-04a|RobertHalf Report May-04a]]
- [[_COMMUNITY_RobertHalf Report May-05a|RobertHalf Report May-05a]]
- [[_COMMUNITY_RobertHalf Report May-05b|RobertHalf Report May-05b]]
- [[_COMMUNITY_RobertHalf Report May-06a|RobertHalf Report May-06a]]
- [[_COMMUNITY_RobertHalf Report May-06b|RobertHalf Report May-06b]]
- [[_COMMUNITY_RobertHalf Report May-07a|RobertHalf Report May-07a]]
- [[_COMMUNITY_RobertHalf Report May-07b|RobertHalf Report May-07b]]
- [[_COMMUNITY_RobertHalf Report May-08|RobertHalf Report May-08]]
- [[_COMMUNITY_Dice Applied Jobs Log|Dice Applied Jobs Log]]
- [[_COMMUNITY_Dice Failed Jobs Log|Dice Failed Jobs Log]]
- [[_COMMUNITY_RobertHalf Platform God Node|RobertHalf Platform God Node]]

## God Nodes (most connected - your core abstractions)
1. `Randstad Bot` - 24 edges
2. `Kforce Bot` - 22 edges
3. `Candidate: Nikhil Premachandra Rao` - 18 edges
4. `Matlen Silver Bot` - 17 edges
5. `Insight Global Bot` - 17 edges
6. `RobertHalf.com Bot (roberthalf-bot.js)` - 16 edges
7. `Indeed Bot` - 16 edges
8. `Dice Job Automation Agent Spec` - 14 edges
9. `applyToJob()` - 12 edges
10. `Collabera Bot` - 12 edges

## Surprising Connections (you probably didn't know these)
- `Cover Letter Target Role: Data Scientist` --semantically_similar_to--> `Kforce Job: Data Scientist`  [INFERRED] [semantically similar]
  Nikhil_Rao_Cover_Letter.pdf → Kforce/scanned_jobs 2.txt
- `Skill: Generative AI and LLM Engineering (RAG, Prompt Engineering, LLM Agents, Embeddings)` --semantically_similar_to--> `Kforce Job: Data Scientist`  [INFERRED] [semantically similar]
  Nikhil_Resume.pdf → Kforce/scanned_jobs 2.txt
- `Skill: Machine Learning and AI Engineering (Deep Learning, NLP, Forecasting, Anomaly Detection)` --semantically_similar_to--> `Kforce Job: Data Scientist`  [INFERRED] [semantically similar]
  Nikhil_Resume.pdf → Kforce/scanned_jobs 2.txt
- `Skill: Machine Learning and AI Engineering (Deep Learning, NLP, Forecasting, Anomaly Detection)` --semantically_similar_to--> `Kforce Job: Senior Data Scientist`  [INFERRED] [semantically similar]
  Nikhil_Resume.pdf → Kforce/scanned_jobs 2.txt
- `Cover Letter Value Proposition: Production AI Engineering, RAG, LLM Agents, Business Impact` --semantically_similar_to--> `Kforce Job: AI Engineer / Applied Data Scientist`  [INFERRED] [semantically similar]
  Nikhil_Rao_Cover_Letter.pdf → Kforce/scanned_jobs 2.txt

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
- **Candidate Profile to Kforce Target Role Alignment (Resume + Cover Letter + Kforce Data Scientist jobs)** — resume_candidate_nikhil, cover_letter_target_role, kforce_job_data_scientist, kforce_job_ai_engineer_applied_ds, kforce_job_mlops_engineer [INFERRED 0.87]
- **Job Application Submission Flow** — pre_submit_screenshot_apply_now_form, pre_submit_screenshot_applicant_nikhil, pre_submit_screenshot_nikhil_resume, pre_submit_screenshot_apply_for_role_button [INFERRED 0.85]
- **Job Listing Content** — pre_submit_screenshot_hybrid_working_conditions, pre_submit_screenshot_job_skills, pre_submit_screenshot_microsoft_products_skill, pre_submit_screenshot_strategic_staff [EXTRACTED 1.00]
- **All Bots Share Common Infrastructure Pattern** — concept_applied_ids, concept_openclaw_workspace, concept_status_json, concept_scanned_file, concept_failed_file [INFERRED 0.95]
- **Parallel Worker Queue-Drain Application Loop** — concept_parallel_workers, concept_job_queue, concept_rate_limit, concept_sigint [EXTRACTED 1.00]
- **Form Fill + Resume Upload + Submit + Confirm Pipeline** — concept_fill_field, concept_resume_upload, concept_confirm_re, concept_uncertain_status [INFERRED 0.90]
- **May 2026 Cross-Platform Output File Trio (Applied + Failed + Applied IDs across S3Strategic, Kforce, InsightGlobal, Randstad-DS)** — s3strategic_applied_jobs_log, s3strategic_failed_jobs_log, s3strategic_applied_ids, kforce_applied_jobs_log, kforce_failed_jobs_log, kforce_applied_ids, insightglobal_applied_jobs_log, insightglobal_failed_jobs_log, randstad_ds_applied_jobs_log, randstad_ds_failed_jobs_log [INFERRED 0.88]
- **Cross-Platform Submission Failure Pattern (UNCERTAIN/NO_SUBMIT/max retries across MatlenSilver, Kforce, InsightGlobal, S3Strategic, Collabera)** — cross_platform_uncertain_pattern, matlensilver_uncertain_no_confirmation, kforce_error_max_retries, insightglobal_uncertain_itsm_director, s3strategic_uncertain_status, collabera_no_submit_pattern [INFERRED 0.85]
- **AI/ML Role Applications Across Multiple Platforms (AI Engineer, ML Engineer, Data Scientist)** — insightglobal_job_ai_engineer_527407, insightglobal_job_founding_ai_systems_engineer, randstad_ds_job_ml_engineer_mclean, randstad_ds_job_principal_ai_engineer, kforce_job_machine_learning_engineer, kforce_job_python_aiml_developer, kforce_job_agentic_ai_copilot, s3strategic_job_ai_engineer [INFERRED 0.82]

## Communities

### Community 0 - "Collabera & Cross-Platform Failures"
Cohesion: 0.03
Nodes (74): Collabera Failed Jobs Log (NO_SUBMIT + FAILED + SKIPPED_TITLE pattern), Collabera Job: Junior Security Engineer (AI-Focused) (369158), Collabera NO_SUBMIT Pattern (modal form not completing), Collabera SKIPPED_TITLE Pattern (Job Description / Talent Solutions titles), Cross-Platform UNCERTAIN Pattern (submitted but no confirmation detected), Community: Collabera Bot Functions, Community: InsightGlobal Bot Functions, Community: Kforce Bot Apply Flow (+66 more)

### Community 1 - "Multi-ATS Bot Architecture"
Cohesion: 0.09
Nodes (53): Brian Multi-ATS Bot (multiats-bot.js), Collabera Bot, Collabera apply_newv2 Iframe Form Filler, Applied IDs Deduplication File, Collabera ATS (Custom WordPress, apply_newv2 iframe), Indeed ATS (Easy Apply, Multi-Step Modal, LLM Screening), Insight Global ATS (jobs.insightglobal.com ASP.NET), Kforce ATS (SPA Angular/React, Base64 Job IDs) (+45 more)

### Community 2 - "Dice Bot & Shared Infrastructure"
Cohesion: 0.07
Nodes (43): applied_ids.txt Deduplication File, applied_jobs.txt Output Log, Dice.com Bot (dice-bot.js), failed_jobs.txt Output Log, Job Application Automation Suite, Shared Job Queue, 4 Parallel Playwright Workers, Persistent Browser Session (+35 more)

### Community 3 - "Cover Letters & Resume"
Cohesion: 0.06
Nodes (43): Cover Letter Theme: Cross-Functional Collaboration and Outcomes Focus, Cover Letter Domain Focus: FinTech and Healthcare AI, Nikhil Rao Cover Letter PDF, Cover Letter Target Role: Data Scientist, Cover Letter Value Proposition: Production AI Engineering, RAG, LLM Agents, Business Impact, Kforce Applied IDs 2 (8 uncertain IDs from 21:02 session), Kforce Applied Jobs Log 2, Kforce Applied Jobs Log 3 (+35 more)

### Community 4 - "InsightGlobal Bot Functions"
Cohesion: 0.14
Nodes (33): answerQuestions(), applyToJob(), buildLocationUrls(), checkJobSuitability(), ensureDir(), extractJobsFromPage(), findAndClickApply(), formTestMode() (+25 more)

### Community 5 - "MatlenSilver Bot Functions"
Cohesion: 0.13
Nodes (31): answerQuestions(), applyToJob(), buildLocationUrls(), checkJobSuitability(), ensureDir(), extractJobsFromPage(), findAndClickEasyApply(), formTestMode() (+23 more)

### Community 6 - "S3Strategic Bot Functions"
Cohesion: 0.16
Nodes (31): answerScreeningQuestions(), applyToJob(), buildApplyUrl(), buildSearchUrl(), ensureDir(), extractJobsFromPage(), fillInput(), fillPersonalInfo() (+23 more)

### Community 7 - "Kforce Bot Functions"
Cohesion: 0.15
Nodes (26): applyToJob(), clickApplyWithKforce(), decodeSlug(), ensureDir(), extractJobsFromPage(), fillApplyForm(), formTestMode(), getNextJob() (+18 more)

### Community 8 - "Randstad Bot Functions"
Cohesion: 0.16
Nodes (26): applyToJob(), buildSearchUrl(), ensureDir(), extractJobsFromPage(), fillApplyForm(), fillEEO(), findAndClickApply(), formTestMode() (+18 more)

### Community 9 - "Indeed Bot (LLM Screening)"
Cohesion: 0.17
Nodes (27): answerKnownQuestions(), answerOpenQuestions(), applyToJob(), askLLM(), ensureDir(), extractJobsFromPage(), fillKnownFields(), fixValidationErrors() (+19 more)

### Community 10 - "Vaco Bot Functions"
Cohesion: 0.17
Nodes (26): answerQuestions(), applyToJob(), buildJobUrl(), ensureDir(), fetchVacoJobsPage(), fillApplyForm(), findAndClickApply(), formTestMode() (+18 more)

### Community 11 - "RobertHalf Bot Functions"
Cohesion: 0.17
Nodes (22): applyToJob(), clickButton(), ensureDir(), extractJobsFromPage(), fillField(), formTestMode(), getTotalResultCount(), initAppliedFile() (+14 more)

### Community 12 - "Generic Apply Form Pipeline"
Cohesion: 0.2
Nodes (23): applyToJob(), clickButton(), ensureDir(), extractJobsFromPage(), fillField(), getNextJob(), initAppliedFile(), isWithin24Hours() (+15 more)

### Community 13 - "Collabera Bot Functions"
Cohesion: 0.19
Nodes (23): applyToJob(), buildSearchUrl(), ensureDir(), extractJobsFromPage(), fillField(), getNextJob(), initAppliedFile(), initLogFile() (+15 more)

### Community 14 - "Architecture & Expansion Plans"
Cohesion: 0.11
Nodes (23): Apex Systems Skip Rationale (Cloudflare WAF 403, Encrypted Apply Tokens), Architecture Plan for New Bots (4 Workers, Shared Queue, Output Files), Suggested Build Order: S3, Matlen, Collabera, TekSystems, Vaco, Yoh, Hays, Experis, Bullhorn Backend ATS (S3, Vaco, Yoh), Collabera Bot Spec (Custom WordPress, JS Modal Apply), Yet-to-do: Job Application Automation Expansion Plan, Experis Bot Spec (ManpowerGroup WebSphere, Fragile Sessions), Hays Bot Spec (Proprietary ATS, Login Required) (+15 more)

### Community 15 - "InsightGlobal Apply Flow"
Cohesion: 0.24
Nodes (20): applyToJob(), buildSearchUrl(), clickApplyAndExpandForm(), ensureDir(), extractJobsFromPage(), fillAndSubmitForm(), fillField(), fillIframeForm() (+12 more)

### Community 16 - "MatlenSilver Login & Test Mode"
Cohesion: 0.2
Nodes (18): applyToJob(), ensureDir(), ensureLoggedIn(), getNextJob(), initAppliedFile(), isWithinMaxAge(), loadAppliedJobs(), markApplied() (+10 more)

### Community 17 - "Randstad Session Output"
Cohesion: 0.12
Nodes (18): Randstad Applied Jobs Log, Randstad Bot Session, Randstad Failed Jobs Log, Randstad Job Title Filter (FILTERED vs QUEUED), Randstad Uncertain Error: No Submit Button Found, Randstad Scan: 303 Jobs Found (290 Filtered, 13 Queued), Randstad Scanned Jobs Log, Randstad Session Stats 2026-04-21 (+10 more)

### Community 18 - "Date-Filtered Bot Functions"
Cohesion: 0.3
Nodes (14): applyToJob(), ensureDir(), extractJobsFromDOM(), fillField(), isWithin1Day(), loadAppliedIds(), log(), runBot() (+6 more)

### Community 19 - "Job Form Fields Metadata"
Cohesion: 0.31
Nodes (9): Applicant Nikhil, Apply For Role Button, Apply Now Form, Hybrid Working Conditions, Job Skills Requirements, Microsoft Products Skill (Excel, SharePoint, Power BI, PowerPoint), Nikhil Resume PDF, S3Strategic Job Application Page (+1 more)

### Community 20 - "RobertHalf Reports (May 2026)"
Cohesion: 0.29
Nodes (7): RobertHalf 4 Parallel Workers, RobertHalf Session Live Report Format, UNCERTAIN Application Status (Submitted without Confirmation), RobertHalf Failed Jobs Log, RobertHalf Report 2026-05-04 14:00, RobertHalf Report 2026-05-08 14:00, RobertHalf Report 2026-05-09 14:00

### Community 21 - "RobertHalf Sessions (Apr 24-25)"
Cohesion: 0.4
Nodes (6): RobertHalf 4 Workers All DONE Apr 24, RobertHalf 4 Workers All IDLE Apr 25 (empty session, 0 scanned), RobertHalf Live Report 2026-04-24 (26 scanned, 0 applied, 15 uncertain), RobertHalf Live Report 2026-04-25 (0 scanned, empty session), RobertHalf UNCERTAIN Application Status (submitted but no confirmation detected, Apr 24), Session Tally Integrity Check Apr 24 (26 scanned = 0+3+0+15+8 verified)

### Community 22 - "RobertHalf Sessions (Apr 22)"
Cohesion: 0.5
Nodes (4): RobertHalf Live Report 2026-04-22 13:42 (20 min, 28 scanned, 0 applied, 18 uncertain), RobertHalf 4 Workers All DONE Apr 22, RobertHalf Session Tally Apr 22 (28 scanned, 0 applied, 2 skipped, 18 uncertain, 8 pending), RobertHalf UNCERTAIN Status: submitted but no confirmation detected (18 jobs)

### Community 23 - "RobertHalf Session Apr 23a"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 2026-04-23 01:20:34

### Community 24 - "RobertHalf Session Apr 28a"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 04/28/2026 06:00

### Community 25 - "RobertHalf Zero-Applied Pattern"
Cohesion: 1.0
Nodes (1): RobertHalf Zero-Applied Pattern

### Community 26 - "RobertHalf Session Apr 27a"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 04/27/2026 10:00

### Community 27 - "RobertHalf Session Apr 29a"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 04/29/2026 06:00

### Community 28 - "RobertHalf Session Apr 23b"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 2026-04-23 01:12:43

### Community 29 - "RobertHalf Session Apr 23c"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 2026-04-23 01:21:04

### Community 30 - "RobertHalf Session May 03"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 05/03/2026

### Community 31 - "RobertHalf Session Apr 27b"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 04/27/2026 06:00

### Community 32 - "RobertHalf Session Apr 29b"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 04/29/2026 10:00

### Community 33 - "RobertHalf Session Apr 28b"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 04/28/2026 10:00

### Community 34 - "RobertHalf Session Apr 23d"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 2026-04-23 01:20:15

### Community 35 - "RobertHalf Session Apr 25"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 04/25/2026

### Community 36 - "RobertHalf Session Apr 20"
Cohesion: 1.0
Nodes (1): RobertHalf Live Report 2026-04-20 (6 scanned, 0 applied, 4 uncertain)

### Community 37 - "Kforce Empty Session"
Cohesion: 1.0
Nodes (1): Kforce Session 20:53 (0 jobs found)

### Community 38 - "Kforce Empty Applied IDs"
Cohesion: 1.0
Nodes (1): Kforce Applied IDs 3 (empty)

### Community 39 - "RobertHalf Report May-04a"
Cohesion: 1.0
Nodes (1): RobertHalf Report 2026-05-04 10:00

### Community 40 - "RobertHalf Report May-05a"
Cohesion: 1.0
Nodes (1): RobertHalf Report 2026-05-05 10:00

### Community 41 - "RobertHalf Report May-05b"
Cohesion: 1.0
Nodes (1): RobertHalf Report 2026-05-05 14:00

### Community 42 - "RobertHalf Report May-06a"
Cohesion: 1.0
Nodes (1): RobertHalf Report 2026-05-06 10:00

### Community 43 - "RobertHalf Report May-06b"
Cohesion: 1.0
Nodes (1): RobertHalf Report 2026-05-06 14:00

### Community 44 - "RobertHalf Report May-07a"
Cohesion: 1.0
Nodes (1): RobertHalf Report 2026-05-07 10:00

### Community 45 - "RobertHalf Report May-07b"
Cohesion: 1.0
Nodes (1): RobertHalf Report 2026-05-07 14:00

### Community 46 - "RobertHalf Report May-08"
Cohesion: 1.0
Nodes (1): RobertHalf Report 2026-05-08 10:00

### Community 47 - "Dice Applied Jobs Log"
Cohesion: 1.0
Nodes (1): Dice Applied Jobs Log (May 2026 sessions)

### Community 48 - "Dice Failed Jobs Log"
Cohesion: 1.0
Nodes (1): Dice Failed Jobs Log (recent sessions)

### Community 49 - "RobertHalf Platform God Node"
Cohesion: 1.0
Nodes (1): God Node: Robert Half Job Platform (22 edges)

## Knowledge Gaps
- **129 isolated node(s):** `Brian Multi-ATS Bot (multiats-bot.js)`, `Platform Inventory (14 Staffing Sites)`, `Collabera Bot Spec (Custom WordPress, JS Modal Apply)`, `Hays Bot Spec (Proprietary ATS, Login Required)`, `Experis Bot Spec (ManpowerGroup WebSphere, Fragile Sessions)` (+124 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `RobertHalf Session Apr 23a`** (1 nodes): `RobertHalf Live Report 2026-04-23 01:20:34`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Apr 28a`** (1 nodes): `RobertHalf Live Report 04/28/2026 06:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Zero-Applied Pattern`** (1 nodes): `RobertHalf Zero-Applied Pattern`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Apr 27a`** (1 nodes): `RobertHalf Live Report 04/27/2026 10:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Apr 29a`** (1 nodes): `RobertHalf Live Report 04/29/2026 06:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Apr 23b`** (1 nodes): `RobertHalf Live Report 2026-04-23 01:12:43`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Apr 23c`** (1 nodes): `RobertHalf Live Report 2026-04-23 01:21:04`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session May 03`** (1 nodes): `RobertHalf Live Report 05/03/2026`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Apr 27b`** (1 nodes): `RobertHalf Live Report 04/27/2026 06:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Apr 29b`** (1 nodes): `RobertHalf Live Report 04/29/2026 10:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Apr 28b`** (1 nodes): `RobertHalf Live Report 04/28/2026 10:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Apr 23d`** (1 nodes): `RobertHalf Live Report 2026-04-23 01:20:15`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Apr 25`** (1 nodes): `RobertHalf Live Report 04/25/2026`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Session Apr 20`** (1 nodes): `RobertHalf Live Report 2026-04-20 (6 scanned, 0 applied, 4 uncertain)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Kforce Empty Session`** (1 nodes): `Kforce Session 20:53 (0 jobs found)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Kforce Empty Applied IDs`** (1 nodes): `Kforce Applied IDs 3 (empty)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Report May-04a`** (1 nodes): `RobertHalf Report 2026-05-04 10:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Report May-05a`** (1 nodes): `RobertHalf Report 2026-05-05 10:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Report May-05b`** (1 nodes): `RobertHalf Report 2026-05-05 14:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Report May-06a`** (1 nodes): `RobertHalf Report 2026-05-06 10:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Report May-06b`** (1 nodes): `RobertHalf Report 2026-05-06 14:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Report May-07a`** (1 nodes): `RobertHalf Report 2026-05-07 10:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Report May-07b`** (1 nodes): `RobertHalf Report 2026-05-07 14:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Report May-08`** (1 nodes): `RobertHalf Report 2026-05-08 10:00`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Dice Applied Jobs Log`** (1 nodes): `Dice Applied Jobs Log (May 2026 sessions)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Dice Failed Jobs Log`** (1 nodes): `Dice Failed Jobs Log (recent sessions)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `RobertHalf Platform God Node`** (1 nodes): `God Node: Robert Half Job Platform (22 edges)`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Kforce Error: Apply with Kforce not found` connect `Collabera & Cross-Platform Failures` to `Cover Letters & Resume`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Why does `Kforce Failed Jobs Log 3 (Apply with Kforce not found)` connect `Cover Letters & Resume` to `Collabera & Cross-Platform Failures`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `Insight Global Bot` (e.g. with `Brian Multi-ATS Bot (multiats-bot.js)` and `Nikhil Resume PDF (InsightGlobal)`) actually correct?**
  _`Insight Global Bot` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Brian Multi-ATS Bot (multiats-bot.js)`, `Platform Inventory (14 Staffing Sites)`, `Collabera Bot Spec (Custom WordPress, JS Modal Apply)` to the rest of the system?**
  _129 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Collabera & Cross-Platform Failures` be split into smaller, more focused modules?**
  _Cohesion score 0.03 - nodes in this community are weakly interconnected._
- **Should `Multi-ATS Bot Architecture` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._
- **Should `Dice Bot & Shared Infrastructure` be split into smaller, more focused modules?**
  _Cohesion score 0.07 - nodes in this community are weakly interconnected._