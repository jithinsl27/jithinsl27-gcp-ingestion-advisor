"""Ballpark consumption estimator (1-year and 3-year).

Approach
--------
* Simulate 36 months. Each source's change volume grows by the scenario's
  annual growth rate (compounded monthly).
* Each recommended pattern (`engine`) has a sizing model that converts
  GB/month into service units (vCPU-hours, GiB processed, DCU-hours ...).
* Shared platform pieces (BigQuery, orchestration, Data Fusion instance,
  connectivity, landing bucket) are added once.
* List prices come from data/pricing.json; regionally-priced services are
  multiplied by the region uplift from data/regions.json.
* Two views per horizon: pay-as-you-go and with committed-use discounts
  (1-yr CUD for the 1-year view, 3-yr CUD for the 3-year view) applied to
  services that offer them (BigQuery editions, Dataflow streaming, Composer).

All sizing constants live in ASSUMPTIONS so they are visible in the UI and
easy to tune. This is a discovery-phase ballpark, not a quote.
"""
from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

from .catalog import FREQUENCIES, SOURCE_BY_ID, STREAMING_FREQS
from .recommender import recommend, platform_components
from .components import COMPONENT_BY_ID, cost_components, component_view, normalized, platform_story

DATA_DIR = Path(__file__).parent / "data"
GIB_PER_TIB = 1024
HOURS = 730

ASSUMPTIONS = {
    "batch_gb_per_vcpu_hr": {"none": 25.0, "light": 20.0, "heavy": 8.0},
    "batch_min_vcpu_hr_per_run": 1.0,          # 4 vCPU x 15 min startup/teardown floor
    "stream_gb_per_vcpu_day": {"none": 150.0, "light": 100.0, "heavy": 40.0},
    "stream_min_vcpu": 2,
    "memory_gib_per_vcpu": 3.75,
    "streaming_engine_cu_per_vcpu_hr": 0.5,
    "datafusion_gb_per_vcpu_hr": 15.0,
    "datafusion_min_vcpu_hr_per_run": 4.0,     # ephemeral Dataproc cluster spin-up
    "spark_gb_per_dcu_hr": {"none": 20.0, "light": 15.0, "heavy": 6.0},
    "spark_min_dcu_hr_per_run": 3.0,
    "landing_retention_days": 7,
    "net_new_ratio": {"cdc": 0.3, "append": 1.0},  # share of change volume that grows BigQuery storage
    "longterm_share_after_90d": 0.7,
    "curated_layers_overhead": 0.5,            # silver/gold tables created by ELT (+50 % storage)
    "elt_scan_multiplier": 3.0,                # ELT queries scan ~3x the data ingested each month
    "auto_analytics_scan_multiplier": 2.0,     # BI/analytics scan ~2x stored data per month (on-demand auto)
    "teradata_agent_gb_per_hr": 500.0,
    "cloud_run_minutes_per_run": 10,
    "contingency": 0.10,
}

CDC_CATEGORIES = {"rdbms", "rdbms_gcp", "rdbms_nocdc", "sap", "nosql", "nosql_gcp", "dwh"}
RUNS = {f["id"]: f["runs_per_month"] for f in FREQUENCIES}


def load_pricing():
    with open(DATA_DIR / "pricing.json") as f:
        return json.load(f)


def load_regions():
    with open(DATA_DIR / "regions.json") as f:
        return json.load(f)["regions"]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def tiered(gib, tiers):
    cost, prev = 0.0, 0.0
    for limit, price in tiers:
        top = gib if limit is None else min(gib, limit)
        if top > prev:
            cost += (top - prev) * price
            prev = top
        if limit is not None and gib <= limit:
            break
    return cost


def growth_factor(month, annual_growth):
    return (1 + annual_growth) ** ((month - 1) / 12)


def batch_vcpu_hours(gb, runs, transform):
    if runs <= 0:
        return 0.0
    per_run = gb / runs
    rate = ASSUMPTIONS["batch_gb_per_vcpu_hr"][transform]
    return runs * max(ASSUMPTIONS["batch_min_vcpu_hr_per_run"], per_run / rate)


