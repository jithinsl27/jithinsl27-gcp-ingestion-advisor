"""Data Cloud Compass - FastAPI entry point.

Serves the single-page UI from /static and a small JSON API:
  GET  /api/catalog    pick-lists, tools, regions
  GET  /api/samples    example discovery scenarios
  POST /api/estimate   recommendations + 1/3-year ballpark
  POST /api/plan       month-by-month ramp-up plan with ramped consumption
  POST /api/workload   workload-based sizing (pipelines, queries, dashboards, data volumes)
  GET  /api/config     front-end settings (sign-in client ID, storage, AI assist, live prices)
  GET  /api/pricing/status   live price / availability refresh status
  POST /api/compare    estimates for two or more scenarios side by side
  GET  /healthz        liveness probe for Cloud Run

Signed-in (Google ID token, see app/auth.py):
  GET  /api/me                              who is signed in
  GET/POST /api/scenarios                   list / create saved scenarios
  GET/PUT/DELETE /api/scenarios/{id}        open / save a new version / delete
  GET  /api/scenarios/{id}/versions[/{n}]   version history
  POST /api/scenarios/{id}/share            share with people or by link
  POST /api/assist/notes, /api/assist/file  AI assist (Gemini) and spreadsheet import
  POST /api/pricing/refresh                 refresh live prices now
"""
from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import assist as AS
from . import auth
from . import live_pricing as LP
from .catalog import SOURCE_BY_ID, catalog_payload
from .components import COMPONENT_BY_ID
from .estimator import estimate, load_regions, load_static_regions
from .store import get_store
from .plan import build_plan
from .workload import workload_estimate

APP_DIR = Path(__file__).parent
STATIC_DIR = APP_DIR / "static"
SAMPLES_DIR = APP_DIR.parent / "samples"
VERSION = os.environ.get("APP_VERSION", "1.0.0")

def _region_ids():
    return [r["id"] for r in load_static_regions()]


@asynccontextmanager
async def lifespan(_app):
    store = get_store()
    LP.external_cache["get"] = lambda: store.kv_get("pricing")
    LP.external_cache["put"] = lambda d: store.kv_put("pricing", d)
    mode = os.environ.get("LIVE_PRICING", "auto")
    if mode == "on" or (mode == "auto" and os.environ.get("K_SERVICE")):
        LP.ensure_fresh(_region_ids())          # background thread; static prices until it succeeds
    yield


app = FastAPI(title="Data Cloud Compass", version=VERSION, lifespan=lifespan,
              description="From discovery to blueprint on Google Cloud: ingestion patterns, BI/AI/API/database integrations, "
                          "per-region consumption estimates, workload sizing and ramp-up roadmap.")

# The public demo (GitHub Pages) calls this service directly. Bearer tokens, no cookies.
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "https://jithinsl27.github.io").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET", "POST", "PUT", "DELETE"],
                   allow_headers=["Authorization", "Content-Type"], max_age=3600)


@app.middleware("http")
async def _daily_refresh(request: Request, call_next):
    if os.environ.get("K_SERVICE") and os.environ.get("LIVE_PRICING", "auto") != "off" and request.url.path == "/api/estimate":
        LP.ensure_fresh(_region_ids())          # no-op unless the cached prices are older than a day
    return await call_next(request)


class Source(BaseModel):
    id: str = Field(..., max_length=64)
    name: str = Field("", max_length=120)
    type: str
    data_type: Literal["structured", "semi_structured", "unstructured", "events"] = "structured"
    frequency: Literal["realtime", "near_realtime", "hourly", "daily", "weekly", "monthly", "one_time"] = "daily"
    location: Literal["on_prem", "gcp", "aws", "azure", "saas"] = "on_prem"
    transform: Literal["none", "light", "heavy"] = "none"
    initial_volume_gb: float = Field(0, ge=0, le=2e12)     # up to ~2 ZB (inputs accept KB ... ZB, stored in GB)
    daily_change_gb: float = Field(0, ge=0, le=2e12)
    tables: Optional[int] = Field(None, ge=0)
    notes: str = Field("", max_length=2000)
    region: Optional[str] = None             # processing region for this source (defaults to scenario region)
    included: bool = True                    # False = kept in the scenario but left out of this phase's estimate
    start_month: Optional[int] = Field(None, ge=1, le=36)
    iot_option: Optional[Literal["native", "mqtt_broker", "litmus", "clearblade", "mde"]] = None
    target: Literal["data_platform", "data_lake", "operational_db"] = "data_platform"
    custom_name: str = Field("", max_length=120)         # product name when type == "custom"
    like_type: Optional[str] = Field(None, max_length=40)  # catalogued type the custom source behaves like


