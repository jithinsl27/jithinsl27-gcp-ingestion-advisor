"""Implementation readiness: pre-kickoff checklist, milestones and team for the finalised architecture.

Everything is derived from the scenario (sources, targets, components, environments, region)
and the ramp-up plan (squads, go-live months), so the checklist only asks for what this
architecture actually needs. Owners: Customer, Partner, Joint (both) or Google.
"""
from __future__ import annotations

import math

from .catalog import SOURCE_BY_ID
from .components import COMPONENT_BY_ID

# Per source category: (what must be ready, why). Customer-owned unless stated.
SOURCE_PREREQS = {
    "rdbms": [
        ("Enable change data capture on {name} (Oracle: ARCHIVELOG + supplemental logging; MySQL: binlog ROW format; "
         "PostgreSQL: logical replication slot / pgoutput; SQL Server: CDC on tables)", "Datastream / DMS read changes from the database logs"),
        ("Create a read-only replication user for {name} and keep transaction logs for at least 7 days", "Least-privilege access and safe recovery if replication pauses"),
        ("Table inventory for {name}: tables in scope, primary keys, LOB columns, expected daily change", "Sizing, backfill plan and tables without keys need a merge strategy"),
    ],
    "sap": [
        ("SAP LT Replication Server (SLT) available for {name}, with the BigQuery Connector for SAP installable on it", "The connector runs inside SLT"),
        ("Confirm SAP licensing allows replication of {name} data to an external platform; RFC user created", "SAP runtime licences can restrict extraction"),
    ],
    "dwh": [
        ("Run the BigQuery Migration assessment on {name} (query logs and metadata export)", "Sizes the migration and SQL translation effort before planning waves"),
        ("Extraction host / migration agent for {name} with network access and credentials; agreed freeze and cut-over windows", "Historical extraction and parallel run need a stable window"),
    ],
    "hadoop": [
        ("Host for Storage Transfer agents (Docker) with read access to HDFS / NFS for {name}", "Agents copy files privately over the link"),
        ("Hive / Spark job inventory and table formats for {name}", "Decides which jobs move to Dataproc Serverless vs BigQuery SQL"),
    ],
    "files_onprem": [
        ("Host for Storage Transfer agents with access to the file shares / SFTP for {name}; file formats and schemas documented", "Agents run next to the files; schemas drive the load jobs"),
    ],
    "kafka": [
        ("Kafka endpoints, authentication (SASL / mTLS), topic list and Schema Registry access for {name}", "Dataflow consumes topics directly"),
    ],
    "saas_salesforce": [
        ("Integration user and connected app for {name} with read access to objects in scope; API limits checked", "Managed connectors call the SaaS API"),
    ],
    "saas_other": [
        ("API credentials, rate limits and object list for {name}", "Managed connectors / Application Integration call the API"),
    ],
    "api": [
        ("API documentation, credentials, rate limits and sample payloads for {name}", "Needed to build and test extraction jobs"),
    ],
    "object_aws": [
        ("Cross-cloud access for {name}: AWS IAM role / access key for BigQuery Data Transfer; egress budget approved with AWS", "Transfers read directly from S3; egress is billed by AWS"),
    ],
    "object_azure": [
        ("SAS token or service principal for {name}; Azure egress budget approved", "Transfers read directly from Blob Storage"),
    ],
    "mainframe": [
        ("JCL access, COBOL copybooks and dataset list for {name}; Mainframe Connector installable on z/OS", "The connector runs as a JCL step and needs copybooks to transcode"),
    ],
    "nosql": [
        ("Change streams enabled and a read user for {name}", "Dataflow templates read change streams"),
    ],
    "rdbms_nocdc": [
        ("Read-only user, extraction windows and incremental keys (updated-at columns) for {name}", "Without log-based CDC, changes are pulled on a schedule"),
    ],
    "rdbms_gcp": [
        ("Enable logical replication / binlog on {name} and grant a replication user", "Datastream reads changes from the managed database"),
    ],
    "events": [
        ("Event producers, topics / payload schemas and expected peak events per second for {name}; device or ISV licences if an IoT option is used", "Sizes Pub/Sub and streaming pipelines"),
    ],
    "stream_aws": [
        ("Cross-cloud access to the Kinesis stream for {name} and an egress budget", "The pipeline reads the stream from Google Cloud"),
    ],
    "stream_azure": [
        ("Event Hubs connection string / Kafka endpoint for {name} and an egress budget", "The pipeline reads the stream from Google Cloud"),
    ],
    "logs": [
        ("Log sources, sinks and retention for {name}", "Cloud Logging sinks route logs to BigQuery"),
    ],
    "unstructured": [
        ("Document repositories, formats and access for {name}; which documents may be used by AI", "Object tables and Gemini enrichment need governed access"),
    ],
    "nosql_gcp": [
        ("Change streams enabled on {name}", "Dataflow templates read change streams"),
    ],
    "object_gcp": [
        ("Bucket access and file conventions for {name}", "Loads and BigLake tables read the bucket directly"),
    ],
    "saas_google": [
        ("Admin access to link {name} (GA4 / Ads / Marketing Platform) to BigQuery", "Exports and transfers are enabled from the product consoles"),
    ],
}
GENERIC_SOURCE = [("Owner, access path, data formats and sample data for {name}", "Needed to build and test the pipeline")]

