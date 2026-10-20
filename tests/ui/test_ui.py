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
    foot = page.locator("#drillBody tfoot td").nth(2).inner_text()   # 12-month column of the editable BOM
    assert abs(money(foot) - headline) <= 1.5
    assert page.locator("#drillBody tbody tr").count() > 5
    assert page.locator("#drillBody [data-bom-f='qty']").count() > 3     # quantities are editable
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
    page.wait_for_function("document.querySelector('#ppCount').textContent.includes('14 pages')", timeout=10_000)
    # commercial options: every year shows whole currency amounts (no stray decimals)
    import re
    page_txt = page.locator("#ppPages .pp-page:not(.cover)", has_text="Commercial options").first.inner_text()
    assert not re.search(r"\$[\d,]+\.\d", page_txt), page_txt[:400]


def test_kickoff_readiness_checklist_milestones_and_team(page):
    page.wait_for_selector("#overviewBody .plan-card", timeout=15_000)
    goto(page, "kickoff")
    page.wait_for_selector("#kickoffBody [data-kitem]", timeout=15_000)
    total = page.locator("#kickoffBody [data-kitem]").count()
    assert total > 20
    page.locator("#kickoffBody [data-kitem]").first.check()
    page.wait_for_function(f"document.querySelector('.modnav [data-badge=\"kickoff\"]').textContent === '1/{total}'", timeout=10_000)
    page.click('[data-kowner="Partner"]')
    assert 0 < page.locator("#kickoffBody [data-kitem]").count() < total
    page.click('[data-kview="milestones"]')
    assert "Landing zone ready" in page.inner_text("#kickoffBody .kick-ms")
    page.click('[data-kview="team"]')
    assert "Data engineer" in page.inner_text("#kickoffBody")
    assert "FTE" in page.inner_text("#kickoffBody .kick-kpis")
    # ticks survive a reload (saved with the scenario)
    page.reload()
    page.wait_for_selector("#summaryStrip .fig", state="attached", timeout=10_000)
    goto(page, "kickoff")
    page.wait_for_selector("#kickoffBody", timeout=15_000)
    page.wait_for_function("document.querySelector('.modnav [data-badge=\"kickoff\"]').textContent.startsWith('1/')", timeout=15_000)


def test_architecture_offers_recommended_controls_and_legend(page):
    goto(page, "arch")
    page.wait_for_selector("#archSvg .dg-legend")
    ghosts = page.locator("#archSvg [data-addcomp]")
    if ghosts.count():
        before = ghosts.count()
        ghosts.first.click()
        page.wait_for_function(f"document.querySelectorAll('#archSvg [data-addcomp]').length < {before}", timeout=10_000)
    assert "Platform foundation" in page.locator("#archSvg").text_content()
    # no label in the diagram is wider than its box
    over = page.evaluate("""() => [...document.querySelectorAll('#archSvg .dg-node')].filter(g => {
      const r = g.querySelector('rect'); if (!r) return false; const rb = r.getBBox();
      return [...g.querySelectorAll('text')].some(t => { const b = t.getBBox(); return b.x + b.width > rb.x + rb.width + 1; });
    }).length""")
    assert over == 0


def test_first_visit_asks_name_and_email(browser, base_url):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    pg = ctx.new_page()
    pg.goto(base_url + "/")
    pg.wait_for_selector("#idDialog[open]", timeout=10_000)
    pg.fill("#id_name", "Ada Lovelace")
    pg.fill("#id_email", "not-an-email")
    pg.click("#idForm button[type=submit]")
    assert "valid email" in pg.inner_text("#id_err")
    pg.fill("#id_email", "ada@example.com")
    pg.click("#idForm button[type=submit]")
    pg.wait_for_selector("#idDialog", state="hidden")
    assert pg.inner_text("#whoBtn") == "AL"
    ctx.close()


def test_pricing_plans_specs_and_editable_bom(page):
    page.wait_for_selector("#overviewBody .plan-card", timeout=15_000)
    goto(page, "pricing")
    page.wait_for_selector(".plan-cards.three .plan-card")
    assert page.locator(".plan-cards.three .plan-card").count() == 3
    page.click('#tab-pricing [data-plan="commit_3y"]')
    assert page.locator(".spec-card").count() >= 1
    before = money(page.locator("button.plan-total b").inner_text())
    page.click("button.plan-total")
    page.wait_for_selector("#drillBody [data-bom-f='qty']")
    inp = page.locator("#drillBody [data-bom-f='qty']").first
    inp.fill(str(float(inp.input_value()) * 3 + 100))
    page.click("[data-bom-apply]")
    page.wait_for_selector("#drillBody tr.edited", timeout=15_000)
    page.click("#drillClose")
    page.wait_for_function(f"(() => {{ const b = document.querySelector('button.plan-total b'); return b && parseFloat(b.textContent.replace(/[^0-9.]/g, '')) > {before}; }})()", timeout=15_000)