class Environment(BaseModel):
    id: str = Field(..., max_length=40)
    name: str = Field("", max_length=60)
    preset: Optional[str] = Field(None, max_length=20)
    included: bool = True
    data_pct: Optional[float] = Field(None, ge=0, le=1000)
    ingestion_pct: Optional[float] = Field(None, ge=0, le=1000)
    compute_pct: Optional[float] = Field(None, ge=0, le=1000)
    ai_pct: Optional[float] = Field(None, ge=0, le=1000)
    apps_pct: Optional[float] = Field(None, ge=0, le=1000)
    platform_pct: Optional[float] = Field(None, ge=0, le=1000)
    runtime_pct: Optional[float] = Field(None, ge=0, le=100)
    bq_slots: Optional[float] = Field(None, ge=0, le=100_000)       # legacy: flat slots
    bq_baseline: Optional[float] = Field(None, ge=0, le=100_000)
    bq_max: Optional[float] = Field(None, ge=0, le=100_000)


class BigQueryShape(BaseModel):
    batch_window_hours: Optional[float] = Field(None, ge=1, le=24)
    business_hours: Optional[float] = Field(None, ge=1, le=24)
    peak_concurrency: Optional[float] = Field(None, ge=1, le=20)
    heavy_target_minutes: Optional[float] = Field(None, ge=1, le=1440)


class BigQuerySettings(BaseModel):
    mode: Literal["ondemand", "editions"] = "ondemand"
    edition: Literal["auto", "standard", "enterprise", "enterprise_plus"] = "auto"
    baseline_slots: Optional[float] = Field(None, ge=0, le=100_000)
    max_slots: Optional[float] = Field(None, ge=0, le=100_000)
    scan_basis: Literal["auto", "heuristic", "workload", "measured"] = "auto"
    elt_scan_multiplier: Optional[float] = Field(None, ge=0, le=100)
    analytics_scan_multiplier: Optional[float] = Field(None, ge=0, le=100)
    slot_hours_per_tib: Optional[float] = Field(None, gt=0, le=10_000)
    measured_scan_tib_month: Optional[float] = Field(None, ge=0, le=10_000_000)
    measured_slot_hours_month: Optional[float] = Field(None, ge=0, le=1e10)
    shape: Optional[BigQueryShape] = None


class Commercial(BaseModel):
    discount_pct: float = Field(0, ge=0, le=90)
    support_plan: Literal["none", "standard", "enhanced", "premium"] = "none"
    range_low_pct: float = Field(-25, ge=-90, le=0)
    range_high_pct: float = Field(30, ge=0, le=300)


class Lakehouse(BaseModel):
    raw_zone: bool = True
    raw_scope: Literal["batch", "all"] = "batch"
    raw_retention_months: int = Field(3, ge=1, le=120)
    raw_storage_class: Literal["standard", "nearline", "coldline", "archive"] = "standard"
    silver_pct: float = Field(30, ge=0, le=500)
    gold_pct: float = Field(20, ge=0, le=500)


class SecurityOpts(BaseModel):
    enabled: bool = True
    sdp_discovery: bool = True
    cmek: bool = True
    vpc_sc: bool = True


class Component(BaseModel):
    id: str = Field(..., max_length=64)
    type: str
    start_month: Optional[int] = Field(None, ge=1, le=36)
    included: bool = True                    # False = drawn in the architecture but not priced
    settings: dict[str, float | int | str | bool | None] = Field(default_factory=dict, max_length=20)


class QueryLine(BaseModel):
    count: float = Field(0, ge=0, le=1_000_000)
    frequency: Literal["hourly", "daily", "weekly", "monthly", "quarterly", "yearly"] = "daily"
    gb: float = Field(1, ge=0, le=2e12)


