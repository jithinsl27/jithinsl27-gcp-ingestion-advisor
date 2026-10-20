/* Data Cloud Compass - risks.js: monthly risk register.
 *
 * Write a risk in plain language ("Subscriber billing won't be ready for month 3, expect month 5").
 * The service turns it into plan changes (Gemini, or built-in rules), shows the before / after roadmap
 * and cost with recommendations, and nothing changes until the architect clicks "Apply to the plan".
 * Applied risks can be reverted. Risks are saved with the scenario and appear in the proposal. */
import { S } from "./state.js";
import { $, api, call, esc, toast } from "./core.js";
import { money } from "./cost.js";
import { changed } from "./events.js";
import { tip } from "./tips.js";

const st = { draft: null, busy: false, text: "", month: null };
const list = () => (S.scenario.risks ||= []);
const uid = () => "r" + Math.random().toString(36).slice(2, 9);
const LV = ["low", "medium", "high"];
const KIND_NAME = { delay: "Go-live moves", descope: "Taken out of this phase", volume: "Data volume changes", none: "No change to the numbers" };
const signed = (v) => (Math.abs(v) < 0.5 ? money(0, 0) : (v > 0 ? "+" : "−") + money(Math.abs(v), 0));
const srcName = (id) => S.scenario.sources.find((s) => s.id === id)?.name || id;
const curMonth = () => st.month || Math.min(24, Math.max(1, ...(S.planResult?.waves || []).map((w) => w.build_start_month || 1), 1));

function changeLabel(c, golive) {
  if (c.kind === "delay") return `${esc(srcName(c.source_id))}: go-live month ${golive?.[c.source_id] ?? "?"} → <b>${c.month}</b>`;
  if (c.kind === "descope") return `${esc(srcName(c.source_id))}: <b>taken out of this phase</b>`;
  if (c.kind === "volume") return `${esc(srcName(c.source_id))}: data volume <b>×${c.factor}</b>`;
  return "No change to sources or volumes";
}

function matrix() {
  const open = list().filter((r) => r.status !== "closed");
  const cell = (l, i) => open.filter((r) => r.likelihood === l && r.impact === i).length;
  const tone = (l, i) => { const s = LV.indexOf(l) + LV.indexOf(i); return s >= 3 ? "hi" : s === 2 ? "md" : "lo"; };
  return `<div class="rk-matrix" aria-label="Risk matrix: likelihood by impact">
    <div class="rk-axis-y">Likelihood ${tip("How likely the risk is to happen. Set by Gemini or the rules, and editable.")}</div>
    <table><tbody>${[...LV].reverse().map((l) => `<tr><th scope="row">${l}</th>${LV.map((i) => { const n = cell(l, i); return `<td class="${tone(l, i)}">${n || ""}</td>`; }).join("")}</tr>`).join("")}
      <tr><td></td>${LV.map((i) => `<th scope="col">${i}</th>`).join("")}</tr></tbody></table>
    <div class="rk-axis-x">Impact ${tip("How much the risk changes the plan or cost if it happens.")}</div></div>`;
}

function chart(imp) {
  const b = imp.monthly.before.slice(0, 24), a = imp.monthly.after.slice(0, 24);
  const max = Math.max(...b, ...a, 1), W = 560, H = 120, bw = W / 24;
  const bar = (arr, cls, off) => arr.map((v, i) => `<rect class="${cls}" x="${i * bw + off}" y="${H - (v / max) * H}" width="${bw / 2 - 1}" height="${(v / max) * H}"><title>Month ${i + 1}: ${money(v)}</title></rect>`).join("");
  return `<svg class="rk-chart" viewBox="0 0 ${W} ${H + 16}" role="img" aria-label="Monthly spend before and after the risk">
    ${bar(b, "bf", 1)}${bar(a, "af", bw / 2)}
    ${[1, 6, 12, 18, 24].map((m) => `<text x="${(m - 1) * bw + bw / 2}" y="${H + 13}" text-anchor="middle">M${m}</text>`).join("")}</svg>
    <div class="rk-legend"><span class="bf"></span>Current plan <span class="af"></span>With this risk</div>`;
}

