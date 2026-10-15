"""Build the public demo of Data Cloud Compass for GitHub Pages.

There is one pricing engine - the Python service on Cloud Run. The demo is the
same front end (app/static) published as static files that call that service:

    COMPASS_API_URL=https://ingestion-advisor-xxxx.run.app python demo/build_demo.py

Outputs demo/dist/ (index.html + static/). The Cloud Run service must allow the
Pages origin (CORS_ORIGINS, default https://jithinsl27.github.io - set by deploy.sh).
Without COMPASS_API_URL the page explains how to connect it.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "app" / "static"
DIST = Path(__file__).parent / "dist"


def build(api_url: str | None = None) -> Path:
    api_url = (api_url if api_url is not None else os.environ.get("COMPASS_API_URL", "")).strip().rstrip("/")
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(STATIC, DIST / "static")
    html = (STATIC / "index.html").read_text()
    if api_url:
        banner = ('<div class="demo-banner">Data Cloud Compass demo - estimates come from the live service. '
                  '<a href="https://github.com/jithinsl27/jithinsl27-gcp-ingestion-advisor#deploy" target="_blank" rel="noopener">Deploy your own copy</a> in a few clicks.</div>')
        cfg = f"<script>window.COMPASS_API_BASE = {json.dumps(api_url)};</script>"
    else:
        banner = ('<div class="demo-banner warn">This demo is not connected to a Data Cloud Compass service yet. '
                  'Deploy to Cloud Run with <code>./deploy.sh</code>, then set the repository variable <code>COMPASS_API_URL</code> to the service URL.</div>')
        cfg = "<script>window.COMPASS_API_BASE = '';</script>"
    style = ("<style>.demo-banner{background:var(--blue-soft);color:var(--ink);font-size:13px;padding:6px 16px;text-align:center}"
             ".demo-banner.warn{background:#FEF7E0}</style>")
    html = html.replace("</head>", f"  {cfg}\n  {style}\n</head>", 1)
    html = html.replace("<body>", "<body>\n  " + banner, 1)
    (DIST / "index.html").write_text(html)
    (DIST / ".nojekyll").write_text("")
    return DIST / "index.html"


if __name__ == "__main__":
    print(f"Built {build()}")
