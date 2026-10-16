"""Charge-back: what a department's request costs on the organisation's negotiated Google Cloud prices.

1. The finance / data office downloads a price-sheet template (every service line the tool prices, its
   unit and list price), types in the negotiated unit prices and uploads it back - the *price book*.
2. A department asks for something: data sources to ingest, pipelines, reports and AI use cases.
   The request is turned into a small scenario on the shared platform and priced with the same engine,
   with the negotiated unit prices applied. Shared platform items (network links, support plan) are
   left out - they are paid centrally - unless the request asks for them.
3. The result lists the services, quantity per month, unit, negotiated unit price and monthly cost;
   saved requests build a charge-back ledger per department.
"""
from __future__ import annotations

import csv
import io
import secrets
import time

from .estimator import estimate

SOURCE_KINDS = {
    "database_cdc": {"type": "postgresql", "frequency": "near_realtime", "label": "Databases - change data capture"},
    "database_batch": {"type": "other_jdbc", "frequency": "daily", "label": "Databases - daily batch"},
    "files": {"type": "gcs", "frequency": "daily", "label": "Files (landed in Cloud Storage)"},
    "saas": {"type": "salesforce", "frequency": "daily", "label": "SaaS applications"},
    "streaming": {"type": "kafka", "frequency": "realtime", "label": "Event streams"},
    "documents": {"type": "documents", "frequency": "daily", "label": "Documents (for AI)"},
}
SHARED_SERVICES = ["Network (HA VPN)", "Network (Interconnect)", "Contingency & operations", "Cloud KMS (CMEK)",
                   "Sensitive Data Protection (discovery)"]
BI_TOOLS = ("looker_studio_pro", "looker", "existing")


def request_scenario(req: dict, region: str) -> dict:
    """Turn a department request into a scenario on the shared platform."""
    sources = []
    for i, s in enumerate(req.get("sources") or []):
        kind = SOURCE_KINDS.get(s.get("kind"))
        n = max(0, int(s.get("count") or 0))
        if not kind or not n:
            continue
        daily = float(s.get("daily_gb") or 0) / n
        hist = float(s.get("history_gb") or 0) / n
        for j in range(n):
            sources.append({"id": f"r{i}_{j}", "name": f"{kind['label']} {j + 1}", "type": kind["type"], "frequency": kind["frequency"],
                            "location": "gcp" if kind["type"] in ("gcs",) else "saas" if kind["type"] == "salesforce" else "on_prem",
                            "data_type": "unstructured" if s.get("kind") == "documents" else "events" if s.get("kind") == "streaming" else "structured",
                            "initial_volume_gb": hist, "daily_change_gb": daily})
    p = req.get("pipelines") or {}
    rep = req.get("reports") or {}
    ai = req.get("ai") or {}
    comps = []
    users = int(rep.get("users") or 0)
    bi = rep.get("bi_tool") or "looker_studio_pro"
    if bi == "looker_studio_pro" and users:
        comps.append({"id": "bi", "type": "looker_studio_pro", "settings": {"users": users}})
    elif bi == "looker" and users:
        comps.append({"id": "bi", "type": "looker", "settings": {"users": users, "annual_quote_usd": float(rep.get("looker_annual_usd") or 0)}})
    n_ai = int(ai.get("use_cases") or 0)
    if n_ai:
        comps.append({"id": "ai", "type": "agent_platform", "settings": {
            "model": ai.get("model") or "flash", "requests_month": n_ai * float(ai.get("requests_per_month") or 5000),
            "input_tokens": float(ai.get("input_tokens") or 4000), "output_tokens": float(ai.get("output_tokens") or 800),
            "agent_seconds": 6, "bq_gb_per_request": 0.2}})
        comps.append({"id": "bqml", "type": "bqml", "settings": {}})
    dashboards = int(rep.get("dashboards") or 0)
    workload = {
        "data": {"structured_tb": 0, "semi_structured_tb": 0, "unstructured_tb": 0, "tables": 0},
        "telemetry": {"volume_gb": 0},
        "pipelines": {"simple": int(p.get("simple") or 0), "medium": int(p.get("medium") or 0), "complex": int(p.get("complex") or 0),
                      "runs_per_day": float(p.get("runs_per_day") or 1), "engine": "elt"},
        "queries": {k: {"count": 0} for k in ("simple", "complex", "heavy", "adhoc")},
        "dashboards": {"count": dashboards, "refreshes_per_day": float(rep.get("refreshes_per_day") or 8),
                       "queries_per_refresh": 8, "gb_per_query": float(rep.get("gb_per_query") or 0.5), "cache_pct": 60},
        "ramp": {"months": 0},
    }
    adhoc = int(rep.get("adhoc_reports") or 0)
    if adhoc:
        workload["queries"]["adhoc"] = {"count": adhoc, "frequency": "weekly", "gb": 20}
    envs = [{"id": "prod", "name": "Production", "preset": "prod"}]
    if req.get("with_dev"):
        envs.append({"id": "dev", "name": "Development", "preset": "dev"})
    use_workload = bool(dashboards or adhoc or any(int(p.get(k) or 0) for k in ("simple", "medium", "complex")))
    return {
        "customer": req.get("department") or "Department", "region": region,
        "sources": sources, "components": comps, "environments": envs, "workload": workload,
        "bq": {"mode": req.get("bq_mode") or "ondemand", "edition": "auto", "scan_basis": "workload" if use_workload else "auto"},
        "contingency_pct": 0, "annual_growth_pct": float(req.get("growth_pct") or 20),
        "excluded_services": [] if req.get("include_shared") else SHARED_SERVICES,
        "orchestration": "workflows", "security": {}, "plan": {},
    }


