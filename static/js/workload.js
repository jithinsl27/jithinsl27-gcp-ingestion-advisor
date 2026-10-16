/* Data Cloud Compass - workload.js (ES module, no build step). */
import { S } from "./state.js";
import { $, esc } from "./core.js";
import { chartSvg, money, regionTable } from "./cost.js";
import { runWorkload } from "./events.js";
import { opt, regionOptions } from "./main.js";
import { save, unitGb } from "./scenario.js";
import { changed } from "./events.js";

// ---------------- workload sizing
export const QUERY_ROWS = [["simple", "Simple queries"], ["complex", "Complex queries"], ["heavy", "Heavy / periodic queries"], ["adhoc", "Ad-hoc reports"]];

export function wlGet(path) { return path.split(".").reduce((o, k) => (o == null ? o : o[k]), S.scenario.workload); }

export function wlSet(path, v) {
  const ks = path.split(".");
  let o = S.scenario.workload;
  ks.slice(0, -1).forEach((k) => (o = o[k] = o[k] || {}));
  o[ks[ks.length - 1]] = v;
}

export function renderWorkloadForm() {
  const host = $("#workloadBody");
  if (!S.catalog || !S.scenario.workload) return;
  const n = (path, label, step = 1, attrs = "") => `<label>${esc(label)}<input type="number" min="0" step="${step}" data-w="${path}" value="${esc(wlGet(path))}" ${attrs}></label>`;
  const sel = (path, label, options) => `<label>${esc(label)}<select data-w="${path}">${opt(options, wlGet(path) ?? "")}</select></label>`;
  const chk = (path, label) => `<label class="toggle"><input type="checkbox" data-w="${path}" ${wlGet(path) ? "checked" : ""}> ${esc(label)}</label>`;
  const wu = S.scenario.workload_units || (S.scenario.workload_units = {});
  const unitSel = (path, base) => {
    const u = wu[path] || base;
    return `<select data-wunit="${path}" data-base="${base}" aria-label="Unit">${S.catalog.volume_units.map((x) => `<option${x.id === u ? " selected" : ""}>${x.id}</option>`).join("")}</select>`;
  };
  const volIn = (path, base, label) => {
    const u = wu[path] || base;
    return `<span class="vol"><input type="number" min="0" step="any" data-w="${path}" data-base="${base}" data-unit="${u}" value="${esc(+((Number(wlGet(path)) || 0) * unitGb(base) / unitGb(u)).toPrecision(6))}"${label ? ` aria-label="${esc(label)}"` : ""}>${unitSel(path, base)}</span>`;
  };
  const vol = (path, label, base) => `<label>${esc(label)}${volIn(path, base)}</label>`;
  const regSel = (path, label) => `<label>${esc(label)}<select data-w="${path}">${regionOptions("Same as BigQuery region (" + S.scenario.region + ")")}</select></label>`;
  const freqs = S.catalog.query_frequencies;
  const used = S.scenario.bq?.scan_basis === "workload";
  host.innerHTML = `
    <div class="wl-switch ${used ? "on" : ""}"><label class="toggle"><input type="checkbox" id="wlUse" ${used ? "checked" : ""}>
      <b>Use these numbers to size BigQuery and pricing</b></label>
      <span>${used ? "On - BigQuery compute, slots and every pricing plan follow the reports, pipelines and queries below." : "Off - BigQuery is sized with a rule of thumb from the data volume. Change any number below to switch it on."}</span></div>
    <div class="wl-layout">
      <form class="wl-form" id="wlForm" onsubmit="return false">
        <fieldset><legend>How much data</legend><div class="grid3">
          ${vol("data.structured_tb", "Structured data", "TB")}${vol("data.semi_structured_tb", "Semi-structured data", "TB")}${vol("data.unstructured_tb", "Unstructured data", "TB")}
          ${n("data.annual_growth_pct", "Annual growth %", 5)}${n("data.tables", "Number of tables", 50)}
        </div></fieldset>
        <fieldset><legend>Telemetry / streaming</legend><div class="grid3">
          ${vol("telemetry.volume_gb", "Telemetry volume", "GB")}
          ${sel("telemetry.per", "Per", [{ id: "day", name: "Per day" }, { id: "month", name: "Per month" }])}
          ${n("telemetry.retention_months", "Retention (months)", 1)}
          <div class="span3">${chk("telemetry.transform", "Transform in flight (Dataflow streaming)")}</div>
        </div></fieldset>
        <fieldset><legend>Data pipelines (jobs that load and transform data)</legend><div class="grid3">
          ${n("pipelines.simple", "Simple pipelines", 5)}${n("pipelines.medium", "Medium pipelines", 5)}${n("pipelines.complex", "Complex pipelines", 5)}
          ${n("pipelines.runs_per_day", "Runs per day (each)", 1)}
          ${sel("pipelines.engine", "Pipeline engine", [{ id: "elt", name: "ELT in BigQuery (Dataform)" }, { id: "etl", name: "ETL on Dataflow" }])}
        </div></fieldset>
        <fieldset><legend>Reports and queries people run</legend>
          <div class="qtable" role="table">
            <div class="qrow qhead" role="row"><span>Workload</span><span>Count</span><span>Runs</span><span>Scanned / run</span></div>
            ${QUERY_ROWS.map(([k, label]) => `<div class="qrow" role="row"><span>${esc(label)}</span>
              <input type="number" min="0" step="1" data-w="queries.${k}.count" value="${esc(wlGet(`queries.${k}.count`))}" aria-label="${esc(label)} count">
              <select data-w="queries.${k}.frequency" aria-label="${esc(label)} frequency">${opt(freqs, wlGet(`queries.${k}.frequency`))}</select>
              ${volIn(`queries.${k}.gb`, "GB", `${label} data scanned`)}</div>`).join("")}
          </div>
        </fieldset>
        <fieldset><legend>Dashboards</legend><p class="hint">How many dashboards, how often they refresh and how much data each refresh reads.</p><div class="grid3">
          ${n("dashboards.count", "Dashboards", 1)}${n("dashboards.refreshes_per_day", "Refreshes per day", 1)}${n("dashboards.queries_per_refresh", "Queries per refresh", 1)}
          ${vol("dashboards.gb_per_query", "Scanned per query", "GB")}${n("dashboards.cache_pct", "Served from cache / BI Engine %", 5)}
        </div></fieldset>
        <fieldset><legend>Ramp-up phase</legend><div class="grid3">
          ${n("ramp.months", "Months", 1)}${vol("ramp.data_gb", "Total data during ramp", "GB")}
          ${n("ramp.pipelines", "Pipelines during ramp", 1)}${n("ramp.reports", "Reports / dashboards during ramp", 1)}
        </div></fieldset>
        <details class="wl-adv"><summary>Advanced: working hours, regions and the standalone estimate</summary>
        <fieldset><legend>When work runs</legend><div class="grid3">
          ${n("slots.batch_window_hours", "Batch window (hours)", 1)}${n("slots.business_hours", "Business hours / day", 1)}${n("slots.peak_concurrency", "Peak hour vs average (x)", 0.1)}
          ${n("slots.heavy_target_minutes", "Heavy query target (minutes)", 5)}
          ${sel("slots.edition", "Edition", [{ id: "auto", name: "Recommend for me" }, { id: "standard", name: "Standard" }, { id: "enterprise", name: "Enterprise" }, { id: "enterprise_plus", name: "Enterprise Plus" }])}
        </div></fieldset>
        <fieldset><legend>Regions &amp; pricing</legend><div class="grid3">
          ${regSel("data_region", "Data & queries")}${regSel("pipelines_region", "Pipelines & orchestration")}${regSel("streaming_region", "Streaming")}
          ${sel("bq_model", "BigQuery compute", S.catalog.bq_models)}
          <span data-show-editions>${n("slot_hours_per_tib", "Slot-hours per TiB scanned", 5)}</span>
          ${n("contingency_pct", "Contingency %", 5)}
          <div class="span3">${chk("include_components", "Include the analytics, AI & governance components from the Architecture tab")}</div>
        </div></fieldset>
        </details>
        <button type="button" class="btn ghost small" id="wlReset">Load example values</button>
      </form>
      <div class="wl-results"><div id="wlSummary" aria-live="polite"></div>
        <details class="wl-adv"><summary>Standalone workload-only estimate (for comparison)</summary><div id="wlResults"></div></details></div>
    </div>`;
  ["data_region", "pipelines_region", "streaming_region"].forEach((k) => { const el = $(`[data-w="${k}"]`, host); if (el) el.value = wlGet(k) || ""; });
  toggleEditionsField();
  renderWorkloadResults();
  renderWorkloadSummary();
}

