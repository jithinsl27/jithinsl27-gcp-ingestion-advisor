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
from .recommender import effective_type, recommend, platform_components
from .components import COMPONENT_BY_ID, cost_components, component_view, normalized, platform_story
from .environments import env_summary, normalized_envs, replicate
from .bom import build_bom, product_months
from . import slots as SL
from . import live_pricing as LP

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
    "mqtt_broker_vms": 2,                      # self-managed MQTT broker: 2 x 4-vCPU VMs (HA pair)
}

LAKEHOUSE_DEFAULTS = {
    "raw_zone": True,             # Cloud Storage raw zone (immutable copies of source extracts)
    "raw_scope": "batch",         # "batch" = file / batch sources, "all" = every source incl. CDC & streams
    "raw_retention_months": 3,
    "raw_storage_class": "standard",
    "silver_pct": 30,             # silver (cleansed, conformed) as % of bronze
    "gold_pct": 20,               # gold (curated marts, features) as % of bronze
}


BQ_DEFAULTS = {
    "mode": "ondemand",            # ondemand | editions
    "edition": "auto",             # auto (recommended) | standard | enterprise | enterprise_plus
    "baseline_slots": None,        # None = auto-sized; number = architect's override (production)
    "max_slots": None,             # None = auto-sized (busiest hour); number = override
    "scan_basis": "auto",          # auto | heuristic | workload | measured
    "elt_scan_multiplier": None,   # None = ASSUMPTIONS value
    "analytics_scan_multiplier": None,
    "slot_hours_per_tib": 60.0,
    "measured_scan_tib_month": None,   # from INFORMATION_SCHEMA.JOBS (customer's current estate)
    "measured_slot_hours_month": None,
}


def bq_settings(scenario: dict) -> dict:
    """BigQuery compute settings, accepting the legacy bq_model / bq_slots fields."""
    raw = scenario.get("bq") or {}
    b = {**BQ_DEFAULTS, **{k: v for k, v in raw.items() if k in BQ_DEFAULTS and v not in (None, "")}}
    legacy = scenario.get("bq_model")
    if not raw.get("mode") and legacy in SL.EDITIONS:
        b["mode"] = "editions"
        if not raw.get("edition"):
            b["edition"] = legacy
        if not raw and scenario.get("bq_slots") not in (None, ""):
            # legacy: a flat number of slots, billed around the clock
            b["baseline_slots"] = b["max_slots"] = float(scenario["bq_slots"])
    if b["mode"] not in ("ondemand", "editions"):
        b["mode"] = "ondemand"
    if b["edition"] not in ("auto",) + SL.EDITIONS:
        b["edition"] = "auto"
    if b["scan_basis"] not in ("auto", "heuristic", "workload", "measured"):
        b["scan_basis"] = "auto"
    b["slot_hours_per_tib"] = max(0.1, float(b["slot_hours_per_tib"]))
    b["elt_scan_multiplier"] = float(b["elt_scan_multiplier"]) if b["elt_scan_multiplier"] is not None else ASSUMPTIONS["elt_scan_multiplier"]
    b["analytics_scan_multiplier"] = (float(b["analytics_scan_multiplier"]) if b["analytics_scan_multiplier"] is not None
                                      else ASSUMPTIONS["auto_analytics_scan_multiplier"])
    meas_t, meas_s = b["measured_scan_tib_month"], b["measured_slot_hours_month"]
    b["calibrated"] = bool(meas_t and float(meas_t) > 0)
    if b["calibrated"] and meas_s and float(meas_s) > 0:
        b["slot_hours_per_tib"] = float(meas_s) / float(meas_t)
    if b["scan_basis"] == "auto":
        b["scan_basis"] = "measured" if b["calibrated"] else "heuristic"
    if b["scan_basis"] == "measured" and not b["calibrated"]:
        b["scan_basis"] = "heuristic"
    b["shape"] = SL.shape_settings({**(raw.get("shape") or {}), **((scenario.get("workload") or {}).get("slots") or {}),
                                    **(raw.get("shape") or {})})
    return b


def workload_scan_classes(scenario: dict) -> dict | None:
    """Steady-state monthly TiB by job class from the Workload sizing tab (None when it is empty)."""
    from .workload import workload_estimate  # local import: workload imports this module
    w = workload_estimate(scenario)
    cls = {"pipelines": 0.0, "interactive": 0.0, "adhoc": 0.0, "heavy": 0.0}
    for line in w.get("scan_lines_steady_month") or []:
        item, tib = line["item"], float(line["tib"])
        if item.endswith("pipelines (ELT)"):
            cls["pipelines"] += tib
        elif item == "Ad-hoc reports":
            cls["adhoc"] += tib
        elif item == "Heavy / periodic queries":
            cls["heavy"] += tib
        else:
            cls["interactive"] += tib
    if sum(cls.values()) <= 0:
        return None
    W = w.get("workload") or {}
    q = W.get("queries") or {}
    cls["_heavy_query_tib"] = float(q.get("heavy", {}).get("gb") or 0) / GIB_PER_TIB if float(q.get("heavy", {}).get("count") or 0) else 0.0
    cls["_adhoc_query_tib"] = float(q.get("adhoc", {}).get("gb") or 0) / GIB_PER_TIB if float(q.get("adhoc", {}).get("count") or 0) else 0.0
    cls["_dashboards"] = float((W.get("dashboards") or {}).get("count") or 0) > 0
    return cls


COMMERCIAL_DEFAULTS = {"discount_pct": 0.0, "support_plan": "none", "range_low_pct": -25.0, "range_high_pct": 30.0}
SUPPORT_PLANS = ("none", "standard", "enhanced", "premium")