class WorkloadData(BaseModel):
    structured_tb: float = Field(20, ge=0, le=2e9)
    semi_structured_tb: float = Field(10, ge=0, le=2e9)
    unstructured_tb: float = Field(20, ge=0, le=2e9)
    annual_growth_pct: float = Field(20, ge=-50, le=500)
    tables: float = Field(500, ge=0, le=10_000_000)


class WorkloadTelemetry(BaseModel):
    volume_gb: float = Field(100, ge=0, le=2e12)
    per: Literal["day", "month"] = "day"
    transform: bool = False
    retention_months: int = Field(13, ge=1, le=120)


class WorkloadPipelines(BaseModel):
    simple: float = Field(50, ge=0, le=100_000)
    medium: float = Field(30, ge=0, le=100_000)
    complex: float = Field(20, ge=0, le=100_000)
    runs_per_day: float = Field(1, ge=0, le=1440)
    engine: Literal["elt", "etl"] = "elt"


class WorkloadDashboards(BaseModel):
    count: float = Field(25, ge=0, le=1_000_000)
    refreshes_per_day: float = Field(12, ge=0, le=1440)
    queries_per_refresh: float = Field(8, ge=0, le=1000)
    gb_per_query: float = Field(0.5, ge=0, le=2e12)
    cache_pct: float = Field(60, ge=0, le=100)


class WorkloadRamp(BaseModel):
    months: int = Field(2, ge=0, le=24)
    data_gb: float = Field(110, ge=0, le=2e12)
    pipelines: float = Field(5, ge=0, le=100_000)
    reports: float = Field(1, ge=0, le=100_000)


class WorkloadSlots(BaseModel):
    batch_window_hours: float = Field(6, ge=1, le=24)
    business_hours: float = Field(10, ge=1, le=24)
    peak_concurrency: float = Field(1.5, ge=1, le=20)
    heavy_target_minutes: float = Field(30, ge=1, le=1440)
    edition: Literal["auto", "standard", "enterprise", "enterprise_plus"] = "auto"


class Workload(BaseModel):
    data_region: Optional[str] = None
    pipelines_region: Optional[str] = None
    streaming_region: Optional[str] = None
    bq_model: Literal["ondemand", "standard", "enterprise", "enterprise_plus"] = "ondemand"
    data: WorkloadData = Field(default_factory=WorkloadData)
    telemetry: WorkloadTelemetry = Field(default_factory=WorkloadTelemetry)
    pipelines: WorkloadPipelines = Field(default_factory=WorkloadPipelines)
    queries: dict[Literal["simple", "complex", "heavy", "adhoc"], QueryLine] = Field(default_factory=dict)
    dashboards: WorkloadDashboards = Field(default_factory=WorkloadDashboards)
    ramp: WorkloadRamp = Field(default_factory=WorkloadRamp)
    slot_hours_per_tib: float = Field(60, gt=0, le=10_000)
    contingency_pct: float = Field(10, ge=0, le=100)
    include_components: bool = False
    slots: Optional[WorkloadSlots] = None


class Scenario(BaseModel):
    customer: str = Field("", max_length=120)
    region: str = "us-central1"
    skill: Literal["sql", "low_code", "code", "spark"] = "sql"
    orchestration: Literal["auto", "composer", "workflows", "none"] = "auto"
    environment: Literal["poc", "production", "production_ha"] = "production"
    bq_model: Literal["ondemand", "standard", "enterprise", "enterprise_plus"] = "ondemand"
    bq_slots: Optional[float] = Field(None, ge=0, le=100_000)       # legacy: flat slots, see `bq`
    bq: Optional[BigQuerySettings] = None
    commercial: Optional[Commercial] = None
    pricing_option: Literal["payg", "cud1", "cud3"] = "payg"
    analytics_tib_month: Optional[float] = Field(None, ge=0, le=1_000_000)
    annual_growth_pct: float = Field(20, ge=-50, le=500)
    contingency_pct: float = Field(10, ge=0, le=100)
    processing_region: Optional[str] = None
    sources: list[Source] = Field(default_factory=list, max_length=200)
    components: Optional[list[Component]] = Field(None, max_length=60)
    security: Optional[SecurityOpts] = None
    platform: Optional[dict] = None          # legacy fixed layer, converted to components
    workload: Optional[Workload] = None
    plan: Optional[dict[str, int]] = None    # {"teams": 2}
    excluded_services: list[str] = Field(default_factory=list, max_length=100)  # service lines left out of pricing
    environments: Optional[list[Environment]] = Field(None, max_length=12)
    lakehouse: Optional[Lakehouse] = None


