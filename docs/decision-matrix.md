# Decision matrix: source → GCP ingestion pattern

This is the rule set implemented in `app/recommender.py`. Inputs that drive a decision: **source type**, **freshness** (real-time / near real-time / hourly / daily / weekly / monthly / one-time), **in-flight transformation** (none / light / heavy), **where it runs** (on-prem, GCP, AWS, Azure, SaaS), **volume**, and the **team skill set** (SQL-first, low-code, code-first, Spark).

## Relational databases

| Source | Condition | Recommended pattern | Main alternatives |
|---|---|---|---|
| Oracle, SQL Server, MySQL, PostgreSQL, Cloud SQL, AlloyDB, Spanner | default (any freshness, no heavy transform) | **Datastream CDC → BigQuery** (backfill + continuous changes) | Dataflow JDBC template, Data Fusion, federated queries (Cloud SQL/AlloyDB/Spanner) |
| same | heavy in-flight transformation | **Datastream → Cloud Storage → Dataflow (Datastream-to-BigQuery template) → BigQuery** | Datastream direct + Dataform (ELT) |
| same | heavy transform and daily/weekly batch | Batch ETL by skill (below) | Datastream if freshness becomes a need |
| Db2, other JDBC | batch | Batch ETL by skill | Debezium / IIDR → Managed Kafka for real-time CDC |

**Batch ETL by skill**: low-code → Cloud Data Fusion; Spark → Dataproc Serverless; SQL-first with no transform → Dataflow JDBC-to-BigQuery template + Dataform (ELT); otherwise → Dataflow batch pipeline.

## Warehouses and big data

| Source | Pattern |
|---|---|
| Teradata, Redshift, Snowflake | **BigQuery Migration Service + Data Transfer Service** migration connector (schema, data, incremental), SQL translation and validation |
| Netezza, Synapse | Export → Storage Transfer → Cloud Storage → BigQuery load; Migration Service for SQL |
| Hadoop / Hive / HDFS | Spark/code teams → **Dataproc Serverless** + BigLake; others → Storage Transfer (HDFS) → BigLake/BigQuery + Dataform |
| Any, initial ≥ 100 TB | add **Transfer Appliance** for the seed load |

## Enterprise applications

| Source | Condition | Pattern |
|---|---|---|
| SAP ECC / S/4HANA / BW | real-time / hourly | **BigQuery Connector for SAP** (SLT) + Cortex Framework |
| SAP | daily or slower | **Cloud Data Fusion** SAP plugins (ODP, BW Open Hub, table batch) |
| Mainframe | any | **Mainframe Connector** → Cloud Storage (ORC) → BigQuery; partner log readers for real-time CDC |

## NoSQL

| Source | Pattern |
|---|---|
| MongoDB, Cassandra | Real-time → **Dataflow** change-stream templates; batch → Dataflow batch templates; JSON columns flattened in Dataform |
| Firestore, Bigtable | Dataflow change streams / export, or Bigtable external tables |

## Files and object storage

| Source | Pattern |
|---|---|
| On-prem files (NFS/SMB/SFTP) | **Storage Transfer Service (agent)** → Cloud Storage → BigQuery load / BigLake; + Dataflow for heavy cleansing |
| Amazon S3 / Azure Blob | **BigQuery Data Transfer Service** (hourly minimum); BigQuery Omni / BigLake to query in place; Storage Transfer + Dataflow for heavy transforms |
| Cloud Storage | Load jobs (free on shared slots) or BigLake tables |
| Documents, images, media | Cloud Storage + **BigQuery object tables** + Document AI / Gemini via BigQuery ML |

## Streaming and events

| Source | Condition | Pattern |
|---|---|---|
| Kafka / Confluent | any | **Dataflow Kafka-to-BigQuery template**; alternatives Managed Service for Apache Kafka + BigQuery sink, Pub/Sub import topics |
| Kinesis / MSK, Event Hubs | no transform | **Pub/Sub import topic → BigQuery subscription** |
| same | light/heavy transform | Pub/Sub import topic → Dataflow → BigQuery |
| IoT, clickstream | no transform | **Pub/Sub → BigQuery subscription** (zero code) |
| same | transform | Pub/Sub → Dataflow streaming → BigQuery |
| Cloud Logging | any | **Log router sink → BigQuery** / Log Analytics |

## SaaS and APIs

| Source | Pattern |
|---|---|
| Google Ads, GA4, YouTube, CM360, Merchant Center | **BigQuery DTS** (no transfer charge); GA4 native export |
| Salesforce | **BigQuery DTS Salesforce connector**; Data Fusion or Integration Connectors for event-driven flows |
| Other SaaS (ServiceNow, Workday …) | Low-code/heavy → Data Fusion; otherwise **Integration Connectors / Application Integration**; check for a DTS third-party connector first |
| Custom REST / GraphQL | **Cloud Run job + Cloud Scheduler** → Storage Write API; webhooks → Cloud Run → Pub/Sub → BigQuery subscription |

## Platform components (decided across all sources)

| Component | Rule |
|---|---|
| Transformation | Always **Dataform** (SQL ELT inside BigQuery) |
| Orchestration | Auto: ≥ 3 externally scheduled pipelines or ≥ 2 heavy ones → **Cloud Composer**; 1-2 → **Workflows + Scheduler**; none (all CDC/streaming/DTS/Data Fusion) → no orchestrator |
| Connectivity | Any private-network source → **HA VPN**; ≥ 1 TB/day from private networks → **Cloud Interconnect** |
| Data Fusion edition | Basic; Enterprise when SAP is in scope or environment is Production (HA) |

## Agentic data cloud layer

| Capability | Services shown and costed |
|---|---|
| BI & semantic layer | Looker (quote input), Looker Studio Pro (per user), Looker Studio |
| Data agents | Agent Platform (ADK, Agent Engine runtime), Gemini model tokens, BigQuery queries from agents, Conversational Analytics |
| Workforce AI | Gemini Enterprise (Business / Standard / Plus per user) |
| Model serving | Vertex AI online endpoints on L4, A100, H100 or CPU |
| Governance | Knowledge Catalog (Dataplex): profiling, quality scans, lineage, metadata |
| Security | Sensitive Data Protection discovery, Cloud KMS CMEK, VPC Service Controls, policy tags & masking, Security Command Center |

Change the rules in `app/recommender.py` (and mirror them in `demo/engine.js`; the parity test will tell you if they diverge).