# Skills per ingestion / processing engine
ENGINE_SKILLS = {
    "datastream": "Datastream CDC", "dataflow_stream": "Dataflow / Apache Beam streaming", "dataflow_batch": "Dataflow / Apache Beam",
    "pubsub": "Pub/Sub", "pubsub_bqsub": "Pub/Sub BigQuery subscriptions", "dataproc": "Spark on Dataproc Serverless",
    "datafusion": "Cloud Data Fusion", "sap_connector": "SAP SLT + BigQuery Connector for SAP", "dts_migration": "BigQuery Migration Service & SQL translation",
    "dts_free": "BigQuery Data Transfer Service", "files_transfer": "Storage Transfer Service", "app_integration": "Application Integration",
    "cloud_run": "Cloud Run jobs (Python)", "log_sink": "Cloud Logging sinks", "dms": "Database Migration Service",
}


def _item(area, owner, text, why, due="Before kickoff", critical=False):
    return {"area": area, "owner": owner, "item": text, "why": why, "due": due, "critical": critical}


def build_readiness(scenario: dict, sources: list, recs: list, comp_rows: list, waves: list, teams: int,
                    first_live: int, half_live: int, all_live: int, horizon: int, agents_month: int, connectivity: str = "") -> dict:
    region = scenario.get("region", "")
    envs = scenario.get("environments") or [{"name": "Production"}]
    env_names = ", ".join(e.get("name", "") for e in envs)
    types = {c["type"] for c in comp_rows}
    cats = {c["category"] for c in comp_rows}
    needs_link = any(r.needs_connectivity for r in recs)
    conn = connectivity or ""
    targets = {getattr(r, "target", "data_platform") for r in recs}
    bq_mode = (scenario.get("bq") or {}).get("mode", "ondemand")

    ck = []
    # ---------------- governance & commercial
    ck += [
        _item("Programme & commercial", "Joint", "Executive sponsor, product owner and steering committee cadence agreed", "Decisions and escalations need named owners", critical=True),
        _item("Programme & commercial", "Joint", "Business outcomes and success criteria (KPIs, first use cases, acceptance criteria) signed off", "Defines what 'done' means for each milestone", critical=True),
        _item("Programme & commercial", "Joint", "Statement of work, RACI and change-control process agreed", "Clear scope boundaries between customer, partner and Google"),
        _item("Programme & commercial", "Customer", "Commercial model chosen from the pricing plans (pay-as-you-go, 1-year or 3-year commitment) and budget approved", "Commitments are best bought once usage stabilises after go-live"),
        _item("Programme & commercial", "Partner", "Delivery team staffed (see Team) and Google Cloud partner funding / incentives checked", "Avoids a slow start; funding can offset early costs"),
        _item("Programme & commercial", "Partner", "High-level and low-level design drafted from the finalised architecture (this diagram, patterns and sizing)", "The design is reviewed in week 1 instead of written in it", due="Week 1"),
        _item("Programme & commercial", "Partner", "Test strategy, cut-over approach and risk / dependency log drafted", "Agreed early so every go-live follows the same gates", due="Week 2"),
        _item("Programme & commercial", "Partner", "Landing-zone and pipeline Terraform modules / accelerators prepared", "Shortens month 1 to configuration, not development"),
        _item("Programme & commercial", "Customer", "Partner team onboarding: accounts, laptops / VDI, VPN and building access", "Delivery cannot start without access", critical=True),
    ]
    # ---------------- cloud foundation
    ck += [
        _item("Cloud foundation", "Customer", "Google Cloud organisation, Cloud Identity / IdP federation (SSO) and billing account in place", "Everything else is built on the organisation", critical=True),
        _item("Cloud foundation", "Joint", f"Folder and project structure agreed for each environment ({env_names})", "Isolation, IAM and cost tracking per environment"),
        _item("Cloud foundation", "Customer", f"Data residency confirmed and an org policy restricting resource locations to {region} (and approved regions)", "Keeps data in the agreed region", critical=True),
        _item("Cloud foundation", "Joint", "Access model: Google groups for platform admins, data engineers, analysts and consumers; break-glass account", "IAM is granted to groups, never to individuals"),
        _item("Cloud foundation", "Customer", "Source-control (GitHub / GitLab / Cloud Source) and CI/CD runner access for the partner team; Terraform state bucket", "Infrastructure and Dataform are deployed as code"),
        _item("Cloud foundation", "Partner", "Quota review and increase requests (BigQuery, Dataflow vCPUs, Datastream streams, Gemini tokens per minute)", "Quota approvals can take days", due="Week 1"),
    ]
    if bq_mode == "editions":
        ck.append(_item("Cloud foundation", "Customer", "BigQuery edition and slot reservation plan approved (baseline vs autoscale; commitment timing)", "Reservations are created per environment before workloads land", due="Week 1"))
    # ---------------- networking
    if needs_link:
        link = "Dedicated / Partner Interconnect" if "interconnect" in str(conn) else "HA VPN or Interconnect"
        ck += [
            _item("Network & connectivity", "Customer", f"{link} ordered and on-prem router / firewall team engaged (Interconnect lead time is often 4-8 weeks)", "Every on-prem source depends on private connectivity", critical=True),
            _item("Network & connectivity", "Joint", "Non-overlapping IP ranges, DNS resolution and firewall rules from Google Cloud to each source host / port", "Datastream, transfer agents and Dataflow reach sources privately"),
        ]
    ck.append(_item("Network & connectivity", "Joint", "Private Google Access / Private Service Connect design agreed; no public IPs on data services", "Enterprise baseline for data exfiltration risk"))
    # ---------------- per source
    seen = set()
    for s, r in zip(sources, recs):
        st = SOURCE_BY_ID.get(s.get("type"), {})
        cat = st.get("category", "")
        if s.get("type") == "custom":
            like = SOURCE_BY_ID.get(s.get("like_type"), {})
            cat = like.get("category", cat)
        name = s.get("custom_name") or s.get("name") or st.get("name", "source")
        for text, why in SOURCE_PREREQS.get(cat, GENERIC_SOURCE):
            key = (cat, text, name)
            if key in seen:
                continue
            seen.add(key)
            ck.append(_item("Source systems", "Customer", text.format(name=name), why, critical=cat in ("rdbms", "sap", "dwh") and "Enable" in text))
        ck.append(_item("Source systems", "Customer", f"Named data owner and system SME for {name} (about 10-20% of their time during its build)", "Answers mapping questions and signs off reconciliation"))
    if "data_lake" in targets:
        ck.append(_item("Source systems", "Joint", "Data lake conventions: bucket layout, open file formats (Parquet / Avro / Iceberg), retention and lifecycle rules", "Sources targeted at the lake land in Cloud Storage only"))
    if "data_mesh" in targets:
        doms = sorted({getattr(r, "domain", "") for r in recs if getattr(r, "target", "") == "data_mesh"} - {""})
        ck.append(_item("Programme & commercial", "Customer", f"Data mesh domain owners named for {', '.join(doms) or 'each domain'} - one accountable owner and team per domain",
                        "Each domain owns its BigQuery project and data products", critical=True))
        ck.append(_item("Data platform", "Joint", "Data product contracts per domain: schema, freshness and quality SLOs, access policy and who may subscribe (BigQuery sharing)",
                        "Consumers rely on the contract, not on the source system"))
        ck.append(_item("Security & governance", "Joint", "Federated governance: global policies (tags, masking, retention) set centrally in Dataplex, applied by every domain",
                        "Keeps domains autonomous but consistent"))
    if "operational_db" in targets:
        ck.append(_item("Source systems", "Joint", "Operational database migration: target AlloyDB / Cloud SQL sizing, downtime window and application cut-over plan", "Database Migration Service keeps the target in sync until cut-over", critical=True))
    # ---------------- data platform
    ck += [
        _item("Data platform", "Joint", "Medallion conventions agreed: dataset naming per layer (raw / bronze / silver / gold), partitioning and clustering standards", "Consistent layout makes governance and cost control automatic"),
        _item("Data platform", "Customer", "Freshness SLA, history window and retention per source confirmed", "Drives the pattern (CDC vs batch) and storage cost"),
        _item("Data platform", "Joint", "Data quality rules and reconciliation approach (row counts, sums, key checks) for each source", "Exit criterion for every source going live"),
    ]
    # ---------------- security & governance (driven by selected controls)
    ck.append(_item("Security & governance", "Customer", "Data classification and PII inventory for the sources in scope", "Determines masking, policy tags and DLP scope", critical=True))
    if "cmek" in types:
        ck.append(_item("Security & governance", "Customer", "Cloud KMS key ring and key owners for CMEK; key rotation policy", "Keys must exist before datasets and buckets are created"))
    if "vpc_sc" in types:
        ck.append(_item("Security & governance", "Joint", "VPC Service Controls perimeter design: projects inside, ingress / egress rules for BI, partners and CI/CD", "A wrong perimeter blocks pipelines on day one"))
    if "policy_tags" in types:
        ck.append(_item("Security & governance", "Customer", "Policy-tag taxonomy and row-access rules (who may see which columns and rows)", "Implemented in BigQuery once data lands"))
    if "knowledge_catalog" in types:
        ck.append(_item("Security & governance", "Customer", "Data stewards and business glossary owners for Knowledge Catalog", "Lineage and quality scans need owners to act on them"))
    if "sdp" in types:
        ck.append(_item("Security & governance", "Customer", "Sensitive Data Protection inspection scope and de-identification rules", "Profiles and masks sensitive data as it lands"))
    if "assured_workloads" in types:
        ck.append(_item("Security & governance", "Customer", "Assured Workloads / sovereign control package selected for the regulated folder", "Must be created before projects are placed in it", critical=True))
    # ---------------- consumption
    if "looker" in types:
        ck.append(_item("Analytics & AI", "Customer", "Looker licence and instance edition ordered; LookML model owners named", "Instance provisioning precedes dashboard build"))
    if cats & {"bi"} and any(COMPONENT_BY_ID[t]["vendor"] == "partner" for t in types if COMPONENT_BY_ID[t]["category"] == "bi"):
        ck.append(_item("Analytics & AI", "Customer", "Partner BI tools: connector / gateway hosts, service accounts and licences (not in the Google estimate)", "Partner BI connects to BigQuery with its own runtime"))
    if types & {"agent_platform", "gemini_enterprise", "bqml", "vertex_gpu"}:
        ck += [
            _item("Analytics & AI", "Joint", "Priority AI use cases with an evaluation set (questions + expected answers) and owners", "Agents are accepted against measured quality, not demos", critical=True),
            _item("Analytics & AI", "Customer", "Responsible-AI and data-access review; Gemini 3.8 Flash enabled in the project with quota for the expected tokens per minute", "Model access and quota are prerequisites for agent build"),
        ]
    if "gemini_enterprise" in types:
        ck.append(_item("Analytics & AI", "Customer", "Gemini Enterprise edition and licences; IdP groups for pilot users", "Licences are assigned per user"))
    if "apigee" in types:
        ck.append(_item("Analytics & AI", "Customer", "Apigee organisation provisioned (network peering / PSC) and API product owners named", "Apigee provisioning takes time and needs network ranges"))
    if "database" in cats:
        ck.append(_item("Analytics & AI", "Joint", "Operational database requirements: availability, read replicas, application connection model", "Sizes AlloyDB / Cloud SQL / Spanner correctly"))
    # ---------------- operations
    ck += [
        _item("Operations & support", "Customer", "Support model after go-live: run team, on-call, incident routing and the Google Cloud Customer Care plan", "Someone must own the platform after hypercare"),
        _item("Operations & support", "Joint", "Monitoring and alerting targets (pipeline lag, failed jobs, slot usage, budget alerts) and FinOps owner", "Keeps consumption inside the approved plan"),
        _item("Operations & support", "Customer", "UAT users and business sign-off owners per data domain", "Each milestone closes with business acceptance", due="Before first go-live"),
    ]

    # ---------------- milestones
    link_m = 1 if needs_link else None
    ms = [
        {"month": 0, "name": "Mobilise & kickoff", "exit": "Readiness checklist complete; team onboarded; access granted", "deliverables": ["Kickoff deck", "RACI and plan baseline", "Risk & dependency log"]},
        {"month": 1, "name": "Landing zone ready", "exit": f"Projects for {env_names}, IAM groups, org policies, network, security controls and CI/CD pipelines deployed by Terraform",
         "deliverables": ["Landing zone (Terraform)", "Security baseline", "Dataform repository & CI/CD"]},
    ]
    if link_m:
        ms.append({"month": link_m, "name": "Private connectivity live", "exit": "Sources reachable privately from Google Cloud; throughput tested", "deliverables": ["Connectivity test report"]})
    if waves:
        first = [w["name"] for w in waves if w["go_live_month"] == first_live]
        ms.append({"month": first_live, "name": "First data live in BigQuery", "exit": f"{', '.join(first[:3])} in bronze and silver with reconciliation passed",
                   "deliverables": ["Pipelines in production", "Data quality checks", "Runbook"]})
        if half_live != first_live and half_live != all_live:
            ms.append({"month": half_live, "name": "Half of sources live", "exit": "Gold marts for the first use cases; performance baseline", "deliverables": ["Curated marts", "Cost & slot baseline"]})
        if cats & {"bi"}:
            ms.append({"month": first_live, "name": "First dashboards", "exit": "First business dashboards on gold data accepted by users", "deliverables": ["Semantic model", "Dashboards"]})
        if types & {"agent_platform", "gemini_enterprise"}:
            ms.append({"month": agents_month, "name": "First data agents", "exit": "Agents meet the agreed evaluation score on the evaluation set", "deliverables": ["Agents on Agent Engine", "Evaluation report"]})
        ms.append({"month": all_live, "name": "All sources live", "exit": "Every source in scope reconciled and signed off; parallel run complete where needed",
                   "deliverables": ["Reconciliation sign-off", "Decommissioning plan for legacy feeds"]})
        ms.append({"month": min(36, all_live + 1), "name": "Commitment decision", "exit": "Usage stable for a month: buy BigQuery / compute commitments sized from actuals", "deliverables": ["FinOps review", "Commitment recommendation"]})
    ms.append({"month": horizon, "name": "Hypercare complete & handover", "exit": "Run team operating the platform; open defects closed or accepted", "deliverables": ["Operations handover", "Knowledge transfer", "Closure report"]})
    ms.sort(key=lambda m: m["month"])

    # ---------------- team
    engines = set()
    for r in recs:
        engines.update(r.engine.split("+"))
    skills_de = sorted({ENGINE_SKILLS[e] for e in engines if e in ENGINE_SKILLS})
    n_src = len(sources)
    partner = [
        {"role": "Engagement / delivery manager", "count": 1 if n_src > 3 or teams > 1 else 0.5, "skills": ["Agile delivery", "Google Cloud programme governance", "RAID and change control"], "when": "Whole programme"},
        {"role": "Data & AI solution architect", "count": 1, "skills": ["BigQuery lakehouse design", "Ingestion patterns", "Security & governance", "FinOps"], "when": "Whole programme"},
        {"role": "Cloud platform engineer", "count": 2 if (needs_link and len(envs) > 2) or "vpc_sc" in types else 1,
         "skills": ["Terraform", "Landing zone / org policies", "Networking" + (" (Interconnect / HA VPN)" if needs_link else ""), "IAM", "CI/CD"], "when": "Heavy in month 1, then 50%"},
        {"role": "Data engineer", "count": max(2, 2 * teams), "skills": skills_de or ["BigQuery loading"], "when": f"{teams} squad(s) of 2, months 1-{all_live}"},
        {"role": "Analytics engineer", "count": max(1, math.ceil(teams / 2)), "skills": ["BigQuery SQL", "Dataform", "Dimensional modelling", "Data quality assertions"], "when": f"From month {first_live}"},
    ]
    if cats & {"bi"}:
        bi = [COMPONENT_BY_ID[t]["name"] for t in types if COMPONENT_BY_ID[t]["category"] == "bi"]
        partner.append({"role": "BI developer", "count": 1, "skills": bi + (["LookML"] if "looker" in types else []), "when": f"From month {first_live}"})
    ai_types = types & {"agent_platform", "gemini_enterprise", "bqml", "vertex_gpu"}
    if ai_types:
        partner.append({"role": "AI / ML engineer", "count": 2 if len(ai_types) > 1 else 1,
                        "skills": ["Gemini 3.8 Flash on Vertex AI", "Agent Development Kit (ADK)", "Agent Engine", "Evaluation & guardrails", "BigQuery ML"], "when": f"From month {max(1, agents_month - 1)}"})
    if "apigee" in types:
        partner.append({"role": "API engineer", "count": 1, "skills": ["Apigee proxies & products", "OAuth / API security", "AI gateway policies"], "when": f"From month {agents_month}"})
    if cats & {"governance", "security"}:
        sec = [COMPONENT_BY_ID[t]["name"] for t in types if COMPONENT_BY_ID[t]["category"] in ("governance", "security")]
        partner.append({"role": "Security & governance specialist", "count": 0.5, "skills": sec[:5], "when": "Months 1-2, then on demand"})
    if "operational_db" in targets or "database" in cats:
        partner.append({"role": "Database engineer", "count": 0.5, "skills": ["AlloyDB / Cloud SQL", "Database Migration Service", "Performance tuning"], "when": "As databases are introduced"})
    partner.append({"role": "QA / data test engineer", "count": 1 if n_src > 4 else 0.5, "skills": ["Reconciliation testing", "Test automation", "UAT coordination"], "when": f"From month {first_live}"})

    customer = [
        {"role": "Executive sponsor", "count": 1, "skills": ["Decisions, funding, escalation"], "when": "Steering committee"},
        {"role": "Product owner", "count": 1, "skills": ["Backlog and priorities", "Acceptance"], "when": "Whole programme"},
        {"role": "Cloud platform / CoE owner", "count": 1, "skills": ["Organisation, IAM and network approvals"], "when": "Heavy in month 1"},
        {"role": "Source system SMEs / DBAs", "count": n_src, "skills": ["One per source, 10-20% during its build"], "when": "Per wave"},
        {"role": "Network & security team", "count": 1, "skills": ["Firewall, DNS, connectivity, security reviews"], "when": "Months 0-2"},
        {"role": "Data owners & stewards", "count": max(1, math.ceil(n_src / 3)), "skills": ["Definitions, quality rules, access approvals"], "when": "Whole programme"},
        {"role": "Business users (UAT)", "count": max(2, math.ceil(n_src / 2)), "skills": ["Acceptance testing"], "when": "Before each go-live"},
    ]
    fte = round(sum(r["count"] for r in partner), 1)
    fte = int(fte) if fte == int(fte) else fte
    return {
        "checklist": ck,
        "milestones": ms,
        "team": {"partner": partner, "customer": customer, "partner_fte": fte, "squads": teams,
                 "note": f"{fte} partner FTE at peak for {teams} delivery squad(s) over {horizon} months; change squads on the Roadmap to trade speed for team size."},
        "summary": {"items": len(ck), "critical": sum(1 for c in ck if c["critical"]),
                    "by_owner": {o: sum(1 for c in ck if c["owner"] == o) for o in ("Customer", "Partner", "Joint")}},
    }