def commercial_settings(scenario):
    c = {**COMMERCIAL_DEFAULTS, **{k: v for k, v in (scenario.get("commercial") or {}).items() if v not in (None, "")}}
    c["discount_pct"] = min(90.0, max(0.0, float(c["discount_pct"])))
    c["range_low_pct"] = min(0.0, max(-90.0, float(c["range_low_pct"])))
    c["range_high_pct"] = min(300.0, max(0.0, float(c["range_high_pct"])))
    if c["support_plan"] not in SUPPORT_PLANS:
        c["support_plan"] = "none"
    return c


def support_fee(list_spend_month, plan, pricing):
    """Google Cloud Customer Care: tiered % of monthly list-price spend, with a monthly minimum."""
    p = pricing["support"][plan]
    fee, prev = 0.0, 0.0
    for limit, rate in p["tiers"]:
        top = list_spend_month if limit is None else min(list_spend_month, limit)
        if top > prev:
            fee += (top - prev) * rate
            prev = top
    return max(p["min_month"], fee)


def lakehouse_settings(scenario):
    lk = {**LAKEHOUSE_DEFAULTS, **{k: v for k, v in (scenario.get("lakehouse") or {}).items() if v is not None}}
    lk["raw_zone"] = lk["raw_zone"] is not False
    lk["raw_retention_months"] = max(1, int(float(lk["raw_retention_months"])))
    lk["silver_pct"] = max(0.0, float(lk["silver_pct"]))
    lk["gold_pct"] = max(0.0, float(lk["gold_pct"]))
    if lk["raw_storage_class"] not in ("standard", "nearline", "coldline", "archive"):
        lk["raw_storage_class"] = "standard"
    if lk["raw_scope"] not in ("batch", "all"):
        lk["raw_scope"] = "batch"
    return lk

RAW_BATCH_ENGINES = {"files_transfer", "dataflow_batch", "datafusion", "dataproc", "cloud_run", "app_integration", "dts_migration"}
CDC_CATEGORIES = {"rdbms", "rdbms_gcp", "rdbms_nocdc", "sap", "nosql", "nosql_gcp", "dwh"}
RUNS = {f["id"]: f["runs_per_month"] for f in FREQUENCIES}


def load_static_pricing():
    with open(DATA_DIR / "pricing.json") as f:
        return json.load(f)


def load_static_regions():
    with open(DATA_DIR / "regions.json") as f:
        return json.load(f)["regions"]


def load_pricing():
    """pricing.json with live us-central1 list prices applied when available (see live_pricing.py)."""
    return LP.apply_pricing(load_static_pricing(), LP.current())


def load_regions():
    """regions.json with live per-service regional uplift when available."""
    return LP.apply_regions(load_static_regions(), LP.current())