/** Plain-language "what this means" next to the workload inputs (from the main estimate). */
export function renderWorkloadSummary() {
  const host = $("#wlSummary");
  if (!host) return;
  const b = S.result?.bigquery;
  const used = S.scenario.bq?.scan_basis === "workload";
  if (!b || !b.active) { host.innerHTML = `<p class="hint">Add source systems to see what this workload means for BigQuery.</p>`; return; }
  const wlBasis = (b.bases || []).find((x) => x.id === "workload");
  const editions = S.scenario.bq?.mode === "editions";
  const bomBq = (S.result.bom || []).filter((x) => x.service === "BigQuery compute").reduce((a, x) => a + x.month12, 0);
  host.innerHTML = `<div class="wl-mean"><h3>What this means</h3>
    <div class="slot-totals">
      <div><span>Data scanned per month</span><b>${(used ? b.scan_tib_month : wlBasis?.tib_month || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} TiB</b><small>${used ? "used for pricing" : `pricing uses ${b.scan_tib_month.toLocaleString(undefined, { maximumFractionDigits: 1 })} TiB (rule of thumb)`}</small></div>
      <div><span>Computing power (production)</span><b>${used ? `${b.avg_slots} slots avg` : "-"}</b><small>${used ? `busiest hour ${Math.round(b.peak_slots)} slots` : "switch on to size from this workload"}</small></div>
      <div><span>BigQuery compute, all environments</span><b>${money(bomBq)}</b><small>per month at month 12 · ${editions ? "editions (slots)" : "on-demand"}</small></div>
    </div>
    ${used ? `<ul class="slot-recs">${(b.scan_by_class || []).map((c) => `<li><b>${esc(c.class)}</b>: ${c.tib_month.toLocaleString(undefined, { maximumFractionDigits: 2 })} TiB scanned per month</li>`).join("")}</ul>` : ""}
    <p><button type="button" class="link-btn" data-goto-tab="slots">See the BigQuery slots per environment ›</button> · <button type="button" class="link-btn" data-goto-tab="pricing">See the pricing plans ›</button></p></div>`;
}

