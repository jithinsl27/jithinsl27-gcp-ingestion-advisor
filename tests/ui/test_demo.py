"""The public demo is the same front end calling the Cloud Run API from another origin."""


def test_demo_calls_the_api_cross_origin(browser, demo_url):
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(demo_url + "/")
    pg.wait_for_selector("#summaryStrip .fig", timeout=15_000)
    assert "estimates come from the live service" in pg.inner_text(".demo-banner")
    assert pg.locator("#archSvg").count() == 1
    ctx.close()
    assert not errors, errors