@app.get("/healthz")
def healthz():
    return {"status": "ok", "version": VERSION}


@app.get("/api/config")
def get_config():
    """Front-end settings. GOOGLE_OAUTH_CLIENT_ID enables 'Create in my Google Drive' for Sheets / Slides exports."""
    st = LP.status()
    return {"google_client_id": auth.client_id(), "auth": auth.enabled(), "store": get_store().kind,
            "assist": os.environ.get("ASSIST", "on") != "off" and auth.enabled(), "version": VERSION,
            "pricing": {"source": st["source"], "fetched_at": st["fetched_at"]},
            "feedback_url": os.environ.get("FEEDBACK_URL", "")}


@app.get("/api/pricing/status")
def pricing_status():
    return LP.status()


@app.post("/api/pricing/refresh")
def pricing_refresh(user: dict = Depends(auth.current_user)):
    try:
        LP.refresh(_region_ids())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Could not refresh prices: {type(e).__name__}: {str(e)[:300]}") from e
    return LP.status()


@app.get("/api/catalog")
def get_catalog():
    return catalog_payload(load_regions())


@app.get("/api/samples")
def get_samples():
    out = []
    for p in sorted(SAMPLES_DIR.glob("*.json")):
        with open(p) as f:
            data = json.load(f)
        out.append({"file": p.name, "title": data.get("customer") or p.stem, "scenario": data})
    return out


def _validate(scenario: Scenario):
    unknown = [s.type for s in scenario.sources if s.type not in SOURCE_BY_ID]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown source type(s): {', '.join(unknown)}")
    regions = {r["id"] for r in load_regions()}
    used = [scenario.region, scenario.processing_region] + [s.region for s in scenario.sources]
    used += [str(c.settings.get("region")) for c in (scenario.components or []) if c.settings.get("region")]
    if scenario.workload:
        used += [scenario.workload.data_region, scenario.workload.pipelines_region, scenario.workload.streaming_region]
    bad = [r for r in used if r and r not in regions]
    if bad:
        raise HTTPException(status_code=422, detail=f"Unknown region: {', '.join(sorted(set(bad)))}")
    bad_c = [c.type for c in (scenario.components or []) if c.type not in COMPONENT_BY_ID]
    if bad_c:
        raise HTTPException(status_code=422, detail=f"Unknown component(s): {', '.join(bad_c)}")


@app.post("/api/estimate")
def post_estimate(scenario: Scenario):
    _validate(scenario)
    return JSONResponse(estimate(scenario.model_dump(exclude_none=True)))


@app.post("/api/plan")
def post_plan(scenario: Scenario):
    _validate(scenario)
    return JSONResponse(build_plan(scenario.model_dump(exclude_none=True)))


@app.post("/api/workload")
def post_workload(scenario: Scenario):
    _validate(scenario)
    return JSONResponse(workload_estimate(scenario.model_dump(exclude_none=True)))


class CompareRequest(BaseModel):
    scenarios: list[Scenario] = Field(..., min_length=2, max_length=4)
    labels: list[str] = Field(default_factory=list, max_length=4)


@app.post("/api/compare")
def post_compare(req: CompareRequest):
    out = []
    for i, sc in enumerate(req.scenarios):
        _validate(sc)
        e = estimate(sc.model_dump(exclude_none=True))
        out.append({"label": req.labels[i] if i < len(req.labels) else f"Option {chr(65 + i)}",
                    "by_option": {k: {"totals": v["totals"], "by_group": v["by_group"], "by_service": v["by_service"]}
                                  for k, v in e["by_option"].items()},
                    "environments": e["environments"], "bigquery": e["bigquery"], "region": e["region"],
                    "recommendations": e["recommendations"], "availability": e["availability"]})
    return out


