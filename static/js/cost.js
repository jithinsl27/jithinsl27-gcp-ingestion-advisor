/* Data Cloud Compass - cost.js (ES module, no build step). */
import { S } from "./state.js";
import { $, esc } from "./core.js";
import { envSizingSection } from "./environments.js";
import { OPT, OPTIONS, OPT_NOTE, OV, bomCost, compMeta, envOpt, hasEstimate, optShort } from "./pricing.js";

// ---------------- cost
export function fx() { return (S.result || S.wlResult)?.fx?.[S.currency] || 1; }

export const GROUP_COLORS = {
  "Data ingestion & CDC": "#F9AB00", "BigQuery & storage": "#1A73E8", "Analytics & AI": "#9334E6", "APIs & databases": "#E52592",
  "Governance & security": "#12A4AF", "Platform & network": "#34A853", "Contingency": "#9AA0A6",
};

export function money(usd, digits) {
  const v = usd * fx();
  const d = digits ?? (Math.abs(v) >= 1000 ? 0 : 2);
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: S.currency, maximumFractionDigits: d, minimumFractionDigits: d }).format(v); }
  catch (_) { return `${S.currency} ${v.toFixed(d)}`; }
}

export function moneyShort(usd) {
  const v = usd * fx();
  const a = Math.abs(v);
  const s = a >= 1e6 ? (v / 1e6).toFixed(1) + "M" : a >= 1e3 ? (v / 1e3).toFixed(0) + "k" : v.toFixed(0);
  return `${S.currency === "USD" ? "$" : S.currency + " "}${s}`;
}

export function fmtGB(gb) {
  gb = Number(gb) || 0;
  if (gb >= 1024 * 1024) return (gb / 1024 / 1024).toFixed(1) + " PB";
  if (gb >= 1024) return (gb / 1024).toFixed(gb >= 10240 ? 0 : 1) + " TB";
  return (gb >= 10 ? gb.toFixed(0) : +gb.toFixed(2)) + " GB";
}

export function regionTable(rows) {
  if (!rows || rows.length < 1) return "";
  return `<h3>By region</h3><div style="overflow-x:auto"><table><thead><tr><th>Region</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
    + rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${money(r.year1)}</td><td>${money(r.three_year)}</td></tr>`).join("")
    + `</tbody></table></div>`;
}

