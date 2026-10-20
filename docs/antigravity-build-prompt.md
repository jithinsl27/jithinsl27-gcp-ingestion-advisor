# Build prompt: Data Cloud Compass (for Google Antigravity)

**How to use:** open a new workspace in Antigravity, start a task in the Agent Manager and paste everything below the line as the first message. Let the agent produce its implementation plan first and review it before it writes code. If you prefer smaller steps, paste the "Context", "Product" and "Engineering rules" sections first, then send one phase from "Build plan" at a time.

---

## Context

You are building **Data Cloud Compass**, a web application for Google Cloud Data & AI architects, Customer Engineers, Specialists and Sales to use **live in customer discovery meetings**. During the meeting the user captures the customer's source systems, data volumes and goals. The app recommends Google Cloud-native ingestion for each source, draws the target architecture, sizes BigQuery year by year, estimates a ballpark 1-year and 3-year cost (pay as you go, 1-year and 3-year commitments), recommends use cases, plans delivery and kickoff, tracks monthly risks, and produces a customer proposal, Google Slides and Sheets.

Owner: **Jithin S L** (show "Created by Jithin S L" pinned at the bottom of the left menu). The app is in **beta**: feedback goes to **jithinsl@google.com**.

Work in this order: **plan → build in phases → verify each phase in the browser and with tests → write the docs**. Before coding, produce an implementation plan artifact that lists the files, the data model, the API and the phases below, and wait for my approval. After each phase, show me a walkthrough with screenshots of the screens you built.

## Product

### Principles
- Built for a live meeting: fast, clear, no jargon in the UI. Plain business English, short sentences, sentence case.
- Every number is explainable: each heading and figure has a small "i" that shows, on hover or keyboard focus, how it was calculated.
- Estimates are **ballpark list prices**. Never invent prices: they live in one reviewed pricing file with a "last reviewed" date and source links, optionally refreshed from the Cloud Billing Catalog.
- A human stays in the loop before anything leaves the tool.
- Each tester works separately; nothing one person does changes another person's work.

### Left menu (modules, in this order)
Overview · Product monitor · Use cases · Technical enquiry · Sources · Architecture · Workload · Environments · Pricing · Roadmap · Risks · Proposal · Kickoff · Charge-back · Settings · Usage (admin) · Data flow & integrations.

Each module has a title, a one-line description, a row of **insight chips** (key figures) top-right, and a badge in the menu (count or headline figure). The top bar has: brand ("Data Cloud Compass - From discovery to blueprint on Google Cloud"), customer name, BigQuery region, currency, Discover, Scenarios, Load sample, Export, Feedback (marked "Beta") and the user's initials.

### Modules

**Overview** - one card per module with its key figures; four commercial headline cards (1 year pay as you go, 1-year commitment, 3-year commitment, 3 years pay as you go); "Where the money goes" bars by area; "Reset - start fresh" with Undo.

**Sources** - add, edit, include/exclude and import the customer's source systems. 35 source types in categories (relational DBs incl. Oracle, SQL Server, MySQL, PostgreSQL, Cloud SQL, AlloyDB, Spanner, Db2, JDBC; warehouses Teradata, Redshift, Snowflake, Netezza, Synapse; Hadoop; SAP; mainframe; MongoDB, Cassandra, Firestore; on-prem files, S3, Azure Blob, Cloud Storage; Kafka, Kinesis, Event Hubs; IoT, clickstream, logs; Google marketing (GA4/Ads), Salesforce, other SaaS, REST APIs; documents) plus "Other - not in this list" by product name that behaves like a chosen type. Fields: name, type, data type, location (on-prem, GCP, AWS, Azure, SaaS), frequency (real-time, near real-time, hourly, daily, weekly, monthly, one-time), transformation (none, light, heavy), initial volume and daily change (inputs from KB to ZB, stored in GB), tables, notes, processing region, **target** and, for data mesh, **business domain**.
- Targets: **Data platform** (BigQuery lakehouse: bronze, silver, gold), **Data mesh** (a business domain owns the data in its own BigQuery project and publishes data products through BigQuery sharing / Analytics Hub, governed by Dataplex; cost per domain), **Data lake** (Cloud Storage, open formats, BigLake), **Operational database** (AlloyDB / Cloud SQL via Database Migration Service, relational sources only).
- Each source card shows its target and the recommended ingestion chain.

