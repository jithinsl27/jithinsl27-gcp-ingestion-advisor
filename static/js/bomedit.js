/* Data Cloud Compass - bomedit.js: recommended specification per environment and the editable bill of materials.
 *
 * Edits are stored in the scenario (bom_overrides: service, environment, qty per month and/or unit price) and
 * applied by the engine, so every total, plan, chart and export reflects them.
 */
import { S } from "./state.js";
import { $, $$, esc, toast } from "./core.js";
import { GROUP_COLORS, fmtQty, money, moneyShort, unitPrice } from "./cost.js";
import { changed } from "./events.js";
import { regionName } from "./main.js";

export const OPT_OF = { payg_1y: "payg", commit_1y: "cud1", commit_3y: "cud3", payg_3y: "payg" };
const PLAN_NAME = { payg_1y: "Pay as you go - 1 year", commit_1y: "1-year commitment", commit_3y: "3-year commitment", payg_3y: "Pay as you go - 3 years" };
const EDITION = { standard: "Standard", enterprise: "Enterprise", enterprise_plus: "Enterprise Plus" };
export const ed = { plan: "payg_1y", env: "all", q: "", open: false, draft: {} };

const rowCost = (b, opt, field = "month12") => (opt === "payg" ? b[field] : b[opt]?.[field] ?? b[field]);
const overrides = () => (S.scenario.bom_overrides ||= []);
const ovFor = (svc, env) => overrides().find((o) => o.service === svc && o.environment === env);

// ------------------------------------------------------------------ recommended specification per environment
export function envSpecSection(planKey) {
  const r = S.result;
  if (!r?.environments?.length) return "";
  const opt = OPT_OF[planKey] || "payg";
  const specs = Object.fromEntries((r.bigquery?.env_specs || []).map((x) => [x.id, x]));
  const editions = S.scenario.bq?.mode === "editions";
  const tot = r.bigquery?.project_totals?.[opt];
  let html = `<h3>Recommended specification per environment <small class="muted">${esc(PLAN_NAME[planKey])} · steady month (month 12)</small></h3>`;
  if (tot && editions) html += `<p class="hint">BigQuery for the whole project: <b>${tot.commitment ? `${tot.commitment} committed slots` : "no slot commitment"}</b> (baseline ${tot.baseline}) and up to <b>${tot.max}</b> slots with autoscaling across all environments - about ${money(tot.monthly)} per month. Slot rules: baseline and commitments start at 100 slots and grow in steps of 50; autoscaling adds slots in steps of 50 and is always pay as you go.</p>`;
  html += `<div class="spec-grid">`;
  r.environments.forEach((e, i) => {
    const rows = (r.bom || []).filter((b) => b.environment === e.id && Math.abs(rowCost(b, opt)) >= 0.5).sort((a, b) => rowCost(b, opt) - rowCost(a, opt));
    const month = rows.reduce((a, b) => a + rowCost(b, opt), 0);
    const sp = specs[e.id];
    const o = sp?.by_option?.[opt];
    const f = e.factors || {};
    const bqLine = !sp ? "" : editions
      ? `<div class="spec-bq"><b>BigQuery ${esc(EDITION[sp.edition] || "")}</b>
          <span>${o.commitment ? `${o.commitment} slots committed` : o.baseline ? `${o.baseline} baseline slots (pay as you go)` : "No baseline - autoscaling only"} · max ${o.max} slots</span>
          <small>Demand: average ${sp.avg_slots} slots, busiest hour ${Math.round(sp.peak_slots)} · ${money(o.monthly)}/month${o.with_min_commitment ? ` · a 100-slot commitment would cost ${money(o.with_min_commitment)}/month` : ""}</small></div>`
      : `<div class="spec-bq"><b>BigQuery on-demand</b><span>${(sp.tib_month || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })} TiB scanned / month</span>
          <small>${money(sp.ondemand_month)}/month · editions would need up to ${o?.max || 0} slots (see BigQuery slots)</small></div>`;
    html += `<article class="spec-card"><header><span class="env-dot e${Math.min(i, 5)}"></span><b>${esc(e.name)}</b><span class="spec-cost">${money(month)}<small>/month</small></span></header>
      ${bqLine}
      <table class="spec-table"><thead><tr><th>Product</th><th>Qty / month</th><th>Unit price</th><th>Per month</th></tr></thead><tbody>
      ${rows.slice(0, 7).map((b) => `<tr><td>${esc(b.service)}</td><td>${b.unit ? `${fmtQty(b.qty_month12)} <small>${esc(b.unit)}</small>` : "-"}</td><td>${b.unit_price != null ? unitPrice(b.unit_price) : "-"}</td><td>${money(rowCost(b, opt))}</td></tr>`).join("")}
      </tbody></table>
      ${rows.length > 7 ? `<p class="hint">+ ${rows.length - 7} more products</p>` : ""}
      <p class="spec-assume">${i === 0 ? "Sized from your sources, products and workload." : `Sized at ${["data_pct", "ingestion_pct", "compute_pct", "ai_pct"].map((k) => `${({ data_pct: "data", ingestion_pct: "ingestion", compute_pct: "compute", ai_pct: "AI" })[k]} ${+f[k]}%`).join(", ")} of ${esc(r.environments[0].name)}; runs ${Math.round((+f.runtime_pct || 100) * 1.68)} h/week.`}</p>
      <button type="button" class="link-btn" data-bom-open data-bom-env="${esc(e.id)}">Full specification &amp; edit ›</button></article>`;
  });
  return html + `</div>`;
}