def price_request(req: dict, book: dict | None) -> dict:
    book = book or {}
    region = req.get("region") or book.get("region") or "us-central1"
    sc = request_scenario(req, region)
    list_est = estimate(sc)
    units = {r["service"]: r["unit"] for r in list_est["bom"]}
    negotiated = {i["service"]: float(i["price"]) for i in book.get("items", [])
                  if i.get("price") not in (None, "") and i["service"] in units and (not i.get("unit") or i["unit"] == units[i["service"]])}
    est = estimate({**sc, "price_book": negotiated}) if negotiated else list_est
    list_rows = {(r["environment"], r["service"]): r for r in list_est["bom"]}
    lines = []
    for r in est["bom"]:
        lr = list_rows.get((r["environment"], r["service"]), {})
        lines.append({"environment": r["environment_name"], "service": r["service"], "group": r["group"], "unit": r["unit"],
                      "qty_month": r["qty_month12"], "unit_price": r["unit_price"], "list_unit_price": lr.get("unit_price"),
                      "negotiated": r["service"] in negotiated, "monthly": r["month12"], "list_monthly": lr.get("month12"),
                      "year1": r["year1"], "region": r.get("region") or region})
    lines.sort(key=lambda x: -x["monthly"])
    monthly = round(sum(x["monthly"] for x in lines), 2)
    list_monthly = round(sum((x["list_monthly"] or 0) for x in lines), 2)
    return {
        "request": req, "region": region, "lines": lines,
        "totals": {"monthly": monthly, "list_monthly": list_monthly, "saving_monthly": round(list_monthly - monthly, 2),
                   "year1": round(sum(x["year1"] for x in lines), 2)},
        "assumptions": [
            "Month 12 of the request (data at its first-year size) is shown as the steady monthly charge.",
            "Shared platform items (network links, encryption keys, data discovery, contingency) are paid centrally and excluded" if not req.get("include_shared") else "Shared platform items are included",
            f"BigQuery compute {'on-demand per TiB scanned' if (req.get('bq_mode') or 'ondemand') == 'ondemand' else 'from the shared slot reservation (slot-hours)'}.",
            f"{len(negotiated)} negotiated unit prices applied from the price book" if negotiated else "No price book uploaded - Google list prices are used.",
        ],
        "price_book_used": bool(negotiated),
    }


def template_rows(region: str) -> list[dict]:
    """Every service line a request can produce, with its unit and list price (for the price-sheet template)."""
    ref = {"department": "Reference", "with_dev": True, "bq_mode": "ondemand",
           "sources": [{"kind": k, "count": 1, "daily_gb": 10, "history_gb": 500} for k in SOURCE_KINDS],
           "pipelines": {"simple": 10, "medium": 5, "complex": 2}, "reports": {"dashboards": 5, "users": 50, "bi_tool": "looker_studio_pro", "adhoc_reports": 5},
           "ai": {"use_cases": 2}}
    rows = {}
    for mode in ("ondemand", "editions"):
        est = estimate(request_scenario({**ref, "bq_mode": mode}, region))
        for r in est["bom"]:
            if (r["service"], r["unit"]) in rows or not r["unit"]:
                continue
            rows[(r["service"], r["unit"])] = {"service": r["service"], "group": r["group"], "unit": r["unit"], "list_price": r["unit_price"]}
    return sorted(rows.values(), key=lambda r: (r["group"], r["service"]))