**Discover** (dialog from the top bar) - three faster ways to capture sources: a guided interview, pasting meeting notes (Gemini extracts sources, products, open questions and assumptions as structured JSON), or importing an inventory spreadsheet (CSV/XLSX with a downloadable template). Always show a review step before adding.

**Ingestion recommendation rules** (deterministic, in Python, with rationale, alternatives and caveats for each source):
- Relational DBs → Datastream CDC → BigQuery by default; heavy transforms → Datastream → Cloud Storage → Dataflow → BigQuery; heavy transform + daily batch → batch ETL by skill. Db2/JDBC batch → batch ETL by skill.
- Batch ETL by skill: low-code → Cloud Data Fusion; Spark → Dataproc Serverless; SQL-first → Dataflow JDBC template + Dataform ELT; otherwise Dataflow batch.
- Teradata/Redshift/Snowflake → BigQuery Migration Service + Data Transfer Service; Netezza/Synapse → export → Storage Transfer → load; Hadoop → Dataproc Serverless + BigLake or Storage Transfer; ≥100 TB initial → add Transfer Appliance.
- SAP real-time/hourly → BigQuery Connector for SAP (SLT) + Cortex Framework; daily → Data Fusion SAP plugins. Mainframe → Mainframe Connector.
- MongoDB/Cassandra → Dataflow change-stream or batch templates. Files on-prem → Storage Transfer agent; S3/Azure → BigQuery Data Transfer Service; documents → Cloud Storage + BigQuery object tables + Gemini.
- Kafka → Dataflow Kafka-to-BigQuery template; Kinesis/Event Hubs → Pub/Sub import topic → BigQuery subscription (Dataflow if transforming); IoT/clickstream → Pub/Sub → BigQuery subscription (Dataflow if transforming); Cloud Logging → log sink.
- SaaS: Google marketing and Salesforce → BigQuery Data Transfer Service; others → Cloud Run / Application Integration / Data Fusion connectors.
- Batch and file flows land in a Cloud Storage **raw zone** first; CDC and streaming go straight to bronze.
- Private connectivity (HA VPN or Interconnect) when sources are on-prem or in other clouds; Apigee as the integration layer for API sources when Apigee is in the design.
- Flag services not offered in the chosen region, with nearby alternatives. Treat launch-baseline services (Cloud Storage, Cloud SQL, Cloud KMS, Compute Engine) as available in every region even when the Billing Catalog has not listed a new region yet.

