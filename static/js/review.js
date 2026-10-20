/* Data Cloud Compass - review.js: human-in-the-loop check before anything leaves the tool.
 *
 * Every customer-facing export (Slides, Sheets, PDF / print, Word, Google Doc, Markdown, CSV, SVG)
 * first shows the key figures and four confirmations. Export stays disabled until all are ticked.
 * The confirmation is kept for this exact scenario - any change asks again. */
import { S } from "./state.js";
import { $, $$, api, esc } from "./core.js";
import { money } from "./cost.js";
import { optShort } from "./pricing.js";
import { pp } from "./modules.js";
import { changed, refreshNow } from "./events.js";

/** Looker is in the architecture but has no licence quote yet (it is quote-based). */
const lookerNoQuote = () => S.scenario.components.find((c) => c.type === "looker" && c.included !== false && !(+c.settings.annual_quote_usd > 0));

let pending = null;
let reviewedKey = null;

/** A cheap fingerprint of the scenario: any edit gives a different key. */
function key() {
  const t = JSON.stringify(S.scenario || {});
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return `${t.length}:${h}`;
}

function figures() {
  const r = S.result;
  const t = r?.totals || {};
  const P = pp()?.plans;
  const sc = S.scenario || {};
  const n = (sc.sources || []).filter((s) => s.included !== false).length;
  const row = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;
  return row("Customer", esc(sc.customer || "-"))
    + row("Region", esc(r?.region?.name || sc.region || "-"))
    + row("Sources in this phase", String(n))
    + row("Environments", String((sc.environments || []).length || 1))
    + row("Pricing option", esc(optShort()))
    // the same programme figures as the Overview and Pricing pages (ramp-up included when chosen)
    + row("1 year, pay as you go", money(P?.payg_1y?.total ?? t.year1_payg ?? 0))
    + row("3 years, 3-yr commitment", money(P?.commit_3y?.total ?? t.three_year_cud3 ?? 0));
}

/** Run `go` once the person has reviewed this scenario; `what` names the export in the dialog. */
export function reviewThen(what, go) {
  if (reviewedKey && reviewedKey === key()) return go();
  const d = $("#reviewDialog");
  if (!d) return go();
  pending = { go, what };
  $("#reviewWhat").textContent = `You are about to export: ${what}. Take a moment to check it before it is shared.`;
  $("#reviewFigs").innerHTML = figures();
  const lk = lookerNoQuote();
  $("#reviewLooker").innerHTML = lk ? `<div class="review-looker" role="alert"><b>Looker price missing.</b> Looker is in the architecture, but its licence is quote-based and no quote has been entered, so it is not in the totals.
      <label>Annual Looker licence quote (USD)<input type="number" min="0" step="1000" id="rvLookerQuote" placeholder="e.g. 120000"></label>
      <label class="rv-skip"><input type="checkbox" id="rvLookerSkip"> Continue without Looker pricing - the proposal will say the Looker licence is excluded</label></div>` : "";
  $$("[data-rv-check]", d).forEach((c) => (c.checked = false));
  $("#reviewGo").disabled = true;
  d.showModal();
}

export function bindReview() {
  const d = $("#reviewDialog");
  if (!d) return;
  const valid = () => $$("[data-rv-check]", d).every((c) => c.checked)
    && (!$("#rvLookerQuote") || +$("#rvLookerQuote").value > 0 || $("#rvLookerSkip").checked);
  d.addEventListener("change", () => { $("#reviewGo").disabled = !valid(); });
  d.addEventListener("input", () => { $("#reviewGo").disabled = !valid(); });
  $("#reviewCancel").addEventListener("click", () => { pending = null; d.close(); });
  d.addEventListener("cancel", () => { pending = null; });
  $("#reviewForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!valid()) return;
    const q = $("#rvLookerQuote") ? +$("#rvLookerQuote").value : 0;
    const p = pending;
    pending = null;
    if (q > 0) {
      // add the quote, then wait for every figure to include it before exporting
      const lk = lookerNoQuote();
      if (lk) lk.settings.annual_quote_usd = q;
      $("#reviewGo").disabled = true;
      $("#reviewGo").textContent = "Updating…";
      changed();
      await refreshNow();
      $("#reviewGo").textContent = "Export";
    }
    reviewedKey = key();
    d.close();
    api.usageEvent("export reviewed", (p?.what || "") + (q > 0 ? " · Looker quote added" : $("#rvLookerSkip")?.checked ? " · without Looker pricing" : ""));
    p?.go();
  });
}