// ------------------------------------------------------------------ editable bill of materials (dialog)
export function openBomEditor(planKey, env = "all") {
  ed.plan = planKey || ed.plan;
  ed.env = env;
  ed.draft = {};
  ed.open = true;
  renderBomEditor();
  const d = $("#drillDialog");
  if (!d.open) d.showModal();
}

export function renderBomEditor() {
  if (!ed.open) return;
  const r = S.result;
  const host = $("#drillBody");
  $("#drillTitle").textContent = `Bill of materials - ${PLAN_NAME[ed.plan]}`;
  if (!r) { host.innerHTML = "<p>Calculating…</p>"; return; }
  const opt = OPT_OF[ed.plan];
  const months = ed.plan === "commit_3y" || ed.plan === "payg_3y" ? 36 : 12;
  const planField = months === 36 ? "three_year" : "year1";
  const envs = r.environments || [];
  const q = ed.q.toLowerCase();
  const rows = (r.bom || []).filter((b) => (ed.env === "all" || b.environment === ed.env) && (!q || b.service.toLowerCase().includes(q) || b.group.toLowerCase().includes(q)))
    .filter((b) => Math.abs(b.three_year) >= 0.5);
  const edits = overrides().length;
  let html = `<div class="bom-tools">
    <label>Environment <select data-bom-env-sel><option value="all">All environments</option>${envs.map((e) => `<option value="${esc(e.id)}"${ed.env === e.id ? " selected" : ""}>${esc(e.name)}</option>`).join("")}</select></label>
    <label>Plan <select data-bom-plan>${Object.entries(PLAN_NAME).map(([k, n]) => `<option value="${k}"${ed.plan === k ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
    <label class="grow">Find <input type="search" data-bom-q value="${esc(ed.q)}" placeholder="Product or capability"></label>
    <span class="spacer"></span>
    ${edits ? `<button type="button" class="btn ghost small" data-bom-resetall>Reset all ${edits} edit${edits === 1 ? "" : "s"}</button>` : ""}
    <button type="button" class="btn primary small" data-bom-apply disabled>Apply changes</button></div>
    <p class="hint">Change a <b>quantity per month</b> or a <b>unit price</b> and press Apply - the whole application (plans, environments, roadmap, exports and proposal) is recalculated. Commitment discounts keep their ratio to the new price. Quantities are for month 12 (steady state); earlier months scale the same way.</p>`;
  html += `<div style="overflow-x:auto"><table class="bom-table bom-edit"><thead><tr><th>Environment</th><th>Product</th><th>Region</th><th>Unit</th><th class="num">Qty / month</th><th class="num">Unit price (${esc(S.currency)})</th><th class="num">Per month</th><th class="num">${months === 36 ? "3 years" : "12 months"} (${esc(PLAN_NAME[ed.plan])})</th><th></th></tr></thead><tbody>`;
  let lastG = null, tm = 0, tp = 0;
  rows.sort((a, b) => (a.group > b.group ? 1 : a.group < b.group ? -1 : 0) || rowCost(b, opt, planField) - rowCost(a, opt, planField)).forEach((b) => {
    if (b.group !== lastG) { html += `<tr class="bom-group"><th colspan="9"><i style="background:${GROUP_COLORS[b.group] || "#9AA0A6"}"></i>${esc(b.group)}</th></tr>`; lastG = b.group; }
    const ov = ovFor(b.service, b.environment);
    const k = `${b.environment}|${b.service}`;
    const pm = rowCost(b, opt), pt = rowCost(b, opt, planField);
    tm += pm; tp += pt;
    const editable = !["Contingency & operations", "Negotiated discount"].includes(b.service) && !b.service.startsWith("Google Cloud Customer Care");
    html += `<tr class="${b.edited ? "edited" : ""}"><td>${esc(b.environment_name)}</td><td><b>${esc(b.service)}</b>${b.edited ? ` <span class="tag">edited</span>` : ""}</td>
      <td>${esc(b.region ? regionName(b.region) : "-")}</td><td class="bom-unit">${esc(b.unit || "-")}</td>
      <td class="num">${editable && b.unit ? `<input type="number" min="0" step="any" data-bom-k="${esc(k)}" data-bom-f="qty" value="${+(+b.qty_month12).toPrecision(6)}" aria-label="${esc(b.service)} quantity">` : b.unit ? fmtQty(b.qty_month12) : "-"}</td>
      <td class="num">${editable && b.unit && b.unit_price != null ? `<input type="number" min="0" step="any" data-bom-k="${esc(k)}" data-bom-f="unit_price" value="${+(+b.unit_price).toPrecision(6)}" aria-label="${esc(b.service)} unit price">`
        : editable && !b.unit ? `<input type="number" min="0" step="any" data-bom-k="${esc(k)}" data-bom-f="monthly" value="${+(+b.month12).toFixed(2)}" aria-label="${esc(b.service)} monthly cost" title="No unit: edit the monthly cost">` : b.unit_price != null ? unitPrice(b.unit_price) : "-"}</td>
      <td class="num">${money(pm)}</td><td class="num"><b>${money(pt)}</b></td>
      <td>${ov ? `<button type="button" class="link-btn" data-bom-reset="${esc(k)}" title="Back to the calculated value">Reset</button>` : ""}</td></tr>`;
  });
  html += `</tbody><tfoot><tr><td colspan="6">Total${ed.env === "all" ? "" : " for this environment"} </td><td class="num">${money(tm)}</td><td class="num">${money(tp)}</td><td></td></tr></tfoot></table></div>`;
  host.innerHTML = html;
}