def test_bigquery_slots_by_year_in_product_monitor(page):
    goto(page, "monitor")
    page.click('.mon-sub [data-mon-sub="slots"]')
    page.wait_for_selector("#slotsBody .explain")
    assert page.locator('.modnav [data-tab="slots"]').count() == 0          # no separate menu item any more
    page.click('#slotsBody [data-bq-mode="editions"]')
    page.wait_for_selector("#slotsBody .slot-plan", timeout=15_000)
    assert "100 slots" in page.inner_text("#slotsBody .explain")
    # three year cards plus the 3-year total, and a Year 1-3 row per environment
    assert page.locator("#slotsBody .slot-years .sy").count() == 4
    assert page.locator("#slotsBody .slot-plan tbody tr").count() % 3 == 0
    page.click('#slotsBody [data-slot-opt="cud3"]')
    page.wait_for_selector("#slotsBody .slot-plan th:has-text('Top-up')")
    # every header explains itself on hover
    page.hover("#slotsBody .slot-plan thead th .tip >> nth=0")
    page.wait_for_selector("#tipbox:not([hidden])")
    assert "slot-hours" in page.inner_text("#tipbox")


def test_use_cases_recommend_and_add(page):
    goto(page, "usecases")
    page.wait_for_selector("#useCasesBody .uc-card")
    assert 1 <= page.locator("#useCasesBody .uc-card").count() <= 5
    page.locator("#useCasesBody [data-uc-toggle]").first.click()
    page.fill("#ucName", "Branch performance dashboard")
    page.click("#ucAdd button")
    assert page.locator("#useCasesBody .uc-list li").count() == 2
    assert page.inner_text('.modnav [data-badge="usecases"]') == "2"


def test_chargeback_prices_a_request(page):
    goto(page, "chargeback")
    page.wait_for_selector("#cbBody .cb-result", timeout=20_000)
    first = money(page.locator("#cbBody .cb-kpis b").first.inner_text())
    page.fill("[data-cb='reports.users']", "500")
    page.wait_for_function(f"parseFloat(document.querySelector('#cbBody .cb-kpis b').textContent.replace(/[^0-9.]/g, '')) > {first}", timeout=15_000)
    page.fill("[data-cb='department']", "Marketing")
    page.click("[data-cb-save]")
    page.wait_for_selector("#cbBody .cb-depts", timeout=15_000)
    assert "Marketing" in page.inner_text("#cbBody .cb-depts")


def test_usage_admin_page(page):
    goto(page, "usage")
    page.wait_for_selector("#usageBody table", timeout=15_000)      # open locally without an admin key
    assert "ui@example.com" in page.inner_text("#usageBody")


def test_product_monitor_four_products_draft_until_environments_finalised(page):
    goto(page, "monitor")
    page.wait_for_selector("#monitorBody .mon-card")
    assert page.locator("#monitorBody .mon-card h3").all_inner_texts() == ["BigQuery", "Looker", "Apigee", "Gemini Enterprise"]
    assert "draft" in page.inner_text("#monitorBody .mon-state").lower()
    # each used product shows year 1-3 cost and a 3-year total
    used = page.locator("#monitorBody .mon-card.on")
    assert used.count() >= 1 and used.first.locator(".mon-yrs .tot td").count() == 3
    # Looker without a quote asks for it, and the quote flows into the card
    if page.locator("#monitorBody [data-mon-quote]").count():
        page.fill("#monitorBody [data-mon-quote]", "120000")
        page.press("#monitorBody [data-mon-quote]", "Tab")
        page.wait_for_function("!document.querySelector('#monitorBody [data-mon-quote]')", timeout=15_000)
    # finalise the environments -> Final
    goto(page, "env")
    page.check("#envFinal")
    goto(page, "monitor")
    page.wait_for_function("document.querySelector('#monitorBody .mon-state').textContent.includes('Final')", timeout=15_000)
    off = page.locator('#monitorBody .mon-card.off [data-mon-add]')
    if off.count():
        before = page.locator("#monitorBody .mon-card.on").count()
        off.first.click()
        page.wait_for_function(f"document.querySelectorAll('#monitorBody .mon-card.on').length > {before}", timeout=15_000)


def test_data_flow_page_merges_ingestion_and_integrations(page):
    assert page.locator('.modnav [data-tab="platform"]').count() == 0
    goto(page, "recs")
    page.wait_for_selector("#recsBody *")
    assert page.locator("#tab-recs #platformBody").count() == 1
    assert "Integrations" in page.inner_text("#tab-recs")


