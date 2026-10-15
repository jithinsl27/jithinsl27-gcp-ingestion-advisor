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

## 4. Products: BI, AI, APIs, databases, governance and security

At the top of the **Architecture** tab, type a product name in the search box (e.g. *power*, *spanner*, *sage*, *kms*). Results are ranked by name and show the category, how it connects, and whether it is costed.

- **Enter** or **Add** puts the product into the architecture; **Remove** takes it out. Clicking results keeps the list open so you can add several; you can also drag a result onto the diagram.
- Selected products appear as **pills** under the search box. **×** removes a product; clicking its name opens its settings (users, models, nodes, API calls …, and the **region** for Google services).
- **Governance and security are products too** - Knowledge Catalog, Collibra, Alation, Atlan, Informatica, Sensitive Data Protection, Cloud KMS (CMEK), VPC Service Controls, policy tags & masking, Security Command Center, Assured Workloads. The band at the bottom of the diagram shows only what you add.
- **Google Cloud products are costed; partner products** (Power BI, Tableau, SageMaker, Databricks, Collibra …) are drawn with a dashed border and a *Partner* tag and never costed.

### Choosing what is priced

- **Sources**: tick or untick each source in the sidebar (or use **Select all** / **Clear all**). Unticked sources stay in the scenario, appear dimmed as *Later phase* on the diagram, and are left out of recommendations, the estimate and the roadmap - useful for pricing phase 1 first.
- **Products**: the checkbox on each costed pill (or *Include in pricing* in its settings) keeps the product in the architecture but takes it out of the numbers; it shows as *Not priced*.
- **Service lines**: on the Consumption estimate tab, untick any service (e.g. Datastream, Composer, contingency) to leave it out of every total, the roadmap and workload sizing; unticked lines stay listed so you can tick them back.

## 5. Tabs

| Tab | Use it to |
|---|---|
| **Architecture** | Search and add products; walk the end-to-end flow on the white, presentation-ready canvas |
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
