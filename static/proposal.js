/* Data Cloud Compass - customer proposal generator (max 15 pages).
 *
 * build(ctx) turns the current engagement into a list of pages made of simple
 * blocks (paragraphs, bullets, KPI tiles, tables, images, charts). The same
 * pages render as an A4 HTML preview (print / Save as PDF) and as a Word
 * document (docx library, loaded on demand) that Google Docs can import.
 */
(() => {
  "use strict";
  const MAX_PAGES = 15;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const SECTIONS = [
    { id: "cover", name: "Cover" },
    { id: "summary", name: "Executive summary" },
    { id: "landscape", name: "Current landscape & scope" },
    { id: "architecture", name: "Target architecture" },
    { id: "ingestion", name: "Ingestion & data movement" },
    { id: "lakehouse", name: "Lakehouse, governance & security" },
    { id: "consumption", name: "Analytics, AI & integration" },
    { id: "environments", name: "Environments & operating model" },
    { id: "capacity", name: "BigQuery capacity & slot sizing" },
    { id: "commercials", name: "Commercial options" },
    { id: "products", name: "Product breakdown" },
    { id: "monthly", name: "Monthly consumption & ramp-up" },
    { id: "roadmap", name: "Delivery roadmap" },
    { id: "assumptions", name: "Assumptions, risks & dependencies" },
    { id: "next", name: "Kickoff readiness, team & next steps" },
  ];
  const PLAN_KEY = { payg_1y: "payg", commit_1y: "cud1", commit_3y: "cud3", payg_3y: "payg" };
  const sum = (a, lo = 0, hi = a.length) => a.slice(lo, hi).reduce((x, y) => x + y, 0);

  // ------------------------------------------------------------------ content
  async function build(ctx) {
    const { scenario: sc, result: r, wl, plan, catalog, opts } = ctx;
    const m = ctx.money, ms = ctx.moneyShort;
    const pricing = plan?.pricing?.[opts.basis] || plan?.pricing?.ramped;
    const plans = pricing?.plans;
    const chosen = plans?.[opts.plan] || plans?.payg_1y;
    const customer = sc.customer || "Customer";
    const recs = r.recommendations;
    const srcName = (id) => sc.sources.find((s) => s.id === id)?.name || id;
    const comps = sc.components.map((c) => ({ c, meta: ctx.compMeta(c.type) }));
    const lake = r.platform.lakehouse || {};
    const tg = r.platform.targets || {};
    const sl = wl?.slots;
    const pages = [];
    const on = (id) => opts.sections.includes(id);
    const page = (id, title, blocks) => { if (on(id)) pages.push({ id, title, blocks: blocks.filter(Boolean) }); };

    // 1 cover
    page("cover", "", [{ type: "cover", customer, title: opts.title || "Data & AI platform on Google Cloud",
      subtitle: `Target architecture, ingestion design, sizing and commercial options`,
      by: [opts.author, opts.company].filter(Boolean).join(", "), date: new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) }]);

    // 2 executive summary
    const live = plan ? Math.max(...plan.waves.map((w) => w.go_live_month), 1) : null;
    page("summary", "Executive summary", [
      { type: "p", text: opts.summary || `${customer} wants a governed, AI-ready data platform on Google Cloud. This proposal brings ${recs.length} source system${recs.length === 1 ? "" : "s"} onto Google Cloud${(tg.data_platform || []).length ? ` - ${(tg.data_platform || []).length} into a BigQuery lakehouse (bronze, silver and gold layers)` : ""}${(tg.data_lake || []).length ? `, ${(tg.data_lake || []).length} into a Cloud Storage data lake` : ""}${(tg.operational_db || []).length ? `, ${(tg.operational_db || []).length} into managed operational databases` : ""} - and connects them to ${comps.filter((x) => ["bi", "ai", "integration"].includes(x.meta.category)).map((x) => x.meta.name).slice(0, 5).join(", ") || "the customer's analytics tools"}.` },
      plans ? { type: "kpis", items: [
        { label: "1 year, pay as you go", value: m(plans.payg_1y.total) },
        { label: "1-year commitment", value: m(plans.commit_1y.total), note: `saves ${m(plans.commit_1y.saving)}` },
        { label: "3-year commitment", value: m(plans.commit_3y.total), note: plans.commit_3y.by_year.map((v, i) => `Y${i + 1} ${ms(v)}`).join(" · ") },
        { label: "All sources live", value: live ? `Month ${live}` : "-", note: plan ? `${plan.teams} delivery squad(s)` : "" },
      ] } : null,
      ...(() => {
        const ucs = (sc.use_cases || []).length ? sc.use_cases.map((u) => u.name) : (r.use_cases || []).map((u) => `${u.name} - ${u.value}`);
        return ucs.length ? [{ type: "h", text: (sc.use_cases || []).length ? "Use cases" : "Recommended use cases" }, { type: "ul", items: ucs.slice(0, 6) }] : [];
      })(),
      { type: "h", text: "What we recommend" },
      { type: "ul", items: [
        `GCP-native, serverless ingestion: ${[...new Set(recs.map((x) => ctx.tool(x.primary).name))].slice(0, 6).join(", ")}.`,
        lake.raw_zone ? `A Cloud Storage raw zone (${lake.raw_retention_months} months) feeding BigQuery bronze, silver (${lake.silver_pct}%) and gold (${lake.gold_pct}%) layers built with Dataform.` : `BigQuery bronze, silver and gold layers built with Dataform.`,
        `${ctx.bqModelName()} in ${r.region.name}${r.bigquery?.project_totals && sc.bq?.mode === "editions" ? `; across all environments up to ${r.bigquery.project_totals.cud1.max} slots with ${r.bigquery.project_totals.cud3.commitment ? `${r.bigquery.project_totals.cud3.commitment} slots committed on 3 years` : "no slot commitment until usage is steady"}` : ""}.`,
        `${sc.environments.length} environment${sc.environments.length > 1 ? "s" : ""} (${sc.environments.map((e) => e.name).join(", ")}), each sized as a share of production.`,
        plans ? `Commercially, a ${plans.commit_3y.saving > plans.commit_1y.saving ? "3-year" : "1-year"} commitment gives the best value once the ramp-up is complete.` : "",
      ].filter(Boolean) },
    ].filter(Boolean));

    // 3 landscape
    const srcRows = sc.sources.slice(0, 18).map((s) => {
      const rec = recs.find((x) => x.source_id === s.id);
      const type = s.type === "custom" ? `${s.custom_name || "Custom"} (custom)` : catalog.source_types.find((t) => t.id === s.type)?.name || s.type;
      return [s.name, type, ctx.freqName(s.frequency), `${ctx.fmtGB(s.initial_volume_gb)} + ${ctx.fmtGB(s.daily_change_gb)}/day`,
        { data_platform: "Data platform", data_lake: "Data lake", operational_db: "Operational DB" }[rec?.target || s.target || "data_platform"], s.included === false ? "Later" : "Phase 1"];
    });
    page("landscape", "Current landscape & scope", [
      { type: "p", text: `Discovery identified ${sc.sources.length} source system${sc.sources.length === 1 ? "" : "s"} with about ${ctx.fmtGB(sc.sources.reduce((a, s) => a + (Number(s.initial_volume_gb) || 0), 0))} of historical data and ${ctx.fmtGB(sc.sources.reduce((a, s) => a + (Number(s.daily_change_gb) || 0), 0))} of change per day.` },
      { type: "table", head: ["Source", "Type", "Freshness", "Volume", "Target", "Phase"], rows: srcRows, widths: [22, 20, 14, 18, 14, 12] },
      sc.sources.length > 18 ? { type: "note", text: `${sc.sources.length - 18} further sources are listed in the Sheets export.` } : null,
    ].filter(Boolean));

    // 4 architecture
    const arch = await ctx.diagramPng("#archSvg", 1440);
    page("architecture", "Target architecture", [
      arch ? { type: "img", data: arch.dataUrl, w: arch.w, h: arch.h, bytes: arch.bytes } : { type: "note", text: "Open the Architecture module once to include the diagram." },
      { type: "ul", items: [
        "Sources connect privately (HA VPN or Interconnect where needed) to serverless ingestion and change data capture.",
        lake.raw_zone ? "Batch extracts land first in a Cloud Storage raw zone for replay and audit." : "Data lands directly in the BigQuery bronze layer.",
        "BigQuery hosts bronze (as ingested), silver (cleansed, conformed) and gold (curated marts) layers as open Iceberg / BigLake tables.",
        "BI, AI agents, APIs and operational databases consume the same governed data; governance and security span every layer.",
      ] },
    ]);

    // 5 ingestion
    page("ingestion", "Ingestion & data movement", [
      { type: "table", head: ["Source", "Pattern", "Services"], widths: [22, 40, 38],
        rows: recs.slice(0, 14).map((x) => [srcName(x.source_id), x.pattern, x.chain.map((t) => ctx.tool(t).name).join(" → ")]) },
      { type: "h", text: "Why these patterns" },
      { type: "ul", items: [...new Set(recs.map((x) => x.rationale[0]))].slice(0, 5) },
    ]);

    // 6 lakehouse, governance, security
    const gov = comps.filter((x) => ["governance", "security"].includes(x.meta.category));
    page("lakehouse", "Lakehouse, governance & security", [
      { type: "table", head: ["Layer", "Purpose", "Size at month 12"], widths: [22, 56, 22], rows: [
        ...(lake.raw_zone ? [["Raw zone (Cloud Storage)", `Immutable source extracts, ${lake.raw_storage_class} class, ${lake.raw_retention_months} months`, ctx.fmtGB(lake.raw_gib_month12)]] : []),
        ...(lake.layers || []).map((l) => [`${l.name} (BigQuery)`, l.role, ctx.fmtGB(l.gib_month12)]),
        ...((tg.data_lake || []).length ? [["Data lake (Cloud Storage)", "Open-format lake for sources targeted at the lake, queried through BigLake", ctx.fmtGB(r.platform.data_lake_gib_month12 || 0)]] : []),
      ] },
      { type: "h", text: "Governance & security controls" },
      { type: "ul", items: gov.length ? gov.map((x) => `${x.meta.name}: ${x.meta.method}.`) : ["Add governance and security products (Knowledge Catalog, CMEK, VPC Service Controls …) in the Architecture module."] },
    ]);

    // 7 consumption
    const use = comps.filter((x) => ["bi", "ai", "integration", "database"].includes(x.meta.category)).slice(0, 12);
    page("consumption", "Analytics, AI & integration", [
      { type: "table", head: ["Product", "Vendor", "How it connects"], widths: [26, 14, 60],
        rows: use.map((x) => [x.meta.name, x.meta.vendor === "google" ? "Google Cloud" : "Partner (not costed)",
          x.meta.modes ? (x.meta.modes.notes[x.c.settings[x.meta.modes.key]] || x.meta.method) : x.meta.method]) },
    ]);

    // 8 environments
    const envs = r.environments || [];
    page("environments", "Environments & operating model", [
      { type: "table", head: ["Environment", "Sizing vs production", "Year 1", "3 years"], widths: [20, 50, 15, 15],
        rows: envs.map((e, i) => [e.name, i === 0 ? "Baseline" : catalog.environment_factors.map((f) => `${f.name.replace(" %", "")} ${e.factors[f.id]}%`).join(", "), m(e.year1), m(e.three_year)]) },
      { type: "ul", items: ["Separate projects per environment under one organisation and folder hierarchy, with shared VPC and private connectivity.",
        "Dataform and infrastructure-as-code (Terraform) promote changes from development to production through CI/CD.",
        "Budgets, quotas and labels per environment give cost visibility and guardrails."] },
    ]);

    // 9 capacity
    page("capacity", "BigQuery capacity & slot sizing", sl ? [
      { type: "kpis", items: [
        { label: "Average demand", value: `${sl.avg_slots} slots` }, { label: "Peak hour", value: `${Math.round(sl.peak_slots)} slots` },
        { label: "Reservation", value: `${sl.baseline_slots} → ${sl.max_slots}`, note: "baseline → max autoscale" },
        { label: "Recommended", value: sl.model === "editions" ? ctx.EDITION_NAME[sl.edition] : "On-demand", note: m(sl.model === "editions" ? sl.costs.recommended_month : sl.costs.ondemand_month) + " / month" }] },
      { type: "chart", kind: "bars", labels: sl.profile.map((_, h) => `${String(h).padStart(2, "0")}h`), values: sl.profile, title: "Average slot demand by hour of day", color: "#1A73E8" },
      { type: "ul", items: [...sl.recommendations.slice(0, 4), ...sl.edition_reasons.slice(0, 2)] },
    ] : [{ type: "note", text: "Open the Sizing & slots module to size BigQuery capacity." }]);

    // 10 commercials
    if (plans) {
      page("commercials", "Commercial options", [
        { type: "p", text: `Whole-programme consumption ${opts.basis === "ramped" ? "following the ramp-up plan (each service starts when it goes live)" : "with every service at full scope from month 1"}, at public list prices in ${ctx.currency}.` },
        { type: "table", head: ["Option", "Year 1", "Year 2", "Year 3", "Total", "Saving vs pay as you go"], widths: [26, 14, 14, 14, 16, 16], rows: [
          ["Pay as you go - 1 year", m(plans.payg_1y.total), "-", "-", m(plans.payg_1y.total), "-"],
          ["1-year commitment", m(plans.commit_1y.total), "-", "-", m(plans.commit_1y.total), m(plans.commit_1y.saving)],
          ["Pay as you go - 3 years", ...plans.payg_3y.by_year.map((v) => m(v)), m(plans.payg_3y.total), "-"],
          ["3-year commitment", ...plans.commit_3y.by_year.map((v) => m(v)), m(plans.commit_3y.total), m(plans.commit_3y.saving)],
        ] },
        { type: "chart", kind: "grouped", labels: ["Year 1", "Year 2", "Year 3"], series: [
          { name: "Pay as you go", values: plans.payg_3y.by_year, color: "#FBBC04" }, { name: "3-year commitment", values: plans.commit_3y.by_year, color: "#188038" }],
          title: `Yearly consumption (${ctx.currency})` },
        { type: "note", text: "Commitment pricing applies to services that offer committed-use discounts; other services stay pay as you go. Partner licences, taxes and support are not included." },
      ]);
      // 11 products
      const key = PLAN_KEY[opts.plan] || "payg", months = chosen.months;
      const prods = mergeEnv(pricing.products).map((p) => ({ ...p, cost: sum(p[key], 0, months), q: sum(p.qty, 0, months) })).filter((p) => p.cost > 0).sort((a, b) => b.cost - a.cost);
      const top = prods.slice(0, 16), rest = prods.slice(16);
      const rows = top.map((p) => months === 36
        ? [p.service, p.unit || "-", p.unit ? ctx.fmtQty(p.q) : "-", ctx.unitPrice(p.unit && p.q ? p.cost / p.q : null), ...[0, 1, 2].map((y) => ms(sum(p[key], y * 12, y * 12 + 12))), m(p.cost)]
        : [p.service, p.unit || "-", p.unit ? ctx.fmtQty(p.q) : "-", ctx.unitPrice(p.unit && p.q ? p.cost / p.q : null), m(p.cost / 12), m(p.cost)]);
      if (rest.length) rows.push(months === 36 ? [`${rest.length} other items`, "", "", "", "", "", "", m(rest.reduce((a, p) => a + p.cost, 0))] : [`${rest.length} other items`, "", "", "", "", m(rest.reduce((a, p) => a + p.cost, 0))]);
      page("products", `Product breakdown - ${chosen.label}`, [
        { type: "table", head: months === 36 ? ["Product", "Unit", "Qty, 3 yrs", "Unit price", "Year 1", "Year 2", "Year 3", "Total"] : ["Product", "Unit", "Qty, 12 months", "Unit price", "Avg / month", "Total"],
          widths: months === 36 ? [28, 12, 11, 10, 10, 10, 10, 9] : [34, 14, 14, 12, 13, 13], rows, small: true },
        { type: "note", text: `Total ${m(chosen.total)}. Unit price is the blended price over the term including regional uplift and tiers. All environments combined.` },
      ]);
      // 12 monthly
      const series = chosen.monthly;
      const mrows = months === 12 ? series.map((v, i) => [`Month ${i + 1}`, m(v), plan.months[i] ? [...plan.months[i].sources_live, ...plan.months[i].components_started].slice(0, 3).join(", ") || "-" : "-"])
        : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((qtr) => [`Year ${Math.floor(qtr / 4) + 1} · Q${qtr % 4 + 1}`, m(sum(series, qtr * 3, qtr * 3 + 3)), `${ms(series[qtr * 3])} → ${ms(series[qtr * 3 + 2])} per month`]);
      page("monthly", `Monthly consumption & ramp-up - ${chosen.label}`, [
        { type: "chart", kind: "bars", labels: series.map((_, i) => `M${i + 1}`), values: series, title: `Monthly consumption (${ctx.currency})`, color: "#1A73E8" },
        { type: "table", head: months === 12 ? ["Month", "Consumption", "Goes live"] : ["Quarter", "Consumption", "Monthly run-rate"], widths: [24, 22, 54], rows: mrows, small: true },
      ]);
    }

    // 13 roadmap
    const gantt = await ctx.diagramPng("#roadmapBody .gantt-wrap svg", 1000);
    page("roadmap", "Delivery roadmap", plan ? [
      gantt ? { type: "img", data: gantt.dataUrl, w: gantt.w, h: gantt.h, bytes: gantt.bytes, maxH: 0.55 } : null,
      plan.readiness ? { type: "table", small: true, head: ["Month", "Milestone", "Exit criteria"], widths: [14, 26, 60], rows: plan.readiness.milestones.map((x) => [x.month === 0 ? "Before M1" : `M${x.month}`, x.name, x.exit]) }
        : { type: "table", head: ["Milestone", "Month"], widths: [70, 30], rows: plan.milestones.map((x) => [x.name, `Month ${x.month}`]) },
    ].filter(Boolean) : [{ type: "note", text: "Roadmap not available yet." }]);

    // 14 assumptions
    page("assumptions", "Assumptions, risks & dependencies", [
      { type: "h", text: "Assumptions" },
      { type: "ul", items: [
        `Public list prices reviewed ${r.pricing_meta.last_reviewed}, regional uplift for ${r.region.name}, ${sc.annual_growth_pct}% annual data growth, ${sc.contingency_pct}% contingency.`,
        "Volumes, change rates and query patterns are discovery estimates and will be validated in the pilot.",
        "Partner licences (BI, ISV connectors, catalogues), taxes, support and professional services are excluded.",
      ] },
      { type: "h", text: "Risks & dependencies" },
      { type: "ul", items: [...new Set(recs.flatMap((x) => x.caveats))].slice(0, 6).concat(["Data-residency and security sign-off for every region used."]) },
    ]);

    // 15 kickoff readiness, team & next steps
    const rd = plan?.readiness;
    page("next", "Kickoff readiness, team & next steps", [
      rd ? { type: "p", text: `Delivery team: about ${rd.team.partner_fte} partner FTE at peak in ${rd.team.squads} squad(s), with ${rd.team.customer.length} customer roles. The full checklist (${rd.summary.items} items) is in the Kickoff readiness module and the Sheets export.` } : null,
      rd ? { type: "table", small: true, head: ["Partner role", "People", "Key skills"], widths: [30, 10, 60], rows: rd.team.partner.map((x) => [x.role, String(x.count), x.skills.slice(0, 4).join(", ")]) } : null,
      rd ? { type: "h", text: "Critical before kickoff" } : null,
      rd ? { type: "table", small: true, head: ["Owner", "Item"], widths: [14, 86], rows: rd.checklist.filter((c) => c.critical).slice(0, 8).map((c) => [c.owner, c.item]) } : null,
      { type: "h", text: "Next steps" },
      { type: "ol", items: [
        "Confirm scope, success criteria and the commercial option with business and IT stakeholders.",
        "Close the critical readiness items with source owners, network and security teams.",
        "Mobilise the delivery squads; start with the landing zone and one quick-win and one CDC source.",
      ] },
      { type: "p", text: `Prepared ${[opts.author, opts.company].filter(Boolean).length ? "by " + [opts.author, opts.company].filter(Boolean).join(", ") : ""} with Data Cloud Compass. Figures are ballpark estimates for discussion; validate with the Google Cloud Pricing Calculator before contracting.` },
    ]);
    return pages.slice(0, MAX_PAGES);
  }

  function mergeEnv(rows) {
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.service)) by.set(r.service, { ...r, payg: [...r.payg], cud1: [...r.cud1], cud3: [...r.cud3], qty: [...r.qty] });
      else { const a = by.get(r.service); ["payg", "cud1", "cud3", "qty"].forEach((f) => r[f].forEach((v, i) => (a[f][i] += v))); }
    }
    return [...by.values()];
  }

  // ------------------------------------------------------------------ charts (self-contained SVG)
  function chartSvg(b, fmt) {
    const W = 760, H = 230, L = 64, R = 10, T = 28, B = 28;
    const vals = b.kind === "grouped" ? b.series.flatMap((s) => s.values) : b.values;
    const max = Math.max(...vals, 1) * 1.1;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    let g = `<text x="${L}" y="16" font-family="Arial" font-size="13" font-weight="700" fill="#202124">${esc(b.title)}</text>`;
    for (let k = 0; k <= 3; k++) { const v = (max / 3) * k; g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E8EAED"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-family="Arial" font-size="10" fill="#5F6368">${esc(fmt(v))}</text>`; }
    const n = b.labels.length, bw = (W - L - R) / n;
    b.labels.forEach((lab, i) => {
      if (b.kind === "grouped") {
        const k = b.series.length, w = (bw * 0.7) / k;
        b.series.forEach((s, j) => { const v = s.values[i]; g += `<rect x="${L + i * bw + bw * 0.15 + j * w}" y="${y(v)}" width="${w - 2}" height="${y(0) - y(v)}" fill="${s.color}"/>`; });
      } else {
        const v = b.values[i];
        g += `<rect x="${L + i * bw + bw * 0.15}" y="${y(v)}" width="${bw * 0.7}" height="${Math.max(0, y(0) - y(v))}" fill="${b.color || "#1A73E8"}"/>`;
      }
      if (n <= 12 || i % Math.ceil(n / 12) === 0) g += `<text x="${L + i * bw + bw / 2}" y="${H - 9}" text-anchor="middle" font-family="Arial" font-size="10" fill="#5F6368">${esc(lab)}</text>`;
    });
    if (b.kind === "grouped") g += b.series.map((s, j) => `<rect x="${W - 260 + j * 130}" y="6" width="10" height="10" fill="${s.color}"/><text x="${W - 246 + j * 130}" y="15" font-family="Arial" font-size="11" fill="#3C4043">${esc(s.name)}</text>`).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${g}</svg>`;
  }

  // ------------------------------------------------------------------ HTML (preview + print)
  function blockHtml(b, ctx) {
    if (!b) return "";
    switch (b.type) {
      case "cover": return `<div class="pp-cover"><div class="pp-bar"><i></i><i></i><i></i><i></i></div><p class="pp-cust">${esc(b.customer)}</p><h1>${esc(b.title)}</h1><p class="pp-sub">${esc(b.subtitle)}</p>
        <p class="pp-meta">${b.by ? `Prepared by ${esc(b.by)}<br>` : ""}${esc(b.date)}</p><p class="pp-brand">Proposal prepared with Data Cloud Compass</p></div>`;
      case "h": return `<h3>${esc(b.text)}</h3>`;
      case "p": return `<p>${esc(b.text)}</p>`;
      case "note": return `<p class="pp-note">${esc(b.text)}</p>`;
      case "ul": return `<ul>${b.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
      case "ol": return `<ol>${b.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>`;
      case "kpis": return `<div class="pp-kpis">${b.items.map((k) => `<div><span>${esc(k.label)}</span><b>${esc(k.value)}</b>${k.note ? `<small>${esc(k.note)}</small>` : ""}</div>`).join("")}</div>`;
      case "table": return `<table class="pp-table${b.small ? " small" : ""}"><colgroup>${(b.widths || []).map((w) => `<col style="width:${w}%">`).join("")}</colgroup><thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
        <tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      case "img": return `<img class="pp-img" src="${b.data}" alt="" style="max-height:${(b.maxH || 0.62) * 100}%">`;
      case "chart": return `<div class="pp-chart">${chartSvg(b, ctx.moneyShort)}</div>`;
      default: return "";
    }
  }
  function toHtml(pages, ctx) {
    return pages.map((p, i) => `<article class="pp-page${p.id === "cover" ? " cover" : ""}">${p.title ? `<header><h2>${esc(p.title)}</h2></header>` : ""}
      <div class="pp-body">${p.blocks.map((b) => blockHtml(b, ctx)).join("")}</div>
      ${p.id === "cover" ? "" : `<footer><span>${esc(ctx.scenario.customer || "Customer")} · Data & AI platform proposal</span><span>${i + 1} / ${pages.length}</span></footer>`}</article>`).join("");
  }

  // ------------------------------------------------------------------ Word (.docx)
  function loadDocx(base) {
    if (window.docx) return Promise.resolve(window.docx);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = base + "docx.min.js";
      s.onload = () => (window.docx ? resolve(window.docx) : reject(new Error("Word library failed to load")));
      s.onerror = () => reject(new Error("Could not load the Word library"));
      document.head.appendChild(s);
    });
  }
  async function svgPng(svg) {
    const r = await window.CompassExports.svgToPng(svg, 760, 2);
    return r;
  }
  async function toDocx(pages, ctx, base) {
    const D = await loadDocx(base);
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ImageRun, AlignmentType, PageBreak, ShadingType, Footer, PageNumber, TableLayoutType } = D;
    const FONT = "Arial";
    const kids = [];
    const para = (text, o = {}) => new Paragraph({ spacing: { after: 120 }, ...o, children: [new TextRun({ text, font: FONT, size: o.size || 21, bold: o.bold, color: o.color, italics: o.italics })] });
    const cell = (text, head, w) => new TableCell({ width: { size: Math.round(w * 97), type: WidthType.DXA }, shading: head ? { type: ShadingType.CLEAR, color: "auto", fill: "1A73E8" } : undefined,
      margins: { top: 50, bottom: 50, left: 80, right: 80 },
      children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ""), font: FONT, size: 17, bold: head, color: head ? "FFFFFF" : "202124" })] })] });
    const PAGE_W = 9000000; // EMU-ish budget for images (approx 6.5in usable width -> pixels below)
    const imgRun = (bytes, w, h, maxH = 0.62) => {
      let width = 620, height = Math.round((h / w) * width);
      const cap = Math.round(860 * maxH);
      if (height > cap) { height = cap; width = Math.round((w / h) * height); }
      return new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: bytes, transformation: { width, height } })] });
    };
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (i > 0) kids.push(new Paragraph({ children: [new PageBreak()] }));
      if (p.title) kids.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 200 }, children: [new TextRun({ text: p.title, font: FONT, size: 34, bold: true, color: "1A73E8" })] }));
      for (const b of p.blocks) {
        if (!b) continue;
        if (b.type === "cover") {
          kids.push(para("", { spacing: { before: 2400 } }), para(b.customer, { size: 32, bold: true, color: "1A73E8" }), para(b.title, { size: 56, bold: true }),
            para(b.subtitle, { size: 26, color: "5F6368" }), para(b.by ? `Prepared by ${b.by}` : "", { size: 22 }), para(b.date, { size: 22, color: "5F6368" }));
        } else if (b.type === "h") kids.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 }, children: [new TextRun({ text: b.text, font: FONT, size: 26, bold: true })] }));
        else if (b.type === "p") kids.push(para(b.text));
        else if (b.type === "note") kids.push(para(b.text, { size: 17, italics: true, color: "5F6368" }));
        else if (b.type === "ul" || b.type === "ol") b.items.forEach((x, k) => kids.push(new Paragraph({ spacing: { after: 80 }, bullet: b.type === "ul" ? { level: 0 } : undefined,
          children: [new TextRun({ text: (b.type === "ol" ? `${k + 1}. ` : "") + x, font: FONT, size: 21 })] })));
        else if (b.type === "kpis") kids.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ children: b.items.map((k) => new TableCell({ width: { size: 100 / b.items.length, type: WidthType.PERCENTAGE }, margins: { top: 80, bottom: 80, left: 100, right: 100 },
            shading: { type: ShadingType.CLEAR, color: "auto", fill: "F1F3F4" },
            children: [para(k.label, { size: 17, color: "5F6368" }), para(k.value, { size: 30, bold: true }), ...(k.note ? [para(k.note, { size: 16, color: "5F6368" })] : [])] })) })] }), para(""));
        else if (b.type === "table") {
          const w = b.widths || b.head.map(() => 100 / b.head.length);
          const tot = w.reduce((x, y) => x + y, 0);
          kids.push(new Table({ width: { size: 9700, type: WidthType.DXA }, columnWidths: w.map((x) => Math.round((x / tot) * 9700)), layout: TableLayoutType.FIXED,
            rows: [new TableRow({ tableHeader: true, children: b.head.map((h, k) => cell(h, true, w[k])) }),
            ...b.rows.map((r) => new TableRow({ children: r.map((c, k) => cell(c, false, w[k])) }))] }), para(""));
        } else if (b.type === "img" && b.bytes) kids.push(imgRun(b.bytes, b.w, b.h, b.maxH));
        else if (b.type === "chart") { const png = await svgPng(chartSvg(b, ctx.moneyShort)); kids.push(imgRun(png.bytes, png.w, png.h, 0.3)); }
      }
    }
    void PAGE_W;
    const doc = new Document({ creator: "Data Cloud Compass", title: `${ctx.scenario.customer || "Customer"} - Data & AI platform proposal`,
      sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ font: FONT, size: 16, color: "5F6368", children: [`${ctx.scenario.customer || "Customer"} · page `, PageNumber.CURRENT] })] })] }) },
        children: kids }] });
    return Packer.toBlob(doc);
  }

  window.CompassProposal = { build, toHtml, toDocx, SECTIONS, MAX_PAGES };
})();
