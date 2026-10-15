# Pricing model

The estimator (`app/estimator.py`) simulates **36 months**. Each month every source's change volume grows by the scenario's annual growth rate (compounded monthly). Each recommended pattern converts GB into billable units; shared platform services are added once; a contingency percentage is applied on top.

Two views per horizon:

- **Pay-as-you-go** - list prices.
- **With commitments** - 1-year CUD prices for the 1-year view, 3-year CUD prices for the 3-year view, applied only where Google offers them in this model: BigQuery editions slots, Dataflow streaming, Composer, Agent Engine, Knowledge Catalog premium processing.

A **discussion range** is shown as 75% of the committed figure to 130% of the pay-as-you-go figure.

## Price sources

All prices are USD list prices for `us-central1` in `app/data/pricing.json`, reviewed 2026-10-15 from:

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
- **Compute, on-demand**: (ELT scans of 3× monthly ingested data + analytics scans) × $6.25/TiB after 1 TiB free. Analytics scans default to 2× stored data per month, or the TiB/month you enter (grows with the growth rate).
- **Compute, editions**: average slots × 730 h × edition rate (Standard $0.04, Enterprise $0.06, Enterprise Plus $0.10; CUD rates for commitment views).

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

1. Edit `app/data/pricing.json` (and `regions.json` for uplifts). Keep the same keys.
2. Update `_meta.last_reviewed`.
3. Run `python -m pytest -q` and `python demo/build_demo.py`.
4. Redeploy (`./deploy.sh` or push to `main` with Cloud Build).
