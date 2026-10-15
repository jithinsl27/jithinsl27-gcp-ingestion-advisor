# Application architecture

```
┌──────────────────────── Browser ────────────────────────┐
│ app/static/index.html, styles.css, app.js (no build)    │
│  • source list + dialog      • SVG architecture diagram │
│  • settings & AI layer       • tabs, chart, exports     │
│  • scenario kept in localStorage, saved/opened as JSON  │
└───────────────┬─────────────────────────────────────────┘
                │ GET /api/catalog, /api/samples
                │ POST /api/estimate (scenario JSON)
┌───────────────▼──────── Cloud Run (FastAPI) ────────────┐
│ main.py        validation (pydantic), routes, static     │
│ catalog.py     source types, tools, pick-lists           │
│ recommender.py rules → Recommendation per source,        │
│                platform components, platform narrative   │
│ components.py  BI/AI/API/DB/governance library + costs   │
│ estimator.py   36-month multi-region simulation, CUDs    │
│ workload.py    workload-based sizing                     │
│ plan.py        ramp-up roadmap + ramped costs            │
│ data/pricing.json, data/regions.json  (editable)         │
└──────────────────────────────────────────────────────────┘
```

The service is stateless: no database, no secrets, no customer data stored. Scaling to zero keeps it essentially free when idle.

## API

| Method | Path | Body / result |
|---|---|---|
| GET | `/healthz` | `{"status":"ok","version":...}` |
| GET | `/api/catalog` | source types, tools, frequencies, regions, option lists |
| GET | `/api/samples` | sample scenarios from `samples/*.json` |
| POST | `/api/estimate` | scenario → totals, by_service, by_group, by_source, by_region, monthly, recommendations, platform (components, story), assumptions |
| POST | `/api/workload` | scenario with `workload` → ramp/steady monthly, 1/3-year, by category, line items, compute comparison, by region |
| POST | `/api/plan` | scenario → phases, waves, component rollout, milestones, ramped month-by-month consumption |
| GET | `/docs` | OpenAPI UI (FastAPI) |

Scenario shape (see `app/main.py` for limits and defaults):

```json
{
  "customer": "Acme", "region": "me-central2", "skill": "sql", "orchestration": "auto",
  "environment": "production", "bq_model": "enterprise", "bq_slots": 200,
  "analytics_tib_month": null, "annual_growth_pct": 20, "contingency_pct": 10,
  "sources": [{"id": "s1", "name": "Core banking", "type": "oracle", "data_type": "structured",
               "frequency": "near_realtime", "location": "on_prem", "transform": "light",
               "initial_volume_gb": 8000, "daily_change_gb": 60}],
  "processing_region": "me-central2",
  "components": [{"id": "c1", "type": "power_bi", "settings": {"users": 200}},
                 {"id": "c2", "type": "vertex_gpu", "settings": {"gpu": "l4", "replicas": 2, "region": "us-central1"}}],
  "security": {"enabled": true, "sdp_discovery": true, "cmek": true, "vpc_sc": true},
  "workload": {"data": {"structured_tb": 20}, "queries": {"heavy": {"count": 100, "frequency": "yearly"}}},
  "plan": {"teams": 2}
}
```

## Extending

**Add a source type**: add an entry to `SOURCE_TYPES` in `catalog.py` with an existing `category`, or add a new category and a branch in `recommender.recommend()` (and `demo/engine.js`). Add default field values for the dialog in `TYPE_DEFAULTS` in `app.js`.

**Add a component** (BI, AI, API, database, governance): add an entry to `COMPONENTS` in `components.py` (vendor, method, settings, integration steps, docs); for Google components add a cost branch in `cost_components()` and prices in `pricing.json`. It appears in the library, diagram and Integrations tab automatically.

**Add a tool**: add it to `TOOLS` in `catalog.py` (name, layer, summary, doc link). Reference it in a rule's `chain` or `alternatives`.

**Add a cost model**: give the recommendation a new `engine` key and price it in the per-month loop in `estimator.estimate()`; put prices in `pricing.json`.

**Mirror in the demo**: the static demo uses `demo/engine.js`. `tests/test_demo_parity.py` compares it with Python on all samples and 25 random scenarios, so any divergence fails the build.

## Security notes

- Input is validated with pydantic (enums, numeric bounds, list sizes); unknown source types or regions return 422.
- All user text is HTML-escaped before rendering; no `innerHTML` with raw input.
- The container runs as a non-root user; no credentials are needed at runtime.
- External resources: Google Fonts only (falls back to system fonts offline).