**Use cases** - explain two routes clearly at the top: **A** the customer has use cases in mind (type them in, with notes: owner, KPI, data needed); **B** the customer has none yet (add sources and the tool recommends the **top 5** from the sources' type and system, each with a "Why" line naming the sources). Library of 14 use cases: Customer 360, churn and next-best action, real-time fraud, finance and regulatory reporting, supply chain, predictive maintenance/IoT, network and operations analytics, warehouse modernisation, document intelligence, conversational analytics (data agents), marketing attribution, self-service BI, governance and data products, operational apps and APIs.
- **Details** on click (dialog): summary, business benefits, KPIs, **data needed with specific data points** (e.g. customer ID, plan, start/end dates, cancellation reason), and how it is built on Google Cloud. Each data need is matched to the customer's sources by category **and** by keywords in the source name: green "covered", grey "possibly in", red "not in scope yet - ask the customer". Curated content for the 14 library use cases; the customer's own use cases are described by Gemini in the same layout (JSON schema), marked "Generated by Gemini".

**Technical enquiry** - ask a technical question in plain language; Gemini with Grounding with Google Search, restricted to Google's public documentation (cloud.google.com and related). Return only answers backed by at least one Google documentation page, with the links; otherwise say it could not be found. Suggested questions follow the architecture.

**Architecture** - a presentation-ready SVG diagram drawn from the scenario, left to right: source systems → connect (VPN/Interconnect, Apigee) → ingestion & CDC → raw zone → processing → BigQuery (bronze/silver/gold layers with sizes, Dataform, orchestration, BigQuery ML & Gemini, reverse ETL) plus Data mesh box (domains, data products), data lake and operational DB boxes → BI & analytics, AI/agents, APIs, operational databases. Columns that are not needed disappear; nodes sit at the barycentre of their flows to avoid crossings; labels are fitted to boxes; legend for batch, streaming/CDC, one-time, AI/API flows, partner (not costed), consumption.
- **Governance & security band** under the diagram with the controls in the design and dashed "+ Recommended" chips for missing enterprise controls (Knowledge Catalog/Dataplex, policy tags & masking, CMEK, VPC Service Controls, Sensitive Data Protection) - click to add.
- **Dataplex is drag and drop**: drag its chip onto BigQuery, the data mesh, the data lake or a source to choose what it governs (toggle on/off per layer); governed layers show a "Dataplex" badge; its price follows the tables in scope. Same choice in its settings for keyboard users.
- **Platform foundation band** (landing zone, IAM, Terraform/Cloud Build, Logging & Monitoring, Backup & DR, FinOps) - not separately priced.
- Product search to add 35 products (21 Google Cloud: Looker, Looker Studio Pro, Gemini Enterprise, Agent Platform data agents, Vertex AI endpoints, BigQuery ML, Apigee, AlloyDB, Cloud SQL, Spanner, Bigtable, Firestore, Memorystore, Knowledge Catalog, Sensitive Data Protection, CMEK, VPC Service Controls, policy tags, Security Command Center, Assured Workloads…; 14 partner: Power BI, Tableau, Collibra, Informatica…, never costed). Products have settings and some have connection modes set by dragging (e.g. Gemini Enterprise grounded on BigQuery / Looker / agents; Apigee as integration layer or AI gateway).

**Data flow & integrations** - per source: pattern, rationale, alternatives, discovery checks; per product: how it connects to BigQuery.

**Workload** - what the customer will run in plain terms (pipelines simple/complex, queries, ad-hoc reports, dashboards, data by type, ramp-up). Drives BigQuery scan volume and slot demand.

**Environments** - production plus development, UAT/test, pre-production, DR presets; each sized as a percentage of production per capability (data, ingestion, BigQuery compute, BI/AI, APIs/DB, platform) and running hours per week. Cost per environment. An **"Environments finalised"** tick: until ticked, Product monitor marks its figures **Draft**; after, **Final** (store a fingerprint of the environments; any change clears it).

**Product monitor** - two views:
1. **Key products**: exactly four cards - **BigQuery** (max slots and committed slots per year, compute and storage cost), **Looker** (licences, quote-based cost), **Apigee** (API calls per month, cost), **Gemini Enterprise** (users, edition, cost). Each card: Year 1, Year 2, Year 3 and 3-year total for the chosen pricing option (toggle: pay as you go / 1-year / 3-year), taken from the same monthly plan as Pricing. A total strip for the four products. Draft/Final badge. If Looker has no quote, the card asks for the annual quote inline. Not-used products show "Add to the architecture".
2. **BigQuery slot details**: slots sized **separately for year 1, 2 and 3** (data grows) per environment and in total. Options: pay as you go, 1-year commitments (re-sized each year), one 3-year commitment that **can only grow** (show top-ups). Commitment sizing: cost-optimal (default) or cover average demand; optional single commitment shared across environments; tick which environments to total. Year cards, a per-environment × year table (average, busiest hour, max, committed, top-up, autoscaled slot-hours, cost), and a side-by-side comparison with saving (or extra cost) vs pay as you go. Rules: commitments start at 100 slots and grow in steps of 50; autoscaling is pay as you go with a ×1.25 allowance for 50-slot steps and the 1-minute minimum; Standard edition has no commitments; edition recommended from features (Enterprise for VPC-SC, CMEK, policy tags, BQML/AI, BI Engine; Enterprise Plus for Assured Workloads). Demand: TiB scanned × slot-hours per TiB (default 60, calibratable from INFORMATION_SCHEMA.JOBS), pipelines in an overnight window, dashboards and ad-hoc in business hours with a busiest-hour factor.

**Pricing** - whole-programme cost three ways (pay as you go, 1-year, 3-year commitments), with or without the ramp-up plan, all or one environment; recommended specification per environment (product, quantity, unit, unit price, monthly); month × product view; editable bill of materials (quantity or unit price per service and environment, with undo); negotiated discount and Customer Care in Settings. **Looker is quote-based**: an "Annual licence quote (USD, 0 = not included)" field on the Looker product, spread over the months it is live. Partner products are never costed.

**Roadmap** - delivery squads schedule source builds after a 1-month foundation (quick wins first); go-live month per source and product; Gantt; milestones; ramped monthly spend. Honour a per-source **go-live override** (set by an applied risk).

**Risks** - monthly risk register. The user writes a risk in plain language and picks the month it was raised. Gemini (JSON schema) - or a built-in rules parser when Gemini is unavailable - turns it into changes: **delay** (new go-live month, or "by N months"), **de-scope** (out of this phase), **volume** (factor, e.g. "will double" = 2), or **none** (people, approvals - logged only). Show "Understood as" (editable change rows), likelihood and impact, then the **impact**: go-live months before → after, all-sources-live month, cost delta for year 1/2/3 and 3 years (pay as you go and 3-year commitment), a monthly spend chart (current plan vs with this risk), and recommendations (rules plus Gemini). Buttons: **Apply to the plan** (updates roadmap, pricing and exports), **Save as open risk**, Discard. Register table with Apply / Revert / Close / Delete, and a **likelihood × impact matrix**. Open and applied risks appear in the proposal.

**Proposal** - up to 15 pages, one per section (cover, executive summary, current landscape, target architecture with the diagram, ingestion, lakehouse/governance/security, analytics/AI/integration, environments, BigQuery capacity using the year 1-3 slot plan, commercial options with a yearly chart, product breakdown, monthly consumption, roadmap, assumptions/risks, kickoff readiness/team/next steps). Choose sections, title, author, company, commercial option and schedule. Download **PDF** (print), **Word (.docx)** or create a **Google Doc**. Notes: partner products listed with "contact the partner for ISV licence pricing"; "Looker licence is quote-based and not included" when no quote. Currency amounts are whole numbers; chart axes for slots are numbers, not currency.

**Kickoff** - readiness checklist derived from the architecture, grouped by area, each item with owner (Customer / Partner / Joint), why it matters, due date and critical flag; ticks saved with the scenario; filter by owner; milestones with exit criteria; partner and customer team size and skills; data mesh adds domain owners, data contracts and federated governance items. Download CSV.

**Charge-back** - once the customer is live, price a department's request (sources, pipelines, reports, AI use cases) on **negotiated prices**: upload a price sheet (Excel, CSV, Google Sheets link, or PDF/scanned image read by Gemini), review the matching, save. Each person has their own price book and ledger; an admin (ADMIN_KEY) can publish a default everyone starts from.

**Settings** - engagement settings, BigQuery model and calibration, lakehouse layers (raw zone retention/class, silver and gold %), commercial terms, growth %, contingency %, sizing constants and price sources.

**Usage (admin)** - who uses the tool and what they do (needs the admin key).

### Cross-cutting behaviour
- **Welcome screen** on the first visit asks for name, work email and team (used only for usage logs). Then a **beta notice** once per browser session: "Data Cloud Compass is in beta. Testing is in progress… If you have any feedback, please email jithinsl@google.com with a screenshot or a note", with an "Email feedback" button. The Feedback button reopens it.
- **Review before export** (human in the loop): every customer-facing export (Slides, Sheets, Print/PDF, proposal PDF/Word/Google Doc, Markdown, CSV, SVG) first shows the key figures (customer, region, sources, environments, pricing option, 1-year and 3-year totals as on the Overview) and four checkboxes; Export stays disabled until all are ticked; if Looker has no quote, ask for the quote (apply it and recalculate before exporting) or an explicit "continue without Looker pricing". Saving the scenario JSON needs no review. The confirmation lasts until the scenario changes. The Export menu shows a note that a review comes first.
- **Hover explanations** ("i") on every heading and figure, keyboard-accessible, rendered in one fixed-position tooltip.
- **Samples**: at least three ready-made scenarios (e.g. a retail bank in KSA, a telco warehouse modernisation, a manufacturing quick-start).
- **Scenarios**: the working scenario lives in the browser (localStorage); with Google sign-in, scenarios are saved in Firestore per owner with versions and sharing (view/edit, link access).
- **Exports**: Google Sheets (architecture, sizing, charts, pricing plans, kickoff readiness, team), Google Slides (customer presentation incl. commercial options, kickoff and milestones), Markdown, CSV, JSON, SVG, Print/PDF.
- Responsive down to phone width; dark mode; keyboard accessible; no external fonts required to render.

## Engineering rules

### Stack
- **Python 3.12, FastAPI, Pydantic v2, Uvicorn**. One engine in Python: recommender, estimator, slots, plan, readiness, use cases, use case details, risks, charge-back, live pricing.
- **Front end: plain ES modules in `app/static/js` with no build step**, one `index.html`, one `styles.css` with CSS custom properties for light and dark. SVG drawn by hand for the diagram and charts. Vendored libraries only where needed (docx generation, spreadsheet export) in `app/static/vendor`.
- **Google Cloud**: Cloud Run (container from a Dockerfile), Firestore (native mode) for saved scenarios, versions, price books, ledger, usage and a 24-hour price cache; Vertex AI Gemini via `google-genai` (model from `GEMINI_MODEL`, default `gemini-3.8-flash`, fallback `gemini-2.5-flash`) for notes, use case details, risks, PDF/image price sheets and grounded enquiries; Cloud Billing Catalog API (API key in Secret Manager) for live prices and regional availability; Google Identity Services for sign-in.
- One shared Gemini helper that takes a prompt and a JSON response schema, rate-limits per user per hour, and returns a clear 503 "Gemini is not available on this deployment" when there are no credentials - every Gemini feature must degrade gracefully (rules fallback or a clear message).

### Suggested layout
```
app/
  main.py            FastAPI app, Pydantic models, all /api routes, serves static files
  catalog.py         source types, tools, regions, targets, frequencies (served by /api/catalog)
  recommender.py     ingestion rules per source + targets (data platform, mesh, lake, operational DB)
  components.py      the 35 products: settings, costing, connection modes, Dataplex scope
  estimator.py       monthly 36-month cost model, environments, BigQuery, bill of materials, domains
  slots.py           slot sizing, edition choice, year-by-year plan (PAYG / 1-yr / 3-yr with top-ups)
  plan.py            roadmap waves, go-live months (with overrides), ramped pricing plans
  readiness.py       kickoff checklist, milestones, team
  usecases.py        library + top-5 recommendation
  usecase_details.py curated details + Gemini prompt/schema for custom use cases
  risks.py           rules parser, Gemini prompt/schema, apply, impact, recommendations
  chargeback.py      price sheet parsing/matching, request pricing, ledger records
  live_pricing.py    Billing Catalog fetch, SKU mapping, 3x sanity check, availability
  assist.py          Gemini helpers (notes, files, ai_json)
  enquiry.py         grounded technical answers
  auth.py, store.py, usage.py
  data/pricing.json  reviewed list prices with last_reviewed date and source URLs
  data/regions.json  regions with uplift factors
  static/            index.html, styles.css, js/*.js, proposal.js, config.js, icons/, vendor/
samples/*.json       sample scenarios
tests/               pytest engine + API tests; tests/ui Playwright browser tests
docs/                user-guide.md, deployment.md, architecture.md, pricing-model.md, decision-matrix.md
Dockerfile, deploy.sh, setup-github-deploy.sh, .github/workflows/{ci,deploy,pages}.yml
```

### API (JSON)
`GET /healthz` · `GET /api/config` · `GET /api/catalog` · `GET /api/samples` · `POST /api/estimate` · `POST /api/plan` · `POST /api/workload` · `POST /api/compare` · `GET /api/pricing/status` · `POST /api/pricing/refresh` · `GET /api/me` · scenarios CRUD + versions + share under `/api/scenarios` · `POST /api/assist/notes` · `POST /api/assist/file` · `GET /api/assist/template.csv` · `POST /api/usecases/details` · `POST /api/risks/parse` · `POST /api/risks/impact` · `POST /api/enquiry` · charge-back: template, price book (get/put/delete, `?scope=default` for admin), extract (file/link), price, requests (list/save/delete) · `POST /api/usage/event` · `GET /api/admin/usage`.
The estimate endpoints store nothing and stay open; saving, sharing and Gemini assist need sign-in when a client ID is configured (technical enquiry, use case details and risks are rate-limited by user/IP instead).

### Data model (scenario JSON, saved as-is)
`customer, region, processing_region, currency, annual_growth_pct, contingency_pct, skill, orchestration, sources[] {id, name, type, data_type, frequency, location, transform, initial_volume_gb, daily_change_gb, tables, region, included, target, domain, go_live_override, custom_name, like_type, iot_option}, components[] {id, type, settings, included}, environments[] {id, name, preset, factor overrides, runtime_pct, bq_baseline, bq_max}, bq {mode: ondemand|editions, edition, baseline_slots, max_slots, commit_strategy, shared_commitment, scan_basis, calibration, shape}, workload {...}, lakehouse {...}, commercial {discount_pct, support_plan}, pricing_option, use_cases[], risks[] {id, text, summary, month, likelihood, impact, changes[], recommendations[], status: open|applied|closed, prev}, env_final {key, at, by}, readiness_done[], proposal {...}, bom_overrides[]`.

### Pricing model rules
- Monthly model over 36 months per service, per environment and per region (regional uplift), with pay as you go, 1-year and 3-year committed-use prices where the service offers them; contingency; negotiated discount and support applied after.
- Assumptions to start from (all editable in Settings): batch GB per vCPU-hour by transform (none 25, light 20, heavy 8); streaming GB per vCPU-day (150/100/40), minimum 2 vCPU; Data Fusion 15 GB per vCPU-hour with a 4 vCPU-hour floor per run; Dataproc 20/15/6 GB per DCU-hour; landing retention 7 days; CDC net-new ratio 0.3; 70% of data older than 90 days is long-term storage; silver/gold add 50% storage; ELT scans 3× data ingested; analytics scans 2× stored data per month; 10% contingency; 20% annual growth.
- BigQuery cost lines must equal the year-by-year slot plan to the cent (test it).
- Live prices: accept a Billing Catalog price only within 3× of the reviewed price; cache 24 hours; show the price source in the UI.

### Quality bar
- Tests: pytest for every engine (rules, slot plan, pricing totals, plan overrides, use case details, risks incl. the rules parser, charge-back isolation per person) and Playwright browser tests for the main flows (samples, pricing, slots, export review incl. Looker quote, proposal ≤ 15 pages, kickoff, risks apply/revert, use case dialog, product monitor Draft → Final). Wait for conditions in browser tests, never fixed sleeps.
- Add a guard test that fails if any front-end code passes a formatter straight to `Array.map` (e.g. `years.map(money)`), because `map` passes the index as the second argument and turns it into decimal places.
- No console errors on any page. Every page checked at desktop and phone width, light and dark.
- UI copy: plain English, no internal jargon, explain abbreviations once.

### Deployment (must work in a few clicks)
- `deploy.sh` (idempotent, run from Cloud Shell): enable APIs (Run, Build, Artifact Registry, Firestore, Vertex AI, Cloud Billing, Secret Manager, API Keys, IAM, Monitoring, Logging); create Firestore; create a runtime service account with only Firestore user, Vertex AI user and log writer; create a Billing API key in Secret Manager; build and deploy to Cloud Run; print the URL, the admin key and next steps. Options: `--project --region --service --oauth-client-id --allowed-domains --firestore-location --cors-origins --gemini-model --feedback-url --admin-key --private --notify-email`.
- **Sign-in e-mails**: the service writes a `compass_signin` structured log line when someone signs in or registers on the first visit (once per person per 12 hours); `deploy.sh` creates an e-mail notification channel and a log-based alert to `--notify-email` (default jithinsl@google.com).
- `setup-github-deploy.sh` for Workload Identity Federation so GitHub Actions deploys on every push to `main`; `ci.yml` runs the tests; `pages.yml` publishes the same front end as a public demo on GitHub Pages that calls the Cloud Run API (CORS).
- A "Deploy in Cloud Shell" button / tutorial in the README.

## Build plan (verify and show me each phase)
1. **Skeleton** - FastAPI app, catalog, static shell with the left menu, top bar, module framework, insight chips, tooltips, light/dark theme, samples loading. Tests run in CI.
2. **Sources & recommendations** - source editor, all targets incl. data mesh domains, recommender rules with rationale, Discover (interview, spreadsheet; notes via Gemini with graceful fallback), Data flow & integrations.
3. **Architecture** - SVG diagram, product search and settings, governance band with recommended controls, Dataplex drag-and-drop scope, foundation band, legend, region availability notices.
4. **Pricing engine** - pricing.json, 36-month estimator, environments, workload, BigQuery editions and year-by-year slot plan, Pricing module with plans, bill of materials and edits, Looker quote field, live Billing Catalog refresh.
5. **Product monitor & environments sign-off** - four key product cards, BigQuery slot details, Draft/Final.
6. **Plan & deliver** - roadmap with overrides, Risks module, Kickoff, Proposal (PDF/Word/Google Doc) with partner ISV and Looker notes, Use cases with details.
7. **Trust & sharing** - welcome screen, beta notice, review before export, exports (Slides, Sheets, Markdown, CSV, SVG, JSON), Google sign-in, saved scenarios with versions and sharing, Charge-back per person, Usage admin, technical enquiry.
8. **Deploy & docs** - Dockerfile, deploy.sh, GitHub workflows and Pages demo, sign-in alert, README and docs (user guide, deployment, architecture, pricing model, decision matrix), final end-to-end walkthrough with screenshots using a fictional customer.

Acceptance: I can deploy with one command in Cloud Shell, open the URL, load a sample, and in under five minutes show a customer the architecture, the year 1-3 BigQuery slots and cost, the three commercial options, recommended use cases with their data needs, the roadmap and a proposal - and every number explains how it was calculated.