export function renderCost() {
  const host = $("#costBody");
  if (S.bomEnv && S.bomEnv !== "all" && !(S.result?.environments || []).some((e) => e.id === S.bomEnv)) S.bomEnv = null;
  if (!hasEstimate()) { host.innerHTML = `<p class="empty-note">Nothing is priced yet. The estimate appears once you add a source system or a Google Cloud product to the architecture. For a workload-based estimate without sources, use Workload sizing.</p>`; return; }
  const t = S.result.totals, ov = OV();
  const optRows = (field) => OPTIONS.map((o) => `<div class="row${o.id === OPT() ? " sel" : ""}"><span>${esc(o.name)}</span><span>${money(OV(o.id).totals[field])}</span></div>`).join("");
  let html = `<p class="hint opt-note">${esc(OPT_NOTE[OPT()])} Switch pricing in the bar above.</p>
    <div class="horizon">
    <div class="card"><h3>1-year consumption <button type="button" class="link-btn" data-drill="year1">Products &amp; pricing ›</button></h3><div class="big">${money(ov.totals.year1)}</div>
      <div class="sub-opt">${esc(optShort())} · ${money(ov.totals.avg_monthly_year1)} per month</div>
      ${optRows("year1")}
      <div class="range">Discussion range ${money(t.range_low_1y)} to ${money(t.range_high_1y)}</div></div>
    <div class="card"><h3>3-year consumption <button type="button" class="link-btn" data-drill="three">Products &amp; pricing ›</button></h3><div class="big">${money(ov.totals.three_year)}</div>
      <div class="sub-opt">${esc(optShort())} · year 1 / 2 / 3: ${moneyShort(ov.totals.year1)} / ${moneyShort(ov.totals.year2)} / ${moneyShort(ov.totals.year3)}</div>
      ${optRows("three_year")}
      <div class="range">Discussion range ${money(t.range_low_3y)} to ${money(t.range_high_3y)}</div></div>
  </div>`;
  html += `<h3>By capability <small class="opt-tag">${esc(optShort())}</small></h3><div class="groups">${ov.by_group.filter((g) => g.three_year > 0).map((g) =>
    `<div><span>${esc(g.group)}</span><b>${money(g.year1)}</b><span>year 1 · ${money(g.three_year)} over 3 years</span></div>`).join("")}</div>`;
  const envs = (S.result.environments || []).map(envOpt);
  if (envs.length > 1) {
    const maxE = Math.max(...envs.map((e) => e.three_year), 1);
    html += `<h3>By environment</h3><div style="overflow-x:auto"><table class="env-table"><thead><tr><th>Environment</th><th>Sizing vs ${esc(envs[0].name)}</th><th>Per month (yr 1)</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
      + envs.map((e, i) => `<tr><td><span class="env-dot e${Math.min(i, 5)}"></span>${esc(e.name)}<span class="share" style="width:${Math.max(2, 60 * e.three_year / maxE)}px"></span></td>
        <td class="env-f">${i === 0 ? "Baseline" : S.catalog.environment_factors.map((f) => `${esc(f.name.replace(" %", ""))} ${+e.factors[f.id]}%`).join(" · ") + (e.slots ? ` · slots ${e.slots.baseline} → ${e.slots.max}` : "")}</td>
        <td>${money(e.monthly_year1)}</td><td>${money(e.year1)}</td><td>${money(e.three_year)}</td></tr>`).join("")
      + `</tbody></table></div>`;
  }
  html += envSizingSection();
  const cmpId = OPT() === "payg" ? "cud3" : OPT();
  const series = OV("payg").monthly.map((v, i) => ({ month: i + 1, payg: v, cud3: OV(cmpId).monthly[i] }));
  html += `<h3>Monthly run-rate over 36 months</h3><div class="chart-key"><span><i></i>Pay-as-you-go</span><span><i class="cud"></i>With ${cmpId === "cud1" ? "1-year" : "3-year"} commitments</span></div>
    <div class="chart-wrap">${chartSvg(series)}</div>`;
  html += bomSection();
  const svcRows = ov.by_service;
  const paygSvc = Object.fromEntries(OV("payg").by_service.map((r) => [r.key, r]));
  const maxSvc = Math.max(...svcRows.map((s) => s.three_year), 1);
  const isPayg = OPT() === "payg";
  html += `<h3>By service <small class="opt-tag">${esc(optShort())}</small></h3><p class="hint">Untick a service to leave it out of every total, the roadmap and workload sizing; tick it again to bring it back.</p>
    <div style="overflow-x:auto"><table class="svc-table"><thead><tr><th>Service</th><th>Year 1</th><th>3 years</th>${isPayg ? "" : "<th>3 years, pay-as-you-go</th><th>Saving</th>"}</tr></thead><tbody>`
    + svcRows.map((s) => { const p = paygSvc[s.key]?.three_year || 0; return `<tr><td><label class="svc-toggle"><input type="checkbox" data-svc="${esc(s.key)}" checked aria-label="Include ${esc(s.key)} in pricing"> ${esc(s.key)}</label><span class="share" style="width:${Math.max(2, 60 * s.three_year / maxSvc)}px"></span></td><td>${money(s.year1)}</td><td>${money(s.three_year)}</td>${isPayg ? "" : `<td>${money(p)}</td><td>${p - s.three_year > 0.5 ? money(p - s.three_year) : "-"}</td>`}</tr>`; }).join("")
    + S.scenario.excluded_services.map((svc) => `<tr class="svc-off"><td><label class="svc-toggle"><input type="checkbox" data-svc="${esc(svc)}" aria-label="Include ${esc(svc)} in pricing"> ${esc(svc)}</label></td><td colspan="${isPayg ? 2 : 4}">Not priced</td></tr>`).join("")
    + `</tbody><tfoot><tr><td>Total</td><td>${money(ov.totals.year1)}</td><td>${money(ov.totals.three_year)}</td>${isPayg ? "" : `<td>${money(OV("payg").totals.three_year)}</td><td>${money(OV("payg").totals.three_year - ov.totals.three_year)}</td>`}</tr></tfoot></table></div>`;
  html += regionTable(ov.by_region);
  html += `<h3>By source system</h3><div style="overflow-x:auto"><table><thead><tr><th>Source</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
    + ov.by_source.map((s) => `<tr><td>${esc(s.name)}</td><td>${money(s.year1)}</td><td>${money(s.three_year)}</td></tr>`).join("")
    + `</tbody></table></div>`;
  const partners = S.scenario.components.filter((c) => compMeta(c.type).vendor === "partner").map((c) => compMeta(c.type).name);
  if (partners.length) html += `<p class="hint">Not costed (partner products): ${esc(partners.join(", "))}.</p>`;
  const unpriced = S.scenario.components.filter((c) => c.included === false).map((c) => compMeta(c.type).name);
  if (unpriced.length) html += `<p class="hint">Left out of pricing by choice: ${esc(unpriced.join(", "))}.</p>`;
  html += `<p class="disclaimer">${esc(S.result.disclaimer)}${S.currency !== "USD" ? ` Converted from USD at ${fx()} ${S.currency}/USD.` : ""}</p>`;
  host.innerHTML = html;
}

export const fmtQty = (q) => q == null ? "-" : q >= 1e6 ? (q / 1e6).toFixed(2) + "M" : q >= 1e4 ? Math.round(q).toLocaleString() : (+q.toPrecision(4)).toLocaleString();

export function unitPrice(p) {
  if (p == null) return "-";
  const v = p * fx();
  const d = v >= 100 ? 0 : v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
  return money(p, d);
}

export function bomRows() {
  if (!S.bomEnv) S.bomEnv = S.result?.environments?.[0]?.id || "all";
  return (S.result?.bom || []).filter((b) => S.bomEnv === "all" || b.environment === S.bomEnv);
}

export function bomSection() {
  const envs = S.result.environments || [];
  const rows = bomRows();
  const multi = envs.length > 1;
  let html = `<h3>Bill of materials <small class="opt-tag">${esc(optShort())}</small></h3><p class="hint">Every priced product with its quantity, effective unit price, cost and why it is needed. Quantities are for month 12 (run-rate) and year 1; unit price is the blended year-1 price including regional uplift and tiers.</p>`;
  if (multi) html += `<div class="bom-filter" role="group" aria-label="Environment">${[{ id: "all", name: "All environments" }, ...envs].map((e) =>
    `<button type="button" class="chip-btn${S.bomEnv === e.id ? " on" : ""}" data-bom-env="${esc(e.id)}">${esc(e.name)}</button>`).join("")}</div>`;
  let lastGroup = null, lastEnv = null;
  const body = rows.map((b) => {
    let head = "";
    if (multi && S.bomEnv === "all" && b.environment !== lastEnv) { head += `<tr class="bom-env"><th colspan="8">${esc(b.environment_name)}</th></tr>`; lastGroup = null; }
    if (b.group !== lastGroup) head += `<tr class="bom-group"><th colspan="8"><i style="background:${GROUP_COLORS[b.group] || "#9AA0A6"}"></i>${esc(b.group)}</th></tr>`;
    lastGroup = b.group; lastEnv = b.environment;
    return head + `<tr><td class="bom-prod"><b>${esc(b.service)}</b><span>${esc(b.why)}</span></td>
      <td>${fmtQty(b.qty_month12)}</td><td>${fmtQty(b.qty_year1)}</td><td class="bom-unit">${esc(b.unit || "-")}</td><td>${unitPrice(b.qty_year1 ? bomCost(b, "year1") / b.qty_year1 : null)}</td>
      <td>${money(bomCost(b, "month12"))}</td><td>${money(bomCost(b, "year1"))}</td><td>${money(bomCost(b, "three_year"))}</td></tr>`;
  }).join("");
  const sum = (k) => rows.reduce((a, b) => a + bomCost(b, k), 0);
  html += `<div style="overflow-x:auto"><table class="bom-table"><thead><tr><th>Product &amp; why it is needed</th><th>Qty / month (M12)</th><th>Qty, year 1</th><th>Unit</th><th>Unit price</th><th>Month 12</th><th>Year 1</th><th>3 years</th></tr></thead>
    <tbody>${body}</tbody><tfoot><tr><td>Total${S.bomEnv !== "all" ? " - " + esc(envs.find((e) => e.id === S.bomEnv)?.name || "") : ""}</td><td></td><td></td><td></td><td></td><td>${money(sum("month12"))}</td><td>${money(sum("year1"))}</td><td>${money(sum("three_year"))}</td></tr></tfoot></table></div>`;
  return html;
}

export function chartSvg(monthly, marker) {
  const W = 900, H = 240, L = 64, R = 12, T = 12, B = 30;
  const max = Math.max(...monthly.map((m) => m.payg), 1) * 1.08;
  const x = (i) => L + (W - L - R) * (i / (monthly.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const path = (k) => monthly.map((m, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(m[k]).toFixed(1)}`).join(" ");
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const v = (max / 4) * g;
    grid += `<line class="chart-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(moneyShort(v))}</text>`;
  }
  [0, 11, 23, 35].forEach((i) => (grid += `<text class="chart-axis" x="${x(i)}" y="${H - 8}" text-anchor="middle">${i === 0 ? "Month 1" : "M" + (i + 1)}</text>`));
  [12, 24].forEach((i) => (grid += `<line class="chart-grid" stroke-dasharray="3 3" x1="${x(i - 0.5)}" x2="${x(i - 0.5)}" y1="${T}" y2="${H - B}"/>`));
  if (marker) grid += `<line class="chart-marker" x1="${x(marker - 0.5)}" x2="${x(marker - 0.5)}" y1="${T}" y2="${H - B}"/><text class="chart-axis" x="${x(marker - 0.5) + 6}" y="${T + 12}">Steady state</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly cost over 36 months">${grid}<path class="chart-line cud" d="${path("cud3")}"/><path class="chart-line payg" d="${path("payg")}"/></svg>`;
}