export function toggleEditionsField() {
  const el = $("[data-show-editions]");
  if (el) el.hidden = S.scenario.workload.bq_model === "ondemand";
}

export function onWorkloadInput(e) {
  if (e.target.id === "wlUse") {
    if (e.type !== "change") return;
    (S.scenario.bq ||= { mode: "ondemand", edition: "auto" }).scan_basis = e.target.checked ? "workload" : "auto";
    changed();
    renderWorkloadForm();
    return;
  }
  const us = e.target.closest("[data-wunit]");
  if (us) {
    if (e.type !== "change") return;
    const path = us.dataset.wunit;
    S.scenario.workload_units[path] = us.value;
    const inp = us.parentElement.querySelector("input");
    inp.dataset.unit = us.value;
    inp.value = +((Number(wlGet(path)) || 0) * unitGb(us.dataset.base) / unitGb(us.value)).toPrecision(6);
    save();
    return;
  }
  const el = e.target.closest("[data-w]");
  if (!el) return;
  let v;
  if (el.type === "checkbox") v = el.checked;
  else if (el.type === "number") {
    v = el.value === "" ? 0 : Math.max(0, Number(el.value));
    if (el.dataset.base) v = v * unitGb(el.dataset.unit || el.dataset.base) / unitGb(el.dataset.base);
  } else v = el.value || null;
  wlSet(el.dataset.w, v);
  if (el.dataset.w === "bq_model") toggleEditionsField();
  const standalone = ["bq_model", "slot_hours_per_tib", "contingency_pct", "data_region", "pipelines_region", "streaming_region", "include_components"].includes(el.dataset.w);
  if (!standalone && S.scenario.bq && S.scenario.bq.scan_basis !== "workload") {
    S.scenario.bq.scan_basis = "workload";
    const sw = $("#wlUse"); if (sw) { sw.checked = true; sw.closest(".wl-switch")?.classList.add("on"); }
  }
  save();
  clearTimeout(S.wlTimer);
  S.wlTimer = setTimeout(standalone ? runWorkload : changed, 300);
}