function key2(k) { const i = k.indexOf("|"); return [k.slice(0, i), k.slice(i + 1)]; }

export function bindBomEditor(showPricing) {
  const d = $("#drillDialog");
  d.addEventListener("close", () => { ed.open = false; });
  document.addEventListener("click", (e) => {
    const o = e.target.closest("[data-bom-open]");
    if (o) { openBomEditor(showPricing(), o.dataset.bomEnv || "all"); return; }
    if (!ed.open || !d.contains(e.target)) return;
    if (e.target.closest("[data-bom-apply]")) {
      Object.entries(ed.draft).forEach(([k, f]) => {
        const [env, svc] = key2(k);
        let ov = ovFor(svc, env);
        if (!ov) { ov = { service: svc, environment: env }; overrides().push(ov); }
        Object.assign(ov, f);
      });
      const n = Object.keys(ed.draft).length;
      ed.draft = {};
      changed();
      toast(`${n} change${n === 1 ? "" : "s"} applied - recalculating`);
      return;
    }
    const rs = e.target.closest("[data-bom-reset]");
    if (rs) {
      const [env, svc] = key2(rs.dataset.bomReset);
      S.scenario.bom_overrides = overrides().filter((x) => !(x.service === svc && x.environment === env));
      changed();
      return;
    }
    if (e.target.closest("[data-bom-resetall]")) { S.scenario.bom_overrides = []; changed(); toast("All edits removed"); }
  });
  d.addEventListener("input", (e) => {
    const inp = e.target.closest("[data-bom-k]");
    if (inp) {
      const v = inp.value === "" ? null : Math.max(0, Number(inp.value));
      (ed.draft[inp.dataset.bomK] ||= {})[inp.dataset.bomF] = v;
      inp.classList.add("dirty");
      $("[data-bom-apply]", d).disabled = false;
      return;
    }
    const qq = e.target.closest("[data-bom-q]");
    if (qq) { ed.q = qq.value; clearTimeout(ed.t); ed.t = setTimeout(() => { renderBomEditor(); const x = $("[data-bom-q]", d); x.focus(); x.setSelectionRange(x.value.length, x.value.length); }, 200); }
  });
  d.addEventListener("change", (e) => {
    if (e.target.matches("[data-bom-env-sel]")) { ed.env = e.target.value; renderBomEditor(); }
    if (e.target.matches("[data-bom-plan]")) { ed.plan = e.target.value; renderBomEditor(); }
  });
  $$("#drillDialog [data-bom-apply]").forEach(() => {});
}

export { moneyShort };
