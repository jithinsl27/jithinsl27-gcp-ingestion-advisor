/* Data Cloud Compass - readiness.js: kickoff readiness (checklist, milestones, team) from the finalised architecture. */
import { S } from "./state.js";
import { $, $$, esc } from "./core.js";
import { markDirty } from "./account.js";
import { save } from "./scenario.js";
import { download, slug } from "./exports.js";

export const kick = { view: "checklist", owner: "all" };
const OWNERS = ["Customer", "Partner", "Joint"];

/** Stable key for a checklist item so ticks survive re-calculation. */
export function itemKey(it) {
  let h = 0;
  const t = it.area + "|" + it.item;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return "k" + (h >>> 0).toString(36);
}
const doneSet = () => new Set(S.scenario.readiness_done || []);
export const readiness = () => S.planResult?.readiness;

export function readinessProgress() {
  const r = readiness();
  if (!r) return null;
  const d = doneSet();
  const done = r.checklist.filter((c) => d.has(itemKey(c))).length;
  const crit = r.checklist.filter((c) => c.critical);
  return { done, total: r.checklist.length, critOpen: crit.filter((c) => !d.has(itemKey(c))).length, critical: crit.length };
}

const monthLabel = (m) => (m === 0 ? "Before M1" : `Month ${m}`);

export function renderReadiness() {
  const host = $("#kickoffBody");
  if (!host) return;
  const r = readiness();
  if (!r || !S.scenario.sources.length) { host.innerHTML = `<p class="empty-note">The kickoff checklist, milestones and team appear once at least one source system is added and the roadmap is calculated.</p>`; return; }
  const p = readinessProgress();
  const seg = (k, label) => `<button type="button" data-kview="${k}" aria-selected="${kick.view === k}">${label}</button>`;
  let html = `<div class="kick-top">
    <div class="seg" role="group" aria-label="View">${seg("checklist", "Kickoff checklist")}${seg("milestones", "Milestones")}${seg("team", "Team & skills")}</div>
    <div class="kick-actions"><button type="button" class="btn small" data-kcsv>Download CSV</button></div></div>`;
  if (kick.view === "checklist") {
    html += `<div class="kick-progress"><div class="bar"><i style="width:${p.total ? (100 * p.done) / p.total : 0}%"></i></div>
      <span><b>${p.done}</b> of ${p.total} ready · <b class="${p.critOpen ? "warn" : "ok"}">${p.critOpen}</b> critical open</span>
      <div class="seg small" role="group" aria-label="Owner">${["all", ...OWNERS].map((o) => `<button type="button" data-kowner="${o}" aria-selected="${kick.owner === o}">${o === "all" ? "All owners" : o}</button>`).join("")}</div></div>`;
    const d = doneSet();
    const items = r.checklist.filter((c) => kick.owner === "all" || c.owner === kick.owner);
    const areas = [...new Set(items.map((c) => c.area))];
    areas.forEach((a) => {
      const list = items.filter((c) => c.area === a);
      const n = list.filter((c) => d.has(itemKey(c))).length;
      html += `<section class="kick-area"><h3>${esc(a)} <small>${n} / ${list.length}</small></h3><ul class="kick-list">`;
      list.forEach((c) => {
        const k = itemKey(c), on = d.has(k);
        html += `<li class="${on ? "done" : ""}"><label><input type="checkbox" data-kitem="${k}" ${on ? "checked" : ""}>
          <span class="kt"><b>${esc(c.item)}</b><small>${esc(c.why)}</small></span></label>
          <span class="kmeta"><i class="owner o-${c.owner.toLowerCase()}">${esc(c.owner)}</i>${c.critical ? `<i class="crit">Critical</i>` : ""}<em>${esc(c.due)}</em></span></li>`;
      });
      html += `</ul></section>`;
    });
  } else if (kick.view === "milestones") {
    html += `<ol class="kick-ms">${r.milestones.map((m) => `<li><span class="when">${monthLabel(m.month)}</span><div><b>${esc(m.name)}</b>
      <p><span>Exit criteria:</span> ${esc(m.exit)}</p><p class="dl">${m.deliverables.map((x) => `<i>${esc(x)}</i>`).join("")}</p></div></li>`).join("")}</ol>
      <p class="note">Months follow the Roadmap (delivery squads and go-live per source). Change the number of squads on the Roadmap to move them.</p>`;
  } else {
    const t = r.team;
    const table = (rows) => `<table class="bom-table kick-team"><thead><tr><th>Role</th><th class="num">People</th><th>Key skills</th><th>When</th></tr></thead><tbody>
      ${rows.map((x) => `<tr><td><b>${esc(x.role)}</b></td><td class="num">${x.count}</td><td>${x.skills.map((s) => `<i class="skill">${esc(s)}</i>`).join("")}</td><td>${esc(x.when)}</td></tr>`).join("")}</tbody></table>`;
    html += `<div class="kick-kpis"><div><span>Partner team at peak</span><b>${t.partner_fte} FTE</b></div><div><span>Delivery squads</span><b>${t.squads}</b></div>
      <div><span>Customer roles</span><b>${t.customer.length}</b></div></div><p class="note">${esc(t.note)}</p>
      <h3>Partner delivery team</h3>${table(t.partner)}<h3>Customer team</h3>${table(t.customer)}`;
  }
  host.innerHTML = html;
}

export function readinessCsv() {
  const r = readiness();
  if (!r) return "";
  const d = doneSet();
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["Section", "Area / month", "Owner", "Item", "Why / exit criteria", "Due / deliverables", "Critical", "Ready"].map(q).join(",")];
  r.checklist.forEach((c) => lines.push(["Checklist", c.area, c.owner, c.item, c.why, c.due, c.critical ? "yes" : "", d.has(itemKey(c)) ? "yes" : ""].map(q).join(",")));
  r.milestones.forEach((m) => lines.push(["Milestone", monthLabel(m.month), "Joint", m.name, m.exit, m.deliverables.join("; "), "", ""].map(q).join(",")));
  r.team.partner.forEach((x) => lines.push(["Team (partner)", x.when, "Partner", x.role, x.skills.join("; "), `${x.count} people`, "", ""].map(q).join(",")));
  r.team.customer.forEach((x) => lines.push(["Team (customer)", x.when, "Customer", x.role, x.skills.join("; "), `${x.count} people`, "", ""].map(q).join(",")));
  return lines.join("\n");
}

export function bindReadiness() {
  const host = $("#kickoffBody");
  if (!host) return;
  host.addEventListener("click", (e) => {
    const v = e.target.closest("[data-kview]");
    if (v) { kick.view = v.dataset.kview; renderReadiness(); return; }
    const o = e.target.closest("[data-kowner]");
    if (o) { kick.owner = o.dataset.kowner; renderReadiness(); return; }
    if (e.target.closest("[data-kcsv]")) download(`${slug()}-kickoff-readiness.csv`, "text/csv", readinessCsv());
  });
  host.addEventListener("change", (e) => {
    const cb = e.target.closest("[data-kitem]");
    if (!cb) return;
    const d = doneSet();
    if (cb.checked) d.add(cb.dataset.kitem); else d.delete(cb.dataset.kitem);
    S.scenario.readiness_done = [...d];
    markDirty();
    save();
    renderReadiness();
    $$('.modnav [data-badge="kickoff"]').forEach((b) => { const p = readinessProgress(); b.textContent = p ? `${p.done}/${p.total}` : ""; });
  });
}
