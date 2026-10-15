/* Data Cloud Compass - roadmap.js (ES module, no build step). */
import { priceSource } from "./notices.js";
import { S } from "./state.js";
import { $, esc } from "./core.js";
import { GROUP_COLORS, money, moneyShort } from "./cost.js";
import { bqModelName, clip } from "./diagram.js";
import { regionName } from "./main.js";
import { compMeta } from "./pricing.js";
import { tool } from "./render.js";

// ---------------- roadmap: final architecture + month-by-month ramp-up
export function renderRoadmap() {
  const host = $("#roadmapBody");
  if (!host) return;
  if (!S.planResult || !S.result || !S.scenario.sources.length) { host.innerHTML = `<p class="empty-note">Add source systems to generate the ramp-up roadmap.</p>`; return; }
  const p = S.planResult, t = p.totals;
  const teamsOpt = [1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}"${n === p.teams ? " selected" : ""}>${n} squad${n > 1 ? "s" : ""}</option>`).join("");
  const allLive = Math.max(...p.waves.map((w) => w.go_live_month), 1);
  let html = `<div class="rm-controls"><label>Delivery capacity<select id="rmTeams">${teamsOpt}</select></label>
    <p class="hint">Sources are built by parallel squads, quick wins first; each service starts consuming in the month it goes live.</p></div>`;
  html += `<div class="rm-kpis">
    <div><span>Programme length</span><b>${p.horizon} months</b><span>all sources live by month ${allLive}</span></div>
    <div><span>Year 1 with ramp-up</span><b>${money(t.ramped_year1)}</b><span>vs ${money(t.steady_year1)} if everything ran from month 1</span></div>
    <div><span>3 years with ramp-up</span><b>${money(t.ramped_three_year)}</b><span>${money(t.ramped_three_year_cud3)} with 3-yr commitments</span></div>
    <div><span>Steady-state run-rate</span><b>${money(p.months[p.months.length - 1].total)}</b><span>per month from month ${p.horizon}</span></div>
  </div>`;

  // final architecture
  const arch = $("#archSvg");
  html += `<h3>Final target architecture</h3><div class="rm-arch"><div class="diagram-wrap">${arch ? arch.outerHTML.replace('id="archSvg"', 'id="archSvgRoadmap"') : ""}</div></div>`;
  const ingTools = [...new Set(S.result.recommendations.flatMap((r) => r.chain.map((x) => tool(x).name)))];
  const byCat = (cat) => S.scenario.components.filter((c) => compMeta(c.type).category === cat).map((c) => compMeta(c.type).name + (compMeta(c.type).vendor === "partner" ? " (partner)" : ""));
  const consumers = [...byCat("bi"), ...byCat("ai"), ...byCat("integration"), ...byCat("database")];
  const govList = [...byCat("governance"), ...byCat("security")];
  const orch = S.result.platform.orchestration.tool;
  const layer = (cls, title, items) => `<div class="rm-layer ${cls}"><h4>${esc(title)}</h4><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("") || "<li>None selected</li>"}</ul></div>`;
  html += `<div class="rm-layers">
    ${layer("l-src", `Sources in this phase (${S.result.recommendations.length})`, S.scenario.sources.filter((s) => s.included !== false).map((s) => s.name))}
    ${layer("l-ing", "Ingestion & CDC", ingTools)}
    ${layer("l-bq", "BigQuery platform", [`BigQuery in ${regionName(S.scenario.region)}`, bqModelName(), "Dataform ELT", orch !== "none" ? tool(orch).name : null, "BigQuery ML & AI functions"].filter(Boolean))}
    ${layer("l-use", "BI, AI, APIs & databases", consumers)}
    ${layer("l-gov", "Governance & security", govList)}
  </div>`;

  // gantt
  html += `<h3>Ramp-up plan</h3><div class="gantt-wrap">${ganttSvg(p)}</div>`;

  // month-by-month cost
  html += `<h3>Consumption month by month</h3><div class="stack-legend">${p.group_order.filter((g) => p.months.some((m) => m.by_group[g])).map((g) => `<span><i style="background:${GROUP_COLORS[g]}"></i>${esc(g)}</span>`).join("")}<span><i style="background:none;border-top:2px dashed var(--ink-2);height:0;border-radius:0"></i>Steady state (no ramp)</span></div>
    <div class="chart-wrap">${rampChart(p)}</div>`;
  let cum = 0;
  html += `<div style="overflow-x:auto"><table class="rm-table"><thead><tr><th>Month</th><th style="text-align:left">Goes live this month</th><th>Ramped cost</th><th>Steady state</th><th>Cumulative</th></tr></thead><tbody>`
    + p.months.map((m) => {
      cum += m.total;
      const ms = p.milestones.filter((x) => x.month === m.month).map((x) => x.name);
      const live = [...ms, ...m.sources_live, ...m.components_started].join(" · ") || "-";
      return `<tr><td>M${m.month}</td><td class="live">${esc(live)}</td><td>${money(m.total)}</td><td>${money(m.steady)}</td><td>${money(cum)}</td></tr>`;
    }).join("") + `</tbody></table></div>`;
  html += `<p class="disclaimer">Plan assumes ${p.assumptions.foundation_weeks} weeks of foundation and build effort per pattern (e.g. ${p.assumptions.effort_weeks.dts_free} weeks for a Data Transfer Service source, ${p.assumptions.effort_weeks.datastream} for Datastream CDC, ${p.assumptions.effort_weeks.dts_migration} for a warehouse migration), plus extra time for heavy transforms and loads over 100 TB. Adjust squads to see the effect on timeline and cost.</p>`;
  host.innerHTML = html;
}