# --------------------------------------------------------------------------- signed-in features
def _summary(sc: dict) -> dict:
    try:
        e = estimate(sc)
        opt = sc.get("pricing_option") or "payg"
        t = e["by_option"][opt]["totals"]
        return {"year1": t["year1"], "three_year": t["three_year"], "pricing_option": opt,
                "sources": len(sc.get("sources") or []), "region": sc.get("region")}
    except Exception:  # noqa: BLE001 - a summary must never block saving
        return {}


class SaveRequest(BaseModel):
    scenario: Scenario
    title: str = Field("", max_length=120)
    note: str = Field("", max_length=500)
    base_version: Optional[int] = None


class ShareRequest(BaseModel):
    viewers: list[str] = Field(default_factory=list, max_length=100)
    editors: list[str] = Field(default_factory=list, max_length=100)
    link_access: Literal["none", "view", "edit"] = "none"


def _emails(xs):
    out = []
    for x in xs:
        x = x.strip().lower()
        if x and "@" in x and x not in out:
            out.append(x)
    return out


@app.get("/api/me")
def me(user: dict = Depends(auth.current_user)):
    return {**user, "store": get_store().kind}


@app.get("/api/scenarios")
def list_scenarios(user: dict = Depends(auth.current_user)):
    return get_store().list_for(user["email"])


@app.post("/api/scenarios")
def create_scenario(req: SaveRequest, user: dict = Depends(auth.current_user)):
    _validate(req.scenario)
    sc = req.scenario.model_dump(exclude_none=True)
    return get_store().create(user["email"], req.title, sc, _summary(sc), req.note)


@app.get("/api/scenarios/{sid}")
def get_scenario(sid: str, user: dict = Depends(auth.current_user)):
    return get_store().get(user["email"], sid)


@app.put("/api/scenarios/{sid}")
def save_scenario(sid: str, req: SaveRequest, user: dict = Depends(auth.current_user)):
    _validate(req.scenario)
    sc = req.scenario.model_dump(exclude_none=True)
    return get_store().save(user["email"], sid, sc, _summary(sc), req.note, req.title or None, req.base_version)


@app.delete("/api/scenarios/{sid}")
def delete_scenario(sid: str, user: dict = Depends(auth.current_user)):
    get_store().delete(user["email"], sid)
    return {"deleted": sid}


@app.get("/api/scenarios/{sid}/versions")
def scenario_versions(sid: str, user: dict = Depends(auth.current_user)):
    return get_store().list_versions(user["email"], sid)


@app.get("/api/scenarios/{sid}/versions/{version}")
def scenario_version(sid: str, version: int, user: dict = Depends(auth.current_user)):
    return get_store().get_version(user["email"], sid, version)


@app.post("/api/scenarios/{sid}/share")
def share_scenario(sid: str, req: ShareRequest, user: dict = Depends(auth.current_user)):
    return get_store().share(user["email"], sid, _emails(req.viewers), _emails(req.editors), req.link_access)


class NotesRequest(BaseModel):
    text: str = Field(..., min_length=10, max_length=60_000)


@app.post("/api/assist/notes")
def assist_notes(req: NotesRequest, user: dict = Depends(auth.current_user)):
    return AS.gemini(req.text, user["email"])


@app.post("/api/assist/file")
async def assist_file(request: Request, file: UploadFile = File(...)):
    """Template spreadsheets are imported without sign-in; anything else goes to Gemini (signed in)."""
    data = await file.read(5_000_001)
    if len(data) > 5_000_000:
        raise HTTPException(status_code=413, detail="File is larger than 5 MB")
    rows = AS.read_table(file.filename or "upload.csv", data)
    direct = AS.from_template(rows)
    if direct and direct["sources"]:
        return direct
    user = auth.current_user(request.headers.get("authorization", ""))
    return AS.gemini(AS.table_as_text(rows), user["email"])


@app.get("/api/assist/template.csv")
def assist_template():
    return PlainTextResponse(AS.template_csv(), media_type="text/csv",
                             headers={"Content-Disposition": 'attachment; filename="compass-source-inventory.csv"'})


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
