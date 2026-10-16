"""Browser tests: start the app on a free port and drive it with Playwright (Chromium)."""
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
pw = pytest.importorskip("playwright.sync_api")


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


DEMO_PORT = _free_port()


@pytest.fixture(scope="session")
def base_url():
    port = _free_port()
    env = {**os.environ, "LIVE_PRICING": "off", "AUTH_DEV_USER": "architect@example.com", "STORE": "memory", "ASSIST": "off",
           "CORS_ORIGINS": f"http://127.0.0.1:{DEMO_PORT}"}
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port)], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{port}"
    import httpx
    for _ in range(100):
        try:
            if httpx.get(url + "/healthz", timeout=0.5).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.1)
    yield url
    proc.terminate()


@pytest.fixture(scope="session")
def browser():
    with pw.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"Chromium not available: {e}")
        yield b
        b.close()


@pytest.fixture()
def page(browser, base_url):
    ctx = browser.new_context(viewport={"width": 1440, "height": 950})
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(base_url + "/")
    pg.wait_for_selector("#summaryStrip .fig", state="attached", timeout=10_000)
    yield pg
    ctx.close()
    assert not errors, errors


def goto(page, tab):
    """Open a module from the left-hand menu."""
    page.click(f'.modnav [data-tab="{tab}"]')


def pricing_detail(page):
    """Pricing module -> Detailed breakdown (headline figures, drill-down, consumption tables)."""
    goto(page, "pricing")
    page.click('[data-pview="detail"]')
    page.wait_for_selector("#summaryStrip .fig, #summaryStrip .empty-sum")


@pytest.fixture(scope="session")
def demo_url(base_url, tmp_path_factory):
    """The GitHub Pages build, served from another origin and calling the API (CORS)."""
    sys.path.insert(0, str(ROOT))
    from demo.build_demo import build
    build(api_url=base_url)
    proc = subprocess.Popen([sys.executable, "-m", "http.server", str(DEMO_PORT), "--bind", "127.0.0.1"],
                            cwd=ROOT / "demo" / "dist", stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    time.sleep(0.8)
    yield f"http://127.0.0.1:{DEMO_PORT}"
    proc.terminate()
