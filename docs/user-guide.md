# User guide

The advisor is built to be used live during discovery workshops, typically screen-shared. Everything recalculates instantly as you type.

## 1. Set up the engagement

- **Customer name** (top bar): appears in exports.
- **Region**: the Google Cloud region (or US/EU multi-region) where BigQuery and processing will run. Drives the regional price uplift and the residency discussion.
- **Currency**: display currency. Fixed conversion rates live in `pricing.json` (`fx`).
- **Load sample**: three ready-made customers to demo or start from.

## 2. Capture source systems

Click **Add source** for each system the customer wants in BigQuery.

| Field | Meaning | Why it matters |
|---|---|---|
| Source system type | 35 types across databases, warehouses, SAP, mainframe, NoSQL, files, streams, SaaS, APIs, documents | Selects the rule set |
| Name | The customer's own name for it | Shown on the diagram and in the proposal |
| Data type | Structured, semi-structured, unstructured, events | Influences load format and notes |
| Where it runs | On-prem, GCP, AWS, Azure, SaaS | Drives connectivity (VPN / Interconnect) and egress caveats |
| Freshness needed | Real-time … monthly, or one-time migration | CDC/streaming vs batch; batch runs per month |
| In-flight transformation | None (pure ELT), light, heavy | Adds Dataflow/Data Fusion processing, changes throughput |
| Initial volume (GB) | Historical data to load once | One-time load cost, BigQuery storage |
| Daily change volume (GB/day) | New + changed data per day | Ongoing ingestion cost, storage growth |
| Discovery notes | Free text | Carried into the proposal |

The colour bar on each source shows its flow: green dashed = streaming/CDC, amber = scheduled batch, violet dotted = one-time. Click any source (in the list or on the diagram) to edit or remove it.

**Sizing tips**: daily change volume for a database ≈ redo/binlog volume or (rows changed × average row size). For streams, use average throughput × 86,400 s. When in doubt, enter a range-midpoint and show the discussion range.

## 3. Engagement settings

- **Team skill set**: SQL-first (ELT, Dataform), low-code (Data Fusion), code-first (Dataflow/Beam), Spark (Dataproc Serverless). Changes batch tool choices.
- **Orchestration**: Auto picks Composer, Workflows or none based on how many pipelines need scheduling; or force a choice.
- **BigQuery pricing**: On-demand (per TiB scanned) or an edition with average slots.
- **Analytics scan, TiB/month**: leave on Auto, or enter the customer's expected query volume.
- **Annual data growth %** and **Contingency %**.
- **Environment**: Production (HA) moves Data Fusion to Enterprise edition.

## 4. Analytics, AI & governance

Toggle each capability to include it in the diagram, the narrative and the cost:

- **BI & semantic layer**: Looker (enter the annual quote to price it), Looker Studio Pro (per user) or Looker Studio.
- **Gemini Enterprise**: edition and number of users.
- **Data agents (Agent Platform)**: Gemini model, requests per month, tokens per request.
- **Model serving on GPU endpoints**: accelerator, replicas, hours per day.
- **Governance (Knowledge Catalog / Dataplex)**: share of tables with quality scans and scan frequency.
- **Security & compliance**: Sensitive Data Protection discovery, CMEK, VPC Service Controls.

## 5. Read the results

| Tab | Use it to |
|---|---|
| **Architecture** | Walk the end-to-end flow; governance band underneath every layer |
| **Ingestion patterns** | Explain per-source choices: pattern, service chain (links to docs), rationale, alternatives, things to check during discovery; platform blueprint at the top |
| **AI, governance & security** | Tell the agentic data cloud story with per-capability cost and a suggested demo storyline |
| **Consumption estimate** | 1-year and 3-year totals, with commitments, by capability, monthly run-rate, by service, by source |
| **Assumptions** | Every sizing constant and price source, for transparency with the customer |

## 6. Export and save

**Export** menu: Markdown proposal, CSV cost breakdown, scenario JSON (to reopen later), architecture SVG, print/PDF. **Open scenario** reloads a saved JSON. Work is also kept automatically in your browser.

## Good practice

- Present numbers as a **range**, and state the region, growth and commitment assumptions.
- Re-run with the customer's real volumes after discovery and validate in the Pricing Calculator before a formal proposal.
- Use the caveats list as your follow-up checklist (CDC prerequisites, licensing, API limits, egress).