export function ganttSvg(p) {
  const rows = p.phases;
  const L = 250, R = 16, T = 30, rowH = 26, W = 1000;
  const H = T + rows.length * rowH + 30;
  const mw = (W - L - R) / p.horizon;
  const x = (m) => L + (m - 1) * mw;
  let g = "";
  for (let m = 1; m <= p.horizon; m++) {
    g += `<text class="gt-month" x="${x(m) + mw / 2}" y="18" text-anchor="middle">M${m}</text>`;
    g += `<line class="gt-grid" x1="${x(m)}" x2="${x(m)}" y1="${T - 6}" y2="${H - 24}"/>`;
  }
  rows.forEach((r, i) => {
    const y = T + i * rowH;
    const cls = `gt-bar ${r.key} ${r.category || ""} ${r.vendor || ""}`;
    g += `<text class="gt-label" x="10" y="${y + 16}">${esc(clip(r.name, 34))}</text>`;
    g += `<rect class="${cls}" x="${x(r.start) + 2}" y="${y + 5}" width="${Math.max(8, (r.end - r.start + 1) * mw - 4)}" height="${rowH - 10}" rx="5"><title>${esc(r.name)}: M${r.start}-M${r.end}. ${esc(r.items.join("; "))}</title></rect>`;
  });
  const my = H - 14;
  const seen = {};
  p.milestones.forEach((ms) => {
    const cx = x(ms.month) + mw / 2;
    const k = seen[ms.month] = (seen[ms.month] || 0) + 1;
    if (k === 1) g += `<path class="gt-ms" d="M${cx},${my - 6} L${cx + 6},${my} L${cx},${my + 6} L${cx - 6},${my}Z"><title>${esc(p.milestones.filter((z) => z.month === ms.month).map((z) => z.name).join(", "))}</title></path>`;
  });
  g += `<text class="gt-ms-label" x="10" y="${my + 4}">Milestones</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ramp-up plan by month">${g}</svg>`;
}

export function rampChart(p) {
  const W = 900, H = 260, L = 64, R = 12, T = 12, B = 30;
  const months = p.months;
  const max = Math.max(...months.map((m) => Math.max(m.total, m.steady)), 1) * 1.08;
  const bw = (W - L - R) / months.length;
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let g = "";
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    g += `<line class="chart-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(moneyShort(v))}</text>`;
  }
  months.forEach((m, i) => {
    let acc = 0;
    const x0 = L + i * bw + bw * 0.18, w = bw * 0.64;
    p.group_order.forEach((grp) => {
      const v = m.by_group[grp] || 0;
      if (!v) return;
      g += `<rect x="${x0}" y="${y(acc + v)}" width="${w}" height="${Math.max(0, y(acc) - y(acc + v))}" fill="${GROUP_COLORS[grp]}"><title>M${m.month} ${esc(grp)}: ${esc(money(v))}</title></rect>`;
      acc += v;
    });
    g += `<text class="chart-axis" x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">M${m.month}</text>`;
  });
  const line = months.map((m, i) => `${i ? "L" : "M"}${(L + i * bw + bw / 2).toFixed(1)},${y(m.steady).toFixed(1)}`).join(" ");
  g += `<path d="${line}" fill="none" stroke="var(--ink-2)" stroke-width="2" stroke-dasharray="5 4"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly consumption during ramp-up">${g}</svg>`;
}

