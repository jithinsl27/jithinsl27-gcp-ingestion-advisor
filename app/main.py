"""Data Cloud Compass - FastAPI entry point.

Serves the single-page UI from /static and a small JSON API:
  GET  /api/catalog    pick-lists, tools, regions
  GET  /api/samples    example discovery scenarios
  POST /api/estimate   recommendations + 1/3-year ballpark
  POST /api/plan       month-by-month ramp-up plan with ramped consumption
  POST /api/workload   workload-based sizing (pipelines, queries, dashboards, data volumes)
  GET  /api/config     front-end settings (optional Google OAuth client ID for Drive exports)
  GET  /healthz        liveness probe for Cloud Run
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .catalog import SOURCE_BY_ID, catalog_payload
from .components import COMPONENT_BY_ID
from .estimator import estimate, load_regions
from .plan import build_plan
from .workload import workload_estimate

APP_DIR = Path(__file__).parent
STATIC_DIR = APP_DIR / "static"
SAMPLES_DIR = APP_DIR.parent / "samples"
VERSION = os.environ.get("APP_VERSION", "1.0.0")

app = FastAPI(title="Data Cloud Compass", version=VERSION,
              description="From discovery to blueprint on Google Cloud: ingestion patterns, BI/AI/API/database integrations, "
                          "per-region consumption estimates, workload sizing and ramp-up roadmap.")


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
    bq_slots: Optional[float] = Field(None, ge=0, le=100_000)


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
    bq_slots: Optional[float] = Field(100, ge=0, le=100_000)
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
    return {"google_client_id": os.environ.get("GOOGLE_OAUTH_CLIENT_ID", ""), "feedback_url": os.environ.get("FEEDBACK_URL", "")}


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


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
