# Pricing model

The estimator (`app/estimator.py`) simulates **36 months**. Each month every source's change volume grows by the scenario's annual growth rate (compounded monthly). Each recommended pattern converts GB into billable units; shared platform services are added once; a contingency percentage is applied on top.

Every figure exists for three **pricing options**, chosen in the app:

- **Pay-as-you-go** - list prices.
- **1-year commitment** and **3-year commitment** - committed-use prices applied only where Google offers them in this model: BigQuery edition **baseline** slots (autoscaling is always pay-as-you-go), Dataflow streaming, Composer, Agent Engine, AlloyDB, Cloud SQL, Spanner, Bigtable, Firestore, Memorystore and Knowledge Catalog premium processing. In the 3-year view a 1-year commitment is assumed renewed each year.

Then, in order: **contingency** (% of the month's total), the **negotiated discount** (% off everything), and **Google Cloud Customer Care** on the month's list-price spend - Standard 3 % (min $29), Enhanced 10 % / 7 % / 5 % / 3 % by spend tier (min $100), Premium 10 % / 7 % / 5 % / 3 % (min $15,000) per [cloud.google.com/support](https://cloud.google.com/support).

The **discussion range** runs from the cheapest commitment figure × (1 + low %) to pay-as-you-go × (1 + high %); defaults −25 % / +30 %, editable under Commercial terms.

## Price sources

### Live prices

On Cloud Run the service reads the public **Cloud Billing Catalog API** once a day (`app/live_pricing.py`): the services it needs, their SKUs, each SKU's `serviceRegions` and tiered unit prices. Mapped price points (BigQuery on-demand, storage, Write API and edition slot-hours incl. commitments; Cloud Storage classes; Dataflow vCPU / memory / Streaming Engine; Pub/Sub; Composer and Dataproc Serverless DCU; Cloud Run) are matched by SKU description. A live price replaces the reviewed one only within 3× of it. Per region, the ratio of each SKU's regional price to `us-central1` becomes that service's **regional uplift**, replacing the approximate multiplier. `GET /api/pricing/status` lists what matched, what did not and when it last refreshed; the app shows the source in the summary bar and the Assumptions tab. To adjust a match, edit `PRICE_MAP` in `app/live_pricing.py` (description regular expression, usage type, unit).

**Availability**: a service is treated as offered in a region when one of its SKUs lists that region (global SKUs count everywhere). Without live data only the launch-baseline services (Cloud Storage, Cloud SQL, KMS, Compute Engine) are assumed available and the others are reported as *not verified*.

### Reviewed prices (fallback)

`app/data/pricing.json` holds USD list prices for `us-central1`, reviewed 2026-10-15 from:

- [BigQuery](https://cloud.google.com/bigquery/pricing), [Datastream](https://cloud.google.com/datastream/pricing), [Dataflow](https://cloud.google.com/dataflow/pricing), [Pub/Sub](https://cloud.google.com/pubsub/pricing), [Data Fusion](https://cloud.google.com/data-fusion/pricing), [Composer / Managed Airflow](https://cloud.google.com/composer/pricing), [Dataproc Serverless](https://cloud.google.com/dataproc-serverless/pricing), [Cloud Storage](https://cloud.google.com/storage/pricing), [Storage Transfer](https://cloud.google.com/storage-transfer/pricing), [Integration Connectors](https://cloud.google.com/integration-connectors/pricing)
- [Vertex AI (prediction, Agent Engine)](https://cloud.google.com/vertex-ai/pricing), [Gemini models](https://cloud.google.com/vertex-ai/generative-ai/pricing), [Dataplex / Knowledge Catalog](https://cloud.google.com/dataplex/pricing), [Sensitive Data Protection](https://cloud.google.com/sensitive-data-protection/pricing), [Cloud KMS](https://cloud.google.com/kms/pricing)

Entries flagged `"verify": true` are approximations (Composer environment size in DCUs, Data Fusion pipeline all-in vCPU rate, H100 node price, Interconnect port, Gemini Enterprise per-user prices, Dataplex DCU per scan).

**Regional uplift** (`app/data/regions.json`) is an approximate multiplier versus `us-central1` applied to regionally priced services. Pub/Sub, Datastream, Storage Transfer, network and per-user licences are not multiplied.

**Quote-based items**: Looker licences (enter the customer's annual quote), Security Command Center Premium/Enterprise, partner licences (SAP SLT, IBM IIDR), support.

## Sizing formulas

| Pattern | Units | Formula (per month) |
|---|---|---|
| Datastream CDC | GiB processed | sum of all CDC sources' monthly change GB, priced on graduated tiers ($2.00 / $1.50 / $1.20 / $0.80 per GiB); backfill: first 500 GiB free then $0.40/GiB |
| Dataflow batch | vCPU-h + memory | runs × max(1 vCPU-h, GB per run ÷ throughput); throughput 25 / 20 / 8 GB per vCPU-h for none / light / heavy; memory 3.75 GiB per vCPU; heavy adds shuffle $0.011/GiB |
| Dataflow streaming | always-on workers | vCPUs = max(2, ⌈GB/day ÷ 150 / 100 / 40⌉); × 730 h × (vCPU + memory + 0.5 Streaming Engine CU per vCPU-h) |
| Pub/Sub → BigQuery subscription | TiB | TiB × ($40 publish + $50 BigQuery subscription) |
| Pub/Sub → Dataflow | TiB | TiB × $40 × 2 (publish + delivery) + Dataflow streaming |
| Data Fusion | instance + pipelines | instance: Basic ($1.80/h after 120 free h) or Enterprise ($4.20/h), shared; pipelines: runs × max(4 vCPU-h, GB ÷ 15) × $0.06 |
| Dataproc Serverless | DCU-h | runs × max(3 DCU-h, GB per run ÷ 20 / 15 / 6) × $0.06 |
| Storage Transfer (agent) | GiB | $0.0125/GiB from on-prem; cloud-to-cloud free |
| DTS (Google SaaS, S3, Azure, Salesforce) | - | no transfer charge; BigQuery load jobs on shared slots are free |
| Teradata migration | VM-h | migration agent VM (4 vCPU) 730 h/month while syncing + initial load hours at 500 GB/h |
| SAP connector, Cloud Run extractors | GiB | BigQuery Storage Write API $0.025/GiB after 2 TiB free |
| Logging sink | GiB | streaming inserts $0.05/GiB |
| Integration Connectors | node-h + GiB | 730 h × $0.70 + $10/GiB processed after 20 GiB |

## BigQuery

- **Storage**: initial volume + net-new data (30% of CDC change volume, 100% for append-only sources), +50% for curated/mart layers. Data older than 90 days: 70% billed as long-term. Active $0.02, long-term $0.01 per GiB-month; 10 GiB free.
- **Scan volume** (TiB/month), from one of three bases chosen under *Sizing & calibration*:
  - *Rule of thumb*: ELT scans of 3× the data ingested + analytics scans of 2× the data stored per month (both multipliers editable), or the analytics TiB/month you enter;
  - *Workload sizing tab*: pipelines, queries, ad-hoc reports and dashboards entered there (steady state, grown by the growth rate);
  - *Measured*: TiB scanned per month from the customer's `INFORMATION_SCHEMA.JOBS`, grown by the growth rate (the app gives the query).
- **Compute, on-demand**: scan TiB × $6.25 after 1 TiB free.
- **Compute, editions** (`app/slots.py`): slot-hours = scan TiB × slot-hours per TiB (60 by default, or measured slot-hours ÷ measured TiB). Demand is laid out as an average day (pipelines and heavy jobs in the batch window, dashboards / interactive / ad-hoc in business hours × the busiest-hour factor). Each month: `baseline × 730 h × rate` (pay-as-you-go, 1-year or 3-year commitment rate) + `Σ hours min(max − baseline, demand − baseline) × 30 × 1.25 × pay-as-you-go rate` (the 1.25 covers 50-slot steps, the 1-minute minimum and scale-down lag). Edition rates in us-central1: Standard $0.04, Enterprise $0.06, Enterprise Plus $0.10 per slot-hour.

## Platform

- **Composer**: small environment ≈ 10 DCU average (medium 20 for > 10 sources) × $0.06/DCU-h.
- **Workflows + Scheduler**: $0.10 per scheduled job per month.
- **HA VPN**: 2 tunnels × $0.05/h. **Interconnect**: 10 Gbps dedicated port ≈ $1,700/month + 2 VLAN attachments.
- **Landing bucket**: 7 days of change data in Cloud Storage Standard.

## Analytics, AI, governance, security

| Item | Formula |
|---|---|
| Looker | customer's annual quote ÷ 12 |
| Looker Studio Pro | users × $9 |
| Gemini Enterprise | users × edition price (Business $21, Standard $30, Plus $60 indicative) |
| Agent Engine | requests × seconds per request → vCPU-h ($0.085) and GiB-h ($0.009, 2 GiB per vCPU) after free tier |
| Gemini tokens | requests × (input tokens × input price + output tokens × output price) |
| Agent BigQuery queries | requests × GB scanned per request × on-demand rate (on-demand model only) |
| GPU endpoint | replicas × hours/day × 30.4 × node price (L4 $0.98, A100 $4.22, H100 ≈ $12.80 per hour) |
| Knowledge Catalog | tables (sources × 50 default × 2.5 for curated layers); quality scans on X% of tables × scans/month × 0.05 DCU-h + lineage 0.17 DCU-h per table, at premium $0.089/DCU-h; metadata $2/GiB |
| Sensitive Data Protection | $0.03/GB profiled: all stored data in month 1, then new data monthly |
| Cloud KMS | ~20 key versions + ~3 M operations per month |

## Operational databases and Apigee

| Component | Formula (per month) |
|---|---|
| AlloyDB | nodes (2 with HA + read pool) × (vCPU × $0.06608 + GiB × $0.0112) × 730 + storage $0.30/GiB; CUD 25% / 52% |
| Cloud SQL (Enterprise) | (vCPU × $0.0413 + GiB × $0.007) × 730 (HA rates double) + SSD $0.17/GiB ($0.34 HA); CUD on compute |
| Spanner | nodes × $0.90 / $1.23 / $1.71 (Standard / Enterprise / Enterprise Plus) × 730 + $0.30/GiB; CUD 20% / 40% |
| Bigtable | nodes × $0.65 / $0.85 × 730 + SSD $0.17/GiB; CUD 20% / 40% |
| Firestore | reads $0.03 and writes $0.09 per 100k after free tier + $0.075/GiB |
| Memorystore | capacity × Standard-tier GiB-hour rate by size band × 730 |
| Apigee | environment fee (Base $365, Intermediate $1,460, Comprehensive $3,431) + API calls tiered ($20 / $16 / $13 per million standard; $100 / $80 / $64 extensible) + optional analytics ($20/M) and Advanced API Security ($350/M) |

Partner components (Power BI, Tableau, MicroStrategy, Qlik, ThoughtSpot, DataRobot, Dataiku, SageMaker, Azure ML, Databricks, Collibra, Alation, Atlan, Informatica) are never costed.

## Targets

Each source has a target:

- **Data platform** - lands in BigQuery (bronze, then silver and gold), with the optional Cloud Storage raw zone. BigQuery compute is priced only from the month the first data-platform source goes live (ramp-up plan).
- **Data lake** - lands in Cloud Storage only: cumulative storage (initial load + monthly change, growing with the growth rate) at the raw-zone storage class; no BigQuery storage or compute for that source.
- **Operational database** - MySQL / PostgreSQL / Cloud SQL / AlloyDB sources move with **Database Migration Service** (homogeneous: no charge), Oracle and SQL Server with DMS heterogeneous migration, priced like Datastream (tiered per GiB, first 500 GiB of backfill free, then $0.40 / GiB). Add AlloyDB or Cloud SQL from the product picker to price the target database.

Custom sources (*Other - not in this list*) are priced as the type chosen in *Treat it like*.

## Pricing plans

Plans are computed from the monthly cost of every product line and environment (`product_months`), in three prices: pay-as-you-go, 1-year and 3-year committed-use (only commitment-eligible lines - BigQuery edition baselines, Cloud SQL / AlloyDB, Spanner, Compute Engine, GKE … - get the discount). *PAYG 1 year* and *1-year commitment* sum months 1-12; *3-year commitment* and *PAYG 3 years* sum months 1-36 and are split by year. *With ramp-up plan* uses the roadmap's go-live months; *Full scope from month 1* uses the steady-state estimate.

## Environments

The scenario describes the primary environment. Each additional environment adds a copy of every service line scaled by one factor: storage, Cloud Storage and initial loads by *data %*; CDC, pipelines, streaming, Write API and transfer by *ingestion %*; on-demand BigQuery compute by *compute %*; BI, Gemini Enterprise, agents and GPU endpoints by *AI %*; Apigee and operational databases by *apps %*; orchestration, Data Fusion, governance and security by *platform %*. Services billed while running (streaming Dataflow, Composer, Data Fusion instance, VMs, Integration Connectors nodes, GPU endpoints, Agent Engine, Apigee environment, AlloyDB, Cloud SQL, Spanner, Bigtable, Memorystore) are further multiplied by *running hours %* (hours per week ÷ 168). HA VPN / Interconnect and the Looker licence are shared (factor 0). Contingency applies to the total.

With BigQuery editions each environment has its own reservation: demand = production demand × *compute %*; max = production max × *compute %* (50-slot steps); baseline = production baseline × *compute %* rounded down, or 0 when the environment runs part-time. Any baseline or max can be overridden per environment.

## Lakehouse layers

- **Raw zone**: GiB landed = initial load + monthly change of the sources in scope (file / extract-based engines, or all sources), kept for *retention* months, priced at the chosen Cloud Storage class (Standard $0.020, Nearline $0.010, Coldline $0.004, Archive $0.0012 per GiB-month in us-central1). It replaces the short-lived landing bucket.
- **Silver and gold**: BigQuery storage is bronze × (1 + silver % + gold %); defaults 30 % + 20 % (the previous 50 % curated overhead).

## IoT

Google-native Pub/Sub ingestion is costed as before. *MQTT broker on GKE / Compute Engine* adds an HA pair of 4-vCPU VMs. *Manufacturing Data Engine* is costed as Pub/Sub + Dataflow streaming. Litmus, ClearBlade and Manufacturing Connect licences are partner costs and are not included.

## Bill of materials

Every line item carries a quantity in its billing unit (GiB, TiB scanned, slot-hours, vCPU-hours, DCU-hours, user-months, node-hours, M API calls …). The BOM shows month-12 and year-1 quantities and a blended unit price = year-1 cost ÷ year-1 quantity, which includes regional uplift, tiers and free allowances.

## BigQuery slot sizing

The same model serves the estimate and the Workload sizing tab (`app/slots.py`). Max (auto) = max(busiest hour, heavy / ad-hoc query burst to finish within the target minutes) rounded up to 50 slots. The baseline (auto) is chosen from 0 … max in 50-slot steps to minimise `baseline × 730 × 1-year commit price + autoscaled slot-hours × pay-as-you-go price`. Standard edition: no baseline or commitments, 1,600-slot maximum. The edition comparison shows on-demand and each edition at its own auto-sized baseline / max for all three pricing options; editions are recommended only when at least 10 % cheaper than on-demand (with a 1-year commitment).

## Regions

Every line item carries a region. Sources use their own processing region (default: BigQuery region); Google components can each set a region; orchestration, Data Fusion and network use the processing region; BigQuery, storage and security use the home region. When a source (or workload streaming) runs outside the BigQuery region, cross-region transfer is added at ~$0.02/GiB within a continent and ~$0.08/GiB between continents (verify for specific routes).

## Workload sizing

| Item | Formula |
|---|---|
| BigQuery storage | (structured + semi-structured TB) × growth + telemetry retained; 60% long-term after month 3 |
| Cloud Storage | unstructured TB × growth × $0.02/GiB |
| Queries & reports | count × runs per month (hourly 730, daily 30, weekly 4.3, monthly 1, quarterly ⅓, yearly 1/12) × GB scanned |
| Dashboards | count × refreshes/day × 30 × queries/refresh × GB/query × (1 − cache %) |
| Pipelines (ELT) | count × runs × GB scanned per run (simple 5, medium 50, complex 250 GB) |
| Pipelines (ETL) | count × runs × vCPU-h per run (0.5 / 2 / 8) on Dataflow |
| Orchestration | Composer when > 10 pipelines, else Workflows |
| Telemetry | Pub/Sub BigQuery subscription, or Pub/Sub + Dataflow streaming when transformed |
| Editions | slot-hours = TiB scanned × slot-hours per TiB (default 60, editable) |
| Ramp-up | first N months use the ramp data volume, ramp pipelines and reports, plus development scans of 5× ramp data |

## Roadmap

Foundation month 1 (4 weeks); build effort per pattern (DTS 2 weeks, Datastream 3, Dataflow 4, Data Fusion 5, Spark 6, SAP 8, warehouse migration 10; +2 for heavy transforms, +4 for 100 TB+, +4 for mainframe/Hadoop); squads build in parallel, quick wins first. Each source's costs start in its go-live month (initial load in that month); BigQuery editions slots and shared platform services start with the first live source; components start per the rollout rules in the user guide.

## Updating prices

Deployed services refresh mapped prices daily on their own. For the reviewed fallback and for items without a live mapping:

1. Edit `app/data/pricing.json` (and `regions.json` for uplifts). Keep the same keys.
2. Update `_meta.last_reviewed`.
3. Run `python -m pytest -q`.
4. Push to `main` (deploys automatically once `setup-github-deploy.sh` has run) or run `./deploy.sh`.
