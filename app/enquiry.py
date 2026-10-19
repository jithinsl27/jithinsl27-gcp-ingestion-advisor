"""Customer technical enquiry: natural-language answers from Google's public documentation only.

The question goes to Gemini (Vertex AI) with Grounding with Google Search, steered to Google's
documentation sites. Only answers backed by at least one Google documentation page are returned;
every answer lists those pages as references. If no Google documentation supports an answer, the
user is told so instead of getting an ungrounded reply.
"""
from __future__ import annotations

import os
import re
import time
from collections import OrderedDict
from urllib.parse import urlparse

# Google public documentation hosts accepted as sources
GOOGLE_HOSTS = ("cloud.google.com", "docs.cloud.google.com", "ai.google.dev", "developers.google.com", "firebase.google.com",
                "support.google.com", "workspace.google.com", "looker.com", "docs.looker.com")

PROMPT = """You are a Google Cloud technical specialist answering a customer's question during a sales
engagement. Answer ONLY with facts from Google's official public documentation (cloud.google.com,
docs.cloud.google.com, ai.google.dev, developers.google.com, support.google.com and Looker docs).
Search those sites (for example with "site:cloud.google.com"). Do not use blogs, forums, vendors or
other websites. If the documentation does not answer the question, say exactly:
"I could not find this in Google's public documentation."
Write in clear natural language for a business or technical reader: a direct answer first, then the
key details as short bullet points (limits, prices, regions, prerequisites) where relevant. Keep it
under 250 words. Do not invent numbers.

Question: """

_cache: "OrderedDict[str, dict]" = OrderedDict()
NOT_FOUND = "I could not find this in Google's public documentation."


def _host_ok(host: str) -> bool:
    host = (host or "").lower().removeprefix("www.")
    return any(host == h or host.endswith("." + h) for h in GOOGLE_HOSTS)


def _resolve(uri: str) -> str:
    """Grounding links are redirect URLs - resolve them to the documentation page itself."""
    if not uri or "vertexaisearch.cloud.google.com/grounding-api-redirect" not in uri:
        return uri
    try:
        import httpx
        r = httpx.head(uri, follow_redirects=False, timeout=5)
        loc = r.headers.get("location")
        if loc:
            return loc
        r = httpx.get(uri, follow_redirects=True, timeout=8)
        return str(r.url)
    except Exception:  # noqa: BLE001 - keep the redirect link, it still opens the page
        return uri


def pretty_title(url: str, fallback: str = "") -> str:
    """'https://cloud.google.com/bigquery/docs/reservations-commitments' -> 'BigQuery · Reservations commitments'."""
    try:
        parts = [p for p in urlparse(url).path.split("/") if p and p not in ("docs", "doc", "en", "us", "guides", "concepts", "how-to")]
    except Exception:  # noqa: BLE001
        return fallback
    if not parts:
        return fallback or urlparse(url).netloc
    nice = {"bigquery": "BigQuery", "looker": "Looker", "apigee": "Apigee", "vertex-ai": "Vertex AI", "dataflow": "Dataflow",
            "datastream": "Datastream", "pubsub": "Pub/Sub", "storage": "Cloud Storage", "composer": "Cloud Composer",
            "dataplex": "Dataplex", "alloydb": "AlloyDB", "sql": "Cloud SQL", "spanner": "Spanner", "gemini": "Gemini",
            "gemini-enterprise": "Gemini Enterprise", "kms": "Cloud KMS", "vpc-service-controls": "VPC Service Controls"}
    product = nice.get(parts[0], parts[0].replace("-", " ").title())
    page = parts[-1].split("#")[0].replace("-", " ").replace("_", " ")
    return product if len(parts) == 1 else f"{product} · {page[:1].upper()}{page[1:]}"


def references_from(meta) -> list[dict]:
    """Google documentation pages from the grounding metadata (title is the site's domain)."""
    refs, seen = [], set()
    for ch in (getattr(meta, "grounding_chunks", None) or []):
        web = getattr(ch, "web", None)
        if not web or not getattr(web, "uri", None):
            continue
        title = (getattr(web, "title", "") or "").strip()
        domain = getattr(web, "domain", None) or title
        url = _resolve(web.uri)
        host = urlparse(url).netloc if url.startswith("http") and "grounding-api-redirect" not in url else domain
        if not _host_ok(host) and not _host_ok(domain):
            continue
        if url in seen:
            continue
        seen.add(url)
        real = url.startswith("http") and "grounding-api-redirect" not in url
        refs.append({"title": pretty_title(url, title) if real else (title or host), "url": url,
                     "host": (urlparse(url).netloc if real else domain or "").removeprefix("www.")})
    return refs


def clean_answer(text: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"\[\d+(?:,\s*\d+)*\]", "", text)          # stray numeric citation marks
    return text


def ask(question: str, email: str, history: list | None = None) -> dict:
    q = " ".join((question or "").split())[:1000]
    if len(q) < 3:
        raise ValueError("Type a question about Google Cloud.")
    key = q.lower()
    if key in _cache:
        hit = dict(_cache[key])
        hit["cached"] = True
        return hit
    if os.environ.get("ASSIST", "on") == "off":
        raise ValueError("Technical enquiry uses Gemini, which is turned off on this deployment.")
    try:
        from google import genai
        from google.genai import types
    except ImportError as e:
        raise ValueError("Technical enquiry needs Gemini (google-genai), which is not installed here.") from e
    client = genai.Client(vertexai=True, project=os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCP_PROJECT"),
                          location=os.environ.get("GEMINI_LOCATION", "global"))
    cfg = types.GenerateContentConfig(tools=[types.Tool(google_search=types.GoogleSearch())], temperature=0.1, max_output_tokens=2048)
    context = ""
    for h in (history or [])[-3:]:
        context += f"Earlier question: {str(h.get('q', ''))[:300]}\nEarlier answer: {str(h.get('a', ''))[:600]}\n"
    last = None
    t0 = time.time()
    for model in dict.fromkeys([os.environ.get("GEMINI_MODEL", "gemini-3.8-flash"), "gemini-2.5-flash"]):
        try:
            r = client.models.generate_content(model=model, contents=(context + PROMPT + q), config=cfg)
            cand = r.candidates[0] if r.candidates else None
            text = clean_answer(r.text or "")
            refs = references_from(getattr(cand, "grounding_metadata", None)) if cand else []
            found = bool(refs) and NOT_FOUND.lower() not in text.lower()
            out = {"question": q, "answer": text if found else NOT_FOUND, "references": refs if found else [],
                   "grounded": found, "model": model, "seconds": round(time.time() - t0, 1),
                   "searches": list(getattr(getattr(cand, "grounding_metadata", None), "web_search_queries", None) or [])}
            _cache[key] = out
            while len(_cache) > 300:
                _cache.popitem(last=False)
            return out
        except Exception as e:  # noqa: BLE001 - try the fallback model, then report
            last = e
    raise ValueError(f"Gemini could not answer: {type(last).__name__}: {str(last)[:200]}")
