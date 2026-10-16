"""Bill of materials: every priced product with quantity, unit price, cost and why it is needed."""
from __future__ import annotations

WHY = [
    # (prefix, explanation) - first match wins
    ("Datastream (CDC)", "Serverless change data capture: streams inserts, updates and deletes from operational databases into BigQuery within minutes, without load on the source."),
    ("Dataflow (batch)", "Runs scheduled batch pipelines (Google templates or Apache Beam) that extract and transform data before it lands in BigQuery."),
    ("Dataflow (streaming)", "Always-on streaming pipelines for parsing, enrichment, windowing and exactly-once writes into BigQuery."),
    ("Pub/Sub", "Event ingestion buffer that decouples producers; BigQuery subscriptions write messages into tables without pipeline code."),
    ("MQTT broker", "Self-managed MQTT broker (e.g. EMQX, HiveMQ) as an HA pair that bridges device traffic into Pub/Sub."),
    ("Data Fusion pipelines", "Ephemeral Dataproc clusters that execute the low-code Data Fusion pipelines."),
    ("Data Fusion instance", "One shared managed Data Fusion instance: visual pipeline designer with 150+ connectors."),
    ("Dataproc Serverless", "Serverless Spark for existing Spark / Hadoop jobs and heavy transformations, billed per DCU-hour."),
    ("Storage Transfer Service", "Agent-based, resumable transfer of on-premises or mainframe files into Cloud Storage."),
    ("Compute Engine (migration agent)", "VM hosting the BigQuery Migration Service extraction agent for the warehouse migration."),
    ("Integration Connectors", "Managed connectors for SaaS and enterprise applications that have no native BigQuery transfer."),
    ("Cloud Run jobs", "Containerised extractors on a schedule that pull from REST APIs and write through the Storage Write API."),
    ("One-time initial load", "Historical backfill moved once at go-live (initial snapshot / migration)."),
    ("Cross-region data transfer", "Network charge for moving data between the processing region and the BigQuery region."),
    ("BigQuery storage", "Bronze, silver and gold tables of the lakehouse, active and long-term storage."),
    ("BigQuery ingestion", "BigQuery Storage Write API and streaming inserts used by CDC, SAP and streaming loads."),
    ("BigQuery compute", "Query and ELT processing for dashboards, ad-hoc analysis, Dataform transformations and AI functions."),
    ("Cloud Storage (raw zone)", "Raw zone: immutable copies of source extracts and files for replay, audit and reprocessing before the bronze layer."),
    ("Cloud Storage (landing zone)", "Short-lived landing bucket for file loads before they are loaded into BigQuery."),
    ("Cloud Storage", "Unstructured data (documents, images, logs) queried from BigQuery through object tables."),
    ("Composer (Airflow)", "Managed Apache Airflow orchestrating pipelines with dependencies, retries, SLAs and alerting."),
    ("Workflows + Scheduler", "Lightweight serverless orchestration that triggers scheduled loads and Dataform runs."),
    ("Network (HA VPN)", "Encrypted, highly available private connectivity from on-premises or other clouds (shared by all environments)."),
    ("Network (Interconnect)", "Dedicated private link for high daily volumes from the data centre (shared by all environments)."),
    ("Looker licence", "Governed semantic layer and enterprise BI platform (customer's licence quote)."),
    ("Looker Studio Pro", "Self-service dashboards with team workspaces, organisational asset ownership and support."),
    ("Gemini Enterprise", "Employee-facing agentic assistant: business users ask questions, run Deep Research and use data agents."),
    ("Agent Engine runtime", "Managed runtime that hosts the data agents (sessions, memory, scaling)."),
    ("BigQuery queries from agents", "BigQuery queries issued by the agents' tools (on-demand pricing)."),
    ("BigQuery queries from Gemini Enterprise", "BigQuery queries run when employees ask data questions in Gemini Enterprise (on-demand pricing)."),
    ("Vertex AI endpoint", "GPU-backed online prediction endpoint serving custom, fine-tuned or open models."),
    ("Apigee (environment)", "Apigee runtime environment: managed API gateway with security, quotas and analytics."),
    ("Apigee (API calls)", "Per-call charge for API proxy traffic (plus API Analytics when enabled)."),
    ("Apigee (Advanced API Security)", "Abuse detection and security scoring for the exposed APIs."),
    ("AlloyDB", "PostgreSQL-compatible operational database for low-latency applications and vector search, federated to BigQuery."),
    ("Cloud SQL", "Managed MySQL / PostgreSQL / SQL Server for application back ends."),
    ("Spanner", "Globally consistent, horizontally scalable operational database."),
    ("Bigtable", "Wide-column store for high-throughput time-series, IoT and feature serving."),
    ("Firestore", "Serverless document database for web and mobile applications."),
    ("Memorystore", "Managed in-memory cache for low-latency serving."),
    ("Sensitive Data Protection", "Discovers and classifies personal and sensitive data across BigQuery to drive policy tags and masking."),
    ("Cloud KMS", "Customer-managed encryption keys (CMEK) for BigQuery, Cloud Storage and pipelines."),
    ("Knowledge Catalog", "Data quality scans, profiling and lineage so every consumer can trust the data products."),
    ("Cloud Storage (data lake)", "Cloud Storage data lake for sources targeted at the lake: open formats (Parquet, Avro, Iceberg) queryable from BigQuery through BigLake."),
    ("Database Migration Service", "Continuous replication into the operational database: schema conversion and change data capture for heterogeneous sources (Oracle / SQL Server to PostgreSQL)."),
    ("Contingency & operations", "Monitoring, logging, support tooling, egress and unknowns."),
    ("Negotiated discount", "Customer-specific discount negotiated with Google Cloud, applied to all consumption above."),
    ("Google Cloud Customer Care", "Google Cloud Customer Care plan: a tiered percentage of monthly list-price spend with a monthly minimum."),
]

