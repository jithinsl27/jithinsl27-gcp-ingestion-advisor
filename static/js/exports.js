/* Data Cloud Compass - exports.js (ES module, no build step). */
import { forgetCloud } from "./account.js";
import { S } from "./state.js";
import { $, esc, toast } from "./core.js";
import { GROUP_COLORS, fmtGB, fmtQty, fx, money, moneyShort, unitPrice } from "./cost.js";
import { bqModelName } from "./diagram.js";
import { changed } from "./events.js";
import { OPT, OPTIONS, OV, compMeta, emptyWorkload, hasEstimate, optShort } from "./pricing.js";
import { freqName, recFor, tool } from "./render.js";
import { syncForm, withDefaults } from "./scenario.js";
import { EDITION_NAME } from "./workload.js";

// ------------------------------------------------------------------ exports
export const NO_DOWNLOAD = !!window.ADVISOR_NO_DOWNLOAD;

export function download(name, mime, text) {
  if (NO_DOWNLOAD && typeof text === "string") {
    const done = () => toast(`Copied ${name} to the clipboard`);
    try {
      navigator.clipboard.writeText(text).then(done, () => showCopyBox(name, text));
    } catch (_) { showCopyBox(name, text); }
    return;
  }
  const blob = text instanceof Blob ? text : new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export function slug() { return (S.scenario.customer || "scenario").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scenario"; }

export function doExport(kind) {
  if (kind === "reset") {
    const prev = S.scenario;
    S.scenario = withDefaults({ workload: emptyWorkload() });
    forgetCloud();
    history.replaceState(null, "", location.pathname);
    syncForm(); changed();
    toast("Started a new scenario", 6000, { label: "Undo", run: () => { S.scenario = prev; syncForm(); changed(); } });
    return;
  }
  if (kind === "json") return download(`${slug()}.json`, "application/json", JSON.stringify(S.scenario, null, 2));
  if (!hasEstimate()) return toast("Add a source system or a product first");
  if (kind === "print") { window.print(); return; }
  if (kind === "gsheets") return openGoogleExport("sheets");
  if (kind === "gslides") return openGoogleExport("slides");
  if (kind === "csv") return download(`${slug()}-costs.csv`, "text/csv", toCsv());
  if (kind === "md") return download(`${slug()}-proposal.md`, "text/markdown", toMarkdown());
  if (kind === "svg") return download(`${slug()}-architecture.svg`, "image/svg+xml", inlineSvg($("#archSvg")));
}

export function toCsv() {
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const c = (v) => (v * fx()).toFixed(2);
  const lines = [[`Service`, `Year 1 (${S.currency})`, `Year 1 1-yr CUD`, `3 years`, `3 years 3-yr CUD`].map(q).join(",")];
  S.result.by_service.forEach((s) => lines.push([q(s.service), c(s.year1), c(s.year1_cud), c(s.three_year), c(s.three_year_cud)].join(",")));
  lines.push("", [q("Region"), q(`Year 1 (${S.currency})`), q("3 years")].join(","));
  (S.result.by_region || []).forEach((s) => lines.push([q(s.name), c(s.year1), c(s.three_year)].join(",")));
  lines.push("", [q("Source"), q(`Year 1 (${S.currency})`), q("3 years")].join(","));
  S.result.by_source.forEach((s) => lines.push([q(s.name), c(s.year1), c(s.three_year)].join(",")));
  lines.push("", [q("Month"), q(`Pay-as-you-go (${S.currency})`), q("With 3-yr commitments")].join(","));
  S.result.monthly.forEach((m) => lines.push([m.month, c(m.payg), c(m.cud3)].join(",")));
  if (S.result.bom?.length) {
    lines.push("", ["Environment", "Product / service", "Why it is needed", "Qty / month (M12)", "Qty, year 1", "Unit", `Unit price (${S.currency})`, `Month 12 (${S.currency})`, `Year 1 (${S.currency})`, `3 years (${S.currency})`].map(q).join(","));
    S.result.bom.forEach((b) => lines.push([q(b.environment_name), q(b.service), q(b.why), b.qty_month12 ?? "", b.qty_year1 ?? "", q(b.unit || ""), b.unit_price == null ? "" : (b.unit_price * fx()).toFixed(6), c(b.month12), c(b.year1), c(b.three_year)].join(",")));
  }
  if (S.wlResult) {
    lines.push("", [q("Workload sizing - line item"), q("Service"), q(`Steady month (${S.currency})`), q("Year 1"), q("3 years")].join(","));
    S.wlResult.lines.forEach((l) => lines.push([q(l.item), q(l.service), c(l.steady_month), c(l.year1), c(l.three_year)].join(",")));
  }
  return lines.join("\n");
}

export function toMarkdown() {
  const t = S.result.totals, p = S.result.platform;
  const L = [];
  L.push(`# Data Cloud Compass - Google Cloud data & AI platform proposal${S.scenario.customer ? ` for ${S.scenario.customer}` : ""}`, "");
  L.push(`BigQuery region: **${S.result.region.name}** · BigQuery pricing: **${bqModelName()}** · Data growth: **${S.scenario.annual_growth_pct}%/yr** · Currency: **${S.currency}**`, "");
  L.push("## Ballpark consumption (source-based)", "", "| Horizon | Pay-as-you-go | With commitments | Discussion range |", "|---|---:|---:|---|");
  L.push(`| 1 year | ${money(t.year1_payg)} | ${money(t.year1_cud1)} (1-yr) | ${money(t.range_low_1y)} - ${money(t.range_high_1y)} |`);
  L.push(`| 3 years | ${money(t.three_year_payg)} | ${money(t.three_year_cud3)} (3-yr) | ${money(t.range_low_3y)} - ${money(t.range_high_3y)} |`, "");
  const ovm = OV();
  L.push(`**Selected pricing: ${OPTIONS.find((o) => o.id === OPT()).name}** - ${money(ovm.totals.avg_monthly_year1)} per month in year 1, ${money(ovm.totals.year1)} for year 1, ${money(ovm.totals.three_year)} over 3 years.`, "");
  L.push("| Horizon | Pay-as-you-go | 1-year commitment | 3-year commitment |", "|---|---:|---:|---:|");
  L.push(`| 1 year | ${OPTIONS.map((o) => money(OV(o.id).totals.year1)).join(" | ")} |`);
  L.push(`| 3 years | ${OPTIONS.map((o) => money(OV(o.id).totals.three_year)).join(" | ")} |`, "");
  L.push(`### By service (${optShort()})`, "", "| Service | Year 1 | 3 years |", "|---|---:|---:|");
  ovm.by_service.forEach((s) => L.push(`| ${s.key} | ${money(s.year1)} | ${money(s.three_year)} |`));
  if ((S.result.environments || []).length > 1) {
    L.push("", "### By environment", "", "| Environment | Year 1 | 3 years |", "|---|---:|---:|");
    S.result.environments.forEach((e) => L.push(`| ${e.name} | ${money(e.year1)} | ${money(e.three_year)} |`));
  }
  if (S.result.bom?.length) {
    L.push("", `### Bill of materials (${S.result.environments?.[0]?.name || "primary environment"})`, "", "| Product | Qty / month | Unit | Unit price | Year 1 | Why it is needed |", "|---|---:|---|---:|---:|---|");
    S.result.bom.filter((b) => b.environment === S.result.environments?.[0]?.id).forEach((b) => L.push(`| ${b.service} | ${fmtQty(b.qty_month12)} | ${b.unit || "-"} | ${unitPrice(b.unit_price)} | ${money(b.year1)} | ${b.why} |`));
  }
  if ((S.result.by_region || []).length > 1) {
    L.push("", "### By region", "", "| Region | Year 1 | 3 years |", "|---|---:|---:|");
    S.result.by_region.forEach((r) => L.push(`| ${r.name} | ${money(r.year1)} | ${money(r.three_year)} |`));
  }
  L.push("", "## Source systems and recommended patterns", "");
  const later = S.scenario.sources.filter((s) => s.included === false).map((s) => s.name);
  if (later.length) L.push(`_Not in this phase (excluded from the estimate): ${later.join(", ")}._`, "");
  S.scenario.sources.forEach((s) => {
    const r = recFor(s.id);
    if (!r) return;
    L.push(`### ${s.name}`, "", `*${S.catalog.source_types.find((x) => x.id === s.type)?.name}* · ${freqName(s.frequency)} · ${fmtGB(s.initial_volume_gb)} initial · ${fmtGB(s.daily_change_gb)}/day · region ${s.region || S.scenario.region}`, "");
    L.push(`**Pattern:** ${r.pattern}`, "", `**Services:** ${r.chain.map((x) => tool(x).name).join(" → ")} → BigQuery`, "");
    r.rationale.forEach((x) => L.push(`- ${x}`));
    if (r.alternatives.length) { L.push("", "**Alternatives**", ""); r.alternatives.forEach((a) => L.push(`- ${tool(a.tool).name}: ${a.why}`)); }
    if (r.caveats.length) { L.push("", "**Check during discovery**", ""); r.caveats.forEach((c) => L.push(`- ${c}`)); }
    if (s.notes) L.push("", `**Notes:** ${s.notes}`);
    L.push("");
  });
  L.push("## BI, AI and governance integrations", "");
  S.scenario.components.forEach((c) => {
    const m = compMeta(c.type);
    L.push(`### ${m.name} (${m.vendor === "google" ? "Google Cloud" : "partner - not costed"})`, "", `**Integration:** ${m.method}`, "");
    m.steps.forEach((x, i) => L.push(`${i + 1}. ${x}`));
    m.notes.forEach((x) => L.push(`- ${x}`));
    L.push("", `Docs: ${m.doc}`, "");
  });
  const sec = p.layer.story.find((b) => b.key === "security");
  if (sec) { L.push("### Security & compliance", ""); sec.points.forEach((x) => L.push(`- ${x}`)); L.push(""); }
  L.push("### Cost by capability", "", "| Capability | Year 1 | 3 years |", "|---|---:|---:|");
  S.result.by_group.forEach((g) => L.push(`| ${g.group} | ${money(g.year1)} | ${money(g.three_year)} |`));
  L.push("", "## Platform blueprint", "");
  L.push(`- **Transformation:** Dataform - ${p.transformation.why}`);
  L.push(`- **Orchestration:** ${p.orchestration.tool === "none" ? "None required" : tool(p.orchestration.tool).name} - ${p.orchestration.why}`);
  L.push(`- **Connectivity:** ${p.connectivity ? tool(p.connectivity).name : "Google-managed / public endpoints"}`);
  if (p.datafusion_edition) L.push(`- **Data Fusion:** shared ${p.datafusion_edition} instance`);
  L.push("");
  if (S.wlResult) {
    const w = S.wlResult, wt = w.totals, W = w.workload;
    L.push("## Workload-based sizing", "");
    L.push(`Data: ${W.data.structured_tb} TB structured, ${W.data.semi_structured_tb} TB semi-structured, ${W.data.unstructured_tb} TB unstructured; telemetry ${W.telemetry.volume_gb} GB per ${W.telemetry.per}; ${W.pipelines.simple + W.pipelines.medium + W.pipelines.complex} pipelines; ${W.dashboards.count} dashboards; ramp-up ${W.ramp.months} months with ${W.ramp.data_gb} GB and ${W.ramp.reports} report(s).`, "");
    L.push("| Period | Pay-as-you-go | With commitments |", "|---|---:|---:|");
    if (w.ramp_months) L.push(`| Ramp-up (per month) | ${money(wt.ramp_monthly)} | |`);
    L.push(`| Steady state (per month) | ${money(wt.steady_monthly)} | |`);
    L.push(`| 1 year | ${money(wt.year1_payg)} | ${money(wt.year1_cud1)} |`);
    L.push(`| 3 years | ${money(wt.three_year_payg)} | ${money(wt.three_year_cud3)} |`, "");
    L.push("| Category | Steady month | Year 1 | 3 years |", "|---|---:|---:|---:|");
    w.by_category.forEach((c) => L.push(`| ${c.category} | ${money(c.steady_month)} | ${money(c.year1)} | ${money(c.three_year)} |`));
    L.push("");
    if (w.slots) {
      const sl = w.slots;
      L.push("### BigQuery slot sizing", "", `Average ${sl.avg_slots} slots, peak ${Math.round(sl.peak_slots)}; reservation baseline ${sl.baseline_slots} → max ${sl.max_slots}; ${sl.model === "editions" ? EDITION_NAME[sl.edition] + " edition" : "on-demand"} recommended.`, "");
      [...sl.recommendations, ...sl.edition_reasons].forEach((x) => L.push(`- ${x}`));
      L.push("");
    }
  }
  if (S.planResult) {
    const pr = S.planResult;
    L.push("## Ramp-up roadmap", "", `${pr.teams} delivery squad(s); programme length ${pr.horizon} months.`, "");
    L.push("| Phase | Months | Notes |", "|---|---|---|");
    pr.phases.forEach((ph) => L.push(`| ${ph.name} | M${ph.start}${ph.end !== ph.start ? `-M${ph.end}` : ""} | ${ph.items.join("; ")} |`));
    L.push("", "| Month | Goes live | Ramped cost | Steady state |", "|---|---|---:|---:|");
    pr.months.forEach((m) => L.push(`| M${m.month} | ${[...pr.milestones.filter((x) => x.month === m.month).map((x) => x.name), ...m.sources_live, ...m.components_started].join(", ") || "-"} | ${money(m.total)} | ${money(m.steady)} |`));
    L.push("", `Year 1 with ramp-up: **${money(pr.totals.ramped_year1)}** (vs ${money(pr.totals.steady_year1)} at full run-rate); 3 years: **${money(pr.totals.ramped_three_year)}**.`, "");
  }
  L.push("---", "", `_${S.result.disclaimer}_`, "");
  return L.join("\n");
}

export function inlineSvg(svg, white) {
  const c = svg.cloneNode(true);
  const src = svg.querySelectorAll("*"), dst = c.querySelectorAll("*");
  const props = ["fill", "stroke", "stroke-width", "stroke-dasharray", "font-family", "font-size", "font-weight", "opacity", "fill-opacity", "stroke-opacity"];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    props.forEach((p) => { const v = cs.getPropertyValue(p); if (v) dst[i].setAttribute(p, v); });
    if (dst[i].getAttribute("font-family")) dst[i].setAttribute("font-family", "Roboto, Arial, sans-serif");
  });
  c.setAttribute("style", `background:${white ? "#FFFFFF" : getComputedStyle(document.body).backgroundColor}`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + new XMLSerializer().serializeToString(c);
}

// ------------------------------------------------------------------ Google Sheets / Slides export
export const GCLIENT_KEY = "data-cloud-compass:google-client-id";

export function googleClientId() {
  let local = "";
  try { local = localStorage.getItem(GCLIENT_KEY) || ""; } catch (_) { /* storage unavailable */ }
  return (window.COMPASS_CONFIG && window.COMPASS_CONFIG.googleClientId) || S.serverClientId || local;
}

export function loadServerConfig() {
  S.serverClientId = S.config?.google_client_id || "";
}

export function openGoogleExport(kind) {
  S.gKind = kind;
  const what = kind === "sheets" ? "Google Sheets workbook" : "Google Slides presentation";
  const content = kind === "sheets"
    ? "summary, architecture diagram, sources and patterns, bill of materials, monthly consumption, environments, workload and BigQuery slot sizing, roadmap and assumptions - with native charts"
    : "title, target architecture, ingestion patterns, integrations, consumption and charts, environments, bill of materials, slot sizing, roadmap and next steps";
  $("#gTitle").textContent = `Export to ${kind === "sheets" ? "Google Sheets" : "Google Slides"}`;
  $("#gIntro").innerHTML = `Builds a ${esc(what)} with the ${esc(content)}. <b>Create in my Google Drive</b> uploads it and converts it to ${kind === "sheets" ? "Sheets" : "Slides"}; <b>Download</b> gives you a ${kind === "sheets" ? ".xlsx" : ".pptx"} file you can open with ${kind === "sheets" ? "Google Sheets (File → Import)" : "Google Slides (File → Import slides)"} or drop into Drive.`;
  $("#gDownload").textContent = kind === "sheets" ? "Download .xlsx" : "Download .pptx";
  $("#gOrigin").textContent = location.origin;
  $("#gClientId").value = googleClientId();
  $("#gSetup").open = !googleClientId();
  $("#gStatus").textContent = "";
  const unavailable = NO_DOWNLOAD || !(window.CompassExports && window.CompassExports.ready());
  $("#gDrive").disabled = unavailable;
  $("#gDownload").disabled = unavailable;
  if (unavailable) $("#gStatus").innerHTML = `Google exports need the full app - open the <a href="https://jithinsl27.github.io/jithinsl27-gcp-ingestion-advisor/" target="_blank" rel="noopener">live demo</a> or your Cloud Run deployment.`;
  $("#gDialog").showModal();
}

export async function buildGoogleFile(kind) {
  if (kind === "sheets") return { blob: await window.CompassExports.xlsx(await workbookSpec()), name: `${slug()}-data-cloud-compass.xlsx` };
  return { blob: await buildDeck(), name: `${slug()}-data-cloud-compass.pptx` };
}

export function bindGoogleExport() {
  $("#gClose").addEventListener("click", () => $("#gDialog").close());
  $("#gClientId").addEventListener("change", (e) => { try { localStorage.setItem(GCLIENT_KEY, e.target.value.trim()); } catch (_) { /* ignore */ } });
  $("#gDownload").addEventListener("click", async () => {
    $("#gStatus").textContent = "Building…";
    try {
      const f = await buildGoogleFile(S.gKind);
      download(f.name, f.blob.type, f.blob);
      $("#gStatus").textContent = `Downloaded ${f.name}.`;
    } catch (err) { $("#gStatus").textContent = `Export failed: ${err.message}`; }
  });
  $("#gDrive").addEventListener("click", async () => {
    const id = ($("#gClientId").value || "").trim() || googleClientId();
    if (!id) { $("#gSetup").open = true; $("#gStatus").textContent = "Add an OAuth client ID first (one-time setup below), or use Download."; return; }
    try { localStorage.setItem(GCLIENT_KEY, id); } catch (_) { /* ignore */ }
    $("#gStatus").textContent = "Building and uploading to Google Drive…";
    try {
      const f = await buildGoogleFile(S.gKind);
      const title = `${S.scenario.customer || "Customer"} - Data Cloud Compass ${S.gKind === "sheets" ? "sizing" : "proposal"}`;
      const res = await window.CompassExports.driveUpload(f.blob, title, S.gKind, id);
      $("#gStatus").innerHTML = `Created <a href="${esc(res.webViewLink)}" target="_blank" rel="noopener">${esc(res.name)}</a> in your Google Drive.`;
    } catch (err) { $("#gStatus").textContent = `Google Drive export failed: ${err.message}. You can still use Download.`; }
  });
}

export const cur = (usd) => Math.round(usd * fx() * 100) / 100;

export async function diagramPng(sel, width) {
  const el = $(sel);
  if (!el) return null;
  try { return await window.CompassExports.svgToPng(inlineSvg(el, true), width, 2); } catch (_) { return null; }
}

export async function workbookSpec() {
  const S = window.CompassExports.STYLE;
  const t = S.result.totals, ccy = S.currency;
  const H = (labels) => labels.map((v) => ({ v, s: S.head }));
  const M = (usd) => ({ v: cur(usd), s: S.money });
  const sheets = [];
  const today = new Date().toISOString().slice(0, 10);

  // Summary
  const groups = S.result.by_group.filter((g) => g.three_year > 0);
  const sum = [
    [{ v: `Data Cloud Compass - ${S.scenario.customer || "Customer"}`, s: S.title }],
    [{ v: `BigQuery region ${S.result.region.name} · ${bqModelName()} · growth ${S.scenario.annual_growth_pct}%/yr · ${S.scenario.environments.length} environment(s) · selected pricing ${OPTIONS.find((o) => o.id === OPT()).name} · currency ${ccy} · ${today}`, s: S.sub }],
    [],
    H(["Horizon", `Pay-as-you-go (${ccy})`, `1-year commitment (${ccy})`, `3-year commitment (${ccy})`, "Discussion range low", "Discussion range high"]),
    ["1 year", M(OV("payg").totals.year1), M(OV("cud1").totals.year1), M(OV("cud3").totals.year1), M(t.range_low_1y), M(t.range_high_1y)],
    ["3 years", M(OV("payg").totals.three_year), M(OV("cud1").totals.three_year), M(OV("cud3").totals.three_year), M(t.range_low_3y), M(t.range_high_3y)],
    [],
    H(["Capability", `Year 1 (${ccy})`, `3 years (${ccy})`]),
    ...groups.map((g) => [g.group, M(g.year1), M(g.three_year)]),
    [{ v: "Total", s: S.bold }, { v: cur(t.year1_payg), s: S.moneyBold }, { v: cur(t.three_year_payg), s: S.moneyBold }],
    [],
    [{ v: S.result.disclaimer, s: S.sub }],
  ];
  sheets.push({ name: "Summary", rows: sum, widths: [34, 22, 22, 20, 20], merges: ["A1:E1", "A2:E2", `A${sum.length}:E${sum.length}`],
    charts: [{ type: "pie", title: `3-year consumption by capability (${ccy})`, catCol: 0, firstRow: 8, lastRow: 7 + groups.length, series: [{ col: 2 }],
      colors: groups.map((g) => (GROUP_COLORS[g.group] || "#9AA0A6").slice(1)), anchor: { col: 6, row: 2, cols: 7, rows: 18 } }] });

  // Architecture
  const arch = await diagramPng("#archSvg", 1440);
  const archRows = [[{ v: "Target architecture", s: S.title }], [{ v: "Diagram exported from Data Cloud Compass; the layers and products are listed below the picture.", s: S.sub }]];
  const imgRows = arch ? Math.ceil((arch.h * (1100 / arch.w)) / 20) + 1 : 0;
  for (let i = 0; i < imgRows; i++) archRows.push([]);
  archRows.push(H(["Layer", "Product", "Vendor", "How it connects / role", "Region", "Priced"]));
  const comps = S.scenario.components.map((c) => ({ c, m: compMeta(c.type) }));
  const catName = (id) => S.catalog.component_categories.find((k) => k.id === id).name;
  const lake = S.result.platform.lakehouse;
  if (lake?.raw_zone) archRows.push(["Raw zone", "Cloud Storage", "Google Cloud", `${lake.raw_storage_class} class, ${lake.raw_retention_months} months, ${lake.raw_scope === "all" ? "all sources" : "batch & file sources"}`, S.scenario.region, "Yes"]);
  (lake?.layers || []).forEach((l) => archRows.push(["BigQuery lakehouse", `${l.name} layer`, "Google Cloud", `${l.role} (${l.pct}% of bronze, ~${fmtGB(l.gib_month12)} at month 12)`, S.scenario.region, "Yes"]));
  comps.forEach(({ c, m }) => {
    const mode = m.modes ? ` - ${m.settings.find((f) => f.key === m.modes.key).options.find((o) => o.id === c.settings[m.modes.key])?.name || ""}` : "";
    archRows.push([catName(m.category), m.name, m.vendor === "google" ? "Google Cloud" : "Partner", { v: m.method + mode, s: S.wrap }, m.costed ? (c.settings.region || S.scenario.region) : "-", m.costed ? (c.included === false ? "No (excluded)" : "Yes") : "Not costed"]);
  });
  sheets.push({ name: "Architecture", rows: archRows, widths: [22, 34, 14, 70, 16, 14],
    images: arch ? [{ png: arch.bytes, name: "Target architecture", anchor: { col: 0, row: 2, cols: 6, rows: imgRows } }] : [] });

  // Sources & ingestion patterns
  const srcRows = [H(["Source", "Type", "Freshness", "Initial volume", "Daily change", "Region", "In this phase", "Pattern", "Services", "IoT integration"])];
  S.scenario.sources.forEach((s) => {
    const r = recFor(s.id);
    srcRows.push([s.name, S.catalog.source_types.find((x) => x.id === s.type)?.name || s.type, freqName(s.frequency), fmtGB(s.initial_volume_gb), fmtGB(s.daily_change_gb) + "/day",
      s.region || S.scenario.region, s.included === false ? "No (later phase)" : "Yes", { v: r ? r.pattern : "-", s: S.wrap }, r ? r.chain.map((x) => tool(x).name).join(" → ") + " → BigQuery" : "-",
      s.type === "iot" ? (S.catalog.iot_options.find((o) => o.id === (s.iot_option || "native"))?.name || "") : ""]);
  });
  sheets.push({ name: "Sources & patterns", rows: srcRows, widths: [28, 24, 14, 14, 14, 16, 14, 50, 50, 36], freeze: 1 });

  // Bill of materials
  const bom = S.result.bom || [];
  const bomRows = [H(["Environment", "Capability", "Product / service", "Why it is needed", "Qty / month (M12)", "Qty, year 1", "Unit", `Unit price (${ccy})`, `Month 12 (${ccy})`, `Year 1 (${ccy})`, `3 years (${ccy})`])];
  bom.forEach((b) => bomRows.push([b.environment_name, b.group, b.service, { v: b.why, s: S.wrap },
    b.qty_month12 == null ? "-" : { v: b.qty_month12, s: S.num }, b.qty_year1 == null ? "-" : { v: b.qty_year1, s: S.num }, b.unit || "-",
    b.unit_price == null ? "-" : { v: Math.round(b.unit_price * fx() * 10000) / 10000, s: S.price }, M(b.month12), M(b.year1), M(b.three_year)]));
  const n = bom.length;
  bomRows.push([{ v: "Total", s: S.bold }, "", "", "", "", "", "", "", { f: `SUM(I2:I${n + 1})`, s: S.moneyBold }, { f: `SUM(J2:J${n + 1})`, s: S.moneyBold }, { f: `SUM(K2:K${n + 1})`, s: S.moneyBold }]);
  sheets.push({ name: "Bill of materials", rows: bomRows, widths: [16, 22, 36, 70, 16, 16, 16, 16, 16, 16, 16], freeze: 1 });

  // Monthly
  const mon = [H(["Month", `Pay-as-you-go (${ccy})`, `With 3-year commitments (${ccy})`])];
  S.result.monthly.forEach((m) => mon.push([`M${m.month}`, M(m.payg), M(m.cud3)]));
  sheets.push({ name: "Monthly", rows: mon, widths: [10, 24, 28], freeze: 1,
    charts: [{ type: "line", title: `Monthly consumption, 36 months (${ccy})`, catCol: 0, firstRow: 1, lastRow: 36, series: [{ col: 1, color: "1A73E8" }, { col: 2, color: "188038", dash: true }], anchor: { col: 4, row: 1, cols: 10, rows: 20 } }] });

  // Environments
  const envs = S.result.environments || [];
  const envRows = [H(["Environment", ...S.catalog.environment_factors.map((f) => f.name), "BigQuery slots", `Per month, yr 1 (${ccy})`, `Year 1 (${ccy})`, `3 years (${ccy})`])];
  envs.forEach((e) => envRows.push([e.name, ...S.catalog.environment_factors.map((f) => ({ v: e.factors[f.id] / 100, s: S.pct })), e.slots ? `${e.slots.baseline} → ${e.slots.max}` : "-", M(e.monthly_year1), M(e.year1), M(e.three_year)]));
  const nf = S.catalog.environment_factors.length;
  sheets.push({ name: "Environments", rows: envRows, widths: [22, ...S.catalog.environment_factors.map(() => 16), 14, 20, 18, 18], freeze: 1,
    charts: envs.length ? [{ type: "bar", title: `Consumption by environment (${ccy})`, catCol: 0, firstRow: 1, lastRow: envs.length, series: [{ col: nf + 3, color: "1A73E8" }, { col: nf + 4, color: "F9AB00" }], anchor: { col: 0, row: envs.length + 3, cols: 8, rows: 16 } }] : [] });

  // Workload sizing + slots
  if (S.wlResult) {
    const w = S.wlResult, wt = w.totals;
    const wr = [[{ v: "Workload-based sizing", s: S.title }], [],
      H(["Period", `Pay-as-you-go (${ccy})`, `With commitments (${ccy})`]),
      ["Ramp-up (per month)", M(wt.ramp_monthly), ""], ["Steady state (per month)", M(wt.steady_monthly), ""], ["1 year", M(wt.year1_payg), M(wt.year1_cud1)], ["3 years", M(wt.three_year_payg), M(wt.three_year_cud3)], [],
      H(["Category", `Steady month (${ccy})`, `Year 1 (${ccy})`, `3 years (${ccy})`])];
    const c0 = wr.length;
    w.by_category.forEach((c) => wr.push([c.category, M(c.steady_month), M(c.year1), M(c.three_year)]));
    const c1 = wr.length - 1;
    wr.push([], H(["Workload line", "Service", `Steady month (${ccy})`, `Year 1 (${ccy})`, `3 years (${ccy})`]));
    w.lines.filter((l) => l.three_year > 0).forEach((l) => wr.push([l.item, l.service, M(l.steady_month), M(l.year1), M(l.three_year)]));
    sheets.push({ name: "Workload sizing", rows: wr, widths: [40, 30, 20, 18, 18],
      charts: [{ type: "bar", horizontal: true, title: `Steady-state month by category (${ccy})`, catCol: 0, firstRow: c0, lastRow: c1, series: [{ col: 1, color: "1A73E8" }], anchor: { col: 6, row: 1, cols: 8, rows: 16 } }] });
    const sl = w.slots;
    if (sl) {
      const sr = [[{ v: "BigQuery slot sizing", s: S.title }], [],
        H(["Measure", "Value"]),
        ["Average demand (slots)", sl.avg_slots], ["Peak hour (slots)", sl.peak_slots], ["Heavy query burst (slots)", sl.heavy_burst_slots],
        ["Recommended baseline (slots)", sl.baseline_slots], ["Max autoscale (slots)", sl.max_slots], ["Edition", EDITION_NAME[sl.edition]], ["Pricing model", sl.model === "editions" ? "Editions (slots)" : "On-demand"],
        [`On-demand per month (${ccy})`, M(sl.costs.ondemand_month)], [`Autoscaling only per month (${ccy})`, M(sl.costs.autoscale_only_month)],
        [`Baseline + autoscale, 1-yr commit (${ccy})`, M(sl.costs.recommended_month)], [`Baseline + autoscale, 3-yr commit (${ccy})`, M(sl.costs.recommended_month_3yr)], [],
        H(["Recommendation"]), ...sl.recommendations.map((x) => [{ v: x, s: S.wrap }]), ...sl.edition_reasons.map((x) => [{ v: x, s: S.wrap }]), [],
        H(["Job type", "TiB / month", "Slot-hours / month", "Avg slots"]), ...sl.by_class.map((b) => [b.class, b.tib_month, b.slot_hours_month, b.avg_slots]), [],
        H(["Hour", "Slots"])];
      const h0 = sr.length;
      sl.profile.forEach((v, h) => sr.push([`${String(h).padStart(2, "0")}:00`, v]));
      sheets.push({ name: "Slot sizing", rows: sr, widths: [60, 16, 18, 12],
        charts: [{ type: "bar", title: "Slot demand by hour of day", catCol: 0, firstRow: h0, lastRow: h0 + 23, series: [{ col: 1, color: "1A73E8" }], anchor: { col: 5, row: 1, cols: 9, rows: 18 } }] });
    }
  }

  // Roadmap
  if (S.planResult) {
    const p = S.planResult;
    const gs = p.group_order.filter((g) => p.months.some((m) => m.by_group[g]));
    const rr = [[{ v: "Ramp-up roadmap", s: S.title }], [{ v: `${p.teams} delivery squad(s) · ${p.horizon} months · year 1 with ramp-up ${money(p.totals.ramped_year1)} vs ${money(p.totals.steady_year1)} at full run-rate`, s: S.sub }], [],
      H(["Month", ...gs.map((g) => `${g} (${ccy})`), `Ramped total (${ccy})`, `Steady state (${ccy})`, "Goes live"])];
    const m0 = rr.length;
    p.months.forEach((m) => rr.push([`M${m.month}`, ...gs.map((g) => M(m.by_group[g] || 0)), M(m.total), M(m.steady),
      { v: [...p.milestones.filter((x) => x.month === m.month).map((x) => x.name), ...m.sources_live, ...m.components_started].join(" · "), s: S.wrap }]));
    const m1 = rr.length - 1;
    rr.push([], H(["Phase", "Start month", "End month", "Scope"]));
    p.phases.forEach((ph) => rr.push([ph.name, ph.start, ph.end, { v: ph.items.join("; "), s: S.wrap }]));
    sheets.push({ name: "Roadmap", rows: rr, widths: [32, ...gs.map(() => 18), 18, 18, 60], freeze: 4,
      charts: [{ type: "stacked", title: `Ramped monthly consumption by capability (${ccy})`, catCol: 0, firstRow: m0, lastRow: m1,
        series: gs.map((g, i) => ({ col: i + 1, color: (GROUP_COLORS[g] || "#9AA0A6").slice(1) })), anchor: { col: gs.length + 5, row: 3, cols: 10, rows: 20 } }] });
  }

  // Assumptions
  const a = S.result.assumptions;
  sheets.push({ name: "Assumptions", rows: [H(["Assumption", "Value"]),
    ["BigQuery region / uplift", `${S.result.region.name} x${S.result.region.uplift.toFixed(2)}`],
    ["Lakehouse", `Raw zone ${lake?.raw_zone ? "on" : "off"}; silver ${lake?.silver_pct}% and gold ${lake?.gold_pct}% of bronze`],
    ["Long-term storage", `${Math.round(a.longterm_share_after_90d * 100)}% of data older than 90 days`],
    ["ELT scan", `${a.elt_scan_multiplier}x data ingested per month`],
    ["Contingency", `${S.scenario.contingency_pct}%`],
    ["Environments", S.scenario.environments.map((e) => e.name).join(", ")],
    ["Partner products", "Never costed (Power BI, Tableau, Litmus, ClearBlade, Collibra …)"],
    ["Prices", `${S.result.pricing_meta.note} Reviewed ${S.result.pricing_meta.last_reviewed}.`],
    ["Disclaimer", { v: S.result.disclaimer, s: S.wrap }]], widths: [30, 110] });
  return sheets;
}

export async function buildDeck() {
  const P = new window.PptxGenJS();
  P.layout = "LAYOUT_WIDE";
  P.author = "Data Cloud Compass";
  P.title = `${S.scenario.customer || "Customer"} - Google Cloud data & AI platform`;
  const FONT = "Roboto", INK = "202124", MUTED = "5F6368", BLUE = "1A73E8";
  const t = S.result.totals, ccy = S.currency;
  P.defineSlideMaster({ title: "COMPASS", background: { color: "FFFFFF" },
    objects: [
      { rect: { x: 0, y: 0, w: 3.33, h: 0.08, fill: { color: "4285F4" } } }, { rect: { x: 3.33, y: 0, w: 3.33, h: 0.08, fill: { color: "EA4335" } } },
      { rect: { x: 6.66, y: 0, w: 3.33, h: 0.08, fill: { color: "FBBC04" } } }, { rect: { x: 9.99, y: 0, w: 3.34, h: 0.08, fill: { color: "34A853" } } },
      { text: { text: `${S.scenario.customer || "Customer"} · Data Cloud Compass`, options: { x: 0.4, y: 7.05, w: 8, h: 0.3, fontFace: FONT, fontSize: 9, color: MUTED } } },
    ],
    slideNumber: { x: 12.4, y: 7.05, fontFace: FONT, fontSize: 9, color: MUTED } });
  const slide = (title, subtitle) => {
    const s = P.addSlide({ masterName: "COMPASS" });
    s.addText(title, { x: 0.4, y: 0.25, w: 12.5, h: 0.6, fontFace: FONT, fontSize: 24, bold: true, color: INK });
    if (subtitle) s.addText(subtitle, { x: 0.4, y: 0.82, w: 12.5, h: 0.4, fontFace: FONT, fontSize: 12, color: MUTED });
    return s;
  };
  const head = (labels) => labels.map((x) => ({ text: x, options: { bold: true, color: "FFFFFF", fill: { color: BLUE } } }));
  const tableOpts = (colW) => ({ x: 0.4, y: 1.35, w: colW.reduce((a, b) => a + b, 0), colW, fontFace: FONT, fontSize: 10, color: INK, border: { type: "solid", pt: 0.5, color: "DADCE0" }, valign: "middle", margin: 0.05 });
  const kpi = (s, x, label, value, note, color) => {
    s.addShape(P.ShapeType.roundRect, { x, y: 1.45, w: 2.95, h: 1.35, fill: { color: "F8F9FA" }, line: { color: "DADCE0" }, rectRadius: 0.08 });
    s.addText([{ text: label + "\n", options: { fontSize: 11, color: MUTED } }, { text: value + "\n", options: { fontSize: 22, bold: true, color: color || INK } }, { text: note || "", options: { fontSize: 10, color: MUTED } }],
      { x: x + 0.15, y: 1.5, w: 2.7, h: 1.25, fontFace: FONT, valign: "top" });
  };
  const cv = (usd) => Math.round(usd * fx());

  // 1. Title
  {
    const s = P.addSlide({ masterName: "COMPASS" });
    s.addText(S.scenario.customer || "Customer", { x: 0.6, y: 1.8, w: 12, h: 0.6, fontFace: FONT, fontSize: 20, color: BLUE, bold: true });
    s.addText("Data & AI platform on Google Cloud", { x: 0.6, y: 2.4, w: 12, h: 1.0, fontFace: FONT, fontSize: 40, bold: true, color: INK });
    s.addText(`Target architecture, ingestion patterns, sizing and 1- / 3-year consumption · BigQuery in ${S.result.region.name} · ${new Date().toLocaleDateString(undefined, { year: "numeric", month: "long" })}`,
      { x: 0.6, y: 3.5, w: 12, h: 0.6, fontFace: FONT, fontSize: 16, color: MUTED });
    s.addText([{ text: "1-year ballpark  ", options: { color: MUTED } }, { text: money(t.year1_payg), options: { bold: true, color: INK } },
      { text: "      3-year ballpark  ", options: { color: MUTED } }, { text: money(t.three_year_payg), options: { bold: true, color: INK } }],
    { x: 0.6, y: 4.5, w: 12, h: 0.5, fontFace: FONT, fontSize: 18 });
  }
  // 2. Architecture
  {
    const s = slide("Target architecture", "Sources → ingestion & CDC → Cloud Storage raw zone → BigQuery bronze / silver / gold → BI, AI, APIs and databases, governed end to end");
    const img = await diagramPng("#archSvg", 1440);
    if (img) {
      const maxW = 12.5, maxH = 5.6;
      let w = maxW, h = (img.h / img.w) * w;
      if (h > maxH) { h = maxH; w = (img.w / img.h) * h; }
      s.addImage({ data: img.dataUrl, x: 0.4 + (maxW - w) / 2, y: 1.3, w, h });
    }
  }
  // 3. Ingestion patterns
  {
    const s = slide("Recommended ingestion patterns", `${S.result.recommendations.length} source systems in this phase · GCP-native ETL / ELT per source`);
    const rows = [head(["Source", "Freshness", "Volume", "Pattern", "Services"])];
    S.scenario.sources.filter((x) => recFor(x.id)).slice(0, 12).forEach((x) => {
      const r = recFor(x.id);
      rows.push([x.name, freqName(x.frequency), `${fmtGB(x.initial_volume_gb)} + ${fmtGB(x.daily_change_gb)}/day`, r.pattern, r.chain.map((k) => tool(k).name).join(" → ")]);
    });
    s.addTable(rows, { ...tableOpts([2.6, 1.4, 1.8, 3.9, 2.8]), fontSize: 9 });
  }
  // 4. Integrations
  {
    const s = slide("BI, AI, API and governance integrations", "How each product connects to BigQuery - partner products are shown but not costed");
    const rows = [head(["Product", "Category", "Vendor", "How it connects / role"])];
    S.scenario.components.slice(0, 14).forEach((c) => {
      const m = compMeta(c.type);
      const mode = m.modes ? (m.modes.notes[c.settings[m.modes.key]] || m.method) : m.method;
      rows.push([m.name, S.catalog.component_categories.find((k) => k.id === m.category).name, m.vendor === "google" ? "Google Cloud" : "Partner", mode]);
    });
    s.addTable(rows, { ...tableOpts([2.9, 2.0, 1.3, 6.3]), fontSize: 9 });
  }
  // 5. Consumption summary
  {
    const s = slide("Ballpark consumption", `${bqModelName()} · ${S.scenario.annual_growth_pct}% annual data growth · ${S.scenario.contingency_pct}% contingency · ${ccy}`);
    const ovk = OV(), oth = OPTIONS.filter((o) => o.id !== OPT());
    kpi(s, 0.4, "Average per month, year 1", money(ovk.totals.avg_monthly_year1), optShort());
    kpi(s, 3.5, "1 year", money(ovk.totals.year1), oth.map((o) => `${money(OV(o.id).totals.year1)} ${o.short}`).join(" · "), BLUE);
    kpi(s, 6.6, "3 years", money(ovk.totals.three_year), oth.map((o) => `${money(OV(o.id).totals.three_year)} ${o.short}`).join(" · "), BLUE);
    kpi(s, 9.7, "Discussion range, 3 years", `${moneyShort(t.range_low_3y)} - ${moneyShort(t.range_high_3y)}`, "commitments to contingency");
    const g = S.result.by_group.filter((x) => x.three_year > 0);
    s.addChart(P.ChartType.bar, [{ name: `Year 1 (${ccy})`, labels: g.map((x) => x.group), values: g.map((x) => cv(x.year1)) }, { name: `3 years (${ccy})`, labels: g.map((x) => x.group), values: g.map((x) => cv(x.three_year)) }],
      { x: 0.4, y: 3.0, w: 6.3, h: 3.9, barDir: "bar", chartColors: [BLUE, "F9AB00"], showLegend: true, legendPos: "b", legendFontFace: FONT, catAxisLabelFontFace: FONT, valAxisLabelFormatCode: "#,##0", catAxisLabelFontSize: 9, valAxisLabelFontSize: 8, showTitle: true, title: "By capability", titleFontSize: 12, titleFontFace: FONT });
    s.addChart(P.ChartType.line, [{ name: "Pay-as-you-go", labels: S.result.monthly.map((m) => `M${m.month}`), values: S.result.monthly.map((m) => cv(m.payg)) }, { name: "With 3-yr commitments", labels: S.result.monthly.map((m) => `M${m.month}`), values: S.result.monthly.map((m) => cv(m.cud3)) }],
      { x: 6.9, y: 3.0, w: 6.0, h: 3.9, chartColors: [BLUE, "188038"], lineDataSymbol: "none", lineSize: 2, showLegend: true, legendPos: "b", legendFontFace: FONT, valAxisLabelFormatCode: "#,##0", catAxisLabelFontSize: 8, valAxisLabelFontSize: 8, showTitle: true, title: `Monthly run-rate (${ccy})`, titleFontSize: 12, titleFontFace: FONT });
  }
  // 6. Environments
  const envs = S.result.environments || [];
  if (envs.length > 1) {
    const s = slide("Environments", `${envs.length} environments, each sized as a share of ${envs[0].name}`);
    const rows = [head(["Environment", "Sizing", "Per month (yr 1)", "Year 1", "3 years"])];
    envs.forEach((e, i) => rows.push([e.name, i === 0 ? "Baseline" : S.catalog.environment_factors.map((f) => `${f.name.replace(" %", "")} ${e.factors[f.id]}%`).join(", "), money(e.monthly_year1), money(e.year1), money(e.three_year)]));
    s.addTable(rows, { ...tableOpts([2.2, 5.6, 1.6, 1.5, 1.6]), fontSize: 9 });
    s.addChart(P.ChartType.bar, [{ name: `3 years (${ccy})`, labels: envs.map((e) => e.name), values: envs.map((e) => cv(e.three_year)) }],
      { x: 0.4, y: 1.6 + 0.32 * (envs.length + 1), w: 7, h: Math.max(2.2, 5.2 - 0.32 * (envs.length + 1)), barDir: "col", chartColors: [BLUE], showLegend: false, valAxisLabelFormatCode: "#,##0", catAxisLabelFontFace: FONT, dataLabelFormatCode: "#,##0", showValue: true, dataLabelFontSize: 9 });
  }
  // 7. Bill of materials (top lines, per environment)
  {
    const bom = (S.result.bom || []).filter((b) => b.environment === (envs[0]?.id || b.environment)).sort((a, b) => b.year1 - a.year1);
    const pages = [bom.slice(0, 13), bom.slice(13, 26)].filter((p) => p.length);
    pages.forEach((page, pi) => {
      const s = slide(`Bill of materials${pages.length > 1 ? ` (${pi + 1}/${pages.length})` : ""}`, `${envs[0]?.name || "Production"} · products ranked by year-1 cost · quantities at month 12${envs.length > 1 ? " · other environments in the Sheets export" : ""}`);
      const rows = [head(["Product", "Why it is needed", "Qty / month", "Unit", "Unit price", "Year 1", "3 years"])];
      page.forEach((b) => rows.push([b.service, b.why.length > 150 ? b.why.slice(0, 147) + "…" : b.why, fmtQty(b.qty_month12), b.unit || "-", unitPrice(b.unit_price), money(b.year1), money(b.three_year)]));
      s.addTable(rows, { ...tableOpts([2.5, 5.0, 1.0, 1.15, 0.95, 1.0, 0.9]), fontSize: 8 });
    });
  }
  // 8. Slot sizing
  const sl = S.wlResult?.slots;
  if (sl) {
    const s = slide("BigQuery slot sizing & recommendation", `From workload inputs at ${sl.slot_hours_per_tib} slot-hours per TiB · ${sl.inputs.batch_window_hours}-hour batch window · ${sl.inputs.business_hours} business hours`);
    kpi(s, 0.4, "Average demand", `${sl.avg_slots} slots`, "over the month");
    kpi(s, 3.5, "Peak hour", `${Math.round(sl.peak_slots)} slots`, sl.heavy_burst_slots > sl.peak_slots ? `heavy query burst ${Math.round(sl.heavy_burst_slots)}` : "busiest hour");
    kpi(s, 6.6, "Reservation", `${sl.baseline_slots} → ${sl.max_slots}`, "baseline → max autoscale", BLUE);
    kpi(s, 9.7, "Recommended", sl.model === "editions" ? EDITION_NAME[sl.edition] : "On-demand", money(sl.model === "editions" ? sl.costs.recommended_month : sl.costs.ondemand_month) + " / month", BLUE);
    s.addChart(P.ChartType.bar, [{ name: "Slots", labels: sl.profile.map((_, h) => `${String(h).padStart(2, "0")}h`), values: sl.profile }],
      { x: 0.4, y: 3.0, w: 6.3, h: 3.9, barDir: "col", chartColors: [BLUE], showLegend: false, showTitle: true, title: "Slot demand by hour of day", titleFontSize: 12, titleFontFace: FONT, catAxisLabelFontSize: 8, valAxisLabelFontSize: 8 });
    s.addText(sl.recommendations.slice(0, 4).map((x) => ({ text: x, options: { bullet: true, breakLine: true } })), { x: 6.9, y: 3.0, w: 6.0, h: 3.9, fontFace: FONT, fontSize: 11, color: INK, valign: "top", paraSpaceAfter: 6 });
  }
  // 9. Roadmap
  if (S.planResult) {
    const p = S.planResult;
    const s = slide("Ramp-up roadmap", `${p.teams} delivery squad(s) · ${p.horizon} months · year 1 with ramp-up ${money(p.totals.ramped_year1)} vs ${money(p.totals.steady_year1)} at full run-rate`);
    const g = await diagramPng("#roadmapBody .gantt-wrap svg", 1000);
    if (g) {
      let w = 12.5, h = (g.h / g.w) * w;
      if (h > 5.6) { h = 5.6; w = (g.w / g.h) * h; }
      s.addImage({ data: g.dataUrl, x: 0.4 + (12.5 - w) / 2, y: 1.3, w, h });
    }
    const s2 = slide("Ramped consumption by month", `Each service starts consuming when it goes live · ${ccy}`);
    const gs = p.group_order.filter((x) => p.months.some((m) => m.by_group[x]));
    s2.addChart(P.ChartType.bar, gs.map((grp) => ({ name: grp, labels: p.months.map((m) => `M${m.month}`), values: p.months.map((m) => cv(m.by_group[grp] || 0)) })),
      { x: 0.4, y: 1.3, w: 12.5, h: 5.6, barDir: "col", barGrouping: "stacked", chartColors: gs.map((x) => (GROUP_COLORS[x] || "#9AA0A6").slice(1)), showLegend: true, legendPos: "r", legendFontSize: 8, valAxisLabelFormatCode: "#,##0", catAxisLabelFontSize: 8, valAxisLabelFontSize: 8 });
  }
  // 10. Next steps
  {
    const s = slide("Assumptions & next steps");
    const lake = S.result.platform.lakehouse;
    const pts = [
      `Ballpark from public list prices (reviewed ${S.result.pricing_meta.last_reviewed}) with regional uplift for ${S.result.region.name}; excludes taxes, support, partner licences and negotiated discounts.`,
      `Lakehouse: ${lake?.raw_zone ? `Cloud Storage raw zone (${lake.raw_storage_class}, ${lake.raw_retention_months} months)` : "no raw zone"}; BigQuery silver ${lake?.silver_pct}% and gold ${lake?.gold_pct}% of bronze.`,
      `Environments: ${S.scenario.environments.map((e) => e.name).join(", ")}.`,
      "Validate volumes, change rates and query patterns with source owners; confirm CDC prerequisites (supplemental logging, replication slots).",
      "Run a 4-6 week pilot on one quick-win source and one CDC source, measure slot usage with INFORMATION_SCHEMA, then right-size commitments.",
      "Confirm data-residency and security controls (VPC Service Controls, CMEK, Assured Workloads) with the customer's risk team.",
      "Validate pricing with the Google Cloud Pricing Calculator before any formal proposal.",
    ];
    s.addText(pts.map((x) => ({ text: x, options: { bullet: true, breakLine: true } })), { x: 0.5, y: 1.3, w: 12.3, h: 5.5, fontFace: FONT, fontSize: 15, color: INK, valign: "top", paraSpaceAfter: 10 });
  }
  return P.write({ outputType: "blob" });
}

export function showCopyBox(name, text) {
  $("#copyTitle").textContent = name;
  $("#copyText").value = text;
  $("#copyDialog").showModal();
  $("#copyText").select();
}
