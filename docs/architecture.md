# Application architecture

```
┌──────────────── Browser (Cloud Run page or GitHub Pages demo) ────────────────┐
│ app/static/index.html, styles.css - ES modules in app/static/js (no build):   │
│  main.js boot · state.js shared state · core.js API client (base URL, token)  │
│  scenario.js · sources.js · components.js · environments.js · bigquery.js     │
│  pricing.js (options, drill-down) · cost.js · workload.js · roadmap.js        │
│  diagram.js · integrations.js · notices.js (availability) · exports.js        │
│  account.js (sign-in, save, versions, share) · compare.js · discover.js       │
│ exports.js (classic) xlsx writer with charts, SVG→PNG, Drive upload           │
│ vendor/pptxgen.bundle.js  Slides (.pptx) builder                              │
└──────────────┬────────────────────────────────────────────────────────────────┘
               │ open:   /api/catalog /api/samples /api/config /api/estimate /api/workload
               │         /api/plan /api/compare /api/pricing/status /api/assist/template.csv
               │ signed: /api/me /api/scenarios… /api/assist/notes /api/assist/file (non-template)
┌──────────────▼────────────────── Cloud Run (FastAPI) ──────────────────────────┐
│ main.py          validation (pydantic), routes, CORS, lifespan                 │
│ auth.py          Google ID token verification, domain / e-mail allow-list      │
│ catalog.py       source types, tools, pick-lists                               │
│ recommender.py   rules → Recommendation per source, platform narrative         │
│ components.py    BI/AI/API/DB/governance library + costs                       │
│ environments.py  dev/test/DR factors, running hours, replication               │
│ slots.py         BigQuery editions: demand profile, baseline + autoscale       │
│ estimator.py     36-month multi-region simulation, 3 pricing options,          │
│                  commercial terms, availability check                          │
│ bom.py           bill of materials (qty, unit price, why) per option           │
│ workload.py      workload-based sizing + slot sizing                           │
│ plan.py          ramp-up roadmap + ramped costs                                │
│ readiness.py     kickoff checklist, milestones, team size & skills             │
│ usecases.py      top 5 use cases from the sources in scope                     │
│ chargeback.py    price book (Excel/CSV/Sheets/PDF/image) and department pricing│
│ usage.py         request logs (Cloud Logging) and usage events, admin summary  │
│ live_pricing.py  Cloud Billing Catalog → prices, regional uplift, availability │
│ store.py         Firestore (or memory): scenarios, versions, sharing, cache    │
│ assist.py        Gemini on Vertex AI (structured output) + spreadsheet import  │
│ data/pricing.json, data/regions.json  reviewed fallback (editable)             │
└──────────────┬───────────────────────┬───────────────────────┬─────────────────┘
               ▼                       ▼                       ▼
        Firestore (native)    Cloud Billing Catalog     Vertex AI (Gemini)
```

There is **one** pricing engine (Python). The GitHub Pages demo is the same front end calling the service cross-origin; there is no JavaScript copy of the engine.

## API

| Method | Path | Auth | Body / result |
|---|---|---|---|
| GET | `/healthz` | - | `{"status":"ok","version":...}` |
| GET | `/api/catalog` | - | source types, tools, frequencies, regions, environment factors, option lists |
| GET | `/api/samples` | - | sample scenarios from `samples/*.json` |
| GET | `/api/config` | - | `google_client_id`, `auth`, `store`, `assist`, `pricing` source |
| POST | `/api/estimate` | - | scenario → `totals`, `by_option` (payg / cud1 / cud3: totals, monthly, by service / group / source / region), `environments` (with `by_option` and `slots`), `bom` (with `cud1` / `cud3` costs), `bigquery` (scan basis, sizing, edition comparison, warnings), `availability`, `commercial`, `recommendations`, `platform`, `assumptions` |
| POST | `/api/workload` | - | workload-based ramp/steady monthly, 1/3-year, by category, line items, compute comparison, slot sizing |
| POST | `/api/plan` | - | phases, waves, component rollout, ramped month-by-month consumption |
| POST | `/api/compare` | - | `{scenarios: [A, B, …], labels}` → per-scenario options, groups, services, environments, BigQuery, availability |
| GET | `/api/pricing/status` | - | live price source, refresh time, matched / unmatched price points, last error |
| POST | `/api/pricing/refresh` | signed in | refresh live prices now |
| GET | `/api/me` | signed in | `{email, name, picture, store}` |
| GET / POST | `/api/scenarios` | signed in | list mine and shared with me / create (`{scenario, title, note}`) |
| GET / PUT / DELETE | `/api/scenarios/{id}` | signed in | open / save a new version (`base_version` guards concurrent edits → 409) / delete (owner) |
| GET | `/api/scenarios/{id}/versions[/{n}]` | signed in | version history / one version with its scenario |
| POST | `/api/scenarios/{id}/share` | signed in | `{viewers, editors, link_access: none|view|edit}` |
| POST | `/api/assist/notes` | signed in | `{text}` → proposal `{sources, components, environments, questions, assumptions}` (Gemini, rate-limited) |
| POST | `/api/assist/file` | template: -, other: signed in | CSV/XLSX upload → proposal |
| GET | `/api/assist/template.csv` | - | inventory template |
| GET | `/docs` | - | OpenAPI UI |

