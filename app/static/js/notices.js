/* Data Cloud Compass - notices.js: region availability warnings and where prices come from. */
import { S } from "./state.js";
import { $, esc, toast } from "./core.js";
import { changed } from "./events.js";
import { compMeta, hasEstimate } from "./pricing.js";

export function priceSource() {
  const m = S.result?.pricing_meta || {};
  if (m.live) {
    const d = m.live_fetched_at ? new Date(m.live_fetched_at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
    return `Live Google Cloud list prices${d ? ` (${d})` : ""}, ${(m.live_accepted || []).length} SKUs refreshed`;
  }
  return `List prices reviewed ${m.last_reviewed || "-"}`;
}

export function renderNotices() {
  const host = $("#notices");
  if (!host) return;
  if (!hasEstimate() || !S.result.availability) { host.innerHTML = ""; return; }
  const a = S.result.availability;
  let html = "";
  for (const u of a.unavailable) {
    const alts = (u.alternatives || []).map((r) =>
      `<button type="button" class="btn ghost small" data-move="${esc(u.family)}" data-from="${esc(u.region)}" data-to="${esc(r.id)}">Run it in ${esc(r.name)}</button>`).join("");
    html += `<div class="notice warn" role="alert"><b>${esc(u.service)} is not offered in ${esc(u.region_name)}</b>
      <span>Used by ${esc(u.used_by.join(", "))}. ${u.family === "bigquery" ? "Choose another BigQuery region in the top bar." : "Process it in a nearby region (adds cross-region transfer) or choose another pattern."}</span>
      ${u.family === "bigquery" ? "" : `<div class="notice-actions">${alts}</div>`}</div>`;
  }
  if (a.unverified.length && a.source === "static") {
    html += `<details class="notice info"><summary>Regional availability of ${a.unverified.length} service${a.unverified.length > 1 ? "s" : ""} not verified</summary>
      <span>${esc(a.unverified.map((u) => `${u.service} in ${u.region}`).join(", "))}. The Cloud Run deployment checks availability daily against the Google Cloud Billing Catalog; confirm in the region picker before committing a design.</span></details>`;
  }
  host.innerHTML = html;
}

export function bindNotices() {
  $("#notices").addEventListener("click", (e) => {
    const b = e.target.closest("[data-move]");
    if (!b) return;
    const u = S.result.availability.unavailable.find((x) => x.family === b.dataset.move && x.region === b.dataset.from);
    if (!u) return;
    const home = S.scenario.region;
    let n = 0;
    S.scenario.sources.forEach((s) => {
      if (u.used_by.includes(s.name) && (s.region || home) === u.region) { s.region = b.dataset.to; n++; }
    });
    S.scenario.components.forEach((c) => {
      if (u.used_by.includes(compMeta(c.type)?.name) && (c.settings.region || home) === u.region) { c.settings.region = b.dataset.to; n++; }
    });
    if (["Orchestration", "Data Fusion instance"].some((x) => u.used_by.includes(x))) { S.scenario.processing_region = b.dataset.to; $("#processing_region").value = b.dataset.to; n++; }
    toast(`${n} item${n === 1 ? "" : "s"} now run in ${b.dataset.to}`);
    changed();
  });
}