def region_uplift(region: dict, service_key: str) -> float:
    return (region.get("uplift_by_service") or {}).get(service_key, region["uplift"])


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
def estimate(scenario: dict, keep_items: bool = False, detail: bool = False) -> dict:
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
    bqs = bq_settings(scenario)
    bq_model = "ondemand" if bqs["mode"] == "ondemand" else "editions"
    sources = [s for s in scenario.get("sources", []) if s.get("type") and s.get("included", True) is not False]

    processing_region = scenario.get("processing_region") or region_id
    if processing_region not in regions:
        processing_region = region_id
    ctx = {"rid": region_id}               # region the next line items are billed in

    def rid_of(r):
        return r if r in regions else region_id

    def up(service_key):
        return region_uplift(regions[ctx["rid"]], service_key) if pricing[service_key].get("regional") else 1.0

    recs = [recommend(s, prefs) for s in sources]
    platform = platform_components(sources, recs, prefs)

    # per-month line items for PAYG; CUD-eligible amounts tracked separately
    payg = defaultdict(float)          # (m, service, source, region) -> usd
    cud = {"cud1": defaultdict(float), "cud3": defaultdict(float)}  # same keys, under that CUD

    excluded = set(scenario.get("excluded_services") or [])
    envs = normalized_envs(scenario)
    primary_env = envs[0]["id"]
    bom = {}                              # (m, service, env_id) -> [usd, qty, cud1_usd, cud3_usd]
    units = {}                            # service -> unit of quantity

    def add(m, service, source, usd, cud1=None, cud3=None, q=None):
        if not usd or service in excluded:
            return
        k = (m, service, source, ctx["rid"])
        payg[k] += usd
        cud["cud1"][k] += usd if cud1 is None else cud1
        cud["cud3"][k] += usd if cud3 is None else cud3
        row = bom.setdefault((m, service, primary_env), [0.0, 0.0, 0.0, 0.0])
        row[0] += usd
        row[2] += usd if cud1 is None else cud1
        row[3] += usd if cud3 is None else cud3
        if q:
            row[1] += q[0]
            units.setdefault(service, q[1])

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
    raw_in = defaultdict(float)               # month -> GiB landed in the Cloud Storage raw zone
    lake_in = defaultdict(float)              # month -> GiB written to the Cloud Storage data lake (target)
    dms_cdc = defaultdict(lambda: defaultdict(float))   # month -> source -> GiB (heterogeneous DMS)
    dms_backfill = defaultdict(lambda: defaultdict(float))
    bq_starts = []
    targets = {"data_platform": [], "data_lake": [], "operational_db": []}
    lk = lakehouse_settings(scenario)
    curated = (lk["silver_pct"] + lk["gold_pct"]) / 100.0
    per_source_meta = []

    for src, rec in zip(sources, recs):
        sid = src.get("id") or src["type"]
        etype = effective_type(src)
        name = src.get("name") or src.get("custom_name") or SOURCE_BY_ID.get(etype, {}).get("name", etype)
        cat = SOURCE_BY_ID.get(etype, {}).get("category", "api")
        to_bq = rec.target == "data_platform"
        to_lake = rec.target == "data_lake"
        targets[rec.target].append(name)
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
        if to_bq:
            initial_by_month[start] += initial
            bq_starts.append(start)
        elif to_lake:
            lake_in[start] += initial
        src_rid = rid_of(src.get("region") or region_id)
        ctx["rid"] = src_rid
        per_source_meta.append({"id": sid, "name": name, "region": src_rid})
        xfer_rate = inter_region_rate(regions, src_rid, region_id, pricing)
        in_raw = to_bq and lk["raw_zone"] and (lk["raw_scope"] == "all" or (freq not in STREAMING_FREQS and bool(RAW_BATCH_ENGINES & set(engines))))
        if in_raw:
            raw_in[start] += initial

        for m in range(1, 37):
            if m < start:
                continue
            g = growth_factor(m, growth)
            daily = 0.0 if one_time else daily0 * g
            monthly = daily * 30
            if to_bq:
                ingested_gib[m] += monthly
                ingested_net_gib[m] += monthly * net_ratio
            elif to_lake:
                lake_in[m] += monthly
            if in_raw:
                raw_in[m] += monthly
            if xfer_rate:
                add(m, "Cross-region data transfer", sid, monthly * xfer_rate, q=(monthly, "GiB"))
                if m == start and initial:
                    add(m, "Cross-region data transfer", sid, initial * xfer_rate, q=(initial, "GiB"))

            for eng in engines:
                if eng == "datastream":
                    datastream_cdc_gib[m] += monthly
                elif eng == "dataflow_batch":
                    vh = batch_vcpu_hours(monthly, runs, transform)
                    usd = (vh * df["batch_vcpu_hr"] + vh * ASSUMPTIONS["memory_gib_per_vcpu"] * df["memory_gib_hr"]) * up("dataflow")
                    if transform == "heavy":
                        usd += monthly * df["shuffle_gib"] * up("dataflow")
                    add(m, "Dataflow (batch)", sid, usd, q=(vh, "vCPU-hours"))
                elif eng == "dataflow_stream":
                    if one_time:
                        continue
                    v = stream_vcpus(daily, transform)
                    compute = (v * HOURS * df["streaming_vcpu_hr"]
                               + v * HOURS * ASSUMPTIONS["memory_gib_per_vcpu"] * df["memory_gib_hr"]
                               + v * HOURS * ASSUMPTIONS["streaming_engine_cu_per_vcpu_hr"] * df["streaming_engine_cu_hr"]) * up("dataflow")
                    add(m, "Dataflow (streaming)", sid, compute,
                        cud1=compute * (1 - df["cud1_discount"]), cud3=compute * (1 - df["cud3_discount"]), q=(v * HOURS, "vCPU-hours"))
                elif eng == "pubsub_bqsub":
                    tib = monthly / GIB_PER_TIB
                    add(m, "Pub/Sub", sid, tib * (ps["throughput_tib"] + ps["bq_subscription_tib"]), q=(tib, "TiB"))
                elif eng == "pubsub":
                    tib = monthly / GIB_PER_TIB
                    add(m, "Pub/Sub", sid, tib * ps["throughput_tib"] * 2, q=(tib, "TiB"))  # publish + subscribe
                elif eng == "datafusion":
                    vh = 0.0
                    if runs > 0 and monthly > 0:
                        vh = runs * max(ASSUMPTIONS["datafusion_min_vcpu_hr_per_run"],
                                        monthly / runs / ASSUMPTIONS["datafusion_gb_per_vcpu_hr"])
                    elif not one_time and monthly > 0:  # streaming pipeline on an always-on cluster
                        vh = HOURS * 4
                    add(m, "Data Fusion pipelines (Dataproc)", sid, vh * pricing["datafusion"]["pipeline_vcpu_hr_all_in"] * up("datafusion"), q=(vh, "vCPU-hours"))
                elif eng == "dataproc":
                    if runs > 0 and monthly > 0:
                        rate = ASSUMPTIONS["spark_gb_per_dcu_hr"][transform]
                        dcu = runs * max(ASSUMPTIONS["spark_min_dcu_hr_per_run"], monthly / runs / rate)
                        add(m, "Dataproc Serverless", sid, dcu * pricing["dataproc_serverless"]["dcu_hr"] * up("dataproc_serverless"), q=(dcu, "DCU-hours"))
                elif eng == "files_transfer":
                    if on_prem or cat == "mainframe":
                        add(m, "Storage Transfer Service", sid, monthly * pricing["storage_transfer"]["agent_gib"], q=(monthly, "GiB"))
                    landing_gib[m] += daily * ASSUMPTIONS["landing_retention_days"]
                elif eng == "dts_free":
                    pass  # DTS connectors used here carry no transfer charge; BigQuery load is free
                elif eng == "dts_migration":
                    if etype == "teradata" and not one_time:
                        add(m, "Compute Engine (migration agent)", sid, HOURS * pricing["compute_engine"]["vm_standard_4vcpu_hr"] * up("compute_engine"), q=(HOURS, "VM-hours"))
                elif eng == "sap_connector":
                    write_api_gib[m] += monthly
                elif eng == "log_sink":
                    if to_bq:
                        streaming_insert_gib[m] += monthly
                elif eng == "dms_hetero":
                    dms_cdc[m][sid] += monthly
                elif eng == "app_integration":
                    ic = pricing["integration_connectors"]
                    add(m, "Integration Connectors", sid,
                        HOURS * ic["third_party_node_hr"] + max(0.0, monthly - ic["free_gib"]) * ic["data_processed_gib"], q=(HOURS, "node-hours"))
                elif eng in ("cloud_run",):
                    cr = pricing["cloud_run"]
                    r = runs if runs else 30
                    secs = r * ASSUMPTIONS["cloud_run_minutes_per_run"] * 60
                    add(m, "Cloud Run jobs", sid, secs * (cr["vcpu_second"] + 2 * cr["gib_second"]) * up("cloud_run"), q=(r, "job runs"))
                    if to_bq:
                        write_api_gib[m] += monthly
                elif eng == "mqtt_broker":
                    if one_time:
                        continue
                    vm_h = ASSUMPTIONS["mqtt_broker_vms"] * HOURS
                    add(m, "MQTT broker (Compute Engine)", sid, vm_h * pricing["compute_engine"]["vm_standard_4vcpu_hr"] * up("compute_engine"), q=(vm_h, "VM-hours"))

            # ---------------- one-time initial load (go-live month)
            if m == start and initial > 0:
                primary_engine = engines[0]
                if primary_engine == "datastream":
                    backfill_by_month[m] += initial
                elif primary_engine in ("dataflow_batch", "dataflow_stream"):
                    vh = batch_vcpu_hours(initial, max(1, math.ceil(initial / 2000)), "light")
                    add(m, "One-time initial load", sid, (vh * df["batch_vcpu_hr"] + vh * ASSUMPTIONS["memory_gib_per_vcpu"] * df["memory_gib_hr"]) * up("dataflow"), q=(initial, "GiB loaded"))
                elif primary_engine == "datafusion":
                    vh = max(ASSUMPTIONS["datafusion_min_vcpu_hr_per_run"], initial / ASSUMPTIONS["datafusion_gb_per_vcpu_hr"])
                    add(m, "One-time initial load", sid, vh * pricing["datafusion"]["pipeline_vcpu_hr_all_in"] * up("datafusion"), q=(initial, "GiB loaded"))
                elif primary_engine == "dataproc":
                    dcu = max(ASSUMPTIONS["spark_min_dcu_hr_per_run"], initial / ASSUMPTIONS["spark_gb_per_dcu_hr"]["light"])
                    add(m, "One-time initial load", sid, dcu * pricing["dataproc_serverless"]["dcu_hr"] * up("dataproc_serverless"), q=(initial, "GiB loaded"))
                elif primary_engine == "files_transfer":
                    if on_prem or cat == "mainframe":
                        add(m, "One-time initial load", sid, initial * pricing["storage_transfer"]["agent_gib"])
                    add(m, "One-time initial load", sid, initial * pricing["gcs"]["standard_gib_month"] * up("gcs"), q=(initial, "GiB loaded"))
                elif primary_engine == "dms_hetero":
                    dms_backfill[m][sid] += initial
                elif primary_engine == "dts_migration" and etype == "teradata":
                    hrs = initial / ASSUMPTIONS["teradata_agent_gb_per_hr"]
                    add(m, "One-time initial load", sid, hrs * pricing["compute_engine"]["vm_standard_4vcpu_hr"] * up("compute_engine"), q=(initial, "GiB loaded"))
                elif primary_engine == "sap_connector":
                    write_api_gib[m] += initial

    # ------------------------------------------------------------ Database Migration Service (heterogeneous; tiers per account)
    dm = pricing["database_migration"]
    free_dms = dm["backfill_free_gib"]
    for m in range(1, 37):
        tot_gib = sum(dms_cdc[m].values())
        if tot_gib:
            total = tiered(tot_gib, dm["cdc_tiers_gib"])
            for sid, gib in dms_cdc[m].items():
                ctx["rid"] = region_id
                add(m, "Database Migration Service (CDC)", sid, total * gib / tot_gib, q=(gib, "GiB"))
        for sid, gib in dms_backfill[m].items():
            billable = max(0.0, gib - free_dms)
            free_dms = max(0.0, free_dms - gib)
            add(m, "Database Migration Service (backfill)", sid, billable * dm["backfill_gib"], q=(billable, "GiB"))

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
                add(m, "Datastream (CDC)", sid, total * share, q=(gib * share, "GiB"))
    ctx["rid"] = region_id
    free_backfill = ds["backfill_free_gib"]
    for m in range(1, 37):
        if backfill_by_month[m]:
            billable = max(0.0, backfill_by_month[m] - free_backfill)
            free_backfill = max(0.0, free_backfill - backfill_by_month[m])
            add(m, "One-time initial load", "_datastream_backfill", billable * ds["backfill_gib"], q=(billable, "GiB loaded"))

    # ------------------------------------------------------------ BigQuery (home region)
    plat_start = min(src_start.values()) if src_start else 1
    bq_start = min(bq_starts) if bq_starts else None
    ctx["rid"] = region_id
    bq_up = up("bigquery")
    stored = 0.0
    history = []  # monthly new data (initial loads + net ingest) for active/long-term split
    new_by_month = defaultdict(float)
    bronze_by_month = {}
    analytics_tib_input = scenario.get("analytics_tib_month")
    scan_classes = {}                 # month -> {"pipelines": TiB, "interactive": TiB, ...}
    wl_classes = workload_scan_classes(scenario)
    heur_month12 = None
    for m in range(1, 37):
        new_by_month[m] = initial_by_month[m] + ingested_net_gib[m]
        history.append(new_by_month[m])
        stored += new_by_month[m]
        recent = sum(history[-3:])
        older = max(0.0, stored - recent)
        lt = older * ASSUMPTIONS["longterm_share_after_90d"]
        active = (stored - lt)
        mult = 1 + curated
        active_b = max(0.0, active * mult - bq["storage_free_gib"])
        st_cost = (active_b * bq["storage_active_gib_month"] + lt * mult * bq["storage_longterm_gib_month"]) * bq_up
        add(m, "BigQuery storage", "_platform", st_cost, q=(active_b + lt * mult, "GiB-months"))
        bronze_by_month[m] = stored

        # ingestion APIs
        wa = max(0.0, write_api_gib[m] - bq["storage_write_api_free_tib"] * GIB_PER_TIB)
        add(m, "BigQuery ingestion (Write API / streaming)", "_platform",
            (wa * bq["storage_write_api_gib"] + streaming_insert_gib[m] * bq["streaming_inserts_gib"]) * bq_up,
            q=(wa + streaming_insert_gib[m], "GiB"))

        # compute
        stored_tib = stored * mult / GIB_PER_TIB
        elt_tib = ingested_gib[m] * bqs["elt_scan_multiplier"] / GIB_PER_TIB
        if analytics_tib_input not in (None, "", 0, "0"):
            analytics_tib = float(analytics_tib_input) * growth_factor(m, growth)
        else:
            analytics_tib = stored_tib * bqs["analytics_scan_multiplier"]
        heur = {"pipelines": elt_tib, "interactive": analytics_tib, "adhoc": 0.0, "heavy": 0.0}
        if m == 12:
            heur_month12 = dict(heur)
        if bq_start is None or m < bq_start:
            cls = {k: 0.0 for k in heur}
        elif bqs["scan_basis"] == "measured":
            tot = sum(heur.values())
            meas = float(bqs["measured_scan_tib_month"]) * growth_factor(m - plat_start + 1, growth)
            cls = {k: (v / tot * meas if tot else (meas if k == "interactive" else 0.0)) for k, v in heur.items()}
        elif bqs["scan_basis"] == "workload" and wl_classes:
            g = growth_factor(m - plat_start + 1, growth)
            cls = {k: wl_classes[k] * g for k in heur}
        else:
            cls = heur
        scan_classes[m] = cls
        scan_tib = sum(cls.values())
        if bq_model == "ondemand":
            billable = max(0.0, scan_tib - bq["ondemand_free_tib"])
            add(m, "BigQuery compute", "_platform", billable * bq["ondemand_tib"] * bq_up, q=(billable, "TiB scanned"))

    # ------------------------------------------------------------ BigQuery editions: baseline + autoscale per environment
    comp_types_all = {c["type"] for c in normalized(scenario)[0] if c.get("included") is not False}
    ref_m = min(36, plat_start + 11)
    sph = bqs["slot_hours_per_tib"]

    def class_slot_hours(cls, f=1.0):
        return {k: v * sph * f for k, v in cls.items()}

    ref_cls = scan_classes.get(ref_m) or {}
    wl_extra = wl_classes if (bqs["scan_basis"] == "workload" and wl_classes) else {}
    sizing = SL.size(class_slot_hours(ref_cls), bqs["shape"], pricing, bq_up, comp_types_all,
                     edition_choice=bqs["edition"], baseline_override=bqs["baseline_slots"], max_override=bqs["max_slots"],
                     heavy_query_tib=wl_extra.get("_heavy_query_tib", 0.0), adhoc_query_tib=wl_extra.get("_adhoc_query_tib", 0.0),
                     dashboards=bool(wl_extra.get("_dashboards")), ondemand_tib=sum(ref_cls.values()),
                     slot_hours_per_tib=sph)
    edition = sizing["edition"]
    env_bq = []                           # (env, baseline, max, auto_baseline, auto_max)
    for i, e in enumerate(envs):
        f = e["compute_pct"] / 100.0
        if i == 0:
            b, mx, ab, am = sizing["baseline"], sizing["max"], sizing["auto_baseline"], sizing["auto_max"]
        else:
            am = SL.ceil_step(sizing["max"] * f) if f > 0 and sizing["max"] else 0
            ab = SL.floor_step(sizing["baseline"] * f) if e["runtime_pct"] >= 100 else 0
            mx = e["bq_max"] if e["bq_max"] is not None else am
            b = e["bq_baseline"] if e["bq_baseline"] is not None else ab
            if edition == "standard":
                b, mx = 0.0, min(mx, SL.STANDARD_MAX_SLOTS)
            b = min(b, mx)
        env_bq.append((e, float(b), float(mx), ab, am))
    env_bq_lines = []                     # (env_id, m, payg, cud1, cud3, slot_hours) for non-primary envs
    if bq_model == "editions":
        prices = SL.edition_prices(pricing, edition, bq_up)
        for m in range(1, 37):
            cls = scan_classes.get(m)
            if not cls or not sum(cls.values()):
                continue
            for i, (e, b, mx, _ab, _am) in enumerate(env_bq):
                f = 1.0 if i == 0 else e["compute_pct"] / 100.0
                if f <= 0 and b <= 0:
                    continue
                prof = SL.profile(class_slot_hours(cls, f), bqs["shape"])
                p_, c1_, c3_, sh_ = SL.month_cost(prof, b, mx, prices)
                if i == 0:
                    add(m, "BigQuery compute", "_platform", p_, cud1=c1_, cud3=c3_, q=(sh_, "slot-hours"))
                elif p_ and "BigQuery compute" not in excluded:
                    env_bq_lines.append((e["id"], m, p_, c1_, c3_, sh_))

    # ------------------------------------------------------------ Shared platform components (processing region)
    ctx["rid"] = processing_region
    orch = platform["orchestration"]["tool"]
    if orch == "composer":
        cp = pricing["composer"]
        size = "small_env_avg_dcu" if len(sources) <= 10 else "medium_env_avg_dcu"
        dcu_h = cp[size] * HOURS
        for m in range(plat_start, 37):
            add(m, "Composer (Airflow)", "_platform", dcu_h * cp["dcu_hr"] * up("composer"),
                cud1=dcu_h * cp["cud1_dcu_hr"] * up("composer"), cud3=dcu_h * cp["cud3_dcu_hr"] * up("composer"), q=(dcu_h, "DCU-hours"))
    elif orch == "workflows":
        for m in range(plat_start, 37):
            add(m, "Workflows + Scheduler", "_platform", len(sources) * pricing["workflows"]["scheduler_job_month"], q=(len(sources), "scheduled jobs"))

    if platform["datafusion_edition"]:
        dfp = pricing["datafusion"]
        if platform["datafusion_edition"] == "enterprise":
            inst = HOURS * dfp["enterprise_hr"]
        else:
            inst = max(0, HOURS - dfp["basic_free_hours"]) * dfp["basic_hr"]
        for m in range(plat_start, 37):
            add(m, f"Data Fusion instance ({platform['datafusion_edition'].title()})", "_platform", inst * up("datafusion"), q=(HOURS, "instance-hours"))

    if platform["connectivity"] == "ha_vpn":
        n = pricing["network"]
        for m in range(plat_start, 37):
            add(m, "Network (HA VPN)", "_platform", n["ha_vpn_tunnel_hr"] * n["ha_vpn_tunnels"] * HOURS, q=(n["ha_vpn_tunnels"] * HOURS, "tunnel-hours"))
    elif platform["connectivity"] == "interconnect":
        ic = pricing["interconnect"]
        for m in range(plat_start, 37):
            add(m, "Network (Interconnect)", "_platform",
                ic["dedicated_10g_port_month"] + ic["vlan_attachment_hr"] * ic["vlan_attachments"] * HOURS, q=(1, "10 Gbps ports"))

    ctx["rid"] = region_id
    raw_stored = {}
    for m in range(1, 37):
        if lk["raw_zone"]:
            lo = max(1, m - lk["raw_retention_months"] + 1)
            gib = sum(raw_in[k] for k in range(lo, m + 1))
            raw_stored[m] = gib
            if gib:
                add(m, "Cloud Storage (raw zone)", "_platform", gib * pricing["gcs"][f"{lk['raw_storage_class']}_gib_month"] * up("gcs"), q=(gib, "GiB-months"))
        elif landing_gib[m]:
            add(m, "Cloud Storage (landing zone)", "_platform", landing_gib[m] * pricing["gcs"]["standard_gib_month"] * up("gcs"), q=(landing_gib[m], "GiB-months"))
    lake_stored = 0.0
    lake_by_month = {}
    for m in range(1, 37):
        lake_stored += lake_in[m]
        lake_by_month[m] = lake_stored
        if lake_stored:
            add(m, "Cloud Storage (data lake)", "_platform", lake_stored * pricing["gcs"]["standard_gib_month"] * up("gcs"), q=(lake_stored, "GiB-months"))

    # ------------------------------------------------------------ Analytics, AI, governance, security
    comps, sec = normalized(scenario)

    def set_region(r):
        ctx["rid"] = rid_of(r or region_id)

    tables = cost_components(comps, sec, pricing, up, sources, new_by_month, bq_model, add,
                             curated, set_region, region_id)
    ctx["rid"] = region_id
    platform["layer"] = {
        "components": [component_view(c) for c in comps],
        "security": sec,
        "tables_estimated": tables,
        "story": platform_story(comps, sec, sources),
    }
    platform["processing_region"] = processing_region
    platform["targets"] = {k: v for k, v in targets.items()}
    platform["data_lake_gib_month12"] = round(lake_by_month.get(12, 0.0), 2)
    m12 = 12
    platform["lakehouse"] = {
        **lk,
        "raw_gib_month12": round(raw_stored.get(m12, 0.0), 2),
        "layers": [
            {"id": "bronze", "name": "Bronze", "role": "Raw / staging tables as ingested (CDC, loads, streams)", "pct": 100.0,
             "gib_month12": round(bronze_by_month.get(m12, 0.0), 2)},
            {"id": "silver", "name": "Silver", "role": "Cleansed, deduplicated, conformed (Dataform)", "pct": lk["silver_pct"],
             "gib_month12": round(bronze_by_month.get(m12, 0.0) * lk["silver_pct"] / 100, 2)},
            {"id": "gold", "name": "Gold", "role": "Curated marts, features and semantic models for BI and AI", "pct": lk["gold_pct"],
             "gib_month12": round(bronze_by_month.get(m12, 0.0) * lk["gold_pct"] / 100, 2)},
        ],
    }

    # ------------------------------------------------------------ Environments (dev / test / DR ...)
    env_tot = replicate([payg, cud["cud1"], cud["cud3"]], bom, envs, service_group, bq_model,
                        extra_lines=[(eid, m, "BigQuery compute", p_, c1_, c3_, sh_) for eid, m, p_, c1_, c3_, sh_ in env_bq_lines],
                        extra_key=lambda m, svc: (m, svc, "_platform", region_id))

    # ------------------------------------------------------------ Contingency
    cont = float(scenario.get("contingency_pct", ASSUMPTIONS["contingency"] * 100)) / 100.0
    cont_on = "Contingency & operations" not in excluded
    for view in (payg, cud["cud1"], cud["cud3"]):
        monthly_tot = defaultdict(float)
        for (m, svc, sid, rid), v in list(view.items()):
            monthly_tot[m] += v
        for m, v in monthly_tot.items():
            if cont_on:
                view[(m, "Contingency & operations", "_platform", region_id)] += v * cont
    if cont_on:
        month_bom = defaultdict(lambda: [0.0, 0.0, 0.0])
        for (m, svc, env_id), (usd, _q, c1, c3) in list(bom.items()):
            mb = month_bom[(m, env_id)]
            mb[0] += usd
            mb[1] += c1
            mb[2] += c3
        for (m, env_id), (v, c1, c3) in month_bom.items():
            if v:
                row = bom.setdefault((m, "Contingency & operations", env_id), [0.0, 0.0, 0.0, 0.0])
                row[0] += v * cont
                row[2] += c1 * cont
                row[3] += c3 * cont

    # ------------------------------------------------------------ Commercial: negotiated discount, Customer Care
    com = commercial_settings(scenario)
    support_svc = f"Google Cloud Customer Care ({com['support_plan'].title()})"
    list_month = defaultdict(float)
    for (m, *_), v in payg.items():
        list_month[m] += v
    if com["discount_pct"]:
        d = com["discount_pct"] / 100.0
        for view in (payg, cud["cud1"], cud["cud3"]):
            mt = defaultdict(float)
            for (m, *_), v in list(view.items()):
                mt[m] += v
            for m, v in mt.items():
                if v:
                    view[(m, "Negotiated discount", "_commercial", region_id)] -= v * d
        mb = defaultdict(lambda: [0.0, 0.0, 0.0])
        for (m, svc, env_id), (usd, _q, c1, c3) in list(bom.items()):
            mb[(m, env_id)][0] += usd
            mb[(m, env_id)][1] += c1
            mb[(m, env_id)][2] += c3
        for (m, env_id), (v, c1, c3) in mb.items():
            if v:
                row = bom.setdefault((m, "Negotiated discount", env_id), [0.0, 0.0, 0.0, 0.0])
                row[0] -= v * d
                row[2] -= c1 * d
                row[3] -= c3 * d
    if com["support_plan"] != "none" and support_svc not in excluded:
        for m, v in list_month.items():
            if v <= 0:
                continue
            fee = support_fee(v, com["support_plan"], pricing)
            for view in (payg, cud["cud1"], cud["cud3"]):
                view[(m, support_svc, "_commercial", region_id)] += fee
            row = bom.setdefault((m, support_svc, primary_env), [0.0, 0.0, 0.0, 0.0])
            row[0] += fee
            row[2] += fee
            row[3] += fee

    # per-environment totals from the bill of materials (includes contingency, discount and support)
    env_tot = {e["id"]: {n: [0.0] * 37 for n in ("payg", "cud1", "cud3")} for e in envs}
    for (m, svc, env_id), (usd, _q, c1, c3) in bom.items():
        if env_id in env_tot:
            env_tot[env_id]["payg"][m] += usd
            env_tot[env_id]["cud1"][m] += c1
            env_tot[env_id]["cud3"][m] += c3

    out = _summarise(payg, cud, recs, platform, sources, per_source_meta, region, scenario, pricing)
    out["commercial"] = com
    out["availability"] = availability_check(sources, recs, comps, platform, regions, region_id, processing_region)
    out["excluded_services"] = sorted(excluded)
    slots_by_env = None
    if bq_model == "editions":
        slots_by_env = {e["id"]: {"baseline": b, "max": mx, "auto_baseline": ab, "auto_max": am,
                                  "baseline_set": (bqs["baseline_slots"] is not None) if i == 0 else e["bq_baseline"] is not None,
                                  "max_set": (bqs["max_slots"] is not None) if i == 0 else e["bq_max"] is not None}
                        for i, (e, b, mx, ab, am) in enumerate(env_bq)}
    out["environments"] = env_summary(envs, env_tot, 0.0, False, slots_by_env)
    out["bigquery"] = _bq_summary(bqs, sizing, scan_classes, ref_m, heur_month12, wl_classes, bq_model, pricing, bq_up, plat_start, src_start)
    drivers = defaultdict(set)
    name_of = {m_["id"]: m_["name"] for m_ in per_source_meta}
    for (m, svc, sid, rid) in payg:
        if sid in name_of:
            drivers[svc].add(name_of[sid])
    out["bom"] = build_bom(bom, units, envs, drivers, service_group, GROUP_ORDER,
                           {"bq_model": bq_model, "contingency_pct": round(cont * 100, 1), "lakehouse": lk,
                            "components": comps, "edition": sizing["edition"], "baseline": sizing["baseline"], "max": sizing["max"]})
    if detail:
        out["product_months"] = product_months(bom, units, envs, service_group, GROUP_ORDER)
    if keep_items:
        out["_items"] = payg
    return out


