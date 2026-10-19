"""Live list prices and regional availability from the Cloud Billing Catalog API.

* Refreshed in the background on Cloud Run once a day (and on start-up when the
  cached copy is older than a day). Until a refresh succeeds - or when the API is
  unreachable - the estimate uses app/data/pricing.json and regions.json.
* Authentication: a Cloud Billing API key (env BILLING_API_KEY, created by
  deploy.sh and kept in Secret Manager) or, failing that, the service account's
  own OAuth token.
* Prices: each mapped price point is matched to a public SKU by service and SKU
  description. A live price only replaces the static one when it is within 3x of
  it (guards against a wrong SKU match); everything matched / skipped is reported
  by /api/pricing/status, so the mapping can be tuned with scripts/inspect_skus.py.
* Regional prices: the ratio of each region's SKU price to us-central1 replaces
  the static per-region uplift, per service.
* Availability: a service is available in a region when one of its SKUs is
  offered there (serviceRegions); global SKUs count as available everywhere.
"""
from __future__ import annotations

import json
import logging
import os
import re
import statistics
import threading
import time
from copy import deepcopy
from pathlib import Path

log = logging.getLogger("compass.pricing")

API = "https://cloudbilling.googleapis.com/v1"
BASE_REGION = "us-central1"
MAX_AGE_S = 24 * 3600
CACHE_FILE = Path(os.environ.get("PRICING_CACHE_FILE", "/tmp/compass-live-pricing.json"))
MULTI = {"US": "us", "EU": "europe"}

# Billing services we read, by family (display names vary over time, so several candidates).
FAMILIES = {
    "bigquery": ["BigQuery", "BigQuery Reservation API", "BigQuery Storage API"],
    "datastream": ["Datastream"],
    "dataflow": ["Dataflow", "Cloud Dataflow"],
    "pubsub": ["Cloud Pub/Sub", "Pub/Sub"],
    "datafusion": ["Cloud Data Fusion"],
    "dataproc": ["Cloud Dataproc", "Dataproc", "Serverless for Apache Spark", "Managed Service for Apache Spark"],
    "composer": ["Cloud Composer"],
    "gcs": ["Cloud Storage"],
    "vertex": ["Vertex AI"],
    "apigee": ["Apigee"],
    "alloydb": ["AlloyDB", "AlloyDB for PostgreSQL"],
    "cloudsql": ["Cloud SQL"],
    "spanner": ["Cloud Spanner", "Spanner"],
    "bigtable": ["Cloud Bigtable", "Bigtable"],
    "firestore": ["Cloud Firestore", "Firestore"],
    "memorystore": ["Cloud Memorystore for Redis", "Memorystore for Redis", "Memorystore"],
    "dataplex": ["Cloud Dataplex", "Dataplex", "Knowledge Catalog"],
    "kms": ["Cloud Key Management Service (KMS)", "Cloud KMS", "Key Management Service"],
    "dlp": ["Cloud Data Loss Prevention", "Sensitive Data Protection"],
    "cloud_run": ["Cloud Run"],
    "workflows": ["Workflows", "Cloud Workflows"],
    "integration_connectors": ["Integration Connectors"],
    "sts": ["Storage Transfer Service"],
    "compute": ["Compute Engine"],
    "looker": ["Looker (Google Cloud core)", "Looker"],
    "discovery_engine": ["Gemini Enterprise", "Agentspace", "Vertex AI Search", "Discovery Engine"],
}
FAMILY_NAMES = {
    "bigquery": "BigQuery", "datastream": "Datastream", "dataflow": "Dataflow", "pubsub": "Pub/Sub",
    "datafusion": "Cloud Data Fusion", "dataproc": "Dataproc Serverless", "composer": "Cloud Composer",
    "gcs": "Cloud Storage", "vertex": "Vertex AI", "apigee": "Apigee", "alloydb": "AlloyDB", "cloudsql": "Cloud SQL",
    "spanner": "Spanner", "bigtable": "Bigtable", "firestore": "Firestore", "memorystore": "Memorystore",
    "dataplex": "Knowledge Catalog (Dataplex)", "kms": "Cloud KMS", "dlp": "Sensitive Data Protection",
    "cloud_run": "Cloud Run", "workflows": "Workflows", "integration_connectors": "Integration Connectors",
    "sts": "Storage Transfer Service", "compute": "Compute Engine", "looker": "Looker",
    "discovery_engine": "Gemini Enterprise",
}
# Available in every region at launch (cloud.google.com/about/locations) - used when there is no live data.
LAUNCH_BASELINE = {"gcs", "cloudsql", "kms", "compute"}

