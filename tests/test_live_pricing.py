"""Live price / availability layer, with a fake Cloud Billing Catalog."""
from app import live_pricing as LP


def sku(desc, regions, price, unit, usage="OnDemand"):
    units = int(price)
    return {"description": desc, "serviceRegions": regions, "category": {"usageType": usage},
            "pricingInfo": [{"pricingExpression": {"usageUnit": unit, "tieredRates": [
                {"startUsageAmount": 0, "unitPrice": {"units": "0", "nanos": 0}},
                {"startUsageAmount": 1, "unitPrice": {"units": str(units), "nanos": int(round((price - units) * 1e9))}}]}}]}


FAKE = {
    "bigquery": [
        sku("Analysis", ["us-central1"], 6.25, "TiBy"),
        sku("Analysis (Dammam)", ["me-central2"], 8.0, "TiBy"),
        sku("Active Logical Storage", ["us-central1"], 0.02, "GiBy.mo"),
        sku("Active Logical Storage Dammam", ["me-central2"], 0.026, "GiBy.mo"),
        sku("Enterprise Edition", ["us-central1"], 0.06, "h"),
        sku("Enterprise Edition - 1 Year Commit", ["us-central1"], 0.048, "h", "Commit1Yr"),
        sku("Long Term Logical Storage", ["us-central1"], 999.0, "GiBy.mo"),   # absurd: must be rejected
    ],
    "dataflow": [sku("vCPU Time Batch", ["us-central1", "me-central2"], 0.056, "h")],
    "gcs": [sku("Standard Storage US Regional", ["us-central1"], 0.02, "GiBy.mo")],
}


def test_parse_and_apply():
    regions = ["us-central1", "me-central2", "europe-west9"]
    d = LP.parse(FAKE, regions)
    assert abs(d["base"]["bigquery/ondemand_tib"] - 6.25) < 1e-9
    assert abs(d["base"]["bigquery/storage_active_gib_month"] - 0.02) < 1e-9
    assert "bigquery/editions/enterprise/cud1" in d["base"]
    assert d["availability"]["bigquery"] == {"us-central1": True, "me-central2": True, "europe-west9": False}
    assert d["availability"]["gcs"]["me-central2"] is False

    static = {"_meta": {}, "bigquery": {"ondemand_tib": 6.0, "storage_active_gib_month": 0.021, "storage_longterm_gib_month": 0.01,
                                        "editions": {"enterprise": {"payg": 0.06, "cud1": 0.05}}}}
    p = LP.apply_pricing(static, d)
    assert p["bigquery"]["ondemand_tib"] == 6.25
    assert p["bigquery"]["storage_longterm_gib_month"] == 0.01          # out of range -> static kept
    assert p["_meta"]["live"]

    r = LP.apply_regions([{"id": "me-central2", "uplift": 1.27}], d)[0]
    assert abs(r["uplift_by_service"]["bigquery"] - ((8 / 6.25 + 0.026 / 0.02) / 2)) < 1e-3


def test_availability_fallbacks():
    assert LP.availability("gcs", "me-central2", None) is True           # launch baseline
    assert LP.availability("datastream", "me-central2", None) is None     # unknown without live data
    live = {"availability": {"datastream": {"me-central2": False}}}
    assert LP.availability("datastream", "me-central2", live) is False


def test_estimate_flags_unavailable_service(monkeypatch):
    from app.estimator import estimate
    live = {"fetched_at": 1, "base": {}, "regional": {}, "availability": {"datastream": {"me-central2": False, "me-central1": True}}}
    monkeypatch.setattr(LP, "current", lambda: live)
    out = estimate({"region": "me-central2", "components": [],
                    "sources": [{"id": "s", "name": "Core", "type": "oracle", "frequency": "near_realtime", "daily_change_gb": 10}]})
    un = out["availability"]["unavailable"]
    assert un and un[0]["family"] == "datastream" and un[0]["alternatives"][0]["id"] == "me-central1"
