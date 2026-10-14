"""GCP Ingestion Advisor - FastAPI entry point.

Serves the single-page UI from /static and a small JSON API:
  GET  /api/catalog    pick-lists, tools, regions
  GET  /api/samples    example discovery scenarios
  POST /api/estimate   recommendations + 1/3-year ballpark
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
from .estimator import estimate, load_regions

APP_DIR = Path(__file__).parent
STATIC_DIR = APP_DIR / "static"
SAMPLES_DIR = APP_DIR.parent / "samples"
VERSION = os.environ.get("APP_VERSION", "1.0.0")

app = FastAPI(title="GCP Ingestion Advisor", version=VERSION,
              description="Discovery-phase advisor: GCP-native ETL/ELT recommendations and ballpark cost for BigQuery ingestion.")


class Source(BaseModel):
    id: str = Field(..., max_length=64)
    name: str = Field("", max_length=120)
    type: str
    data_type: Literal["structured", "semi_structured", "unstructured", "events"] = "structured"
    frequency: Literal["realtime", "near_realtime", "hourly", "daily", "weekly", "monthly", "one_time"] = "daily"
    location: Literal["on_prem", "gcp", "aws", "azure", "saas"] = "on_prem"
    transform: Literal["none", "light", "heavy"] = "none"
    initial_volume_gb: float = Field(0, ge=0, le=50_000_000)
    daily_change_gb: float = Field(0, ge=0, le=5_000_000)
    tables: Optional[int] = Field(None, ge=0)
    notes: str = Field("", max_length=2000)


class BIOpts(BaseModel):
    enabled: bool = True
    tool: Literal["looker", "looker_studio_pro", "looker_studio"] = "looker"
    users: int = Field(50, ge=0, le=1_000_000)
    looker_annual_usd: float = Field(0, ge=0, le=100_000_000)


class GeminiEnterpriseOpts(BaseModel):
    enabled: bool = True
    edition: Literal["business", "standard", "plus"] = "standard"
    users: int = Field(100, ge=0, le=1_000_000)


class AgentOpts(BaseModel):
    enabled: bool = True
    model: Literal["flash_lite", "flash", "pro"] = "flash"
    requests_month: float = Field(50_000, ge=0, le=10_000_000_000)
    input_tokens: float = Field(4000, ge=0, le=2_000_000)
    output_tokens: float = Field(800, ge=0, le=200_000)
    agent_seconds: float = Field(6, ge=0, le=3600)
    bq_gb_per_request: float = Field(0.2, ge=0, le=10_000)


class GPUOpts(BaseModel):
    enabled: bool = False
    gpu: Literal["l4", "a100", "h100", "cpu"] = "l4"
    replicas: int = Field(1, ge=0, le=1000)
    hours_per_day: float = Field(24, ge=0, le=24)


class GovernanceOpts(BaseModel):
    enabled: bool = True
    dq_share_pct: float = Field(20, ge=0, le=100)
    dq_scans_per_month: float = Field(30, ge=0, le=10_000)


class SecurityOpts(BaseModel):
    enabled: bool = True
    sdp_discovery: bool = True
    cmek: bool = True
    vpc_sc: bool = True


class PlatformOpts(BaseModel):
    bi: BIOpts = Field(default_factory=BIOpts)
    gemini_enterprise: GeminiEnterpriseOpts = Field(default_factory=GeminiEnterpriseOpts)
    agents: AgentOpts = Field(default_factory=AgentOpts)
    gpu: GPUOpts = Field(default_factory=GPUOpts)
    governance: GovernanceOpts = Field(default_factory=GovernanceOpts)
    security: SecurityOpts = Field(default_factory=SecurityOpts)


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
    sources: list[Source] = Field(default_factory=list, max_length=200)
    platform: PlatformOpts = Field(default_factory=PlatformOpts)


@app.get("/healthz")
def healthz():
    return {"status": "ok", "version": VERSION}


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


@app.post("/api/estimate")
def post_estimate(scenario: Scenario):
    unknown = [s.type for s in scenario.sources if s.type not in SOURCE_BY_ID]
    if unknown:
        raise HTTPException(status_code=422, detail=f"Unknown source type(s): {', '.join(unknown)}")
    regions = {r["id"] for r in load_regions()}
    if scenario.region not in regions:
        raise HTTPException(status_code=422, detail=f"Unknown region: {scenario.region}")
    return JSONResponse(estimate(scenario.model_dump()))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")