def template_csv(rows):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Service", "Group", "Unit", "List price (USD per unit)", "Negotiated price (USD per unit)"])
    for r in rows:
        w.writerow([r["service"], r["group"], r["unit"], r["list_price"], ""])
    return buf.getvalue()


def parse_price_sheet(rows: list[list]) -> list[dict]:
    """Rows from the uploaded CSV / XLSX (header row first) -> [{service, unit, list_price, price}]."""
    if not rows:
        return []
    hi = next((i for i, r in enumerate(rows[:15]) if any(str(c or "").strip().lower().startswith("service") for c in r)), 0)
    rows = rows[hi:]
    head = [str(h or "").strip().lower() for h in rows[0]]

    def col(*names):
        for n in names:
            for i, h in enumerate(head):
                if h.startswith(n):
                    return i
        return None
    ci, ui, li, pi = col("service"), col("unit"), col("list"), col("negotiated", "price", "your")
    if ci is None or pi is None:
        raise ValueError("The sheet needs a 'Service' column and a 'Negotiated price' column - download the template.")
    out = []
    for r in rows[1:]:
        if ci >= len(r) or not str(r[ci] or "").strip():
            continue
        raw = r[pi] if pi < len(r) else None
        try:
            price = float(str(raw).replace(",", "").replace("$", "").strip()) if raw not in (None, "") else None
        except ValueError:
            price = None
        lp = None
        if li is not None and li < len(r) and r[li] not in (None, ""):
            try:
                lp = float(str(r[li]).replace(",", "").replace("$", ""))
            except ValueError:
                lp = None
        out.append({"service": str(r[ci]).strip(), "unit": str(r[ui]).strip() if ui is not None and ui < len(r) and r[ui] else "",
                    "list_price": lp, "price": price})
    return out


def new_record(req, result, who):
    return {"id": secrets.token_urlsafe(8), "created_at": time.time(), "created_by": who,
            "department": req.get("department") or "", "title": req.get("title") or "", "kind": req.get("kind") or "",
            "request": req, "totals": result["totals"], "lines": result["lines"], "region": result["region"]}


# ---------------------------------------------------------------- reading price sheets in any format
SHEET_TYPES = (".csv", ".tsv", ".txt", ".xlsx", ".xlsm")
DOC_TYPES = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
             ".webp": "image/webp", ".gif": "image/gif", ".tif": "image/tiff", ".tiff": "image/tiff"}


def match_services(items: list[dict], known: list[dict]) -> list[dict]:
    """Map the names in a customer's sheet to the tool's service lines (exact, then closest match)."""
    import difflib
    names = [k["service"] for k in known]
    by_key = {(k["service"], k["unit"]): k for k in known}
    lower = {n.lower(): n for n in names}
    out = []
    for it in items:
        raw = str(it.get("service") or "").strip()
        svc = lower.get(raw.lower())
        how = "exact" if svc else None
        if not svc:
            close = difflib.get_close_matches(raw.lower(), list(lower), n=1, cutoff=0.55)
            if close:
                svc, how = lower[close[0]], "closest"
        unit = it.get("unit") or ""
        cands = [k for k in known if k["service"] == svc]
        if svc and len(cands) > 1:
            cand = next((k for k in cands if unit and k["unit"].lower() == unit.lower()), None) or cands[0]
        else:
            cand = cands[0] if cands else None
        out.append({"source_name": raw, "service": svc, "unit": cand["unit"] if cand else unit,
                    "list_price": cand["list_price"] if cand else it.get("list_price"), "price": it.get("price"),
                    "match": how or "none"})
    for k in known:          # services the sheet does not mention: list price stays
        if not any(o["service"] == k["service"] and o["unit"] == k["unit"] for o in out):
            out.append({"source_name": "", "service": k["service"], "unit": k["unit"], "list_price": k["list_price"],
                        "price": None, "match": "not in sheet"})
    _ = by_key
    return out


def google_sheet_rows(url: str) -> list[list]:
    """Read a Google Sheet shared as 'Anyone with the link can view' (first tab, or the gid in the link)."""
    import re
    import httpx
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", url or "")
    if not m:
        raise ValueError("Paste the link of a Google Sheet (https://docs.google.com/spreadsheets/d/...)")
    gid = re.search(r"[#&?]gid=(\d+)", url)
    export = f"https://docs.google.com/spreadsheets/d/{m.group(1)}/export?format=csv" + (f"&gid={gid.group(1)}" if gid else "")
    r = httpx.get(export, follow_redirects=True, timeout=20)
    if r.status_code != 200 or "text/csv" not in r.headers.get("content-type", ""):
        raise ValueError("Could not read the sheet. Share it as 'Anyone with the link can view', or download it as Excel and upload the file.")
    return list(csv.reader(io.StringIO(r.content.decode("utf-8-sig", errors="replace"))))[:2000]


