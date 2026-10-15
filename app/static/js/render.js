/* Data Cloud Compass - render.js (ES module, no build step). */
import { S } from "./state.js";
import { renderPills } from "./components.js";
import { $, STREAMING, esc } from "./core.js";
import { fmtGB, money, renderCost } from "./cost.js";
import { renderDiagram } from "./diagram.js";
import { renderEnvs } from "./environments.js";
import { renderBqPanel, renderBqDialog } from "./bigquery.js";
import { priceSource, renderNotices } from "./notices.js";
import { renderPlatform, renderRecs } from "./integrations.js";
import { OPT, OV, hasEstimate, optShort, optionSwitch } from "./pricing.js";
import { renderAssumptions, renderRoadmap } from "./roadmap.js";

// ------------------------------------------------------------------ rendering
export function renderAll() {
  renderEnvs();
  renderBqPanel();
  renderNotices();
  if (document.querySelector("#bqDialog")?.open) renderBqDialog();
  renderSources();
  renderPills();
  renderSummary();
  renderDiagram();
  renderRecs();
  renderPlatform();
  renderCost();
  renderAssumptions();
  renderRoadmap();
}

export function flowClass(freq) { return freq === "one_time" ? "once" : STREAMING.has(freq) ? "stream" : "batch"; }

export function recFor(id) { return S.result?.recommendations.find((r) => r.source_id === id); }

export function tool(id) { return S.catalog.tools[id] || { name: id, doc: "#" }; }

export function freqName(id) { return S.catalog.frequencies.find((f) => f.id === id)?.name || id; }

export function renderSources() {
  const list = $("#sourceList");
  const n = S.scenario.sources.length, inc = S.scenario.sources.filter((s) => s.included !== false).length;
  $("#sourceEmpty").hidden = n > 0;
  $("#srcBulk").hidden = n === 0;
  $("#srcCount").textContent = `${inc} of ${n} in this estimate`;
  list.innerHTML = S.scenario.sources.map((s) => {
    const r = recFor(s.id);
    const on = s.included !== false;
    const reg = s.region && s.region !== S.scenario.region ? ` · ${esc(s.region)}` : "";
    return `<li class="${on ? "" : "excluded"}"><label class="src-check" title="${on ? "Included" : "Excluded"} - untick to leave out of this phase">
        <input type="checkbox" data-include="${esc(s.id)}" ${on ? "checked" : ""} aria-label="Include ${esc(s.name)} in the estimate"></label>
      <button class="source-item" data-id="${esc(s.id)}" type="button">
      <i class="bar ${flowClass(s.frequency)}"></i>
      <div><b>${esc(s.name)}</b><span>${esc(freqName(s.frequency))} · ${fmtGB(s.daily_change_gb)}/day${reg}${on ? "" : " · not in this phase"}</span></div>
      <div class="tool">${r ? esc(tool(r.primary).name) : on ? "" : "Later phase"}</div>
    </button></li>`;
  }).join("");
}

export function renderSummary() {
  const el = $("#summaryStrip");
  if (!hasEstimate()) {
    el.innerHTML = S.catalog ? `<div class="note empty-sum">No consumption yet - the estimate starts as soon as you add a source system or a Google Cloud product to the architecture.</div>` : "";
    return;
  }
  const t = OV().totals, tp = OV("payg").totals;
  const nReg = S.result.by_region?.length || 1;
  const fig = (v, label, view) => `<button type="button" class="fig drill" data-drill="${view}" title="Show the products and pricing behind this figure"><b>${money(v)}</b><span>${label} <i aria-hidden="true">›</i></span></button>`;
  const saving = OPT() === "payg" ? "" : `<div class="opt-saving">Saves ${money(tp.three_year - t.three_year)} over 3 years vs pay-as-you-go (${tp.three_year ? Math.round(100 * (tp.three_year - t.three_year) / tp.three_year) : 0}%)</div>`;
  el.innerHTML = `<div class="opt-row"><span class="opt-label">Consumption pricing</span>${optionSwitch()}${saving}</div>`
    + fig(t.avg_monthly_year1, `Average per month, year 1`, "month")
    + fig(t.year1, `1-year, ${optShort()}`, "year1")
    + fig(t.three_year, `3-year, ${optShort()}`, "three")
    + `<div class="note">BigQuery in ${esc(S.result.region.name)}${nReg > 1 ? ` · ${nReg} regions in use` : ""} · ${S.result.recommendations.length} of ${S.scenario.sources.length} sources · ${S.scenario.components.filter((c) => c.included !== false).length} products · ${S.result.environments.length} environment${S.result.environments.length > 1 ? "s" : ""}<br><span class="price-src">${esc(priceSource())}</span></div>`;
}
