"""The public demo is the same front end calling the Cloud Run API from another origin."""


def test_demo_calls_the_api_cross_origin(browser, demo_url):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    ctx.add_init_script("try { localStorage.setItem('data-cloud-compass:identity', JSON.stringify({name: 'Demo', email: 'demo@example.com'})); } catch (e) {}")
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(demo_url + "/")
    pg.wait_for_selector("#summaryStrip .fig", state="attached", timeout=15_000)
    assert "estimates come from the live service" in pg.inner_text(".demo-banner")
    assert pg.locator("#archSvg").count() == 1
    ctx.close()
    assert not errors, errors