export function renderWorkloadResults() {
  const host = $("#wlResults");
  if (!host) return;
  if (!S.wlResult) { host.innerHTML = `<p class="hint">Calculating…</p>`; return; }
  const r = S.wlResult, t = r.totals;
  if (!(t.three_year_payg > 0)) { host.innerHTML = `<p class="empty-note">Enter the customer's data estate, pipelines, queries or dashboards on the left to size consumption - or load the example values.</p>`; return; }
  const rampN = r.ramp_months;
  let html = `<div class="wl-kpis">
    ${rampN ? `<div><span>Ramp-up, months 1-${rampN}</span><b>${money(t.ramp_monthly)}</b><span>per month</span></div>` : ""}
    <div><span>Steady state, month ${rampN + 1}</span><b>${money(t.steady_monthly)}</b><span>per month</span></div>
    <div><span>1 year</span><b>${money(t.year1_payg)}</b><span>${money(t.year1_cud1)} with commitments</span></div>
    <div><span>3 years</span><b>${money(t.three_year_payg)}</b><span>${money(t.three_year_cud3)} with commitments</span></div>
  </div>`;
  html += `<h3>By category</h3><div style="overflow-x:auto"><table><thead><tr><th>Category</th><th>Steady month</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
    + r.by_category.map((c) => `<tr><td>${esc(c.category)}</td><td>${money(c.steady_month)}</td><td>${money(c.year1)}</td><td>${money(c.three_year)}</td></tr>`).join("")
    + `</tbody><tfoot><tr><td>Total</td><td>${money(t.steady_monthly)}</td><td>${money(t.year1_payg)}</td><td>${money(t.three_year_payg)}</td></tr></tfoot></table></div>`;
  html += `<h3>Monthly consumption</h3><div class="chart-key"><span><i></i>Pay-as-you-go</span><span><i class="cud"></i>With 3-year commitments</span></div>
    <div class="chart-wrap">${chartSvg(r.monthly, rampN ? rampN + 1 : 0)}</div>`;
  html += `<h3>Compute model comparison</h3><p class="hint">For the ${r.scan_tib_steady_month.toLocaleString()} TiB scanned in the first steady-state month. Editions assume ${r.assumptions.slot_hours_per_tib} slot-hours per TiB - measure with INFORMATION_SCHEMA.JOBS once workloads run.</p>
    <div style="overflow-x:auto"><table><thead><tr><th>Model</th><th>Per month</th><th>1-yr commit</th><th>3-yr commit</th></tr></thead><tbody>`
    + r.compute_comparison.map((c) => `<tr><td>${esc(c.model)}</td><td>${money(c.monthly)}</td><td>${c.commit1 == null ? "-" : money(c.commit1)}</td><td>${c.commit3 == null ? "-" : money(c.commit3)}</td></tr>`).join("")
    + `</tbody></table></div>`;
  html += slotSection(r.slots);
  if ((r.environments || []).length > 1) {
    html += `<h3>By environment</h3><div style="overflow-x:auto"><table><thead><tr><th>Environment</th><th>Per month (yr 1)</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
      + r.environments.map((e, i) => `<tr><td><span class="env-dot e${Math.min(i, 5)}"></span>${esc(e.name)}</td><td>${money(e.monthly_year1)}</td><td>${money(e.year1)}</td><td>${money(e.three_year)}</td></tr>`).join("")
      + `</tbody></table></div>`;
  }
  html += `<h3>Line items</h3><div style="overflow-x:auto"><table><thead><tr><th>Workload</th><th>Service</th><th>Steady month</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
    + r.lines.filter((l) => l.three_year > 0).map((l) => `<tr><td>${esc(l.item)}</td><td>${esc(l.service)}</td><td>${money(l.steady_month)}</td><td>${money(l.year1)}</td><td>${money(l.three_year)}</td></tr>`).join("")
    + `</tbody></table></div>`;
  html += regionTable(r.by_region);
  html += `<p class="disclaimer">${esc(r.disclaimer)}</p>`;
  host.innerHTML = html;
}

export const EDITION_NAME = { standard: "Standard", enterprise: "Enterprise", enterprise_plus: "Enterprise Plus" };

export function effectiveSlots(sl) {
  return Math.max(sl.baseline_slots, Math.ceil(((sl.baseline_slots * 730 + sl.costs.autoscale_slot_hours_month) / 730) / 50) * 50, 50);
}

export function slotSection(sl) {
  if (!sl) return "";
  const c = sl.costs;
  let html = `<h3 id="slotHead">BigQuery slot sizing &amp; recommendation</h3>
    <p class="hint">Sized from the data volume, job types and frequencies above at ${sl.slot_hours_per_tib} slot-hours per TiB scanned: pipelines and heavy jobs in a ${sl.inputs.batch_window_hours}-hour batch window, dashboards and queries over ${sl.inputs.business_hours} business hours.</p>
    <div class="wl-kpis slot-kpis">
      <div><span>Average demand</span><b>${sl.avg_slots.toLocaleString()} slots</b><span>over the month</span></div>
      <div><span>Peak hour</span><b>${Math.round(sl.peak_slots).toLocaleString()} slots</b><span>${sl.heavy_burst_slots > sl.peak_slots ? `heavy query burst ${Math.round(sl.heavy_burst_slots)}` : "busiest hour"}</span></div>
      <div><span>Reservation</span><b>${sl.baseline_slots} → ${sl.max_slots}</b><span>baseline → max autoscale</span></div>
      <div><span>Recommended</span><b>${sl.model === "editions" ? esc(EDITION_NAME[sl.edition]) : "On-demand"}</b><span>${sl.model === "editions" ? money(c.recommended_month) + "/month" : money(c.ondemand_month) + "/month"}</span></div>
    </div>
    <div class="slot-grid"><div><div class="chart-wrap">${slotProfileSvg(sl)}</div><p class="hint">Average slot demand by hour of day (busiest-hour factor applied in business hours); dashed line = recommended baseline.</p></div>
    <div><ul class="slot-recs">${sl.recommendations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <p class="sub">Edition</p><ul class="slot-recs reasons">${sl.edition_reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <button type="button" class="btn primary small" id="slotApply">Use in the consumption estimate</button></div></div>`;
  html += `<div style="overflow-x:auto"><table><thead><tr><th>Job type</th><th>TiB / month</th><th>Slot-hours / month</th><th>Avg slots</th></tr></thead><tbody>`
    + sl.by_class.map((b) => `<tr><td>${esc(b.class)}</td><td>${b.tib_month.toLocaleString()}</td><td>${b.slot_hours_month.toLocaleString()}</td><td>${b.avg_slots}</td></tr>`).join("")
    + `</tbody></table></div>`;
  html += `<div style="overflow-x:auto"><table><thead><tr><th>Pricing option (per month)</th><th>Cost</th></tr></thead><tbody>
    <tr><td>On-demand (per TiB scanned)</td><td>${money(c.ondemand_month)}</td></tr>
    <tr><td>${esc(EDITION_NAME[sl.edition])} - autoscaling only (pay as you go)</td><td>${money(c.autoscale_only_month)}</td></tr>
    ${sl.edition !== "standard" ? `<tr><td>${esc(EDITION_NAME[sl.edition])} - ${sl.baseline_slots} baseline slots on 1-year commitment + autoscaling</td><td>${money(c.recommended_month)}</td></tr>
    <tr><td>${esc(EDITION_NAME[sl.edition])} - same on 3-year commitment</td><td>${money(c.recommended_month_3yr)}</td></tr>` : ""}</tbody></table></div>`;
  if (sl.by_environment.length > 1) html += `<div style="overflow-x:auto"><table><thead><tr><th>Environment</th><th>Baseline slots</th><th>Max slots</th></tr></thead><tbody>`
    + sl.by_environment.map((e) => `<tr><td>${esc(e.name)}</td><td>${e.baseline_slots}</td><td>${e.max_slots}</td></tr>`).join("") + `</tbody></table></div>`;
  return html;
}

export function slotProfileSvg(sl) {
  const W = 520, H = 180, L = 40, R = 8, T = 10, B = 24;
  const max = Math.max(...sl.profile, sl.baseline_slots, 1) * 1.1;
  const bw = (W - L - R) / 24;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let g = "";
  for (let k = 0; k <= 3; k++) { const v = (max / 3) * k; g += `<line class="chart-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`; }
  sl.profile.forEach((v, h) => {
    g += `<rect class="slot-bar" x="${L + h * bw + 2}" y="${y(v)}" width="${bw - 4}" height="${Math.max(0, y(0) - y(v))}"><title>${String(h).padStart(2, "0")}:00 - ${v} slots</title></rect>`;
    if (h % 3 === 0) g += `<text class="chart-axis" x="${L + h * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${String(h).padStart(2, "0")}h</text>`;
  });
  if (sl.baseline_slots) g += `<line class="chart-marker" x1="${L}" x2="${W - R}" y1="${y(sl.baseline_slots)}" y2="${y(sl.baseline_slots)}"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Slot demand by hour">${g}</svg>`;
}