def stream_vcpus(daily_gb, transform):
    cap = ASSUMPTIONS["stream_gb_per_vcpu_day"][transform]
    return max(ASSUMPTIONS["stream_min_vcpu"], math.ceil(daily_gb / cap))


# --------------------------------------------------------------------------- #
# Main entry point
# --------------------------------------------------------------------------- #
def estimate(scenario: dict, keep_items: bool = False) -> dict:
    pricing = load_pricing()
    regions = {r["id"]: r for r in load_regions()}
    region_id = scenario.get("region", "us-central1")
    region = regions.get(region_id, regions["us-central1"])
    uplift = region["uplift"]
    growth = float(scenario.get("annual_growth_pct", 20)) / 100.0
    prefs = {
        "skill": scenario.get("skill", "sql"),
        "orchestration": scenario.get("orchestration", "auto"),
        "environment": scenario.get("environment", "production"),
    }
    bq_model = scenario.get("bq_model", "ondemand")
    sources = [s for s in scenario.get("sources", []) if s.get("type") and s.get("included", True) is not False]

    processing_region = scenario.get("processing_region") or region_id
    if processing_region not in regions:
        processing_region = region_id
    ctx = {"rid": region_id}               # region the next line items are billed in

    def rid_of(r):
        return r if r in regions else region_id

    def up(service_key):
        return regions[ctx["rid"]]["uplift"] if pricing[service_key].get("regional") else 1.0

    recs = [recommend(s, prefs) for s in sources]
    platform = platform_components(sources, recs, prefs)

    # per-month line items for PAYG; CUD-eligible amounts tracked separately
    payg = defaultdict(float)          # (m, service, source, region) -> usd
    cud = {"cud1": defaultdict(float), "cud3": defaultdict(float)}  # same keys, under that CUD

    excluded = set(scenario.get("excluded_services") or [])

    def add(m, service, source, usd, cud1=None, cud3=None):
        if not usd or service in excluded:
            return
        k = (m, service, source, ctx["rid"])
        payg[k] += usd
        cud["cud1"][k] += usd if cud1 is None else cud1
        cud["cud3"][k] += usd if cud3 is None else cud3

    df = pricing["dataflow"]
    ds = pricing["datastream"]
    ps = pricing["pubsub"]
    bq = pricing["bigquery"]

    datastream_cdc_gib = defaultdict(float)   # month -> GiB, priced in aggregate (billing-account tiers)
    write_api_gib = defaultdict(float)
    streaming_insert_gib = defaultdict(float)
    ingested_net_gib = defaultdict(float)     # month -> GiB that grows BQ storage
    ingested_gib = defaultdict(float)
    initial_by_month = defaultdict(float)    # month -> GiB loaded once (historical data)
    backfill_by_month = defaultdict(float)   # month -> Datastream backfill GiB
    src_start = {}
    landing_gib = defaultdict(float)
    per_source_meta = []

    for src, rec in zip(sources, recs):
        sid = src.get("id") or src["type"]
        name = src.get("name") or SOURCE_BY_ID.get(src["type"], {}).get("name", src["type"])
        cat = SOURCE_BY_ID.get(src["type"], {}).get("category", "api")
        freq = src.get("frequency", "daily")
        transform = src.get("transform", "none")
        daily0 = float(src.get("daily_change_gb") or 0)
        initial = float(src.get("initial_volume_gb") or 0)
        one_time = freq == "one_time"
        runs = RUNS.get(freq) or 0
        net_ratio = ASSUMPTIONS["net_new_ratio"]["cdc" if cat in CDC_CATEGORIES else "append"]
        engines = rec.engine.split("+")
        on_prem = src.get("location", "on_prem") == "on_prem"
        start = max(1, min(36, int(src.get("start_month") or 1)))
        src_start[sid] = start
        initial_by_month[start] += initial
        src_rid = rid_of(src.get("region") or region_id)
        ctx["rid"] = src_rid
        per_source_meta.append({"id": sid, "name": name, "region": src_rid})
        xfer_rate = inter_region_rate(regions, src_rid, region_id, pricing)

        for m in range(1, 37):
            if m < start:
                continue
            g = growth_factor(m, growth)
            daily = 0.0 if one_time else daily0 * g
            monthly = daily * 30
            ingested_gib[m] += monthly
            ingested_net_gib[m] += monthly * net_ratio
            if xfer_rate:
                add(m, "Cross-region data transfer", sid, monthly * xfer_rate)
                if m == start and initial:
                    add(m, "Cross-region data transfer", sid, initial * xfer_rate)

            for eng in engines:
                if eng == "datastream":
                    datastream_cdc_gib[m] += monthly
                elif eng == "dataflow_batch":
                    vh = batch_vcpu_hours(monthly, runs, transform)
                    usd = (vh * df["batch_vcpu_hr"] + vh * ASSUMPTIONS["memory_gib_per_vcpu"] * df["memory_gib_hr"]) * up("dataflow")
                    if transform == "heavy":
                        usd += monthly * df["shuffle_gib"] * up("dataflow")
                    add(m, "Dataflow (batch)", sid, usd)
                elif eng == "dataflow_stream":
                    if one_time:
                        continue
                    v = stream_vcpus(daily, transform)
                    compute = (v * HOURS * df["streaming_vcpu_hr"]
                               + v * HOURS * ASSUMPTIONS["memory_gib_per_vcpu"] * df["memory_gib_hr"]
                               + v * HOURS * ASSUMPTIONS["streaming_engine_cu_per_vcpu_hr"] * df["streaming_engine_cu_hr"]) * up("dataflow")
                    add(m, "Dataflow (streaming)", sid, compute,
                        cud1=compute * (1 - df["cud1_discount"]), cud3=compute * (1 - df["cud3_discount"]))
                elif eng == "pubsub_bqsub":
                    tib = monthly / GIB_PER_TIB
                    add(m, "Pub/Sub", sid, tib * (ps["throughput_tib"] + ps["bq_subscription_tib"]))
                elif eng == "pubsub":
                    tib = monthly / GIB_PER_TIB
                    add(m, "Pub/Sub", sid, tib * ps["throughput_tib"] * 2)  # publish + subscribe
                elif eng == "datafusion":
                    vh = 0.0
                    if runs > 0 and monthly > 0:
                        vh = runs * max(ASSUMPTIONS["datafusion_min_vcpu_hr_per_run"],
                                        monthly / runs / ASSUMPTIONS["datafusion_gb_per_vcpu_hr"])
                    elif not one_time and monthly > 0:  # streaming pipeline on an always-on cluster
                        vh = HOURS * 4
                    add(m, "Data Fusion pipelines (Dataproc)", sid, vh * pricing["datafusion"]["pipeline_vcpu_hr_all_in"] * up("datafusion"))
                elif eng == "dataproc":
                    if runs > 0 and monthly > 0:
                        rate = ASSUMPTIONS["spark_gb_per_dcu_hr"][transform]
                        dcu = runs * max(ASSUMPTIONS["spark_min_dcu_hr_per_run"], monthly / runs / rate)
                        add(m, "Dataproc Serverless", sid, dcu * pricing["dataproc_serverless"]["dcu_hr"] * up("dataproc_serverless"))
                elif eng == "files_transfer":
                    if on_prem or cat == "mainframe":
                        add(m, "Storage Transfer Service", sid, monthly * pricing["storage_transfer"]["agent_gib"])
                    landing_gib[m] += daily * ASSUMPTIONS["landing_retention_days"]
                elif eng == "dts_free":
                    pass  # DTS connectors used here carry no transfer charge; BigQuery load is free
                elif eng == "dts_migration":
                    if src["type"] == "teradata" and not one_time:
                        add(m, "Compute Engine (migration agent)", sid, HOURS * pricing["compute_engine"]["vm_standard_4vcpu_hr"] * up("compute_engine"))
                elif eng == "sap_connector":
                    write_api_gib[m] += monthly
                elif eng == "log_sink":
                    streaming_insert_gib[m] += monthly
                elif eng == "app_integration":
                    ic = pricing["integration_connectors"]
                    add(m, "Integration Connectors", sid,
                        HOURS * ic["third_party_node_hr"] + max(0.0, monthly - ic["free_gib"]) * ic["data_processed_gib"])
                elif eng in ("cloud_run",):
                    cr = pricing["cloud_run"]
                    r = runs if runs else 30
                    secs = r * ASSUMPTIONS["cloud_run_minutes_per_run"] * 60
                    add(m, "Cloud Run jobs", sid, secs * (cr["vcpu_second"] + 2 * cr["gib_second"]) * up("cloud_run"))
                    write_api_gib[m] += monthly

            # ---------------- one-time initial load (go-live month)
            if m == start and initial > 0:
                primary_engine = engines[0]
                if primary_engine == "datastream":
                    backfill_by_month[m] += initial
                elif primary_engine in ("dataflow_batch", "dataflow_stream"):
                    vh = batch_vcpu_hours(initial, max(1, math.ceil(initial / 2000)), "light")
                    add(m, "One-time initial load", sid, (vh * df["batch_vcpu_hr"] + vh * ASSUMPTIONS["memory_gib_per_vcpu"] * df["memory_gib_hr"]) * up("dataflow"))
                elif primary_engine == "datafusion":
                    vh = max(ASSUMPTIONS["datafusion_min_vcpu_hr_per_run"], initial / ASSUMPTIONS["datafusion_gb_per_vcpu_hr"])
                    add(m, "One-time initial load", sid, vh * pricing["datafusion"]["pipeline_vcpu_hr_all_in"] * up("datafusion"))
                elif primary_engine == "dataproc":
                    dcu = max(ASSUMPTIONS["spark_min_dcu_hr_per_run"], initial / ASSUMPTIONS["spark_gb_per_dcu_hr"]["light"])
                    add(m, "One-time initial load", sid, dcu * pricing["dataproc_serverless"]["dcu_hr"] * up("dataproc_serverless"))
                elif primary_engine == "files_transfer":
                    if on_prem or cat == "mainframe":
                        add(m, "One-time initial load", sid, initial * pricing["storage_transfer"]["agent_gib"])
                    add(m, "One-time initial load", sid, initial * pricing["gcs"]["standard_gib_month"] * up("gcs"))
                elif primary_engine == "dts_migration" and src["type"] == "teradata":
                    hrs = initial / ASSUMPTIONS["teradata_agent_gb_per_hr"]
                    add(m, "One-time initial load", sid, hrs * pricing["compute_engine"]["vm_standard_4vcpu_hr"] * up("compute_engine"))
                elif primary_engine == "sap_connector":
                    write_api_gib[m] += initial

    # ------------------------------------------------------------ Datastream (aggregate tiers)
    src_region = {m_["id"]: m_["region"] for m_ in per_source_meta}
    for m in range(1, 37):
        gib = datastream_cdc_gib[m]
        if gib:
            total = tiered(gib, ds["cdc_tiers_gib"])
            # allocate to sources proportionally for the per-source view
            share_by_src = _datastream_shares(sources, recs, m, src_start)
            for sid, share in share_by_src.items():
                ctx["rid"] = src_region.get(sid, region_id)
                add(m, "Datastream (CDC)", sid, total * share)
    ctx["rid"] = region_id
    free_backfill = ds["backfill_free_gib"]
    for m in range(1, 37):
        if backfill_by_month[m]:
            billable = max(0.0, backfill_by_month[m] - free_backfill)
            free_backfill = max(0.0, free_backfill - backfill_by_month[m])
            add(m, "One-time initial load", "_datastream_backfill", billable * ds["backfill_gib"])

    # ------------------------------------------------------------ BigQuery (home region)
    plat_start = min(src_start.values()) if src_start else 1
    ctx["rid"] = region_id
    bq_up = up("bigquery")
    stored = 0.0
    history = []  # monthly new data (initial loads + net ingest) for active/long-term split
    new_by_month = defaultdict(float)
    analytics_tib_input = scenario.get("analytics_tib_month")
    edition_slots = float(scenario.get("bq_slots") or 100)
    for m in range(1, 37):
        new_by_month[m] = initial_by_month[m] + ingested_net_gib[m]
        history.append(new_by_month[m])
        stored += new_by_month[m]
        recent = sum(history[-3:])
        older = max(0.0, stored - recent)
        lt = older * ASSUMPTIONS["longterm_share_after_90d"]
        active = (stored - lt)
        mult = 1 + ASSUMPTIONS["curated_layers_overhead"]
        active_b = max(0.0, active * mult - bq["storage_free_gib"])
        st_cost = (active_b * bq["storage_active_gib_month"] + lt * mult * bq["storage_longterm_gib_month"]) * bq_up
        add(m, "BigQuery storage", "_platform", st_cost)

        # ingestion APIs
        wa = max(0.0, write_api_gib[m] - bq["storage_write_api_free_tib"] * GIB_PER_TIB)
        add(m, "BigQuery ingestion (Write API / streaming)", "_platform",
            (wa * bq["storage_write_api_gib"] + streaming_insert_gib[m] * bq["streaming_inserts_gib"]) * bq_up)

        # compute
        stored_tib = stored * mult / GIB_PER_TIB
        elt_tib = ingested_gib[m] * ASSUMPTIONS["elt_scan_multiplier"] / GIB_PER_TIB
        if analytics_tib_input not in (None, "", 0, "0"):
            analytics_tib = float(analytics_tib_input) * growth_factor(m, growth)
        else:
            analytics_tib = stored_tib * ASSUMPTIONS["auto_analytics_scan_multiplier"]
        scan_tib = elt_tib + analytics_tib
        if bq_model == "ondemand":
            add(m, "BigQuery compute", "_platform", max(0.0, scan_tib - bq["ondemand_free_tib"]) * bq["ondemand_tib"] * bq_up)
        elif m >= plat_start:
            ed = bq["editions"][bq_model]
            slot_hours = edition_slots * HOURS
            add(m, "BigQuery compute", "_platform", slot_hours * ed["payg"] * bq_up,
                cud1=slot_hours * ed["cud1"] * bq_up, cud3=slot_hours * ed["cud3"] * bq_up)

    # ------------------------------------------------------------ Shared platform components (processing region)
    ctx["rid"] = processing_region
    orch = platform["orchestration"]["tool"]
    if orch == "composer":
        cp = pricing["composer"]
        size = "small_env_avg_dcu" if len(sources) <= 10 else "medium_env_avg_dcu"
        dcu_h = cp[size] * HOURS
        for m in range(plat_start, 37):
            add(m, "Composer (Airflow)", "_platform", dcu_h * cp["dcu_hr"] * up("composer"),
                cud1=dcu_h * cp["cud1_dcu_hr"] * up("composer"), cud3=dcu_h * cp["cud3_dcu_hr"] * up("composer"))
    elif orch == "workflows":
        for m in range(plat_start, 37):
            add(m, "Workflows + Scheduler", "_platform", len(sources) * pricing["workflows"]["scheduler_job_month"])

    if platform["datafusion_edition"]:
        dfp = pricing["datafusion"]
        if platform["datafusion_edition"] == "enterprise":
            inst = HOURS * dfp["enterprise_hr"]
        else:
            inst = max(0, HOURS - dfp["basic_free_hours"]) * dfp["basic_hr"]
        for m in range(plat_start, 37):
            add(m, f"Data Fusion instance ({platform['datafusion_edition'].title()})", "_platform", inst * up("datafusion"))

    if platform["connectivity"] == "ha_vpn":
        n = pricing["network"]
        for m in range(plat_start, 37):
            add(m, "Network (HA VPN)", "_platform", n["ha_vpn_tunnel_hr"] * n["ha_vpn_tunnels"] * HOURS)
    elif platform["connectivity"] == "interconnect":
        ic = pricing["interconnect"]
        for m in range(plat_start, 37):
            add(m, "Network (Interconnect)", "_platform",
                ic["dedicated_10g_port_month"] + ic["vlan_attachment_hr"] * ic["vlan_attachments"] * HOURS)

    for m in range(1, 37):
        if landing_gib[m]:
            add(m, "Cloud Storage (landing zone)", "_platform", landing_gib[m] * pricing["gcs"]["standard_gib_month"] * up("gcs"))

    # ------------------------------------------------------------ Analytics, AI, governance, security
    comps, sec = normalized(scenario)

    def set_region(r):
        ctx["rid"] = rid_of(r or region_id)

    tables = cost_components(comps, sec, pricing, up, sources, new_by_month, bq_model, add,
                             ASSUMPTIONS["curated_layers_overhead"], set_region, region_id)
    ctx["rid"] = region_id
    platform["layer"] = {
        "components": [component_view(c) for c in comps],
        "security": sec,
        "tables_estimated": tables,
        "story": platform_story(comps, sec, sources),
    }
    platform["processing_region"] = processing_region

    # ------------------------------------------------------------ Contingency
    cont = float(scenario.get("contingency_pct", ASSUMPTIONS["contingency"] * 100)) / 100.0
    for view in (payg, cud["cud1"], cud["cud3"]):
        monthly_tot = defaultdict(float)
        for (m, svc, sid, rid), v in list(view.items()):
            monthly_tot[m] += v
        for m, v in monthly_tot.items():
            if "Contingency & operations" not in excluded:
                view[(m, "Contingency & operations", "_platform", region_id)] += v * cont

    out = _summarise(payg, cud, recs, platform, sources, per_source_meta, region, scenario, pricing)
    out["excluded_services"] = sorted(excluded)
    if keep_items:
        out["_items"] = payg
    return out


