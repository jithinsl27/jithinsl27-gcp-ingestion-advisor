/* Data Cloud Compass - compare.js: two scenarios side by side (current, a variant, a saved scenario,
 * a saved version or a sample), for every pricing option, capability, environment and BigQuery set-up. */
import { S } from "./state.js";
import { $, api, clone, esc } from "./core.js";
import { fetchCloudScenario, canCloud } from "./account.js";
import { money } from "./cost.js";
import { OPTIONS, OPT } from "./pricing.js";

let picks = { a: "current", b: "current:ondemand" };
let saved = [];
let versions = [];

async function sources() {
  const opts = [
    { id: "current", name: "Current scenario" },
    { id: "current:ondemand", name: "Current - BigQuery on-demand" },
    { id: "current:editions", name: "Current - BigQuery editions (auto-sized)" },
    { id: "current:nodr", name: "Current - production only (no other environments)" },
  ];
  if (canCloud() && S.user) {
    try { saved = await api.list(); } catch (_) { saved = []; }
    if (S.cloud) { try { versions = await api.versions(S.cloud.id); } catch (_) { versions = []; } }
  }
  versions.forEach((v) => opts.push({ id: `version:${v.version}`, name: `${S.cloud.title} - version ${v.version}${v.note ? ` (${v.note})` : ""}`, group: "Versions of this scenario" }));
  saved.filter((d) => d.id !== S.cloud?.id).forEach((d) => opts.push({ id: `cloud:${d.id}`, name: d.title, group: "Saved scenarios" }));
  (S.samples || []).forEach((s) => opts.push({ id: `sample:${s.file}`, name: s.title.replace(/^Sample - /, ""), group: "Samples" }));
  return opts;
}

async function scenarioFor(id) {
  const cur = clone(S.scenario);
  if (id === "current") return cur;
  if (id === "current:ondemand") { cur.bq = { ...(cur.bq || {}), mode: "ondemand" }; return cur; }
  if (id === "current:editions") { cur.bq = { mode: "editions", edition: "auto", scan_basis: cur.bq?.scan_basis || "auto" }; return cur; }
  if (id === "current:nodr") { cur.environments = cur.environments.slice(0, 1); return cur; }
  if (id.startsWith("version:")) return fetchCloudScenario(S.cloud.id, Number(id.slice(8)));
  if (id.startsWith("cloud:")) return fetchCloudScenario(id.slice(6));
  if (id.startsWith("sample:")) return clone(S.samples.find((s) => s.file === id.slice(7)).scenario);
  throw new Error("Unknown scenario");
}

export async function openCompare(preset) {
  if (preset) picks = { ...picks, ...preset };
  const opts = await sources();
  const select = (k) => {
    let html = "", group = null;
    for (const o of opts) {
      if (o.group !== group) { if (group) html += "</optgroup>"; if (o.group) html += `<optgroup label="${esc(o.group)}">`; group = o.group; }
      html += `<option value="${esc(o.id)}"${picks[k] === o.id ? " selected" : ""}>${esc(o.name)}</option>`;
    }
    return `<select id="cmp_${k}">${html}${group ? "</optgroup>" : ""}</select>`;
  };
  $("#cmpBody").innerHTML = `<div class="cmp-pick"><label>Option A ${select("a")}</label><span>vs</span><label>Option B ${select("b")}</label>
    <button type="button" class="btn primary" id="cmpRun">Compare</button></div>
    ${canCloud() && !S.user ? `<p class="hint">Sign in to compare with saved scenarios and versions.</p>` : ""}
    <div id="cmpOut"></div>`;
  if (!$("#cmpDialog").open) $("#cmpDialog").showModal();
  run();
}

async function run() {
  picks = { a: $("#cmp_a").value, b: $("#cmp_b").value };
  const out = $("#cmpOut");
  out.innerHTML = `<p class="hint">Calculating…</p>`;
  try {
    const labels = [$("#cmp_a").selectedOptions[0].text, $("#cmp_b").selectedOptions[0].text];
    const [a, b] = await Promise.all([scenarioFor(picks.a), scenarioFor(picks.b)]);
    const res = await api.compare({ scenarios: [stripUi(a), stripUi(b)], labels });
    out.innerHTML = render(res);
  } catch (e) {
    out.innerHTML = `<p class="bq-warn">${esc(e.message)}</p>`;
  }
}

function stripUi(sc) {
  const p = clone(sc);
  delete p.workload_units;
  if (!p.processing_region) delete p.processing_region;
  (p.sources || []).forEach((s) => { if (!s.region) delete s.region; });
  (p.components || []).forEach((c) => { if (c.settings && !c.settings.region) delete c.settings.region; });
  return p;
}

