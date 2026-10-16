"""Browser tests for BigQuery slots, commercial terms, saved scenarios, compare and discovery."""
import re

from conftest import goto, pricing_detail
from test_ui import money


def wait_estimate(page):
    """The estimate is debounced (250 ms) - wait for the request it fires, then for rendering."""
    page.wait_for_timeout(450)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(100)


def test_bigquery_editions_slots_auto_and_editable(page):
    goto(page, "settings")
    page.click('[data-bq-mode="editions"]')
    page.wait_for_selector('#bqPanel [data-slot-i="0"][data-slot-k="max"]')
    wait_estimate(page)
    inp = page.locator('#bqPanel [data-slot-i="0"][data-slot-k="max"]')
    auto = inp.get_attribute("placeholder")
    assert auto and auto.isdigit() and int(auto) >= 50                     # auto-sized
    y1 = money(page.locator('#summaryStrip [data-drill="year1"] b').inner_text())
    inp.fill("2000")
    inp.press("Tab")
    wait_estimate(page)
    assert page.locator('#bqPanel [data-slot-i="0"][data-slot-k="max"]').input_value() == "2000"
    page.select_option("#bqEdition", "standard")
    wait_estimate(page)
    for _ in range(25):                     # the plan request (pricing plans) can finish after the estimate
        y1b = money(page.locator('#summaryStrip [data-drill="year1"] b').inner_text())
        if y1b != y1:
            break
        page.wait_for_timeout(200)
    assert y1b != y1
    # dialog: edition comparison and calibration
    page.click("[data-bq-open]")
    page.wait_for_selector("#bqBody .cmp-table")
    assert "Enterprise Plus" in page.inner_text("#bqBody") and "Standard" in page.inner_text("#bqBody")
    page.click("#bqDialog [data-close]")
    page.click("[data-bq-reset]")
    wait_estimate(page)
    assert page.locator('#bqPanel [data-slot-i="0"][data-slot-k="max"]').input_value() == ""


def test_commercial_discount_lowers_totals(page):
    before = money(page.locator('#summaryStrip [data-drill="year1"] b').inner_text())
    goto(page, "settings")
    page.fill("#cm_discount_pct", "20")
    page.press("#cm_discount_pct", "Tab")
    wait_estimate(page)
    after = money(page.locator('#summaryStrip [data-drill="year1"] b').inner_text())
    assert after < before * 0.85


def test_save_version_history_and_share(page):
    page.wait_for_selector("#userChip")                                        # dev sign-in
    page.click("#scenariosBtn")
    page.click('[data-sc="save"]')
    page.wait_for_function("document.querySelector('#saveStatus').innerText.includes('v1')")
    page.fill("#customer", "Bank - option B")
    page.keyboard.press("Control+s")
    page.wait_for_function("document.querySelector('#saveStatus').innerText.includes('v2')")
    page.click("#scenariosBtn")
    page.click('[data-sc="history"]')
    page.wait_for_selector("#scBody [data-view]")
    assert page.locator("#scBody tbody tr").count() == 2
    page.click("#scDialog [data-close]")
    page.click("#scenariosBtn")
    page.click('[data-sc="share"]')
    page.fill("#shViewers", "colleague@example.com")
    page.click("#shareForm button[type=submit]")
    page.wait_for_function("!document.querySelector('#scDialog').open")
    assert "?s=" in page.url


def test_compare_current_with_on_demand(page):
    page.click("#scenariosBtn")
    page.click('[data-sc="compare"]')
    page.wait_for_selector("#cmpOut .compare", timeout=15_000)
    txt = page.inner_text("#cmpOut")
    assert "On-demand" in txt and "1-year commitment" in txt and "Year 1 by capability" in txt


def test_guided_discovery_builds_a_design(page):
    page.click("#discoverBtn")
    page.fill('[data-w="customer"]', "Acme Telco")
    page.click('[data-wnav="1"]')
    page.click('[data-add="oracle"]')
    page.click('[data-add="oracle"]')
    page.click('[data-add="kafka"]')
    page.click('[data-wnav="1"]')
    page.fill('[data-w="ge_users"]', "200")
    page.click('[data-wnav="1"]')
    page.click('[data-wnav="1"]')
    assert "Acme Telco" in page.inner_text("#discBody")
    page.click('[data-w-mode="replace"]')
    page.click('[data-wnav="1"]')
    page.wait_for_function("document.querySelectorAll('#sourceList li').length === 3")
    wait_estimate(page)
    assert page.input_value("#customer") == "Acme Telco"
    assert "Gemini Enterprise" in page.inner_text("#selectedPills")


def test_spreadsheet_template_import(page, tmp_path):
    f = tmp_path / "inventory.csv"
    f.write_text("name,type,frequency,daily_change_gb,initial_volume_gb,location\nPayments DB,sqlserver,near_realtime,30,2 TB,on_prem\n")
    page.click("#discoverBtn")
    page.click('[data-dtab="sheet"]')
    page.set_input_files("#sheetFile", str(f))
    page.wait_for_selector("#propApply")
    assert "Payments DB" in page.inner_text("#discBody")
    n = page.locator("#sourceList li").count()
    page.click("#propApply")
    page.wait_for_function(f"document.querySelectorAll('#sourceList li').length === {n + 1}")


def test_environment_runtime_factor_is_editable(page):
    pricing_detail(page)
    page.wait_for_selector('[data-szk="runtime_pct"]')
    assert re.search(r"Running hours", page.inner_text("#costBody"))