def inter_region_rate(regions, a, b, pricing):
    """Per-GiB price for moving data from region a to region b (0 when co-located)."""
    if a == b:
        return 0.0
    ra, rb = regions[a], regions[b]
    if ra.get("multi") or rb.get("multi"):
        if ra["geo"] == rb["geo"]:
            return 0.0  # multi-region contains its member regions for this estimate
    n = pricing["network"]
    return n["inter_region_same_geo_gib"] if ra["geo"] == rb["geo"] else n["inter_region_cross_geo_gib"]


GROUP_ORDER = ["Data ingestion & CDC", "BigQuery", "Analytics & AI", "APIs & databases", "Governance & security", "Platform & network", "Contingency"]


def service_group(name):
    n = name.lower()
    if n.startswith("bigquery") and "agents" not in n:
        return "BigQuery"
    if any(k in n for k in ("apigee", "alloydb", "cloud sql", "spanner", "bigtable", "firestore", "memorystore")):
        return "APIs & databases"
    if any(k in n for k in ("looker", "gemini", "agent", "vertex ai")):
        return "Analytics & AI"
    if any(k in n for k in ("knowledge catalog", "sensitive data", "kms")):
        return "Governance & security"
    if any(k in n for k in ("composer", "workflows", "network", "landing", "data fusion instance", "cross-region")):
        return "Platform & network"
    if "contingency" in n:
        return "Contingency"
    return "Data ingestion & CDC"


