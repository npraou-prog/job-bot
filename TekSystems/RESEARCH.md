# TEKsystems Bot — Research Notes

## Career Site
- **Main portal:** https://careers.teksystems.com/us/en
- **Search page:** https://careers.teksystems.com/us/en/search-results
- **ATS platform:** Phenom People (custom-hosted at `careers.teksystems.com`)
- **CDN fingerprint:** `cdn.phenompeople.com/CareerConnectResources/prod/TESYUS/`

---

## URL Patterns

### Job Search
```
https://careers.teksystems.com/us/en/search-results?keywords=data+scientist
https://careers.teksystems.com/us/en/search-results?keywords=machine+learning+engineer
```

Known filter params (from Phenom People platform docs):
| Param          | Example               | Notes                          |
|----------------|-----------------------|--------------------------------|
| `keywords`     | `data+scientist`      | Main keyword filter            |
| `dateCreated`  | `1` (days)            | Posted-within filter — **TBD confirm** |
| `countryCode`  | `US`                  | Country filter                 |
| `city`         | `New+York`            | City filter                    |
| `workPlace`    | `Remote`              | On-site / Remote / Hybrid      |

Pagination via `from` param (Phenom standard):
```
?keywords=data+scientist&from=0    ← page 1 (first 10)
?keywords=data+scientist&from=10   ← page 2
?keywords=data+scientist&from=20   ← page 3
```
> **Action needed:** Run probe to confirm `from` param step size (10 or 20).

### Job Detail Page
```
https://careers.teksystems.com/us/en/job/{JOB_ID}/{Job-Title-Slug}
```
Examples:
- `https://careers.teksystems.com/us/en/job/JP-005948166/Senior-Data-Scientist`
- `https://careers.teksystems.com/us/en/job/JP-005564162/Data-Scientist`

**Job ID format:** `JP-XXXXXXXXX` (9 digits)

### Apply Page
```
https://careers.teksystems.com/us/en/apply?jobSeqNo=TESYUSJP{ID_NO_DASH}ENUS
```
Example:
- Job ID `JP-005564162` → `jobSeqNo=TESYUSJP005564162ENUS`
- Full URL: `https://careers.teksystems.com/us/en/apply?jobSeqNo=TESYUSJP005564162ENUS`

Pattern to construct apply URL from job ID:
```js
const jobSeqNo = 'TESYUS' + jobId.replace('JP-', 'JP') + 'ENUS';
// JP-005564162 → TESYUSJP005564162ENUS
```

---

## Phenom People ATS — Technical Notes

The site is a **JavaScript SPA** — static HTTP fetching returns empty templates.
**Must use Playwright** (same approach as RobertHalf bot).

### Internal Search API (Phenom standard)
Phenom sites expose a `/widgets` endpoint used internally:
```
POST /widgets?ddoKey=refineSearch
```
- Requires a `refNum` scraped from the page HTML
- May require `x-csrf-token` header from cookies
- Not a public API — needs session context

**Recommended approach:** Use Playwright to navigate the search results page and extract job cards from the rendered DOM (same as RobertHalf), rather than hitting the internal API directly.

---

## Search Slugs / Keywords to Use
```
data scientist
machine learning engineer
machine learning
data science
applied scientist
nlp engineer
artificial intelligence engineer
```

---

## What Needs Probe Mode (Unknown Until Browser Inspection)

| Item | Status | Notes |
|------|--------|-------|
| Apply button selector | ❓ Unknown | Modal? Redirect? New tab? |
| Quick Apply option | ❓ Unknown | May not exist |
| Posted date format | ❓ Unknown | "X days ago" or ISO date? |
| `dateCreated` param works | ❓ Unknown | Need to test in browser |
| Pagination step size | ❓ Unknown | 10 or 20 per page? |
| Screening questions | ❓ Unknown | Format, types |
| Login required to apply | ❓ Unknown | Likely yes |
| Resume upload required | ❓ Unknown | Or pull from profile? |
| CSRF token needed | ❓ Unknown | Phenom sometimes requires it |

---

## Bot Strategy (Proposed)

Same architecture as RobertHalf bot:

1. **Login mode** — save persistent Chromium profile at `~/teksystems-bot-profile`
2. **Scan phase** — parallel Playwright pages (one per keyword slug), extract job cards
3. **Filter** — block non-DS titles (data engineer, data analyst, etc.)
4. **Apply phase** — navigate to job detail → click Apply → navigate form → confirm
5. **Report** — same live `report_TIMESTAMP.txt` tally system

### Key Difference from RobertHalf
- Apply URL can be **constructed directly** from the job ID without clicking Apply first
  → Navigate straight to `https://careers.teksystems.com/us/en/apply?jobSeqNo=...`
  → Skips the job detail page entirely, faster per application
- Need to handle Phenom's multi-step apply form (typically: profile → resume → questions → review → submit)

---

## Action Items for Tomorrow

- [ ] Connect Playwright session (`node teksystems-bot.js login`)
- [ ] Run probe mode on search results page — confirm job card selectors, date format, pagination
- [ ] Run probe mode on apply page — map out form steps, button selectors
- [ ] Confirm `dateCreated=1` filters to last 24 hours
- [ ] Check if login session persists across runs (persistent context)
- [ ] Decide: navigate apply URL directly vs click Apply button on detail page

---

## References
- [Phenom Developer API](https://developer.phenom.com/)
- [Phenom Jobs API (third-party docs)](https://jobo.world/ats/phenompeople)
- [TEKsystems Careers](https://careers.teksystems.com/us/en)
