/* Data Cloud Compass - slotspage.js: BigQuery slots year by year (Product monitor → BigQuery slots).
 *
 * For each environment and year: the slots needed, what to commit (1-year renewed yearly, or one
 * 3-year commitment that can only grow), what autoscales on top, and the BigQuery compute cost -
 * for pay as you go, 1-year and 3-year commitments. Every header explains its calculation on hover. */
import { S } from "./state.js";
import { $, esc } from "./core.js";
import { money } from "./cost.js";
import { changed } from "./events.js";
import { EDITION_NAME, bq, isEditions, profileSvg, slotCell } from "./bigquery.js";
import { tip } from "./tips.js";

const OPTS = [["payg", "Pay as you go"], ["cud1", "1-year commitment"], ["cud3", "3-year commitment"]];
const YEARS = [1, 2, 3];
const ui = { opt: null, off: new Set() };            // selected option, environments left out of the totals
const fmt = (n, d = 0) => (n == null ? "-" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
const rate = (x) => `$${Number(x).toFixed(4)}`;
const pct = (save, base) => (base > 0 ? Math.round((100 * Math.abs(save)) / base) : 0);
/** "saves $X (n%)" or, when committing costs more than pay as you go, "costs $X (n%) more". */
const vsPayg = (save, base) => (save >= -0.5 ? `saves ${money(save)} (${pct(save, base)}%)` : `<span class="warn-txt">costs ${money(-save)} (${pct(save, base)}%) more</span>`);

function texts(p, r) {
  const sh = r.slot_hours_per_tib, sp = r.shape || {};
  const R = p.rates;
  const strat = p.commit_strategy === "average"
    ? "Cover average demand: the year's average slots rounded down to a 50-slot step. Environments averaging under 100 slots stay on autoscaling, because the 100-slot minimum would sit idle."
    : "Cost-optimal: every candidate (none, 100, 150, 200 … up to the max) is priced over the year's live months as commitment × 730 h × commitment rate + autoscaled slot-hours × pay-as-you-go rate; the cheapest wins.";
  return {
    avg: `Average slots in use across the year: slot-hours ÷ (live months × 730 h). Slot-hours = TiB scanned × ${sh} slot-hours per TiB${r.calibrated ? " (measured from the customer's jobs)" : ""}. Demand grows ${S.scenario.annual_growth_pct ?? 20}% a year.`,
    peak: `Busiest hour of an average day in the year's last month: dashboards and ad-hoc queries over ${sp.business_hours || 10} business hours × ${sp.peak_concurrency || 1.5} busiest-hour factor, plus pipelines in the ${sp.batch_window_hours || 6}-hour overnight window.`,
    max: "The reservation's maximum (baseline + autoscaling): the busiest hour, or a heavy query that must finish in its target time, rounded up to 100 slots and then 50-slot steps. Non-production = production max × the environment's compute share.",
    commit: `Slots committed for the year. ${strat} 1-year commitments are re-sized and renewed each year; a 3-year commitment covers all three years.`,
    topup: "A 3-year commitment can only grow. Top-up = this year's 3-year commitment − last year's. Each top-up is bought as a new 3-year commitment.",
    auto: "Slot-hours above the commitment (up to the max), × 1.25 for 50-slot scaling steps and the 1-minute minimum. Always billed at the pay-as-you-go rate.",
    cost: `BigQuery compute for the year: committed slots × 730 h × ${rate(R.cud1)} (1-yr) or ${rate(R.cud3)} (3-yr) per slot-hour + autoscaled slot-hours × ${rate(R.payg)} pay as you go. Pay as you go bills the whole reservation at ${rate(R.payg)}. Region uplift included.`,
    save: "(Pay-as-you-go cost − this option's cost) ÷ pay-as-you-go cost, over the same years and environments.",
    live: "Months of the year in which BigQuery is in use (sources go live during year 1). Commitments are bought at go-live.",
    compare: "The same demand priced three ways. Totals cover the environments ticked above.",
    table: "One row per environment and year. Pick the pricing option above; totals add up the ticked environments.",
    shared: "One commitment for all environments: reservations borrow each other's idle committed slots, so the combined commitment is sized on the combined demand. Usually fewer slots to commit than one commitment per environment.",
  };
}

/** Year rows for the ticked environments (or the shared commitment), for one option. */
function yearTotals(p, opt) {
  const envs = p.environments.filter((e) => !ui.off.has(e.id));
  return YEARS.map((y, i) => {
    if (p.shared_commitment) {
      const t = p.totals[i];
      return { commit: t.commitment[opt], topup: opt === "cud3" ? t.cud3_topup : 0, max: t.max, cost: t.cost[opt], avg: t.avg_slots, peak: t.peak_slots };
    }
    const rows = envs.map((e) => e.years[i]);
    const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
    return { commit: sum((r) => r.commitment[opt]), topup: opt === "cud3" ? sum((r) => r.cud3_topup) : 0, max: sum((r) => r.max),
      cost: sum((r) => r.cost[opt]), avg: sum((r) => r.avg_slots), peak: sum((r) => r.peak_slots) };
  });
}

export function renderSlotsPage() {
  const host = $("#slotsBody");
  if (!host) return;
  const r = S.result?.bigquery;
  if (!r || !r.active) { host.innerHTML = `<p class="empty-note">Add a source system that lands in BigQuery to size the slots.</p>`; return; }
  const ed = isEditions();
  const p = r.plan;
  ui.opt ||= ["payg", "cud1", "cud3"].includes(S.scenario.pricing_option) ? S.scenario.pricing_option : "cud3";
  const T = texts(p, r);
  let html = `<div class="explain">
    <p><b>What is a slot?</b> A slot is a unit of BigQuery computing power. With an edition you reserve a <b>baseline</b> that is always on - the only part a <b>1- or 3-year commitment</b> can discount - plus <b>autoscaling</b> up to a maximum, billed at the pay-as-you-go rate only while queries run. Commitments start at <b>100 slots</b> and grow in steps of <b>50</b>.</p>
    <p>Data grows every year, so slots are sized <b>separately for year 1, 2 and 3</b>. The same numbers feed Pricing, the exports and the proposal.</p></div>`;
  html += `<div class="slot-mode"><div class="seg" role="radiogroup" aria-label="BigQuery pricing model">
      <button type="button" role="radio" aria-checked="${!ed}" class="${!ed ? "on" : ""}" data-bq-mode="ondemand">On-demand (per TiB)</button>
      <button type="button" role="radio" aria-checked="${ed}" class="${ed ? "on" : ""}" data-bq-mode="editions">Editions (slots)</button></div>
    <span class="bq-rec ${((r.recommended_mode === "ondemand") === !ed) ? "ok" : "warn"}">Recommended for this workload: <b>${r.recommended_mode === "ondemand" ? "On-demand" : EDITION_NAME[r.recommended_edition] + " edition"}</b></span>
    <button type="button" class="link-btn" data-bq-open>Calibration &amp; edition comparison ›</button></div>`;
  if (!ed) {
    html += `<p class="hint">On-demand bills per TiB scanned, so there are no slots to reserve or commit. Switch to <b>Editions (slots)</b> to see the slots needed each year and the 1- and 3-year commitment options${r.recommended_mode !== "ondemand" ? " - recommended for this workload" : ""}.</p>`;
    host.innerHTML = html + assumptions(r);
    return;
  }
  if (p.edition === "standard") html += `<p class="notice info">Standard edition has no commitments - every slot autoscales at the pay-as-you-go rate. Choose Enterprise or Enterprise Plus to commit slots for 1 or 3 years.</p>`;

  // ---- controls
  html += `<div class="slot-controls">
    <div><span class="ctl-label">Pricing option ${tip("Shows the slots and cost for one option. Pay as you go has no commitment; 1-year commitments are renewed and re-sized each year; one 3-year commitment covers years 1-3 and can only grow.")}</span>
      <div class="seg small" role="radiogroup" aria-label="Pricing option">${OPTS.map(([o, n]) => `<button type="button" role="radio" aria-selected="${ui.opt === o}" aria-checked="${ui.opt === o}" data-slot-opt="${o}">${n}</button>`).join("")}</div></div>
    <div><span class="ctl-label">Commitment sizing ${tip(T.commit)}</span>
      <div class="seg small" role="radiogroup" aria-label="Commitment sizing">
        <button type="button" role="radio" aria-selected="${p.commit_strategy !== "average"}" data-slot-strat="optimal">Cost-optimal</button>
        <button type="button" role="radio" aria-selected="${p.commit_strategy === "average"}" data-slot-strat="average">Cover average demand</button></div></div>
    ${p.environments.length > 1 ? `<label class="chk"><input type="checkbox" data-slot-shared ${bq().shared_commitment ? "checked" : ""}> Share one commitment across environments ${tip(T.shared)}</label>` : ""}
  </div>`;
  if (p.environments.length > 1) {
    html += `<div class="env-pick"><span class="ctl-label">Environments in the totals ${tip(p.shared_commitment ? "With a shared commitment every environment is in the pool, so all are included." : "Tick the environments to add up - for example production only, or production and development.")}</span>
      ${p.environments.map((e) => `<label class="chk"><input type="checkbox" data-slot-env="${esc(e.id)}" ${ui.off.has(e.id) && !p.shared_commitment ? "" : "checked"} ${p.shared_commitment ? "disabled" : ""}> ${esc(e.name)}</label>`).join("")}</div>`;
  }

  // ---- headline per year for the selected option
  const yt = yearTotals(p, ui.opt), base = yearTotals(p, "payg");
  const tot = yt.reduce((a, y) => a + y.cost, 0), totP = base.reduce((a, y) => a + y.cost, 0);
  const optName = OPTS.find(([o]) => o === ui.opt)[1];
  html += `<div class="slot-years">${yt.map((y, i) => `<div class="sy">
      <span>Year ${i + 1} · ${esc(optName)}</span>
      <b>${ui.opt === "payg" ? `${fmt(y.max)} slots max` : `${fmt(y.commit)} committed`}</b>
      <small>${ui.opt === "payg" ? `${fmt(y.avg, 1)} average in use` : `+ autoscaling up to ${fmt(y.max)} slots`}${ui.opt === "cud3" && y.topup && i > 0 ? ` · <b>top-up ${fmt(y.topup)}</b>` : ""}</small>
      <em>${money(y.cost)}</em></div>`).join("")}
    <div class="sy total"><span>3 years · ${esc(optName)} ${tip(T.cost)}</span><b>${money(tot)}</b>
      <small>${ui.opt === "payg" ? "no commitment" : `${vsPayg(totP - tot, totP)} than pay as you go ${tip(T.save)}`}</small></div></div>`;
  if (ui.opt !== "payg" && yt.every((y) => !y.commit)) html += zeroCommitNote(p);
  else if (ui.opt !== "payg" && tot > totP + 0.5) html += `<p class="hint"><b>Why does committing cost more here?</b> Most demand comes in the overnight batch window and business hours, so slots committed around the clock sit idle part of the day. ${p.commit_strategy === "average" ? "Switch <b>Commitment sizing</b> to <b>Cost-optimal</b> to commit only what pays off." : "Commit less, or keep this workload on autoscaling."}</p>`;

  // ---- per environment and year
  const showTop = ui.opt === "cud3";
  html += `<h3>Slots and cost by environment and year ${tip(T.table)}</h3>
    <div class="tbl-scroll"><table class="bom-table slot-plan"><thead><tr>
      <th>Environment</th><th>Year</th>
      <th class="num">Average in use ${tip(T.avg)}</th><th class="num">Busiest hour ${tip(T.peak)}</th>
      <th class="num">Max slots ${tip(T.max)}</th>
      <th class="num">${ui.opt === "payg" ? "Baseline" : "Committed"} ${tip(ui.opt === "payg" ? "Pay as you go: an always-on baseline is billed at the pay-as-you-go rate; it only pays off for demand that runs most of the day, so it is usually none." : T.commit)}</th>
      ${showTop ? `<th class="num">Top-up ${tip(T.topup)}</th>` : ""}
      <th class="num">Autoscaled slot-hours ${tip(T.auto)}</th><th class="num">Cost ${tip(T.cost)}</th></tr></thead><tbody>`;
  const envRows = p.shared_commitment ? p.environments : p.environments.filter((e) => !ui.off.has(e.id));
  envRows.forEach((e, k) => {
    e.years.forEach((y, i) => {
      html += `<tr class="${i === 2 ? "env-end" : ""}">${i === 0 ? `<th rowspan="3" scope="rowgroup"><span class="env-dot e${Math.min(p.environments.indexOf(e), 5)}"></span>${esc(e.name)}</th>` : ""}
        <td>Year ${i + 1}${y.live_months && y.live_months < 12 ? ` <small class="muted" data-tip="${esc(T.live)}">${y.live_months} mo live</small>` : ""}</td>
        <td class="num">${fmt(y.avg_slots, 1)}</td><td class="num">${fmt(y.peak_slots)}</td><td class="num">${fmt(y.max)}</td>
        <td class="num"><b>${p.shared_commitment && ui.opt !== "payg" ? "<small>shared</small>" : y.baseline[ui.opt] ? fmt(y.baseline[ui.opt]) : "-"}</b></td>
        ${showTop ? `<td class="num">${p.shared_commitment ? "-" : y.cud3_topup ? (i ? "+" : "new ") + fmt(y.cud3_topup) : "-"}</td>` : ""}
        <td class="num">${fmt(y.autoscale_slot_hours[ui.opt])}</td>
        <td class="num">${p.shared_commitment && ui.opt !== "payg" ? "<small>in total</small>" : money(y.cost[ui.opt])}</td></tr>`;
    });
  });
  yt.forEach((y, i) => {
    html += `<tr class="slot-total">${i === 0 ? `<th rowspan="3" scope="rowgroup">${p.shared_commitment ? "Shared commitment" : "Total"}</th>` : ""}
      <td>Year ${i + 1}</td><td class="num">${fmt(y.avg, 1)}</td><td class="num">${fmt(y.peak)}</td><td class="num">${fmt(y.max)}</td>
      <td class="num"><b>${y.commit ? fmt(y.commit) : "-"}</b></td>${showTop ? `<td class="num">${y.topup ? (i ? "+" : "new ") + fmt(y.topup) : "-"}</td>` : ""}
      <td class="num"></td><td class="num"><b>${money(y.cost)}</b></td></tr>`;
  });
  html += `</tbody></table></div>`;

  // ---- the three options side by side
  html += `<h3>Compare the options ${tip(T.compare)}</h3><div class="tbl-scroll"><table class="bom-table slot-compare"><thead><tr><th>Option</th>
      ${YEARS.map((y) => `<th class="num">Year ${y} slots ${tip(y === 1 ? "Committed slots (pay as you go: maximum slots) in this year, for the ticked environments." : "Same, for this year. With a 3-year commitment the number only grows.")}</th>`).join("")}
      ${YEARS.map((y) => `<th class="num">Year ${y} cost ${tip(T.cost)}</th>`).join("")}
      <th class="num">3-year total</th><th class="num">Saving ${tip(T.save)}</th></tr></thead><tbody>
    ${OPTS.map(([o, n]) => { const t = yearTotals(p, o), s = t.reduce((a, y) => a + y.cost, 0);
      return `<tr class="${o === ui.opt ? "on" : ""}"><th scope="row">${esc(n)}</th>
        ${t.map((y) => `<td class="num">${o === "payg" ? `<small>max</small> ${fmt(y.max)}` : fmt(y.commit) + (o === "cud3" && y.topup ? ` <small>(+${fmt(y.topup)})</small>` : "")}</td>`).join("")}
        ${t.map((y) => `<td class="num">${money(y.cost)}</td>`).join("")}
        <td class="num"><b>${money(s)}</b></td><td class="num">${o === "payg" ? "-" : vsPayg(totP - s, totP)}</td></tr>`; }).join("")}
    </tbody></table></div>`;

  // ---- overrides
  html += `<h3>Change the reservation ${tip("Grey numbers are the recommendation for the steady-state year. A baseline you type is used as the commitment in every year and option (values under 100 become 100; others round up to a 50-slot step); clear the box to go back to the recommendation.")}</h3>
    <table class="es-table slot-edit"><thead><tr><th>Environment</th><th>Baseline / commitment</th><th>Max</th></tr></thead><tbody>
    ${S.scenario.environments.map((e, i) => `<tr><td>${esc(e.name)}</td><td>${slotCell(i, "baseline")}</td><td>${slotCell(i, "max")}</td></tr>`).join("")}</tbody></table>
    <label class="bq-ed">Edition ${tip("Commitments need Enterprise or Enterprise Plus. The recommendation follows the security and AI features in the architecture.")}<select id="bqEdition"><option value="auto"${bq().edition === "auto" ? " selected" : ""}>Recommend for me (${esc(EDITION_NAME[r.recommended_edition] || "")})</option>
    ${Object.entries(EDITION_NAME).map(([k, n]) => `<option value="${k}"${bq().edition === k ? " selected" : ""}>${n}</option>`).join("")}</select></label>`;
  host.innerHTML = html + assumptions(r);
}

function zeroCommitNote(p) {
  const prod = p.environments[0]?.years || [];
  const alt = prod.map((y) => y.at_average).filter(Boolean);
  if (!alt.length) return "";
  const o = ui.opt;
  const extra = prod.reduce((a, y) => a + (y.at_average ? y.at_average.cost[o] - y.cost[o] : 0), 0);
  return `<p class="hint"><b>Why no commitment?</b> Demand runs only part of the day, so slots committed around the clock would cost more than autoscaling.
    If the customer still wants to commit, ${esc(p.environments[0].name)} would commit ${prod.map((y, i) => y.at_average ? `${fmt(y.at_average.slots[o])} in year ${i + 1}` : null).filter(Boolean).join(", ")}
    for about ${money(Math.max(0, extra))} more over three years - choose <b>Cover average demand</b> above, or type a baseline under <i>Change the reservation</i>.</p>`;
}

function assumptions(r) {
  return `<h3>When the slots are used (production, steady-state month) ${tip("Average 24-hour demand used to size the reservation: pipelines in the overnight window, dashboards and queries in business hours.")}</h3><div class="slot-grid slots-page"><div class="chart-wrap">${profileSvg(r)}</div>
    <div><p class="sub">Assumptions</p><ul class="slot-recs">
      <li>${r.slot_hours_per_tib} slot-hours per TiB scanned${r.calibrated ? " (measured)" : " (typical for mixed BI and ELT)"}.</li>
      ${(r.scan_by_class || []).map((c) => `<li>${esc(c.class)}: ${c.tib_month.toLocaleString(undefined, { maximumFractionDigits: 2 })} TiB / month → ${c.slot_hours_month.toLocaleString()} slot-hours.</li>`).join("")}
      <li>Pipelines run in a ${r.shape.batch_window_hours}-hour overnight window; reports and dashboards over ${r.shape.business_hours} business hours, busiest hour ×${r.shape.peak_concurrency}.</li>
      <li>Autoscaling billed with a ×${r.autoscale_overhead} allowance for 50-slot steps and the 1-minute minimum.</li>
      <li>Other environments use their compute share of production; part-time environments get no baseline.</li>
      <li>Each year is sized on its own demand; 1-year commitments are renewed yearly, a 3-year commitment only grows.</li></ul>
      <p class="sub">Why this edition</p><ul class="slot-recs reasons">${(r.edition_reasons || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>`;
}

export function bindSlotsPage() {
  const host = $("#slotsBody");
  if (!host) return;
  host.addEventListener("click", (e) => {
    const o = e.target.closest("[data-slot-opt]");
    if (o) { ui.opt = o.dataset.slotOpt; renderSlotsPage(); return; }
    const s = e.target.closest("[data-slot-strat]");
    if (s) { bq().commit_strategy = s.dataset.slotStrat; changed(); }
  });
  host.addEventListener("change", (e) => {
    const v = e.target.closest("[data-slot-env]");
    if (v) { if (v.checked) ui.off.delete(v.dataset.slotEnv); else ui.off.add(v.dataset.slotEnv); renderSlotsPage(); return; }
    if (e.target.closest("[data-slot-shared]")) { bq().shared_commitment = e.target.checked; changed(); }
  });
}