def _bq_summary(bqs, sizing, scan_classes, ref_m, heur12, wl_classes, bq_model, pricing, uplift, plat_start, src_start):
    """What drives BigQuery compute: scan basis, slot sizing, edition comparison, calibration inputs."""
    ref = scan_classes.get(ref_m) or {}
    tib = sum(ref.values())
    heur_tib = sum((heur12 or {}).values())
    wl_tib = sum(v for k, v in (wl_classes or {}).items() if not k.startswith("_")) if wl_classes else None
    meas_tib = float(bqs["measured_scan_tib_month"]) if bqs["calibrated"] else None
    bq = pricing["bigquery"]

    def od(t):
        return round(max(0.0, t - bq["ondemand_free_tib"]) * bq["ondemand_tib"] * uplift, 2) if t is not None else None
    return {
        "mode": bq_model, "scan_basis": bqs["scan_basis"], "reference_month": ref_m, "active": bool(src_start),
        "slot_hours_per_tib": round(bqs["slot_hours_per_tib"], 2),
        "elt_scan_multiplier": bqs["elt_scan_multiplier"], "analytics_scan_multiplier": bqs["analytics_scan_multiplier"],
        "calibrated": bqs["calibrated"],
        "measured_scan_tib_month": bqs["measured_scan_tib_month"], "measured_slot_hours_month": bqs["measured_slot_hours_month"],
        "scan_tib_month": round(tib, 3),
        "scan_by_class": [{"class": SL.CLASS_LABELS[k], "id": k, "tib_month": round(v, 3),
                           "slot_hours_month": round(v * bqs["slot_hours_per_tib"], 1)} for k, v in ref.items() if k in SL.CLASS_LABELS],
        "bases": [
            {"id": "heuristic", "name": "Rule of thumb from data volume", "tib_month": round(heur_tib, 3), "ondemand_month": od(heur_tib),
             "detail": f"ELT scans {bqs['elt_scan_multiplier']:g}x the data ingested; dashboards and analysis scan {bqs['analytics_scan_multiplier']:g}x the data stored, per month"},
            {"id": "workload", "name": "Workload sizing tab", "tib_month": round(wl_tib, 3) if wl_tib is not None else None,
             "ondemand_month": od(wl_tib), "detail": "Pipelines, queries and dashboards entered on the Workload sizing tab"},
            {"id": "measured", "name": "Measured (INFORMATION_SCHEMA)", "tib_month": round(meas_tib, 3) if meas_tib else None,
             "ondemand_month": od(meas_tib), "detail": "TiB billed and slot-hours from the customer's INFORMATION_SCHEMA.JOBS"},
        ],
        "shape": bqs["shape"],
        "edition_choice": bqs["edition"],
        "baseline_override": bqs["baseline_slots"], "max_override": bqs["max_slots"],
        **{k: sizing[k] for k in ("recommended_mode", "autoscale_overhead", "edition", "recommended_edition", "edition_reasons", "baseline", "max", "auto_baseline",
                                  "auto_max", "profile", "avg_slots", "peak_slots", "heavy_burst_slots", "slot_hours_month",
                                  "autoscale_slot_hours_month", "month_cost", "comparison", "warnings")},
    }


