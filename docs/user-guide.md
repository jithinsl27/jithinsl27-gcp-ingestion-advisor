# User guide

Data Cloud Compass is built to be used live in discovery workshops, typically screen-shared. Everything recalculates as you type.

## 1. Set up the engagement

- **Customer name** (top bar): appears in exports.
- **Region**: the BigQuery home region (or US/EU multi-region). Storage, queries and shared security controls are priced here.
- **Currency**: display currency (fixed conversion rates in `pricing.json`).
- **Load sample**: three ready-made customers (KSA retail bank, telco DWH modernisation, manufacturing).

## 2. Capture source systems

Click **Add source** for each system the customer wants in BigQuery.

| Field | Meaning | Why it matters |
|---|---|---|
| Source system type | 35 types across databases, warehouses, SAP, mainframe, NoSQL, files, streams, SaaS, APIs, documents | Selects the rule set |
| Name | The customer's own name for it | Shown on the diagram and in the proposal |
| Data type | Structured, semi-structured, unstructured, events | Load format and notes |
| Where it runs | On-prem, GCP, AWS, Azure, SaaS | Connectivity (VPN / Interconnect) and egress caveats |
| Freshness needed | Real-time … monthly, or one-time migration | CDC / streaming vs batch |
| In-flight transformation | None (ELT), light, heavy | Adds processing, changes throughput |
| Processing region | Where this source's ingestion runs (default: BigQuery region) | Regional price and cross-region transfer |
| Initial volume (GB) / Daily change (GB/day) | Historical load and ongoing change | One-time and ongoing cost, storage growth |

The colour bar shows the flow: green dashed = streaming/CDC, orange = scheduled batch, red dotted = one-time.

## 3. Engagement settings

Team skill set (drives batch tool choice), orchestration, BigQuery pricing model and slots, analytics scan volume, growth, contingency, environment, and the **processing region** for shared services (orchestration, Data Fusion, network).

## 4. BI, AI, APIs, databases & governance (component library)

On the **Architecture** tab, the component library lists every supported tool, grouped as BI & analytics, AI/ML & agents, APIs & integration, Operational databases, and Governance & catalog.

- **Drag** a component onto the diagram, or **click** it, to add it. A tick shows what is already in the architecture.
- **Click** a component on the diagram, in the sidebar list, or on the Integrations tab to configure it (users, models, nodes, API calls …) and, for Google services, choose its **region**.
- **Google Cloud components are costed. Partner components** (Power BI, Tableau, SageMaker, Databricks, Collibra …) are drawn with a dashed border and a *Partner* tag and are **never costed**.
- **Security & compliance** toggles (Sensitive Data Protection, CMEK, VPC Service Controls) are in the sidebar.

Examples: customer uses Power BI → drag *Microsoft Power BI*; the diagram shows it connected to BigQuery through the Power BI BigQuery connector (Import or DirectQuery) and the Integrations tab lists the setup steps. Customer wants agents with governed API access → add *Agent Platform* and *Apigee*; agents call tools and models through Apigee (quotas, token limits, Model Armor).

## 5. Tabs

| Tab | Use it to |
|---|---|
| **Architecture** | Walk the end-to-end flow; add components from the library |
| **Ingestion patterns** | Explain per-source choices: pattern, service chain, rationale, alternatives, discovery checks |
| **Integrations** | Show how each selected tool connects to BigQuery, with cost for Google services |
| **Consumption estimate** | 1-year and 3-year totals with commitments, by capability, service, region and source |
| **Workload sizing** | Estimate from what the customer will run (see below) |
| **Roadmap** | Final architecture, month-by-month plan and ramped consumption (see below) |
| **Assumptions** | Every sizing constant and price source |

## 6. Workload sizing

Use when the customer describes workloads rather than systems, e.g. *"100 pipelines, 25 complex and 20 simple queries, 100 yearly heavy queries, 10 ad-hoc reports, 25 dashboards, 50 TB (20 TB unstructured, 10 TB semi-structured), 100 GB telemetry, and for the first two months 110 GB and one report"*. The defaults are exactly that example.

- **Data estate**: TB by type. Structured and semi-structured go to BigQuery; unstructured to Cloud Storage with BigQuery object tables.
- **Telemetry**: GB per day or month, retention, optional in-flight transform (Dataflow).
- **Pipelines**: counts by complexity, runs per day, and engine (ELT in BigQuery or ETL on Dataflow).
- **Queries & reports**: count, frequency (hourly … yearly) and GB scanned per run for simple, complex, heavy/periodic and ad-hoc.
- **Dashboards**: count, refreshes, queries per refresh, GB per query, cache / BI Engine hit rate.
- **Ramp-up phase**: months, data volume, pipelines and reports during ramp-up.
- **Regions & pricing**: separate regions for data & queries, pipelines and streaming; on-demand or editions (with slot-hours per TiB); option to include the components from the Architecture tab.

Results: ramp-up and steady-state monthly cost, 1-year and 3-year totals, by category, monthly chart, on-demand vs editions comparison, line items and by region.

## 7. Roadmap

Generated automatically from the sources and components:

- **Month 1** foundation (landing zone, IAM, networking, VPC-SC, CMEK, datasets, Dataform CI/CD, catalog).
- **Source waves** built by parallel **delivery squads** (selectable), quick wins first; each source goes live in the month its build ends.
- **Component rollout**: BI with the first live source, databases a month later, agents / GPU serving / Apigee once half the sources are live, Gemini Enterprise a month after agents, governance from month 1.
- **Ramped consumption**: each service starts costing when it goes live, shown as a stacked monthly chart against the steady-state run-rate, plus a month table with what goes live and cumulative spend.

## 8. Export and save

**Export**: Markdown proposal (includes integrations, workload sizing and roadmap), CSV, scenario JSON, architecture SVG, print/PDF. **Open scenario** reloads a saved JSON.

## Good practice

- Present numbers as a **range** and state region, growth and commitment assumptions.
- Keep data residency in mind when choosing different regions per service; the tool flags cross-region processing.
- Validate in the Pricing Calculator before a formal proposal.