function delta(a, b) {
  const d = b - a;
  if (Math.abs(d) < 0.5) return `<td class="num muted">-</td>`;
  const pct = a ? ` (${d > 0 ? "+" : ""}${Math.round((100 * d) / a)}%)` : "";
  return `<td class="num ${d > 0 ? "up" : "down"}">${d > 0 ? "+" : "−"}${money(Math.abs(d))}${pct}</td>`;
}

function render([A, B]) {
  const o = OPT();
  const rows = [];
  const head = `<thead><tr><th></th><th class="num">${esc(A.label)}</th><th class="num">${esc(B.label)}</th><th class="num">B − A</th></tr></thead>`;
  for (const opt of OPTIONS) {
    const ta = A.by_option[opt.id].totals, tb = B.by_option[opt.id].totals;
    rows.push(`<tr class="bom-group"><th colspan="4">${esc(opt.name)}${opt.id === o ? " (selected)" : ""}</th></tr>`);
    [["Average per month, year 1", "avg_monthly_year1"], ["Year 1", "year1"], ["3 years", "three_year"]].forEach(([l, k]) =>
      rows.push(`<tr><td>${l}</td><td class="num">${money(ta[k])}</td><td class="num">${money(tb[k])}</td>${delta(ta[k], tb[k])}</tr>`));
  }
  const bqs = (x) => x.bigquery.mode === "editions" ? `${{ standard: "Standard", enterprise: "Enterprise", enterprise_plus: "Enterprise Plus" }[x.bigquery.edition]} · ${x.bigquery.baseline} → ${x.bigquery.max} slots` : `On-demand · ${x.bigquery.scan_tib_month.toLocaleString(undefined, { maximumFractionDigits: 1 })} TiB/month`;
  rows.push(`<tr class="bom-group"><th colspan="4">Set-up</th></tr>`);
  rows.push(`<tr><td>BigQuery region</td><td class="num">${esc(A.region.name)}</td><td class="num">${esc(B.region.name)}</td><td></td></tr>`);
  rows.push(`<tr><td>BigQuery compute</td><td class="num">${esc(bqs(A))}</td><td class="num">${esc(bqs(B))}</td><td></td></tr>`);
  rows.push(`<tr><td>Sources · environments</td><td class="num">${A.recommendations.length} · ${A.environments.length}</td><td class="num">${B.recommendations.length} · ${B.environments.length}</td><td></td></tr>`);
  const un = (x) => x.availability.unavailable.length;
  if (un(A) || un(B)) rows.push(`<tr><td>Services not offered in their region</td><td class="num">${un(A)}</td><td class="num">${un(B)}</td><td></td></tr>`);
  const ga = Object.fromEntries(A.by_option[o].by_group.map((g) => [g.group, g.year1]));
  const gb = Object.fromEntries(B.by_option[o].by_group.map((g) => [g.group, g.year1]));
  rows.push(`<tr class="bom-group"><th colspan="4">Year 1 by capability (${esc(OPTIONS.find((x) => x.id === o).name)})</th></tr>`);
  [...new Set([...Object.keys(ga), ...Object.keys(gb)])].forEach((g) =>
    rows.push(`<tr><td>${esc(g)}</td><td class="num">${money(ga[g] || 0)}</td><td class="num">${money(gb[g] || 0)}</td>${delta(ga[g] || 0, gb[g] || 0)}</tr>`));
  const sa = Object.fromEntries(A.by_option[o].by_service.map((r) => [r.key, r.year1]));
  const sb = Object.fromEntries(B.by_option[o].by_service.map((r) => [r.key, r.year1]));
  const diffs = [...new Set([...Object.keys(sa), ...Object.keys(sb)])].map((k) => [k, (sb[k] || 0) - (sa[k] || 0)])
    .filter(([, d]) => Math.abs(d) >= 1).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 10);
  if (diffs.length) {
    rows.push(`<tr class="bom-group"><th colspan="4">Biggest differences by product, year 1</th></tr>`);
    diffs.forEach(([k]) => rows.push(`<tr><td>${esc(k)}</td><td class="num">${money(sa[k] || 0)}</td><td class="num">${money(sb[k] || 0)}</td>${delta(sa[k] || 0, sb[k] || 0)}</tr>`));
  }
  return `<div style="overflow-x:auto"><table class="cmp-table compare">${head}<tbody>${rows.join("")}</tbody></table></div>`;
}

export function bindCompare() {
  $("#cmpDialog").addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) return $("#cmpDialog").close();
    if (e.target.id === "cmpRun") run();
  });
  $("#cmpDialog").addEventListener("change", (e) => { if (e.target.id === "cmp_a" || e.target.id === "cmp_b") run(); });
}

