"""Build the static, serverless demo of Data Cloud Compass.

Outputs (in demo/dist/):
  index.html     standalone page (GitHub Pages, any static host, or open locally)
  artifact.html  same page without the document wrapper, for sandboxed hosts
                 that cannot download files (exports become copy-to-clipboard)

The demo uses demo/engine.js (a port of the Python engine) with data generated
here from app/, so prices, regions, catalog and samples stay single-sourced.

    python demo/build_demo.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.catalog import catalog_payload  # noqa: E402
from app.estimator import ASSUMPTIONS, CDC_CATEGORIES, load_pricing, load_regions  # noqa: E402
from app.workload import DEFAULT_WORKLOAD, WORKLOAD_ASSUMPTIONS  # noqa: E402

STATIC = ROOT / "app" / "static"
DIST = Path(__file__).parent / "dist"


def data_payload() -> dict:
    regions = load_regions()
    samples = []
    for p in sorted((ROOT / "samples").glob("*.json")):
        d = json.loads(p.read_text())
        samples.append({"file": p.name, "title": d.get("customer") or p.stem, "scenario": d})
    return {
        "catalog": catalog_payload(regions),
        "pricing": load_pricing(),
        "regions": regions,
        "assumptions": ASSUMPTIONS,
        "cdc_categories": sorted(CDC_CATEGORIES),
        "default_workload": DEFAULT_WORKLOAD,
        "workload_assumptions": WORKLOAD_ASSUMPTIONS,
        "samples": samples,
    }


def safe_script(js: str) -> str:
    return js.replace("</script", "<\\/script")


def build():
    DIST.mkdir(exist_ok=True)
    html = (STATIC / "index.html").read_text()
    css = (STATIC / "styles.css").read_text()
    app_js = (STATIC / "app.js").read_text()
    engine_js = (Path(__file__).parent / "engine.js").read_text()
    data_js = "window.ADVISOR_DATA = " + json.dumps(data_payload(), separators=(",", ":")) + ";"

    head_extra = '<meta name="claude:viewport-fit-sides" content="cover">'
    banner = ('<div class="demo-banner">Data Cloud Compass demo - runs entirely in your browser. '
              'Deploy your own copy to Google Cloud in a few clicks - see the project README.</div>')

    def page(no_download: bool) -> str:
        flags = "window.ADVISOR_NO_DOWNLOAD = true;" if no_download else ""
        scripts = (f"<script>{safe_script(data_js)}</script>\n"
                   f"<script>{safe_script(flags + engine_js)}</script>\n"
                   f"<script>{safe_script(app_js)}</script>")
        out = html.replace('<link rel="stylesheet" href="/static/styles.css">', f"<style>{css}\n.demo-banner{{background:var(--blue-soft);color:var(--ink);font-size:13px;padding:6px max(16px, env(safe-area-inset-left, 0px));text-align:center}}</style>")
        out = out.replace('<script src="/static/app.js"></script>', scripts)
        out = out.replace("<body>", "<body>\n  " + banner, 1)
        return out

    full = page(no_download=False)
    (DIST / "index.html").write_text(full)

    art = page(no_download=True)
    # strip the document wrapper: keep <title>, metas/links/style and body content
    head = re.search(r"<head>(.*?)</head>", art, re.S).group(1)
    head = re.sub(r'<meta charset="utf-8">\s*', "", head)
    head = re.sub(r'<meta name="viewport"[^>]*>\s*', "", head)
    title = re.search(r"<title>.*?</title>", head, re.S).group(0)
    head = head.replace(title, "")
    body = re.search(r"<body>(.*)</body>", art, re.S).group(1)
    (DIST / "artifact.html").write_text(f"{title}\n{head_extra}\n{head.strip()}\n{body.strip()}\n")
    print(f"Built {DIST / 'index.html'} and {DIST / 'artifact.html'}")


if __name__ == "__main__":
    build()