GE_GROUNDING = {
    "bigquery": "grounded on BigQuery through a federated data store",
    "looker": "grounded on the Looker semantic layer (governed metrics)",
    "both": "grounded on BigQuery data stores and the Looker semantic layer",
    "agents": "used through registered data agents only",
}
APIGEE_ROLE = {
    "integration": "used as the integration layer between applications, SaaS and the data platform",
    "agents": "used as the AI gateway and tool registry for agents",
    "both": "used as the integration layer and as the AI gateway for agents",
}


def why_for(service, ctx):
    base = next((w for p, w in WHY if service.startswith(p)), "")
    if service.endswith("tokens (agents)"):
        base = "Gemini model tokens consumed by the data agents as they reason over BigQuery data."
    comps = ctx.get("components") or []
    if service == "BigQuery compute":
        base += (" Billed per TiB scanned (on-demand)." if ctx["bq_model"] == "ondemand"
                 else f" BigQuery {ctx['edition'].replace('_', ' ').title()} edition: {ctx['baseline']:,.0f} baseline slots"
                      f" (commitment-eligible) plus autoscaling up to {ctx['max']:,.0f} slots, billed per slot-hour.")
    elif service == "Gemini Enterprise":
        ge = next((c for c in comps if c["type"] == "gemini_enterprise"), None)
        if ge:
            base += f" {int(float(ge['settings'].get('users') or 0))} users, {GE_GROUNDING.get(ge['settings'].get('grounding'), '')}."
    elif service.startswith("Apigee"):
        ap = next((c for c in comps if c["type"] == "apigee"), None)
        if ap:
            base += f" Apigee is {APIGEE_ROLE.get(ap['settings'].get('role'), 'used for API management')}."
    elif service == "Cloud Storage (raw zone)":
        lk = ctx["lakehouse"]
        base += f" {lk['raw_storage_class'].title()} class, {lk['raw_retention_months']} months retention, {'all sources' if lk['raw_scope'] == 'all' else 'batch and file sources'}."
    elif service == "Contingency & operations":
        base = f"{ctx['contingency_pct']:g}% allowance for " + base[0].lower() + base[1:]
    return base


def build_bom(bom, units, envs, drivers, group_fn, group_order, ctx):
    """Collapse the monthly ledger into one row per (environment, service)."""
    r2 = lambda x: round(x + 1e-12, 2)  # noqa: E731
    acc = {}
    for (m, svc, env_id), vals in bom.items():
        usd, qty = vals[0], vals[1]
        c1, c3 = (vals[2], vals[3]) if len(vals) > 3 else (usd, usd)
        a = acc.setdefault((env_id, svc), {"m12": 0.0, "q12": 0.0, "y1": 0.0, "qy1": 0.0, "y3": 0.0, "qy3": 0.0,
                                           "c1": [0.0, 0.0, 0.0], "c3": [0.0, 0.0, 0.0]})
        for key, v in (("c1", c1), ("c3", c3)):
            a[key][2] += v
            if m <= 12:
                a[key][1] += v
            if m == 12:
                a[key][0] += v
        a["y3"] += usd
        a["qy3"] += qty
        if m <= 12:
            a["y1"] += usd
            a["qy1"] += qty
        if m == 12:
            a["m12"] += usd
            a["q12"] += qty
    env_order = {e["id"]: i for i, e in enumerate(envs)}
    env_name = {e["id"]: e["name"] for e in envs}
    rows = []
    for (env_id, svc), a in acc.items():
        if abs(a["y3"]) < 0.005:
            continue
        unit = units.get(svc)
        group = group_fn(svc)
        drv = sorted(drivers.get(svc, ()))
        why = why_for(svc, ctx)
        if drv:
            why += " Driven by: " + ", ".join(drv[:6]) + (f" and {len(drv) - 6} more" if len(drv) > 6 else "") + "."
        rows.append({
            "environment": env_id, "environment_name": env_name.get(env_id, env_id),
            "service": svc, "group": group, "unit": unit,
            "region": (ctx.get("region_of") or {}).get(svc), "edited": (svc, env_id) in (ctx.get("edited") or set()),
            "qty_month12": round(a["q12"], 2) if unit else None,
            "qty_year1": round(a["qy1"], 2) if unit else None,
            "unit_price": round(a["y1"] / a["qy1"], 6) if unit and a["qy1"] else None,
            "qty_three_year": round(a["qy3"], 2) if unit else None,
            "unit_price_three_year": round(a["y3"] / a["qy3"], 6) if unit and a["qy3"] else None,
            "month12": r2(a["m12"]), "year1": r2(a["y1"]), "three_year": r2(a["y3"]),
            "cud1": {"month12": r2(a["c1"][0]), "year1": r2(a["c1"][1]), "three_year": r2(a["c1"][2])},
            "cud3": {"month12": r2(a["c3"][0]), "year1": r2(a["c3"][1]), "three_year": r2(a["c3"][2])},
            "why": why,
        })
    rows.sort(key=lambda r: (env_order.get(r["environment"], 99),
                             group_order.index(r["group"]) if r["group"] in group_order else 99, -r["three_year"]))
    return rows