Scenario shape (see `app/main.py` for limits and defaults):

```json
{
  "customer": "Acme", "region": "me-central2", "skill": "sql", "orchestration": "auto",
  "environment": "production", "annual_growth_pct": 20, "contingency_pct": 10,
  "bq": {"mode": "editions", "edition": "auto", "baseline_slots": null, "max_slots": null,
         "scan_basis": "auto", "slot_hours_per_tib": 60, "measured_scan_tib_month": null},
  "commercial": {"discount_pct": 0, "support_plan": "enhanced", "range_low_pct": -25, "range_high_pct": 30},
  "pricing_option": "cud1",
  "sources": [{"id": "s1", "name": "Core banking", "type": "oracle", "data_type": "structured",
               "frequency": "near_realtime", "location": "on_prem", "transform": "light",
               "initial_volume_gb": 8000, "daily_change_gb": 60}],
  "components": [{"id": "c1", "type": "power_bi", "settings": {"users": 200}}],
  "environments": [{"id": "prod", "preset": "prod"},
                   {"id": "dev", "preset": "dev", "runtime_pct": 36, "bq_baseline": null, "bq_max": 100}],
  "workload": {"data": {"structured_tb": 20}, "queries": {"heavy": {"count": 100, "frequency": "yearly"}}},
  "plan": {"teams": 2}
}
```

Legacy fields `bq_model` / `bq_slots` (a flat slot count) are still accepted and converted.

## Extending

**Add a source type**: add an entry to `SOURCE_TYPES` in `catalog.py` with an existing `category`, or add a new category and a branch in `recommender.recommend()`. Add default dialog values in `TYPE_DEFAULTS` (`app/static/js/sources.js`) and, for the guided interview, the category's defaults in `discover.js`.

**Add a component** (BI, AI, API, database, governance): add an entry to `COMPONENTS` in `components.py`; for Google components add a cost branch in `cost_components()` and prices in `pricing.json`; map it to a billing family in `live_pricing.COMPONENT_FAMILY` for the availability check. It appears in the library, diagram, Integrations tab, AI assist schema and guided interview automatically.

**Add a live price**: add a row to `PRICE_MAP` in `live_pricing.py` (pricing path, billing family, SKU description regex, usage type, unit) and check `/api/pricing/status` after a refresh.

**Add a cost model**: give the recommendation a new `engine` key and price it in the per-month loop in `estimator.estimate()`; put prices in `pricing.json`; map the engine in `live_pricing.ENGINE_FAMILY`.

## Testing

- `tests/test_engine.py`, `tests/test_live_pricing.py`, `tests/test_api_signed_in.py` - engine, live price parsing (fake catalog), saved scenarios / sharing / versions / compare / import with the in-memory store and `AUTH_DEV_USER`.
- `tests/ui/` - Playwright (Chromium) against a real server: samples, pricing options, drill-down, empty state, BigQuery slots, commercial terms, save / history / share, compare, guided discovery, spreadsheet import, and the GitHub Pages build calling the API cross-origin.

## Security notes

- Input is validated with pydantic (enums, numeric bounds, list sizes); unknown source types, components or regions return 422.
- Signed-in endpoints verify Google ID tokens (audience = the OAuth client ID) and an optional domain / e-mail allow-list; access to saved scenarios is checked per document (owner, editors, viewers, link access).
- Bearer tokens only (no cookies), so CORS for the demo origin does not expose CSRF.
- The Cloud Billing API key lives in Secret Manager, readable only by the runtime service account; the runtime account has only Firestore, Vertex AI and logging roles. GitHub deploys use Workload Identity Federation - no keys.
- All user text is HTML-escaped before rendering. The container runs as a non-root user.
- AI assist: notes go to Gemini in your own project; output is constrained by a JSON schema to the tool's catalog and re-validated; per-user hourly rate limit.