def availability_check(sources, recs, comps, platform, regions, home, processing_region):
    """Which services in the design are not offered (or not verified) in the region they are placed in."""
    live = LP.current()
    need = {}                                   # (family, region) -> set of uses

    def want(fam, rid, use):
        if fam:
            need.setdefault((fam, rid), set()).add(use)
    want("bigquery", home, "BigQuery (data platform)")
    for src, rec in zip(sources, recs):
        rid = src.get("region") or home
        name = src.get("name") or src["type"]
        for eng in rec.engine.split("+"):
            want(LP.ENGINE_FAMILY.get(eng), rid, name)
    orch = (platform.get("orchestration") or {}).get("tool")
    if orch in ("composer", "workflows"):
        want(orch, processing_region, "Orchestration")
    if platform.get("datafusion_edition"):
        want("datafusion", processing_region, "Data Fusion instance")
    for c in comps:
        if c.get("included") is False:
            continue
        rid = (c.get("settings") or {}).get("region") or home
        want(LP.COMPONENT_FAMILY.get(c["type"]), rid, COMPONENT_BY_ID.get(c["type"], {}).get("name", c["type"]))
    unavailable, unverified = [], []
    for (fam, rid), uses in sorted(need.items()):
        ok = LP.availability(fam, rid, live)
        item = {"service": LP.FAMILY_NAMES.get(fam, fam), "family": fam, "region": rid,
                "region_name": regions.get(rid, {}).get("name", rid), "used_by": sorted(uses)}
        if ok is False:
            geo = regions.get(rid, {}).get("geo")
            alts = [r for r in regions.values() if not r.get("multi") and LP.availability(fam, r["id"], live)]
            alts.sort(key=lambda r: (r.get("geo") != geo, r.get("uplift", 1)))
            item["alternatives"] = [{"id": r["id"], "name": r["name"]} for r in alts[:3]]
            unavailable.append(item)
        elif ok is None:
            unverified.append(item)
    return {"source": "live" if live else "static", "fetched_at": (live or {}).get("fetched_at"),
            "unavailable": unavailable, "unverified": unverified, "checked": len(need)}


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


