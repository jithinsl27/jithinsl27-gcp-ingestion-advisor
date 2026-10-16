"""End-to-end checks of the main flows in a real browser."""
import re

from conftest import goto, pricing_detail


def money(text):
    return float(re.sub(r"[^\d.]", "", text))


def test_sample_loads_with_figures_and_architecture(page):
    figs = page.locator("#summaryStrip .fig b").all_inner_texts()
    assert len(figs) == 3 and all(money(f) > 0 for f in figs)
    assert page.locator("#archSvg").count() == 1
    assert page.locator("#sourceList li").count() >= 3


def test_pricing_option_switch_changes_every_figure(page):
    pricing_detail(page)
    payg = money(page.locator('#summaryStrip [data-drill="three"] b').inner_text())
    page.click('#summaryStrip [data-opt="cud3"]')
    cud3 = money(page.locator('#summaryStrip [data-drill="three"] b').inner_text())
    assert cud3 < payg
    assert "Saves" in page.locator("#summaryStrip").inner_text()
    page.reload()
    page.wait_for_selector("#summaryStrip .fig", state="attached")
    assert page.get_attribute('#summaryStrip [data-opt="cud3"]', "aria-checked") == "true"


def test_drill_down_reconciles_with_headline(page):
    pricing_detail(page)
    headline = money(page.locator('#summaryStrip [data-drill="year1"] b').inner_text())
    page.click('#summaryStrip [data-drill="year1"]')
    foot = page.locator("#drillBody tfoot td").nth(1).inner_text()
    assert abs(money(foot) - headline) <= 1.5
    assert page.locator("#drillBody tbody tr").count() > 5
    page.click("#drillClose")


def test_new_scenario_is_empty_until_something_is_added(page):
    page.click("#exportBtn")
    page.click('[data-export="reset"]')
    page.wait_for_function("document.querySelector('#summaryStrip').innerText.includes('No consumption yet')")
    pricing_detail(page)
    assert "Nothing is priced yet" in page.inner_text("#costBody")
    # add one source -> figures appear
    goto(page, "sources")
    page.click("#addSourceBtn")
    page.select_option("#f_type", "oracle")
    page.select_option("#f_target", "data_platform")
    page.fill("#f_name", "Core banking")
    page.fill("#f_daily_change_gb", "50")
    page.click("#f_save")
    page.wait_for_selector("#summaryStrip .fig", state="attached", timeout=10_000)
    assert money(page.locator('#summaryStrip [data-drill="year1"] b').inner_text()) > 0


def test_consumption_tab_shows_environment_sizing(page):
    pricing_detail(page)
    page.wait_for_selector("#envSizing")
    body = page.inner_text("#costBody")
    assert "How each environment is sized" in body and "Resulting specification" in body
    assert page.locator("[data-szi]").count() > 0


def test_workload_and_roadmap_tabs_render(page):
    page.click('[data-tab="workload"]')
    page.wait_for_selector("#wlForm")
    page.click('[data-tab="roadmap"]')
    page.wait_for_selector("#roadmapBody .rm-kpis", timeout=10_000)


def test_modules_overview_and_pricing_plans(page):
    page.wait_for_selector("#overviewBody .plan-card", timeout=15_000)
    assert page.locator("#overviewBody .ov-card").count() >= 8
    page.click('#overviewBody [data-plan="commit_3y"]')
    page.wait_for_selector("#pricingBody .plan-detail")
    assert "3-year commitment" in page.inner_text("#pricingBody .plan-head")
    assert page.locator("#pricingBody .year-tiles > div").count() == 3
    page.click('#pricingBody [data-pmode="qty"]')
    assert page.locator("#pricingBody .matrix tbody tr").count() > 5
    page.click('#pricingBody [data-plan="payg_1y"]')
    assert "Pay as you go - 1 year" in page.inner_text("#pricingBody .plan-head")


def test_custom_source_with_target(page):
    goto(page, "sources")
    n = page.locator("#sourceList li").count()
    page.click("#addSourceBtn")
    page.select_option("#f_type", "custom")
    page.fill("#f_custom_name", "Workday HCM")
    page.select_option("#f_like_type", "saas_other")
    page.select_option("#f_target", "data_lake")
    page.click("#f_save")
    page.wait_for_function(f"document.querySelectorAll('#sourceList li').length === {n + 1}")
    page.wait_for_function("document.querySelector('#sourceList').innerText.includes('Data lake')")
    goto(page, "arch")
    page.wait_for_function("document.querySelector('#archSvg').textContent.includes('Cloud Storage data lake')")


def test_proposal_is_at_most_15_pages(page):
    page.wait_for_selector("#overviewBody .plan-card", timeout=15_000)
    goto(page, "proposal")
    page.wait_for_selector("#ppPages .pp-page", timeout=15_000)
    assert page.locator("#ppPages .pp-page").count() <= 15
    page.uncheck('[data-pp-sec="monthly"]')
    page.wait_for_timeout(600)
    assert "14 pages" in page.inner_text("#ppCount")