# Ingestion engines (recommender) and components -> family
ENGINE_FAMILY = {
    "datastream": "datastream", "dataflow_batch": "dataflow", "dataflow_stream": "dataflow", "pubsub": "pubsub",
    "pubsub_bqsub": "pubsub", "datafusion": "datafusion", "dataproc": "dataproc", "files_transfer": "sts",
    "dts_migration": "bigquery", "dts_free": "bigquery", "sap_connector": "bigquery", "cloud_run": "cloud_run",
    "app_integration": "integration_connectors", "mqtt_broker": "compute", "log_sink": "bigquery",
}
COMPONENT_FAMILY = {
    "looker": "looker", "agent_platform": "vertex", "vertex_gpu": "vertex", "gemini_enterprise": "discovery_engine",
    "bqml": "bigquery", "apigee": "apigee", "alloydb": "alloydb", "cloudsql": "cloudsql", "spanner": "spanner",
    "bigtable": "bigtable", "firestore": "firestore", "memorystore": "memorystore", "knowledge_catalog": "dataplex",
    "sdp": "dlp", "cmek": "kms",
}

# (pricing path, family, description regex, usageType or None, target unit)
PRICE_MAP = [
    (("bigquery", "ondemand_tib"), "bigquery", r"^Analysis\b", "OnDemand", "TiB"),
    (("bigquery", "storage_active_gib_month"), "bigquery", r"^Active Logical Storage", "OnDemand", "GiB.mo"),
    (("bigquery", "storage_longterm_gib_month"), "bigquery", r"^Long[- ]Term Logical Storage", "OnDemand", "GiB.mo"),
    (("bigquery", "storage_write_api_gib"), "bigquery", r"Storage Write API", "OnDemand", "GiB"),
    (("bigquery", "editions", "standard", "payg"), "bigquery", r"^(BigQuery )?Standard Edition\b(?!.*Commit)", "OnDemand", "h"),
    (("bigquery", "editions", "enterprise", "payg"), "bigquery", r"^(BigQuery )?Enterprise Edition\b(?!.*Commit)", "OnDemand", "h"),
    (("bigquery", "editions", "enterprise", "cud1"), "bigquery", r"^(BigQuery )?Enterprise Edition\b.*1 Year", None, "h"),
    (("bigquery", "editions", "enterprise", "cud3"), "bigquery", r"^(BigQuery )?Enterprise Edition\b.*3 Year", None, "h"),
    (("bigquery", "editions", "enterprise_plus", "payg"), "bigquery", r"^(BigQuery )?Enterprise Plus Edition\b(?!.*Commit)", "OnDemand", "h"),
    (("bigquery", "editions", "enterprise_plus", "cud1"), "bigquery", r"^(BigQuery )?Enterprise Plus Edition\b.*1 Year", None, "h"),
    (("bigquery", "editions", "enterprise_plus", "cud3"), "bigquery", r"^(BigQuery )?Enterprise Plus Edition\b.*3 Year", None, "h"),
    (("gcs", "standard_gib_month"), "gcs", r"^Standard Storage\b", "OnDemand", "GiB.mo"),
    (("gcs", "nearline_gib_month"), "gcs", r"^Nearline Storage\b", "OnDemand", "GiB.mo"),
    (("gcs", "coldline_gib_month"), "gcs", r"^Coldline Storage\b", "OnDemand", "GiB.mo"),
    (("gcs", "archive_gib_month"), "gcs", r"^Archive Storage\b", "OnDemand", "GiB.mo"),
    (("dataflow", "batch_vcpu_hr"), "dataflow", r"^vCPU Time Batch", "OnDemand", "h"),
    (("dataflow", "streaming_vcpu_hr"), "dataflow", r"^vCPU Time Streaming", "OnDemand", "h"),
    (("dataflow", "memory_gib_hr"), "dataflow", r"^RAM Time Batch", "OnDemand", "GiB.h"),
    (("dataflow", "streaming_engine_cu_hr"), "dataflow", r"Streaming Engine Compute Unit", "OnDemand", "h"),
    (("pubsub", "throughput_tib"), "pubsub", r"^Message Delivery Basic", "OnDemand", "TiB"),
    (("composer", "dcu_hr"), "composer", r"Composer \d.*(DCU|Data Compute Unit)|(DCU|Data Compute Unit).*Composer", "OnDemand", "h"),
    (("dataproc_serverless", "dcu_hr"), "dataproc", r"Serverless.*(DCU|Data Compute Unit)|(DCU|Data Compute Unit).*Serverless", "OnDemand", "h"),
    (("cloud_run", "vcpu_second"), "cloud_run", r"^CPU Allocation Time", "OnDemand", "s"),
    (("cloud_run", "gib_second"), "cloud_run", r"^Memory Allocation Time", "OnDemand", "GiB.s"),
]