PRICE_PROMPT = """This document is a Google Cloud price quote, order form or negotiated price sheet.
Extract every priced line: the product / service / SKU name, its unit, the list price per unit if shown, and the
negotiated (discounted, contracted) price per unit. If only a discount % is shown, compute the negotiated price
from the list price. Map each line to the closest service in this list when it clearly is the same product
(otherwise leave matched_service empty):
"""


def gemini_price_rows(data: bytes, mime: str, known: list[dict]) -> list[dict]:
    """Read a PDF or a scanned / photographed price sheet with Gemini (OCR + table understanding)."""
    import os
    try:
        from google import genai
        from google.genai import types
    except ImportError as e:
        raise ValueError("Reading PDFs and images needs the AI assist (google-genai), which is not installed here.") from e
    if os.environ.get("ASSIST", "on") == "off":
        raise ValueError("Reading PDFs and images uses Gemini, which is turned off on this deployment - upload Excel or CSV instead.")
    names = sorted({k["service"] for k in known})
    schema = {"type": "OBJECT", "properties": {"items": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "service": {"type": "STRING"}, "matched_service": {"type": "STRING"}, "unit": {"type": "STRING"},
        "list_price": {"type": "NUMBER"}, "negotiated_price": {"type": "NUMBER"}}, "required": ["service"]}}}, "required": ["items"]}
    client = genai.Client(vertexai=True, project=os.environ.get("GOOGLE_CLOUD_PROJECT"), location=os.environ.get("GEMINI_LOCATION", "global"))
    cfg = types.GenerateContentConfig(response_mime_type="application/json", response_schema=schema, temperature=0.0, max_output_tokens=8192)
    last = None
    import json
    for model in dict.fromkeys([os.environ.get("GEMINI_MODEL", "gemini-3.8-flash"), "gemini-2.5-flash"]):
        try:
            r = client.models.generate_content(model=model, config=cfg, contents=[
                types.Part.from_bytes(data=data, mime_type=mime), PRICE_PROMPT + "\n".join(names)])
            items = json.loads(r.text).get("items") or []
            return [{"service": (i.get("matched_service") if i.get("matched_service") in names else i.get("service")) or "",
                     "unit": i.get("unit") or "", "list_price": i.get("list_price"), "price": i.get("negotiated_price")}
                    for i in items]
        except Exception as e:  # noqa: BLE001
            last = e
    raise ValueError(f"Gemini could not read the document: {type(last).__name__}: {str(last)[:200]}")


def read_price_file(filename: str, data: bytes, known: list[dict], read_table) -> dict:
    import os
    ext = os.path.splitext((filename or "").lower())[1]
    if ext in SHEET_TYPES:
        items, method = parse_price_sheet(read_table(filename, data)), "spreadsheet"
    elif ext in DOC_TYPES:
        try:
            items, method = gemini_price_rows(data, DOC_TYPES[ext], known), "gemini"
        except ValueError:
            text = pdf_text(data) if ext == ".pdf" else ""
            if not text.strip():
                raise
            items, method = match_text(text, known), "pdf_text"
    else:
        raise ValueError("Upload Excel (.xlsx), CSV, PDF or an image (PNG / JPG / TIFF) of the price sheet, or paste a Google Sheets link.")
    return {"items": match_services(items, known), "method": method, "file": filename}


# ---------------------------------------------------------------- fallbacks when Gemini is not available
def _num(x):
    import re
    m = re.search(r"-?\d[\d,]*\.?\d*", str(x or "").replace(" ", ""))
    try:
        return float(m.group(0).replace(",", "")) if m else None
    except ValueError:
        return None


def pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader
        return "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(data)).pages[:60])
    except Exception:  # noqa: BLE001 - scanned or unusual PDFs have no text layer
        return ""


def match_text(text: str, known: list[dict]) -> list[dict]:
    """Find each known service on a line of text and take the last number after its name as the price."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    out = []
    for k in known:
        name = k["service"].lower()
        for ln in lines:
            if name in ln.lower():
                rest = ln.lower().split(name, 1)[1].replace("$", " ")
                nums = [n for n in (_num(t) for t in rest.split()) if n is not None]
                if nums:
                    out.append({"service": k["service"], "unit": k["unit"], "list_price": k["list_price"], "price": nums[-1]})
                    break
    return out
