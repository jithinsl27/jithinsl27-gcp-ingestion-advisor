/* Data Cloud Compass - slotspage.js: BigQuery slots per environment, explained for business users. */
import { S } from "./state.js";
import { $, esc } from "./core.js";
import { money } from "./cost.js";
import { EDITION_NAME, bq, isEditions, profileSvg, slotCell } from "./bigquery.js";

const OPTS = [["payg", "Pay as you go"], ["cud1", "1-year commitment"], ["cud3", "3-year commitment"]];

export function renderSlotsPage() {
  const host = $("#slotsBody");
  if (!host) return;
  const r = S.result?.bigquery;
  if (!r || !r.active) { host.innerHTML = `<p class="empty-note">Add a source system that lands in BigQuery to size the slots.</p>`; return; }
  const ed = isEditions();
  const specs = r.env_specs || [];
  const tot = r.project_totals || {};
  const rules = r.rules || { slot_min: 100, slot_step: 50 };
  const basis = { heuristic: "a rule of thumb from the data volume", workload: "the Workload page (reports, pipelines and queries you entered)", measured: "the customer's measured BigQuery usage" }[r.scan_basis] || r.scan_basis;
  let html = `<div class="explain">
    <p><b>What is a slot?</b> A slot is a unit of BigQuery computing power. You either pay <b>per TiB of data your queries scan</b> (on-demand) or <b>reserve slots</b> with an edition: a <b>baseline</b> that is always on (and can be committed for 1 or 3 years at a discount) plus <b>autoscaling</b> up to a maximum, billed only while queries run.</p>
    <p>Rules used here: a baseline or commitment starts at <b>${rules.slot_min} slots</b> and grows in steps of <b>${rules.slot_step}</b>; autoscaling adds slots in steps of ${rules.slot_step} and is always pay as you go. Demand is sized from ${esc(basis)}.</p></div>`;
  html += `<div class="slot-mode"><div class="seg" role="radiogroup" aria-label="BigQuery pricing model">
      <button type="button" role="radio" aria-checked="${!ed}" class="${!ed ? "on" : ""}" data-bq-mode="ondemand">On-demand (per TiB)</button>
      <button type="button" role="radio" aria-checked="${ed}" class="${ed ? "on" : ""}" data-bq-mode="editions">Editions (slots)</button></div>
    <span class="bq-rec ${((r.recommended_mode === "ondemand") === !ed) ? "ok" : "warn"}">Recommended for this workload: <b>${r.recommended_mode === "ondemand" ? "On-demand" : EDITION_NAME[r.recommended_edition] + " edition"}</b></span>
    <button type="button" class="link-btn" data-bq-open>Calibration &amp; edition comparison ›</button></div>`;
  html += `<div class="slot-totals">${OPTS.map(([o, n]) => { const t = tot[o] || {}; return `<div><span>${esc(n)} · whole project</span>
      <b>${ed ? (o === "payg" ? `${t.baseline || 0} baseline` : `${t.commitment || 0} committed`) : "-"}</b>
      <small>${ed ? `up to ${t.max || 0} slots with autoscaling · ${money(t.monthly || 0)}/month` : "switch to Editions to reserve slots"}</small></div>`; }).join("")}
    <div><span>Demand (production)</span><b>${r.avg_slots} avg · ${Math.round(r.peak_slots)} peak</b><small>${(r.scan_tib_month || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} TiB scanned / month</small></div></div>`;
  html += `<h3>Per environment</h3><div style="overflow-x:auto"><table class="bom-table slot-env"><thead><tr><th>Environment</th><th class="num">Average demand</th><th class="num">Busiest hour</th>
      <th>Recommended baseline / commitment</th><th class="num">Max slots</th><th>Per month</th><th>Sized as</th></tr></thead><tbody>`;
  const short = { payg: "Pay as you go", cud1: "1-yr", cud3: "3-yr" };
  specs.forEach((e, i) => {
    html += `<tr><td><span class="env-dot e${Math.min(i, 5)}"></span><b>${esc(e.name)}</b>${e.overridden ? ` <span class="tag">edited</span>` : ""}</td>
      <td class="num">${e.avg_slots}</td><td class="num">${Math.round(e.peak_slots)}</td>
      <td>${ed ? `<ul class="opt-list">${OPTS.map(([o]) => { const x = e.by_option[o]; return `<li><span>${short[o]}</span><b>${x.baseline ? `${x.baseline}${o !== "payg" ? " committed" : " baseline"}` : "autoscale only"}</b></li>`; }).join("")}</ul>` : "<small>on-demand - no reservation</small>"}</td>
      <td class="num">${ed ? `<b>${e.by_option.cud1.max}</b>` : `<small>${e.by_option.cud1.max} if on editions</small>`}</td>
      <td><ul class="opt-list">${OPTS.map(([o]) => `<li><span>${short[o]}</span><b>${money(ed ? e.by_option[o].monthly : e.ondemand_month)}</b></li>`).join("")}</ul></td>
      <td><small>${i === 0 ? "Production demand" : `${+e.compute_pct}% of production compute${e.runtime_pct < 100 ? `, ${Math.round(e.runtime_pct * 1.68)} h/week` : ""}`}</small></td></tr>`;
  });
  html += `</tbody></table></div>`;
  if (ed) {
    html += `<h3>Change the reservation</h3><p class="hint">Grey numbers are the recommendation. Type a baseline or max to override it (values under 100 become 100; others round up to a step of 50); clear the box to go back to the recommendation.</p>
      <table class="es-table slot-edit"><thead><tr><th>Environment</th><th>Baseline</th><th>Max</th></tr></thead><tbody>
      ${S.scenario.environments.map((e, i) => `<tr><td>${esc(e.name)}</td><td>${slotCell(i, "baseline")}</td><td>${slotCell(i, "max")}</td></tr>`).join("")}</tbody></table>
      <label class="bq-ed">Edition<select id="bqEdition"><option value="auto"${bq().edition === "auto" ? " selected" : ""}>Recommend for me (${esc(EDITION_NAME[r.recommended_edition] || "")})</option>
      ${Object.entries(EDITION_NAME).map(([k, n]) => `<option value="${k}"${bq().edition === k ? " selected" : ""}>${n}</option>`).join("")}</select></label>`;
    const nocommit = specs.filter((e) => e.by_option.cud1.with_min_commitment);
    if (nocommit.length) html += `<p class="hint">Why no commitment in ${nocommit.map((e) => esc(e.name)).join(", ")}: demand runs only part of the day, so a 100-slot commitment (billed 24×7) costs more than autoscaling - e.g. ${esc(nocommit[0].name)}: ${money(nocommit[0].by_option.cud1.with_min_commitment)} vs ${money(nocommit[0].by_option.cud1.monthly)} per month. Commit once usage is steadier.</p>`;
  }
  html += `<h3>When the slots are used (production, average day)</h3><div class="slot-grid slots-page"><div class="chart-wrap">${profileSvg(r)}</div>
    <div><p class="sub">Assumptions</p><ul class="slot-recs">
      <li>${r.slot_hours_per_tib} slot-hours per TiB scanned${r.calibrated ? " (measured)" : " (typical for mixed BI and ELT)"}.</li>
      ${(r.scan_by_class || []).map((c) => `<li>${esc(c.class)}: ${c.tib_month.toLocaleString(undefined, { maximumFractionDigits: 2 })} TiB / month → ${c.slot_hours_month.toLocaleString()} slot-hours.</li>`).join("")}
      <li>Pipelines run in a ${r.shape.batch_window_hours}-hour overnight window; reports and dashboards over ${r.shape.business_hours} business hours, busiest hour ×${r.shape.peak_concurrency}.</li>
      <li>Autoscaling billed with a ×${r.autoscale_overhead} allowance for 50-slot steps and the 1-minute minimum.</li>
      <li>Other environments use their compute share of production; part-time environments get no baseline.</li>
      <li>Month ${r.reference_month} (steady state) is the reference month.</li></ul>
      <p class="sub">Why this edition</p><ul class="slot-recs reasons">${(r.edition_reasons || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>`;
  host.innerHTML = html;
}