_UNIT = {  # SKU usageUnit -> (dimension, multiplier to the canonical unit of that dimension)
    "TiBy": ("bytes", 1024.0), "GiBy": ("bytes", 1.0), "MiBy": ("bytes", 1 / 1024),
    "TiBy.mo": ("bytes.mo", 1024.0), "GiBy.mo": ("bytes.mo", 1.0), "GiBy.d": ("bytes.mo", 1 / 30.4167),
    "h": ("time", 1.0), "min": ("time", 1 / 60), "s": ("time", 1 / 3600),
    "GiBy.h": ("bytes.time", 1.0), "GiBy.s": ("bytes.time", 1 / 3600), "GiBy.min": ("bytes.time", 1 / 60),
}
_TARGET = {"TiB": ("bytes", 1024.0), "GiB": ("bytes", 1.0), "GiB.mo": ("bytes.mo", 1.0), "h": ("time", 1.0),
           "s": ("time", 1 / 3600), "GiB.h": ("bytes.time", 1.0), "GiB.s": ("bytes.time", 1 / 3600)}

_state = {"data": None, "refreshing": False, "last_error": None, "last_attempt": 0.0}
_lock = threading.Lock()
external_cache = {"get": None, "put": None}      # set by the app to share the result across instances (Firestore)


# --------------------------------------------------------------------------- fetching
def _auth():
    key = os.environ.get("BILLING_API_KEY", "").strip()
    if key:
        return {"key": key}, {}
    import google.auth
    import google.auth.transport.requests
    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    creds.refresh(google.auth.transport.requests.Request())
    return {}, {"Authorization": f"Bearer {creds.token}"}


def _paged(client, url, params, headers, field):
    out, token = [], None
    while True:
        p = dict(params, pageSize=5000, **({"pageToken": token} if token else {}))
        r = client.get(url, params=p, headers=headers, timeout=60)
        r.raise_for_status()
        j = r.json()
        out += j.get(field, [])
        token = j.get("nextPageToken")
        if not token:
            return out


def fetch_catalog() -> dict:
    """Download the services and SKUs we need. Returns {family: [sku, ...]}."""
    import httpx
    params, headers = _auth()
    with httpx.Client() as client:
        services = _paged(client, f"{API}/services", params, headers, "services")
        by_name = {s["displayName"].strip().lower(): s for s in services}
        skus = {}
        for fam, names in FAMILIES.items():
            for n in names:
                svc = by_name.get(n.lower())
                if svc:
                    skus.setdefault(fam, []).extend(_paged(client, f"{API}/{svc['name']}/skus", params, headers, "skus"))
    return skus


# --------------------------------------------------------------------------- parsing
def _unit_price(sku):
    try:
        pe = sku["pricingInfo"][0]["pricingExpression"]
    except (KeyError, IndexError):
        return None, None
    for t in pe.get("tieredRates") or []:
        up = t.get("unitPrice") or {}
        v = float(up.get("units") or 0) + float(up.get("nanos") or 0) / 1e9
        if v > 0:
            return v, pe.get("usageUnit")
    return None, pe.get("usageUnit")


def _convert(price, usage_unit, target):
    src, dst = _UNIT.get(usage_unit), _TARGET.get(target)
    if not src or not dst or src[0] != dst[0]:
        return None
    return price / src[1] * dst[1]


def _region_code(rid):
    return MULTI.get(rid, rid)


def parse(skus: dict, region_ids: list[str]) -> dict:
    """Turn raw SKUs into base prices, per-region prices and availability."""
    base, regional, matched, unmatched = {}, {r: {} for r in region_ids}, [], []
    for path, fam, rx, usage, target in PRICE_MAP:
        pat = re.compile(rx, re.I)
        cands = [s for s in skus.get(fam, []) if pat.search(s.get("description", ""))
                 and (usage is None or (s.get("category") or {}).get("usageType") == usage)]
        found = False
        for rid in [BASE_REGION] + [r for r in region_ids if r != BASE_REGION]:
            code = _region_code(rid)
            here = [s for s in cands if code in (s.get("serviceRegions") or [])]
            if not here:
                continue
            here.sort(key=lambda s: len(s.get("description", "")))
            price, unit = _unit_price(here[0])
            v = _convert(price, unit, target) if price else None
            if v is None:
                continue
            if rid == BASE_REGION:
                base["/".join(path)] = v
                found = True
            regional[rid]["/".join(path)] = v
        (matched if found else unmatched).append("/".join(path))
    avail = {}
    for fam in FAMILIES:
        lst = skus.get(fam)
        if not lst:
            continue
        regions = set()
        for s in lst:
            regions.update(s.get("serviceRegions") or [])
        avail[fam] = {r: ("global" in regions or _region_code(r) in regions) for r in region_ids}
    return {"fetched_at": time.time(), "base": base, "regional": regional, "availability": avail,
            "matched": matched, "unmatched": unmatched}