// ---------------- assumptions
export function renderAssumptions() {
  const host = $("#assumeBody");
  if (!S.result) { host.innerHTML = ""; return; }
  const a = S.result.assumptions;
  const pct = (v) => Math.round(v * 100) + "%";
  const rows = [
    ["BigQuery region price uplift vs us-central1", `x${S.result.region.uplift.toFixed(2)} (${esc(S.result.region.name)}); each source and component is priced in its own region`],
    ["Cross-region data transfer", "Charged when a source or streaming workload runs in a different region from BigQuery (~$0.02/GiB within a continent, ~$0.08/GiB between continents)"],
    ["Batch throughput per vCPU-hour", `${a.batch_gb_per_vcpu_hr.none} GB (no transform), ${a.batch_gb_per_vcpu_hr.light} GB (light), ${a.batch_gb_per_vcpu_hr.heavy} GB (heavy)`],
    ["Minimum per batch run", `${a.batch_min_vcpu_hr_per_run} vCPU-hour (Dataflow), ${a.datafusion_min_vcpu_hr_per_run} vCPU-hours (Data Fusion cluster), ${a.spark_min_dcu_hr_per_run} DCU-hours (Spark)`],
    ["Streaming capacity per vCPU", `${a.stream_gb_per_vcpu_day.none} / ${a.stream_gb_per_vcpu_day.light} / ${a.stream_gb_per_vcpu_day.heavy} GB per day (none / light / heavy); minimum ${a.stream_min_vcpu} vCPUs per job, always on`],
    ["Storage growth from change data", `${pct(a.net_new_ratio.cdc)} of CDC volume is net-new rows; ${pct(a.net_new_ratio.append)} for append-only sources`],
    ["Curated layers overhead", `+${pct(a.curated_layers_overhead)} storage for curated / mart tables`],
    ["Long-term storage", `${pct(a.longterm_share_after_90d)} of data older than 90 days is billed as long-term`],
    ["BigQuery scan volume", `${esc({ heuristic: "Rule of thumb", workload: "Workload sizing tab", measured: "Measured from INFORMATION_SCHEMA" }[S.result.bigquery.scan_basis])}: ELT ${S.result.bigquery.elt_scan_multiplier}x the data ingested, analytics ${S.result.bigquery.analytics_scan_multiplier}x the data stored per month (editable under BigQuery compute → Sizing &amp; calibration)`],
    ["BigQuery slots", `${S.result.bigquery.slot_hours_per_tib} slot-hours per TiB scanned${S.result.bigquery.calibrated ? " (calibrated)" : ""}; baseline billed every hour (commitment-eligible), autoscaling billed pay-as-you-go with a x${S.result.bigquery.autoscale_overhead} allowance for 50-slot steps and the 1-minute minimum; Standard edition max 1,600 slots, no baseline`],
    ["Non-production running hours", "Always-on services in each environment are scaled by its running hours (e.g. 12 h on weekdays = 36%); BigQuery in part-time environments uses autoscaling only"],
    ["Commercial terms", `${(S.result.commercial || {}).discount_pct || 0}% negotiated discount; Customer Care: ${esc((S.result.commercial || {}).support_plan || "none")}; discussion range ${(S.result.commercial || {}).range_low_pct ?? -25}% / +${(S.result.commercial || {}).range_high_pct ?? 30}%`],
    ["Partner products", "Power BI, Tableau, MicroStrategy, Qlik, ThoughtSpot, DataRobot, Dataiku, SageMaker, Azure ML, Databricks, Collibra, Alation, Atlan, Informatica are drawn and explained but never costed"],
    ["Contingency & operations", `${S.scenario.contingency_pct}% (monitoring, logging, dev/test, unknowns)`],
    ["Commitment discounts", "Applied to BigQuery edition baseline slots, Dataflow streaming, Composer, Agent Engine, AlloyDB, Cloud SQL, Spanner, Bigtable, Firestore, Memorystore and Knowledge Catalog premium processing; 1-year commitments are assumed renewed each year in the 3-year view"],
  ];
  host.innerHTML = `<div class="assume"><h3>Sizing assumptions</h3><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
    <h3>Price sources</h3><p><b>${esc(priceSource())}.</b> ${S.result.pricing_meta.live ? "Prices for the mapped SKUs come from the Google Cloud Billing Catalog (refreshed daily on Cloud Run) with per-region prices; the rest from the reviewed price file." : esc(S.result.pricing_meta.note)}</p>
    ${S.result.availability ? `<p>Regional availability: ${S.result.availability.source === "live" ? "checked against the Billing Catalog" : "not checked live (static rules)"} - ${S.result.availability.unavailable.length} service(s) not offered where they are placed.</p>` : ""}
    <ul>${S.result.pricing_meta.sources.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace("https://cloud.google.com/", ""))}</a></li>`).join("")}</ul>
    <p class="disclaimer">${esc(S.result.disclaimer)}</p></div>`;
}
