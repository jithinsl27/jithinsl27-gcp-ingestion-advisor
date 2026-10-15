"""End-to-end checks of the main flows in a real browser."""
import re


def money(text):
    return float(re.sub(r"[^\d.]", "", text))


def test_sample_loads_with_figures_and_architecture(page):
    figs = page.locator("#summaryStrip .fig b").all_inner_texts()
    assert len(figs) == 3 and all(money(f) > 0 for f in figs)
    assert page.locator("#archSvg").count() == 1
    assert page.locator("#sourceList li").count() >= 3


def test_pricing_option_switch_changes_every_figure(page):
    payg = money(page.locator('#summaryStrip [data-drill="three"] b').inner_text())
    page.click('#summaryStrip [data-opt="cud3"]')
    cud3 = money(page.locator('#summaryStrip [data-drill="three"] b').inner_text())
    assert cud3 < payg
    assert "Saves" in page.locator("#summaryStrip").inner_text()
    page.reload()
    page.wait_for_selector("#summaryStrip .fig")
    assert page.get_attribute('#summaryStrip [data-opt="cud3"]', "aria-checked") == "true"


def test_drill_down_reconciles_with_headline(page):
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
    page.click('[data-tab="cost"]')
    assert "Nothing is priced yet" in page.inner_text("#costBody")
    # add one source -> figures appear
    page.click("#addSourceBtn")
    page.select_option("#f_type", "oracle")
    page.fill("#f_name", "Core banking")
    page.fill("#f_daily_change_gb", "50")
    page.click("#f_save")
    page.wait_for_selector("#summaryStrip .fig", timeout=10_000)
    assert money(page.locator('#summaryStrip [data-drill="year1"] b').inner_text()) > 0


def test_consumption_tab_shows_environment_sizing(page):
    page.click('[data-tab="cost"]')
    page.wait_for_selector("#envSizing")
    body = page.inner_text("#costBody")
    assert "How each environment is sized" in body and "Resulting specification" in body
    assert page.locator("[data-szi]").count() > 0


def test_workload_and_roadmap_tabs_render(page):
    page.click('[data-tab="workload"]')
    page.wait_for_selector("#wlForm")
    page.click('[data-tab="roadmap"]')
    page.wait_for_selector("#roadmapBody .rm-kpis", timeout=10_000)