def test_technical_enquiry_shows_answer_and_links(page):
    import json
    fake = {"question": "q", "answer": "Slots are units of compute.\n- Commitments cover baseline slots.", "grounded": True, "model": "gemini-3.8-flash",
            "references": [{"title": "BigQuery · Slots", "url": "https://cloud.google.com/bigquery/docs/slots", "host": "cloud.google.com"}]}
    page.route("**/api/enquiry", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(fake)))
    goto(page, "enquiry")
    page.fill("#eqQ", "What is a BigQuery slot?")
    page.click("#eqForm button[type=submit]")
    page.wait_for_selector(".eq-item .eq-refs a")
    assert page.get_attribute(".eq-item .eq-refs a", "href").startswith("https://cloud.google.com/")
    assert "Commitments cover baseline slots." in page.inner_text(".eq-item .eq-a li")


def test_reset_clears_everything_and_undo_restores(page):
    goto(page, "overview")
    n = page.locator("#sourceList li").count()
    assert n > 0
    page.once("dialog", lambda d: d.accept())
    page.click("#resetBtn")
    page.wait_for_selector(".ov-empty")
    assert page.locator("#sourceList li").count() == 0
    page.click("#toast .toast-action")
    page.wait_for_function(f"document.querySelectorAll('#sourceList li').length === {n}", timeout=15_000)


def test_beta_notice_with_feedback_email(browser, base_url):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    ctx.add_init_script("localStorage.setItem('data-cloud-compass:identity', JSON.stringify({name: 'UI Test', email: 'ui@example.com'}));")
    pg = ctx.new_page()
    pg.goto(base_url + "/")
    pg.wait_for_selector("#betaDialog[open]", timeout=10_000)
    text = pg.inner_text("#betaDialog")
    assert "beta" in text.lower() and "jithinsl@google.com" in text and "screenshot" in text
    assert pg.get_attribute("#betaMailBtn", "href").startswith("mailto:jithinsl@google.com")
    pg.click("#betaDialog button[value=ok]")
    pg.reload()
    pg.wait_for_timeout(1500)
    assert pg.locator("#betaDialog[open]").count() == 0          # once per browser session
    pg.click("#feedbackBtn")                                      # Feedback (marked Beta) opens it again
    pg.wait_for_selector("#betaDialog[open]")
    ctx.close()


def test_export_needs_a_human_review_first(page):
    assert page.locator(".modnav button").last.get_attribute("data-tab") == "recs"   # Data flow & integrations is last
    page.click("#exportBtn")
    assert "review" in page.inner_text("#exportMenu .menu-note")
    page.click('[data-export="csv"]')
    page.wait_for_selector("#reviewDialog[open]")
    assert "Cost breakdown (CSV)" in page.inner_text("#reviewWhat")
    assert page.is_disabled("#reviewGo")
    boxes = page.locator("#reviewDialog [data-rv-check]")
    assert boxes.count() == 4
    for i in range(3):
        boxes.nth(i).check()
    assert page.is_disabled("#reviewGo")                       # every point must be confirmed
    boxes.nth(3).check()
    if page.locator("#rvLookerSkip").count():             # sample has Looker without a quote
        assert page.is_disabled("#reviewGo")
        page.check("#rvLookerSkip")
    with page.expect_download() as dl:
        page.click("#reviewGo")
    assert dl.value.suggested_filename.endswith("-costs.csv")
    # the same scenario does not ask again ...
    page.click("#exportBtn")
    with page.expect_download():
        page.click('[data-export="csv"]')
    assert page.locator("#reviewDialog[open]").count() == 0
    # ... and saving the scenario file never asks
    page.click("#exportBtn")
    with page.expect_download():
        page.click('[data-export="json"]')
    assert page.locator("#reviewDialog[open]").count() == 0


def test_export_asks_for_the_looker_quote_when_missing(page):
    page.wait_for_selector("#overviewBody .plan-card", timeout=15_000)
    page.click("#exportBtn")
    page.click('[data-export="csv"]')
    page.wait_for_selector("#reviewDialog[open] #rvLookerQuote")
    assert "Looker price missing" in page.inner_text("#reviewLooker")
    for i in range(4):
        page.locator("#reviewDialog [data-rv-check]").nth(i).check()
    assert page.is_disabled("#reviewGo")                       # quote or explicit skip still needed
    page.fill("#rvLookerQuote", "150000")
    assert not page.is_disabled("#reviewGo")
    with page.expect_download():
        page.click("#reviewGo")
    quote = page.evaluate("JSON.parse(localStorage.getItem('ingestion-advisor:scenario:v2')).scenario.components.find(c => c.type === 'looker').settings.annual_quote_usd")
    assert quote == 150000


def test_proposal_flags_partner_isv_pricing_and_missing_looker_quote(page):
    page.wait_for_selector("#overviewBody .plan-card", timeout=15_000)
    goto(page, "proposal")
    page.wait_for_selector("#ppPages .pp-page", timeout=15_000)
    txt = page.inner_text("#ppPages")
    assert "contact the partner" in txt.lower() and "ISV" in txt
    assert "Looker licence is quote-based" in txt
    assert "Max slots, year 1" in txt or "Average demand" in txt
