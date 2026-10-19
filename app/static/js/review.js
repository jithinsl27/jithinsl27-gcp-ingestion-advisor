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
  $$("[data-rv-check]", d).forEach((c) => (c.checked = false));
  $("#reviewGo").disabled = true;
  d.showModal();
}

export function bindReview() {
  const d = $("#reviewDialog");
  if (!d) return;
  d.addEventListener("change", () => { $("#reviewGo").disabled = !$$("[data-rv-check]", d).every((c) => c.checked); });
  $("#reviewCancel").addEventListener("click", () => { pending = null; d.close(); });
  d.addEventListener("cancel", () => { pending = null; });
  $("#reviewForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!$$("[data-rv-check]", d).every((c) => c.checked)) return;
    reviewedKey = key();
    const p = pending;
    pending = null;
    d.close();
    api.usageEvent("export reviewed", p?.what || "");
    p?.go();
  });
}