GROUP_ORDER = ["Data ingestion & CDC", "BigQuery & storage", "Analytics & AI", "APIs & databases", "Governance & security", "Platform & network", "Contingency", "Commercial"]


def service_group(name):
    n = name.lower()
    if (n.startswith("bigquery") and "agents" not in n and "gemini" not in n) or n.startswith("cloud storage"):
        return "BigQuery & storage"
    if any(k in n for k in ("apigee", "alloydb", "cloud sql", "spanner", "bigtable", "firestore", "memorystore")):
        return "APIs & databases"
    if any(k in n for k in ("looker", "gemini", "agent", "vertex ai")):
        return "Analytics & AI"
    if any(k in n for k in ("knowledge catalog", "sensitive data", "kms")):
        return "Governance & security"
    if any(k in n for k in ("composer", "workflows", "network", "data fusion instance", "cross-region")):
        return "Platform & network"
    if "contingency" in n:
        return "Contingency"
    if "customer care" in n or "negotiated discount" in n:
        return "Commercial"
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


def _option_view(view, y, name_of, region_names):
    """Totals and breakdowns for one pricing option (pay-as-you-go, 1-yr or 3-yr commitments)."""
    r2 = lambda x: round(x + 1e-12, 2)  # noqa: E731
    yr1, all3 = set(y[1]), set(range(1, 37))
    monthly = [0.0] * 36
    for (m, *_), v in view.items():
        monthly[m - 1] += v
    t = {"year1": r2(sum(monthly[0:12])), "year2": r2(sum(monthly[12:24])), "year3": r2(sum(monthly[24:36])),
         "three_year": r2(sum(monthly))}
    t["avg_monthly_year1"] = round(t["year1"] / 12, 2)

    def rows(key, label):
        a, b = _sum(view, yr1, key), _sum(view, all3, key)
        return [{"key": k, "name": label(k), "year1": r2(a.get(k, 0.0)), "three_year": r2(b[k])}
                for k in sorted(b, key=lambda k: -b[k])]
    svc = rows("service", lambda k: k)
    for r in svc:
        r["group"] = service_group(r["key"])
    groups = {}
    for r in svc:
        g = groups.setdefault(r["group"], {"group": r["group"], "year1": 0.0, "three_year": 0.0})
        g["year1"] = r2(g["year1"] + r["year1"])
        g["three_year"] = r2(g["three_year"] + r["three_year"])
    return {
        "totals": t, "monthly": [r2(v) for v in monthly],
        "by_service": svc,
        "by_group": sorted(groups.values(), key=lambda g: GROUP_ORDER.index(g["group"])),
        "by_source": sorted(rows("source", lambda k: name_of.get(k, k)), key=lambda r: (r["key"].startswith("_"), -r["three_year"])),
        "by_region": rows("region", lambda k: region_names.get(k, k)),
    }


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
    by_option = {}
    for opt, view in (("payg", payg), ("cud1", cud["cud1"]), ("cud3", cud["cud3"])):
        by_option[opt] = _option_view(view, y, name_of, region_names)
    com = commercial_settings(scenario)
    lo, hi = 1 + com["range_low_pct"] / 100.0, 1 + com["range_high_pct"] / 100.0
    totals["range_low_3y"] = round(totals["three_year_cud3"] * lo, 2)
    totals["range_high_3y"] = round(totals["three_year_payg"] * hi, 2)
    totals["range_low_1y"] = round(totals["year1_cud1"] * lo, 2)
    totals["range_high_1y"] = round(totals["year1_payg"] * hi, 2)

    return {
        "region": region,
        "currency": "USD",
        "fx": pricing["fx"],
        "totals": totals,
        "by_option": by_option,
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