function analysisHtml() {
  const d = st.draft;
  if (!d) return "";
  const imp = d.impact, r = d.risk;
  const srcOpts = (sel) => S.scenario.sources.filter((s) => s.included !== false || s.id === sel).map((s) => `<option value="${esc(s.id)}"${s.id === sel ? " selected" : ""}>${esc(s.name)}</option>`).join("");
  const rows = r.changes.map((c, i) => `<div class="rk-change" data-ci="${i}">
      <select data-cf="kind" aria-label="Change">${Object.entries(KIND_NAME).map(([k, n]) => `<option value="${k}"${k === c.kind ? " selected" : ""}>${n}</option>`).join("")}</select>
      ${c.kind !== "none" ? `<select data-cf="source_id" aria-label="Source">${srcOpts(c.source_id)}</select>` : ""}
      ${c.kind === "delay" ? `<label>new go-live month<input type="number" min="2" max="36" data-cf="month" value="${c.month || ""}"></label>` : ""}
      ${c.kind === "volume" ? `<label>× factor<input type="number" min="0.05" max="20" step="0.1" data-cf="factor" value="${c.factor || 1.5}"></label>` : ""}
      <button type="button" class="link-btn" data-cdel="${i}" aria-label="Remove change">Remove</button></div>`).join("");
  const y = imp.payg.delta, y3 = y.reduce((a, b) => a + b, 0), c3 = imp.cud3.delta.reduce((a, b) => a + b, 0);
  return `<section class="rk-analysis">
    <h3>Understood as ${tip("The changes this risk makes to the plan. Edit them if the reading is not right - the impact recalculates.")}</h3>
    ${d.note ? `<p class="hint">${esc(d.note)}</p>` : r.method === "gemini" ? `<p class="hint">Read by Gemini${r.model ? ` (${esc(r.model)})` : ""} - check the changes.</p>` : ""}
    <p class="rk-summary">${esc(r.summary)}</p>
    <div class="rk-changes">${rows}</div>
    <div class="rk-row"><button type="button" class="link-btn" data-cadd>+ Add a change</button>
      <label>Likelihood<select data-rf="likelihood">${LV.map((l) => `<option${l === r.likelihood ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Impact<select data-rf="impact">${LV.map((l) => `<option${l === r.impact ? " selected" : ""}>${l}</option>`).join("")}</select></label></div>
    <h3>Impact on the plan ${tip("The roadmap and pricing are rebuilt with these changes and compared with the current plan (ramp-up plan, all environments).")}</h3>
    <div class="rk-kpis">
      ${[0, 1, 2].map((i) => `<div><span>Year ${i + 1}, pay as you go</span><b class="${y[i] > 0.5 ? "up" : y[i] < -0.5 ? "down" : ""}">${signed(y[i])}</b></div>`).join("")}
      <div><span>3 years, pay as you go</span><b class="${y3 > 0.5 ? "up" : y3 < -0.5 ? "down" : ""}">${signed(y3)}</b></div>
      <div><span>3 years, 3-yr commitment</span><b class="${c3 > 0.5 ? "up" : c3 < -0.5 ? "down" : ""}">${signed(c3)}</b></div>
      <div><span>All sources live</span><b>Month ${imp.all_live.before}${imp.all_live.after !== imp.all_live.before ? ` → ${imp.all_live.after}` : ""}</b></div></div>
    ${imp.golive_changes.length ? `<table class="bom-table rk-golive"><thead><tr><th>Source</th><th>Go-live now</th><th>With this risk</th></tr></thead><tbody>
      ${imp.golive_changes.map((g) => `<tr><td>${esc(g.name)}</td><td>${g.before ? `Month ${g.before}` : "-"}</td><td><b>${g.after ? `Month ${g.after}` : "Not in this phase"}</b></td></tr>`).join("")}</tbody></table>` : ""}
    ${chart(imp)}
    <h3>Recommendations</h3><ul class="rk-recs">${r.recommendations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    <div class="rk-actions"><button type="button" class="btn primary small" data-rk-apply ${r.changes.some((c) => c.kind !== "none") ? "" : "disabled"}>Apply to the plan</button>
      <button type="button" class="btn ghost small" data-rk-save>Save as open risk</button>
      <button type="button" class="btn ghost small" data-rk-discard>Discard</button>
      <span class="hint">Apply changes the roadmap, pricing and every export. You can revert it later.</span></div></section>`;
}

function registerHtml() {
  const rs = list();
  if (!rs.length) return `<p class="hint">No risks yet. Each month, add the risks raised in the programme review - the register keeps them with this scenario.</p>`;
  return `<div class="tbl-scroll"><table class="bom-table rk-table"><thead><tr><th>Month</th><th>Risk</th><th>Changes</th><th>Likelihood / impact</th><th class="num">3 years ${tip("Change in the three-year pay-as-you-go cost when the risk was analysed.")}</th><th>Status</th><th></th></tr></thead><tbody>
    ${rs.map((r) => `<tr class="st-${r.status}"><td>M${r.month}</td><td>${esc(r.summary || r.text)}</td>
      <td>${r.changes.map((c) => `<div class="rk-chg">${changeLabel(c, r.golive)}</div>`).join("")}</td>
      <td><span class="lv ${r.likelihood}">${r.likelihood}</span> / <span class="lv ${r.impact}">${r.impact}</span></td>
      <td class="num">${signed(r.delta_3y || 0)}</td><td><span class="rk-st ${r.status}">${{ open: "Open", applied: "Applied", closed: "Closed" }[r.status]}</span></td>
      <td class="rk-acts">${r.status === "open" && r.changes.some((c) => c.kind !== "none") ? `<button type="button" class="link-btn" data-rk-applyid="${r.id}">Apply</button>` : ""}
        ${r.status === "applied" ? `<button type="button" class="link-btn" data-rk-revert="${r.id}">Revert</button>` : ""}
        ${r.status !== "closed" ? `<button type="button" class="link-btn" data-rk-close="${r.id}">Close</button>` : ""}
        <button type="button" class="link-btn" data-rk-del="${r.id}">Delete</button></td></tr>`).join("")}</tbody></table></div>`;
}

export function renderRisks() {
  const host = $("#risksBody");
  if (!host) return;
  if (!S.scenario.sources.some((s) => s.included !== false)) { host.innerHTML = `<p class="empty-note">Add source systems first - risks are measured against the roadmap.</p>`; return; }
  const horizon = S.planResult?.horizon || 12;
  host.innerHTML = `<div class="rk-top"><div>
      <p class="lede">Each month, write down the risks raised in the programme review in plain language. Compass works out what they change - go-live months, scope or data volumes - shows the effect on the roadmap and the cost, and recommends what to do. Nothing changes until you apply it.</p>
      <form class="rk-form" id="rkForm">
        <label class="rk-text">Risk<textarea id="rkText" rows="2" maxlength="1500" placeholder="e.g. The subscriber billing database won't be ready for month 3 - expect month 5 because of the vendor upgrade">${esc(st.text)}</textarea></label>
        <label>Raised in<select id="rkMonth">${Array.from({ length: Math.max(horizon, 12) }, (_, i) => `<option value="${i + 1}"${i + 1 === curMonth() ? " selected" : ""}>Month ${i + 1}</option>`).join("")}</select></label>
        <button class="btn primary" type="submit" ${st.busy ? "disabled" : ""}>${st.busy ? "Analysing…" : "Analyse impact"}</button>
      </form>
      <p class="hint">Works for delays ("slips to month 6", "late by 2 months"), de-scoping ("move ticketing to phase 2") and volume changes ("ad data will double"). Other risks are logged with recommendations.</p></div>
      ${matrix()}</div>
    ${analysisHtml()}
    <h3>Risk register <small class="muted">${list().length}</small></h3>${registerHtml()}`;
}

// ------------------------------------------------------------------ actions
function golive() { return st.draft?.golive || Object.fromEntries((S.planResult?.waves || []).map((w) => [w.id, w.go_live_month])); }

async function analyse() {
  const text = $("#rkText").value.trim();
  if (text.length < 3) { toast("Describe the risk first"); return; }
  st.text = text; st.month = +$("#rkMonth").value; st.busy = true; renderRisks();
  try {
    st.draft = await call("POST", "/api/risks/parse", { text, month: st.month, scenario: S.scenario });
    st.draft.text = text;
  } catch (e) { toast(`Risk analysis failed: ${e.message}`, 6000); }
  st.busy = false; renderRisks();
}

async function recalc() {
  const ch = st.draft.risk.changes.filter((c) => c.kind !== "none" && c.source_id);
  try { st.draft.impact = await call("POST", "/api/risks/impact", { changes: ch, scenario: S.scenario }); } catch (e) { toast(e.message, 6000); }
  renderRisks();
}

function record(status) {
  const d = st.draft;
  const r = { id: uid(), text: d.text, summary: d.risk.summary || d.text, month: st.month || 1, likelihood: d.risk.likelihood, impact: d.risk.impact,
    changes: d.risk.changes.filter((c) => c.kind === "none" || c.source_id), recommendations: d.risk.recommendations, golive: d.golive,
    delta_y1: d.impact.payg.delta[0], delta_3y: d.impact.payg.delta.reduce((a, b) => a + b, 0), method: d.risk.method || "rules", status: "open", created_at: Date.now() };
  list().push(r);
  st.draft = null; st.text = "";
  if (status === "applied") applyRisk(r); else { changed(); toast("Risk saved as open"); }
}

function applyRisk(r) {
  r.prev = {};
  r.changes.forEach((c) => {
    const s = S.scenario.sources.find((x) => x.id === c.source_id);
    if (!s || c.kind === "none") return;
    r.prev[s.id] ||= { go_live_override: s.go_live_override ?? null, included: s.included !== false, daily_change_gb: s.daily_change_gb, initial_volume_gb: s.initial_volume_gb };
    if (c.kind === "delay") s.go_live_override = c.month;
    if (c.kind === "descope") s.included = false;
    if (c.kind === "volume") { s.daily_change_gb = +(s.daily_change_gb * c.factor).toFixed(3); s.initial_volume_gb = +(s.initial_volume_gb * c.factor).toFixed(3); }
  });
  r.status = "applied"; r.applied_at = Date.now();
  changed();
  toast("Risk applied - roadmap, pricing and exports now include it", 6000, { label: "Revert", run: () => revertRisk(r) });
}

function revertRisk(r) {
  Object.entries(r.prev || {}).forEach(([id, p]) => {
    const s = S.scenario.sources.find((x) => x.id === id);
    if (!s) return;
    if (p.go_live_override == null) delete s.go_live_override; else s.go_live_override = p.go_live_override;
    s.included = p.included; s.daily_change_gb = p.daily_change_gb; s.initial_volume_gb = p.initial_volume_gb;
  });
  delete r.prev; r.status = "open";
  changed();
  toast("Risk reverted - the plan is back to how it was");
}

export function bindRisks() {
  const host = $("#risksBody");
  if (!host) return;
  host.addEventListener("submit", (e) => { if (e.target.id === "rkForm") { e.preventDefault(); analyse(); } });
  host.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("[data-rk-apply]")) return record("applied");
    if (t.closest("[data-rk-save]")) return record("open");
    if (t.closest("[data-rk-discard]")) { st.draft = null; return renderRisks(); }
    if (t.closest("[data-cadd]")) { const s = S.scenario.sources.find((x) => x.included !== false); st.draft.risk.changes = st.draft.risk.changes.filter((c) => c.kind !== "none").concat([{ kind: "delay", source_id: s?.id, month: (golive()[s?.id] || 2) + 1 }]); return recalc(); }
    const cd = t.closest("[data-cdel]");
    if (cd) { st.draft.risk.changes.splice(+cd.dataset.cdel, 1); if (!st.draft.risk.changes.length) st.draft.risk.changes = [{ kind: "none" }]; return recalc(); }
    const find = (k) => list().find((r) => r.id === t.closest(`[${k}]`)?.getAttribute(k));
    if (t.closest("[data-rk-applyid]")) return applyRisk(find("data-rk-applyid"));
    if (t.closest("[data-rk-revert]")) return revertRisk(find("data-rk-revert"));
    if (t.closest("[data-rk-close]")) { const r = find("data-rk-close"); if (r.status === "applied") revertRisk(r); r.status = "closed"; changed(); return; }
    if (t.closest("[data-rk-del]")) { const r = find("data-rk-del"); if (r.status === "applied" && !confirm("This risk is applied to the plan. Delete it and keep its changes?")) return; S.scenario.risks = list().filter((x) => x !== r); changed(); }
  });
  host.addEventListener("change", (e) => {
    const f = e.target.closest("[data-cf]");
    if (f && st.draft) {
      const c = st.draft.risk.changes[+f.closest("[data-ci]").dataset.ci];
      const k = f.dataset.cf;
      c[k] = k === "month" ? Math.max(2, Math.min(36, +f.value || 2)) : k === "factor" ? Math.max(0.05, +f.value || 1) : f.value;
      if (k === "kind") {
        if (c.kind === "none") { delete c.source_id; delete c.month; delete c.factor; }
        else { c.source_id ||= S.scenario.sources.find((x) => x.included !== false)?.id; if (c.kind === "delay") c.month ||= (golive()[c.source_id] || 2) + 2; if (c.kind === "volume") c.factor ||= 1.5; }
      }
      return recalc();
    }
    const rf = e.target.closest("[data-rf]");
    if (rf && st.draft) st.draft.risk[rf.dataset.rf] = rf.value;
  });
}

export function risksSummary() {
  const rs = list();
  return { open: rs.filter((r) => r.status === "open").length, applied: rs.filter((r) => r.status === "applied").length, total: rs.length,
    applied3y: rs.filter((r) => r.status === "applied").reduce((a, r) => a + (r.delta_3y || 0), 0) };
}