def product_months(bom, units, envs, group_fn, group_order):
    """Monthly cost (PAYG, 1-yr and 3-yr commitment pricing) and quantity per product and environment."""
    acc = {}
    for (m, svc, env_id), (usd, qty, c1, c3) in bom.items():
        a = acc.setdefault((env_id, svc), {"payg": [0.0] * 36, "cud1": [0.0] * 36, "cud3": [0.0] * 36, "qty": [0.0] * 36})
        a["payg"][m - 1] += usd
        a["cud1"][m - 1] += c1
        a["cud3"][m - 1] += c3
        a["qty"][m - 1] += qty
    env_order = {e["id"]: i for i, e in enumerate(envs)}
    env_name = {e["id"]: e["name"] for e in envs}
    rows = []
    for (env_id, svc), a in acc.items():
        if abs(sum(a["payg"])) < 0.005 and abs(sum(a["cud3"])) < 0.005:
            continue
        group = group_fn(svc)
        rows.append({
            "environment": env_id, "environment_name": env_name.get(env_id, env_id), "service": svc, "group": group,
            "unit": units.get(svc),
            "commit_eligible": any(c3 < p - 1e-9 for p, c3 in zip(a["payg"], a["cud3"])),
            "payg": [round(v + 1e-12, 2) for v in a["payg"]], "cud1": [round(v + 1e-12, 2) for v in a["cud1"]],
            "cud3": [round(v + 1e-12, 2) for v in a["cud3"]], "qty": [round(v + 1e-12, 3) for v in a["qty"]],
        })
    rows.sort(key=lambda r: (env_order.get(r["environment"], 99), group_order.index(r["group"]) if r["group"] in group_order else 99, -abs(sum(r["payg"]))))
    return rows


def apply_overrides(overrides, bom, views, region_of, default_region, months_ref=12):
    """Apply the architect's edits to the bill of materials (in place) and return what was applied.

    overrides: [{"service", "environment" ("*" = every environment), "qty" (per month at month 12),
                 "unit_price" (list / PAYG price per unit), "monthly" (month-12 cost, for lines without a unit)}]
    bom:   (m, service, env_id) -> [usd, qty, cud1, cud3]
    views: [payg, cud1, cud3] ledgers keyed (m, service, item, region) - deltas are booked under item "_edit"
    Costs scale with quantity x price; commitment discounts keep their ratio to the PAYG cost.
    """
    applied = []
    for o in overrides or []:
        svc, env = o.get("service"), o.get("environment") or "*"
        keys = [k for k in bom if k[1] == svc and (env == "*" or k[2] == env)]
        if not keys:
            continue
        envs = sorted({k[2] for k in keys})
        for env_id in envs:
            rows = {k[0]: bom[k] for k in keys if k[2] == env_id}
            y1 = sum(v[0] for m, v in rows.items() if m <= 12)
            qy1 = sum(v[1] for m, v in rows.items() if m <= 12)
            q12 = rows.get(months_ref, [0.0, 0.0])[1]
            u12 = rows.get(months_ref, [0.0])[0]
            qf = pf = 1.0
            if o.get("qty") not in (None, "") and q12 > 0:
                qf = max(0.0, float(o["qty"])) / q12
            if o.get("unit_price") not in (None, "") and qy1 > 0 and y1 > 0:
                pf = max(0.0, float(o["unit_price"])) / (y1 / qy1)
            if o.get("monthly") not in (None, "") and u12 > 0 and not (qy1 > 0):
                pf = max(0.0, float(o["monthly"])) / u12
            f = qf * pf
            if abs(f - 1) < 1e-12:
                continue
            rid = region_of.get(svc, default_region)
            for m, v in rows.items():
                deltas = (v[0] * (f - 1), v[2] * (f - 1), v[3] * (f - 1))
                v[0] += deltas[0]
                v[1] *= qf
                v[2] += deltas[1]
                v[3] += deltas[2]
                for view, d in zip(views, deltas):
                    view[(m, svc, "_edit", rid)] += d
            applied.append({"service": svc, "environment": env_id, "qty_factor": round(qf, 6), "price_factor": round(pf, 6)})
    return applied