def _datastream_shares(sources, recs, m, src_start):
    vols = {}
    for s, r in zip(sources, recs):
        sid = s.get("id") or s["type"]
        if "datastream" in r.engine.split("+") and s.get("frequency") != "one_time" and src_start.get(sid, 1) <= m:
            vols[sid] = float(s.get("daily_change_gb") or 0)
    total = sum(vols.values()) or 1.0
    return {k: v / total for k, v in vols.items()}


def _sum(view, months, key=None):
    out = defaultdict(float)
    for (m, svc, sid, rid), v in view.items():
        if m in months:
            out[svc if key == "service" else sid if key == "source" else rid if key == "region" else "total"] += v
    return dict(out)


def _summarise(payg, cud, recs, platform, sources, meta, region, scenario, pricing):
    y = {1: range(1, 13), 2: range(13, 25), 3: range(25, 37)}
    all3 = range(1, 37)
    yr1 = set(y[1])
    yr3 = set(all3)

    def tot(view, months):
        return round(sum(v for (m, *_), v in view.items() if m in months), 2)

    monthly = []
    for m in all3:
        monthly.append({
            "month": m,
            "payg": round(sum(v for (mm, *_), v in payg.items() if mm == m), 2),
            "cud3": round(sum(v for (mm, *_), v in cud["cud3"].items() if mm == m), 2),
        })

    by_service_y1 = _sum(payg, yr1, "service")
    by_service_3y = _sum(payg, yr3, "service")
    services = sorted(set(by_service_3y), key=lambda s: -by_service_3y[s])
    service_rows = [{
        "service": s,
        "group": service_group(s),
        "year1": round(by_service_y1.get(s, 0), 2),
        "year1_cud": round(_sum(cud["cud1"], yr1, "service").get(s, 0), 2),
        "three_year": round(by_service_3y.get(s, 0), 2),
        "three_year_cud": round(_sum(cud["cud3"], yr3, "service").get(s, 0), 2),
    } for s in services]

    groups = {}
    for row in service_rows:
        g = groups.setdefault(row["group"], {"group": row["group"], "year1": 0.0, "three_year": 0.0})
        g["year1"] = round(g["year1"] + row["year1"], 2)
        g["three_year"] = round(g["three_year"] + row["three_year"], 2)
    group_rows = sorted(groups.values(), key=lambda g: GROUP_ORDER.index(g["group"]))

    by_src_y1 = _sum(payg, yr1, "source")
    by_src_3y = _sum(payg, yr3, "source")
    name_of = {m["id"]: m["name"] for m in meta}
    name_of["_platform"] = "Shared platform (BigQuery, orchestration, network, contingency)"
    name_of["_datastream_backfill"] = "Datastream backfill (all CDC sources)"
    name_of["_ai"] = "Analytics, AI & APIs (BI, Gemini Enterprise, agents, GPU serving, Apigee)"
    name_of["_governance"] = "Governance & security (Knowledge Catalog, SDP, KMS)"
    name_of["_db"] = "Operational databases"
    source_rows = [{"id": k, "name": name_of.get(k, k), "year1": round(by_src_y1.get(k, 0), 2),
                    "three_year": round(by_src_3y.get(k, 0), 2)}
                   for k in sorted(by_src_3y, key=lambda k: (k.startswith("_"), -by_src_3y[k]))]

    reg_y1 = _sum(payg, yr1, "region")
    reg_3y = _sum(payg, yr3, "region")
    region_names = {r["id"]: r["name"] for r in load_regions()}
    region_rows = [{"region": k, "name": region_names.get(k, k), "year1": round(reg_y1.get(k, 0), 2),
                    "three_year": round(reg_3y.get(k, 0), 2)}
                   for k in sorted(reg_3y, key=lambda k: -reg_3y[k])]

    totals = {
        "year1_payg": tot(payg, yr1),
        "year1_cud1": tot(cud["cud1"], yr1),
        "year2_payg": tot(payg, set(y[2])),
        "year3_payg": tot(payg, set(y[3])),
        "three_year_payg": tot(payg, yr3),
        "three_year_cud3": tot(cud["cud3"], yr3),
    }
    totals["avg_monthly_year1"] = round(totals["year1_payg"] / 12, 2)
    totals["range_low_3y"] = round(totals["three_year_cud3"] * 0.75, 2)
    totals["range_high_3y"] = round(totals["three_year_payg"] * 1.3, 2)
    totals["range_low_1y"] = round(totals["year1_cud1"] * 0.75, 2)
    totals["range_high_1y"] = round(totals["year1_payg"] * 1.3, 2)

    return {
        "region": region,
        "currency": "USD",
        "fx": pricing["fx"],
        "totals": totals,
        "by_service": service_rows,
        "by_group": group_rows,
        "by_source": source_rows,
        "by_region": region_rows,
        "monthly": monthly,
        "recommendations": [r.to_dict() for r in recs],
        "platform": platform,
        "assumptions": ASSUMPTIONS,
        "pricing_meta": pricing["_meta"],
        "disclaimer": ("Ballpark estimate for discovery discussions only. Based on public list prices "
                       f"(reviewed {pricing['_meta']['last_reviewed']}) with an approximate regional uplift of "
                       f"x{region['uplift']:.2f} for {region['name']}. Excludes taxes, support, egress from other clouds, "
                       "partner licences (Power BI, Tableau, SageMaker and other non-Google tools are not costed) and negotiated discounts. Validate with the Google Cloud Pricing Calculator."),
    }