# --------------------------------------------------------------------------- applying
def _get(d, path):
    for k in path:
        d = d[k]
    return d


def _set(d, path, v):
    for k in path[:-1]:
        d = d[k]
    d[path[-1]] = v


def apply_pricing(static: dict, live: dict | None) -> dict:
    """Static pricing.json with accepted live us-central1 prices."""
    if not live:
        return static
    out = deepcopy(static)
    accepted = []
    for key, v in live.get("base", {}).items():
        path = key.split("/")
        try:
            old = float(_get(out, path))
        except (KeyError, TypeError, ValueError):
            continue
        if old > 0 and 1 / 3 <= v / old <= 3:
            _set(out, path, round(v, 8))
            accepted.append(key)
    out["_meta"] = {**out.get("_meta", {}), "live": True, "live_fetched_at": live.get("fetched_at"),
                    "live_accepted": accepted}
    return out


def apply_regions(regions: list[dict], live: dict | None) -> list[dict]:
    """Regions with per-service uplift from live prices and an availability map."""
    out = []
    for r in regions:
        r = dict(r)
        if live:
            reg = live.get("regional", {}).get(r["id"], {})
            base = live.get("base", {})
            by_sec = {}
            for key, v in reg.items():
                b = base.get(key)
                if b:
                    by_sec.setdefault(key.split("/")[0], []).append(v / b)
            r["uplift_by_service"] = {sec: round(statistics.median(vals), 4) for sec, vals in by_sec.items()
                                      if 0.5 <= statistics.median(vals) <= 3}
        out.append(r)
    return out


def availability(family: str, region: str, live: dict | None):
    """True / False / None (unknown)."""
    # Launch-baseline services exist in every Google Cloud region. The Billing Catalog
    # often lags new regions in serviceRegions (e.g. Cloud KMS in me-central2), so a
    # missing SKU there is not evidence the service is unavailable.
    if family in LAUNCH_BASELINE:
        return True
    if live and family in (live.get("availability") or {}):
        v = live["availability"][family].get(region)
        if v is not None:
            return v
    if region in MULTI:
        return True
    return None


# --------------------------------------------------------------------------- cache + background refresh
def current() -> dict | None:
    d = _state["data"]
    if d is None and CACHE_FILE.exists():
        try:
            d = json.loads(CACHE_FILE.read_text())
            _state["data"] = d
        except (OSError, ValueError):
            d = None
    return d


def _store(d):
    _state["data"] = d
    try:
        CACHE_FILE.write_text(json.dumps(d))
    except OSError:
        pass
    if external_cache["put"]:
        try:
            external_cache["put"](d)
        except Exception as e:  # noqa: BLE001 - cache is best effort
            log.warning("pricing cache write failed: %s", e)


def refresh(region_ids: list[str]) -> dict:
    """Fetch now (blocking). Raises on failure."""
    d = parse(fetch_catalog(), region_ids)
    if not d["base"] and not d["availability"]:
        raise RuntimeError("Cloud Billing Catalog returned no usable SKUs")
    _store(d)
    return d


def ensure_fresh(region_ids: list[str], background=True):
    """Refresh when older than a day (in a background thread by default)."""
    if os.environ.get("LIVE_PRICING", "auto") == "off":
        return
    d = current()
    if d is None and external_cache["get"]:
        try:
            d = external_cache["get"]()
            if d:
                _state["data"] = d
        except Exception as e:  # noqa: BLE001
            log.warning("pricing cache read failed: %s", e)
    fresh = d and time.time() - float(d.get("fetched_at") or 0) < MAX_AGE_S
    if fresh or _state["refreshing"] or time.time() - _state["last_attempt"] < 900:
        return

    def run():
        with _lock:
            _state["refreshing"], _state["last_attempt"] = True, time.time()
            try:
                refresh(region_ids)
                _state["last_error"] = None
                log.info("live pricing refreshed")
            except Exception as e:  # noqa: BLE001 - keep serving static prices
                _state["last_error"] = f"{type(e).__name__}: {e}"[:300]
                log.warning("live pricing refresh failed: %s", _state["last_error"])
            finally:
                _state["refreshing"] = False
    if background:
        threading.Thread(target=run, daemon=True).start()
    else:
        run()


def status() -> dict:
    d = current()
    return {
        "source": "live" if d else "static",
        "fetched_at": d.get("fetched_at") if d else None,
        "matched": d.get("matched", []) if d else [],
        "unmatched": d.get("unmatched", []) if d else [p for p, *_ in [("/".join(m[0]),) for m in PRICE_MAP]],
        "availability_services": sorted((d or {}).get("availability", {}).keys()),
        "refreshing": _state["refreshing"], "last_error": _state["last_error"],
        "mode": os.environ.get("LIVE_PRICING", "auto"),
    }
