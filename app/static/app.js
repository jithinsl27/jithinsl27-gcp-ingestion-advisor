/* GCP Ingestion Advisor - front end (no build step, no framework).
 *
 * The page talks to the backend through `api`. In the hosted demo build the
 * same page runs the Python engine in the browser and sets window.ADVISOR_API,
 * so this file works unchanged in both modes.
 */
(() => {
  "use strict";

  const api = window.ADVISOR_API || {
    catalog: () => fetch("/api/catalog").then(okJson),
    samples: () => fetch("/api/samples").then(okJson),
    estimate: (scenario) => fetch("/api/estimate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scenario),
    }).then(okJson),
  };

  async function okJson(r) {
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch (_) {}
      throw new Error(msg);
    }
    return r.json();
  }

  const STORE_KEY = "ingestion-advisor:scenario:v1";
  const STREAMING = new Set(["realtime", "near_realtime"]);
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const DEFAULT_SCENARIO = {
    customer: "", region: "me-central2", skill: "sql", orchestration: "auto", environment: "production",
    bq_model: "ondemand", bq_slots: 100, analytics_tib_month: null, annual_growth_pct: 20, contingency_pct: 10,
    sources: [],
    platform: {
      bi: { enabled: true, tool: "looker", users: 50, looker_annual_usd: 0 },
      gemini_enterprise: { enabled: true, edition: "standard", users: 100 },
      agents: { enabled: true, model: "flash", requests_month: 50000, input_tokens: 4000, output_tokens: 800, agent_seconds: 6, bq_gb_per_request: 0.2 },
      gpu: { enabled: false, gpu: "l4", replicas: 1, hours_per_day: 24 },
      governance: { enabled: true, dq_share_pct: 20, dq_scans_per_month: 30 },
      security: { enabled: true, sdp_discovery: true, cmek: true, vpc_sc: true },
    },
  };

  function withDefaults(sc) {
    const d = structuredClone(DEFAULT_SCENARIO);
    const out = { ...d, ...sc };
    out.platform = {};
    Object.keys(d.platform).forEach((k) => (out.platform[k] = { ...d.platform[k], ...((sc.platform || {})[k] || {}) }));
    return out;
  }

  let catalog = null;
  let scenario = structuredClone(DEFAULT_SCENARIO);
  let result = null;
  let currency = "USD";
  let editingId = null;
  let estimateTimer = null;
  let seq = 0;

  // ------------------------------------------------------------------ boot
  async function boot() {
    try {
      catalog = await api.catalog();
    } catch (e) {
      toast(`Could not load the catalog: ${e.message}`, 8000);
      return;
    }
    fillSelects();
    if (window.ADVISOR_NO_DOWNLOAD) {
      $$('[data-export="print"]').forEach((b) => (b.hidden = true));
      $$("#exportMenu [data-export]").forEach((b) => { if (["md", "csv", "json", "svg"].includes(b.dataset.export)) b.textContent = "Copy " + b.textContent.charAt(0).toLowerCase() + b.textContent.slice(1); });
    }
    if (window.ADVISOR_DEMO) document.body.classList.add("demo");
    restore();
    bindEvents();
    loadSamples();
    syncForm();
    renderAll();
    scheduleEstimate(0);
  }

  function opt(list, sel) {
    return list.map((o) => `<option value="${esc(o.id)}"${o.id === sel ? " selected" : ""}>${esc(o.name)}</option>`).join("");
  }

  function fillSelects() {
    const regionsByGeo = {};
    catalog.regions.forEach((r) => (regionsByGeo[r.geo] = regionsByGeo[r.geo] || []).push(r));
    $("#region").innerHTML = Object.entries(regionsByGeo).map(([g, rs]) =>
      `<optgroup label="${esc(g)}">${rs.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}</optgroup>`).join("");
    $("#skill").innerHTML = opt(catalog.skills);
    $("#orchestration").innerHTML = opt(catalog.orchestration);
    $("#bq_model").innerHTML = opt(catalog.bq_models);
    const cats = {
      rdbms: "Relational databases", rdbms_gcp: "Relational databases", rdbms_nocdc: "Relational databases",
      dwh: "Warehouses & big data", hadoop: "Warehouses & big data", sap: "Enterprise applications", mainframe: "Enterprise applications",
      nosql: "NoSQL", nosql_gcp: "NoSQL", files_onprem: "Files & object storage", object_aws: "Files & object storage",
      object_azure: "Files & object storage", object_gcp: "Files & object storage", kafka: "Streaming & events",
      stream_aws: "Streaming & events", stream_azure: "Streaming & events", events: "Streaming & events", logs: "Streaming & events",
      saas_google: "SaaS & APIs", saas_salesforce: "SaaS & APIs", saas_other: "SaaS & APIs", api: "SaaS & APIs", unstructured: "Unstructured",
    };
    const groups = {};
    catalog.source_types.forEach((s) => (groups[cats[s.category] || "Other"] = groups[cats[s.category] || "Other"] || []).push(s));
    $("#f_type").innerHTML = Object.entries(groups).map(([g, ss]) =>
      `<optgroup label="${esc(g)}">${ss.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</optgroup>`).join("");
    $("#f_data_type").innerHTML = opt(catalog.data_types);
    $("#f_location").innerHTML = opt(catalog.locations);
    $("#f_frequency").innerHTML = opt(catalog.frequencies);
    $("#f_transform").innerHTML = opt(catalog.transforms);
    const lay = $(".layer");
    $("[data-group=bi] [data-k=tool]", lay).innerHTML = opt(catalog.bi_options);
    $("[data-group=gemini_enterprise] [data-k=edition]", lay).innerHTML = opt(catalog.gemini_enterprise_editions);
    $("[data-group=agents] [data-k=model]", lay).innerHTML = opt(catalog.gemini_models);
    $("[data-group=gpu] [data-k=gpu]", lay).innerHTML = opt(catalog.gpu_types);
    const fx = ["USD", "SAR", "AED", "EUR", "GBP", "INR"];
    $("#currency").innerHTML = fx.map((c) => `<option>${c}</option>`).join("");
  }

  // ------------------------------------------------------------------ persistence
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ scenario, currency })); } catch (_) { /* storage unavailable */ }
  }
  let restored = false;
  function restore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        scenario = withDefaults(d.scenario || {});
        currency = d.currency || "USD";
        restored = true;
      }
    } catch (_) { /* ignore */ }
  }

  function syncForm() {
    $("#customer").value = scenario.customer || "";
    $("#region").value = scenario.region;
    $("#currency").value = currency;
    ["skill", "orchestration", "bq_model", "environment"].forEach((k) => ($("#" + k).value = scenario[k]));
    ["bq_slots", "annual_growth_pct", "contingency_pct"].forEach((k) => ($("#" + k).value = scenario[k] ?? ""));
    $("#analytics_tib_month").value = scenario.analytics_tib_month ?? "";
    $("#slotsField").hidden = scenario.bq_model === "ondemand";
    syncLayer();
  }

  function syncLayer() {
    $$(".layer fieldset").forEach((fs) => {
      const g = scenario.platform[fs.dataset.group];
      $$("[data-k]", fs).forEach((el) => {
        const v = g[el.dataset.k];
        if (el.type === "checkbox") el.checked = !!v; else el.value = v ?? "";
      });
      fs.classList.toggle("off", !g.enabled);
      $$("[data-show]", fs).forEach((el) => (el.hidden = g.tool !== el.dataset.show));
    });
  }

  // ------------------------------------------------------------------ events
  function bindEvents() {
    $("#customer").addEventListener("input", (e) => { scenario.customer = e.target.value; save(); renderSummary(); });
    $("#region").addEventListener("change", (e) => { scenario.region = e.target.value; changed(); });
    $("#currency").addEventListener("change", (e) => { currency = e.target.value; save(); renderCost(); renderSummary(); });
    ["skill", "orchestration", "bq_model", "environment"].forEach((k) =>
      $("#" + k).addEventListener("change", (e) => { scenario[k] = e.target.value; $("#slotsField").hidden = scenario.bq_model === "ondemand"; changed(); }));
    ["bq_slots", "annual_growth_pct", "contingency_pct", "analytics_tib_month"].forEach((k) =>
      $("#" + k).addEventListener("input", (e) => {
        const v = e.target.value === "" ? null : Number(e.target.value);
        scenario[k] = k === "analytics_tib_month" ? v : (v ?? 0);
        changed();
      }));

    $(".layer").addEventListener("change", onLayer);
    $(".layer").addEventListener("input", (e) => { if (e.target.type === "number") onLayer(e); });

    $$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
    $("#addSourceBtn").addEventListener("click", () => openDialog(null));
    $("#sourceList").addEventListener("click", (e) => {
      const li = e.target.closest("[data-id]");
      if (li) openDialog(li.dataset.id);
    });
    $("#diagram").addEventListener("click", (e) => {
      const n = e.target.closest("[data-src]");
      if (n) openDialog(n.dataset.src);
    });

    $("#f_cancel").addEventListener("click", () => $("#sourceDialog").close());
    $("#f_delete").addEventListener("click", () => {
      scenario.sources = scenario.sources.filter((s) => s.id !== editingId);
      $("#sourceDialog").close();
      toast("Source removed");
      changed();
    });
    $("#sourceForm").addEventListener("submit", (e) => { e.preventDefault(); saveSource(); });
    $("#f_type").addEventListener("change", applyTypeDefaults);
    ["f_frequency", "f_location", "f_transform", "f_type"].forEach((id) => $("#" + id).addEventListener("change", updateHint));

    menu("#samplesBtn", "#samplesMenu");
    menu("#exportBtn", "#exportMenu");
    $("#exportMenu").addEventListener("click", (e) => {
      const b = e.target.closest("[data-export]");
      if (!b) return;
      $("#exportMenu").hidden = true;
      doExport(b.dataset.export);
    });
    $("#importFile").addEventListener("change", importScenario);
  }

  function onLayer(e) {
    const el = e.target.closest("[data-k]");
    const fs = e.target.closest("fieldset");
    if (!el || !fs) return;
    const g = scenario.platform[fs.dataset.group];
    if (el.type === "checkbox") g[el.dataset.k] = el.checked;
    else if (el.type === "number") g[el.dataset.k] = el.value === "" ? 0 : Number(el.value);
    else g[el.dataset.k] = el.value;
    fs.classList.toggle("off", !g.enabled);
    $$("[data-show]", fs).forEach((x) => (x.hidden = g.tool !== x.dataset.show));
    changed();
  }

  function menu(btnSel, popSel) {
    const btn = $(btnSel), pop = $(popSel);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = pop.hidden;
      $$(".menu-pop").forEach((p) => (p.hidden = true));
      pop.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", (e) => { if (!pop.contains(e.target)) { pop.hidden = true; btn.setAttribute("aria-expanded", "false"); } });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") pop.hidden = true; });
  }

  function showTab(id) {
    $(".layer").addEventListener("change", onLayer);
    $(".layer").addEventListener("input", (e) => { if (e.target.type === "number") onLayer(e); });

    $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === id)));
    $$(".tabpanel").forEach((p) => (p.hidden = p.id !== "tab-" + id));
  }

  function changed() {
    save();
    renderSources();
    scheduleEstimate(250);
  }

  function scheduleEstimate(delay) {
    clearTimeout(estimateTimer);
    estimateTimer = setTimeout(runEstimate, delay);
  }

  async function runEstimate() {
    const my = ++seq;
    try {
      const payload = { ...scenario, analytics_tib_month: scenario.analytics_tib_month || null };
      const r = await api.estimate(payload);
      if (my !== seq) return;
      result = r;
      renderAll();
    } catch (e) {
      toast(`Estimate failed: ${e.message}`, 6000);
    }
  }

  // ------------------------------------------------------------------ source dialog
  const TYPE_DEFAULTS = {
    rdbms: { data_type: "structured", frequency: "near_realtime", location: "on_prem" },
    rdbms_gcp: { data_type: "structured", frequency: "near_realtime", location: "gcp" },
    rdbms_nocdc: { data_type: "structured", frequency: "daily", location: "on_prem" },
    dwh: { data_type: "structured", frequency: "daily", location: "on_prem" },
    hadoop: { data_type: "semi_structured", frequency: "daily", location: "on_prem" },
    sap: { data_type: "structured", frequency: "near_realtime", location: "on_prem" },
    mainframe: { data_type: "structured", frequency: "daily", location: "on_prem" },
    nosql: { data_type: "semi_structured", frequency: "near_realtime", location: "on_prem" },
    nosql_gcp: { data_type: "semi_structured", frequency: "near_realtime", location: "gcp" },
    files_onprem: { data_type: "semi_structured", frequency: "daily", location: "on_prem" },
    object_aws: { data_type: "semi_structured", frequency: "daily", location: "aws" },
    object_azure: { data_type: "semi_structured", frequency: "daily", location: "azure" },
    object_gcp: { data_type: "semi_structured", frequency: "daily", location: "gcp" },
    kafka: { data_type: "events", frequency: "realtime", location: "on_prem" },
    stream_aws: { data_type: "events", frequency: "realtime", location: "aws" },
    stream_azure: { data_type: "events", frequency: "realtime", location: "azure" },
    events: { data_type: "events", frequency: "realtime", location: "on_prem" },
    logs: { data_type: "semi_structured", frequency: "realtime", location: "gcp" },
    saas_google: { data_type: "structured", frequency: "daily", location: "saas" },
    saas_salesforce: { data_type: "structured", frequency: "daily", location: "saas" },
    saas_other: { data_type: "structured", frequency: "daily", location: "saas" },
    api: { data_type: "semi_structured", frequency: "hourly", location: "saas" },
    unstructured: { data_type: "unstructured", frequency: "daily", location: "on_prem" },
  };

  function applyTypeDefaults() {
    if (editingId) return updateHint();
    const t = catalog.source_types.find((s) => s.id === $("#f_type").value);
    const d = TYPE_DEFAULTS[t?.category] || {};
    Object.entries(d).forEach(([k, v]) => ($("#f_" + k).value = v));
    updateHint();
  }

  function updateHint() {
    const freq = $("#f_frequency").value, type = $("#f_type").value;
    const t = catalog.source_types.find((s) => s.id === type);
    let h = "";
    if (t?.cdc && STREAMING.has(freq)) h = "Log-based CDC will be recommended - confirm the DBA can enable it on the source.";
    else if (freq === "one_time") h = "Only the initial load is costed; ongoing ingestion is excluded.";
    else if (STREAMING.has(freq)) h = "Streaming pipelines run 24x7 and are costed as always-on.";
    else h = "Scheduled batch: cost scales with runs per month and volume per run.";
    $("#f_hint").textContent = h;
  }

  function openDialog(id) {
    editingId = id;
    const s = id ? scenario.sources.find((x) => x.id === id) : null;
    $("#dlgTitle").textContent = s ? "Edit source system" : "Add source system";
    $("#f_save").textContent = s ? "Save changes" : "Add source";
    $("#f_delete").hidden = !s;
    if (s) {
      ["type", "name", "data_type", "location", "frequency", "transform", "initial_volume_gb", "daily_change_gb", "notes"]
        .forEach((k) => ($("#f_" + k).value = s[k] ?? ""));
    } else {
      $("#f_type").value = "oracle"; $("#f_name").value = ""; $("#f_notes").value = "";
      $("#f_transform").value = "none"; $("#f_initial_volume_gb").value = 500; $("#f_daily_change_gb").value = 5;
      applyTypeDefaults();
    }
    updateHint();
    $("#sourceDialog").showModal();
    $("#f_type").focus();
  }

  function saveSource() {
    const v = (k) => $("#f_" + k).value;
    const typeName = catalog.source_types.find((s) => s.id === v("type"))?.name || v("type");
    const src = {
      id: editingId || "s" + Date.now().toString(36),
      name: v("name").trim() || typeName,
      type: v("type"), data_type: v("data_type"), location: v("location"),
      frequency: v("frequency"), transform: v("transform"),
      initial_volume_gb: Math.max(0, Number(v("initial_volume_gb")) || 0),
      daily_change_gb: Math.max(0, Number(v("daily_change_gb")) || 0),
      notes: v("notes"),
    };
    if (editingId) scenario.sources = scenario.sources.map((s) => (s.id === editingId ? src : s));
    else scenario.sources.push(src);
    $("#sourceDialog").close();
    toast(editingId ? "Source updated" : "Source added");
    changed();
  }

  // ------------------------------------------------------------------ samples / import
  async function loadSamples() {
    try {
      const samples = await api.samples();
      $("#samplesMenu").innerHTML = samples.map((s, i) =>
        `<button role="menuitem" data-i="${i}">${esc(s.title.replace(/^Sample - /, ""))}<small>${s.scenario.sources.length} sources, ${esc(s.scenario.region)}</small></button>`).join("");
      $("#samplesMenu").addEventListener("click", (e) => {
        const b = e.target.closest("[data-i]");
        if (!b) return;
        scenario = withDefaults(structuredClone(samples[+b.dataset.i].scenario));
        $("#samplesMenu").hidden = true;
        syncForm();
        changed();
        toast("Sample scenario loaded");
      });
      if (!restored && !scenario.sources.length && samples.length) {
        // First visit: open on a realistic example instead of an empty canvas.
        const first = samples.find((s) => s.file === "retail-bank-ksa.json") || samples[0];
        scenario = withDefaults(structuredClone(first.scenario));
        syncForm();
        changed();
      }
    } catch (_) {
      $("#samplesBtn").hidden = true;
    }
  }

  function importScenario(e) {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => {
      const d = JSON.parse(t);
      const sc = d.scenario || d;
      if (!Array.isArray(sc.sources)) throw new Error("File has no sources list");
      scenario = withDefaults(sc);
      syncForm();
      changed();
      toast("Scenario opened");
    }).catch((err) => toast(`Could not open file: ${err.message}`, 6000));
    e.target.value = "";
    $("#exportMenu").hidden = true;
  }

  // ------------------------------------------------------------------ rendering
  function renderAll() {
    renderSources();
    renderSummary();
    renderDiagram();
    renderRecs();
    renderPlatform();
    renderCost();
    renderAssumptions();
  }

  function flowClass(freq) { return freq === "one_time" ? "once" : STREAMING.has(freq) ? "stream" : "batch"; }
  function recFor(id) { return result?.recommendations.find((r) => r.source_id === id); }
  function tool(id) { return catalog.tools[id] || { name: id, doc: "#" }; }
  function freqName(id) { return catalog.frequencies.find((f) => f.id === id)?.name || id; }

  function renderSources() {
    const list = $("#sourceList");
    $("#sourceEmpty").hidden = scenario.sources.length > 0;
    list.innerHTML = scenario.sources.map((s) => {
      const r = recFor(s.id);
      return `<li><button class="source-item" data-id="${esc(s.id)}" type="button">
        <i class="bar ${flowClass(s.frequency)}"></i>
        <div><b>${esc(s.name)}</b><span>${esc(freqName(s.frequency))} · ${fmtGB(s.daily_change_gb)}/day</span></div>
        <div class="tool">${r ? esc(tool(r.primary).name) : ""}</div>
      </button></li>`;
    }).join("");
  }

  function renderSummary() {
    const el = $("#summaryStrip");
    if (!result || !scenario.sources.length) { el.innerHTML = ""; return; }
    const t = result.totals;
    el.innerHTML = `
      <div class="fig"><b>${money(t.avg_monthly_year1)}</b><span>Average per month, year 1</span></div>
      <div class="fig"><b>${money(t.year1_payg)}</b><span>1-year, pay-as-you-go</span></div>
      <div class="fig"><b>${money(t.three_year_payg)}</b><span>3-year, pay-as-you-go</span></div>
      <div class="note">${esc(result.region.name)} · ${scenario.sources.length} source${scenario.sources.length > 1 ? "s" : ""}</div>`;
  }

  // ---------------- architecture diagram
  function renderDiagram() {
    const host = $("#diagram");
    const srcs = scenario.sources;
    const W = 1440;
    if (!srcs.length || !result) {
      host.innerHTML = `<svg viewBox="0 0 ${W} 220" role="img" aria-label="Empty architecture"><text class="dg-empty" x="${W / 2}" y="110" text-anchor="middle">Add a source system to start drawing the target architecture.</text></svg>`;
      return;
    }
    const plat = result.platform;
    const L = scenario.platform;
    const rowH = 66, top = 46, nodeH = 48;
    const col = { src: 16, conn: 252, ing: 392, proc: 608, bq: 826, out: 1012, ai: 1236 };
    const cw = { src: 212, conn: 118, ing: 192, proc: 192, bq: 156, out: 196, ai: 188 };

    // consume / AI column content
    const orch = plat.orchestration.tool;
    const outs = [["dataform", "Dataform", "SQL ELT, tests, schedules"]];
    if (orch !== "none") outs.push(["orch", orch === "composer" ? "Cloud Composer" : "Workflows", "Orchestration"]);
    if (L.bi.enabled) outs.push(["bi", L.bi.tool === "looker" ? "Looker" : "Looker Studio", L.bi.tool === "looker" ? "Semantic layer & BI" : "Dashboards"]);
    outs.push(["bqml", "BigQuery ML & AI", "Gemini, embeddings, vector"]);
    if (L.agents.enabled) outs.push(["mcp", "BigQuery data agents", "MCP tools, Conversational Analytics"]);
    outs.push(["retl", "Reverse ETL", "AlloyDB / Spanner"]);
    const ais = [];
    if (L.agents.enabled) ais.push(["agents", "Agent Platform", "ADK + Agent Engine + Gemini"]);
    if (L.gemini_enterprise.enabled) ais.push(["ge", "Gemini Enterprise", `${L.gemini_enterprise.users} users, ${L.gemini_enterprise.edition}`]);
    if (L.gpu.enabled) ais.push(["gpu", "Vertex AI GPU endpoint", `${L.gpu.replicas} x ${L.gpu.gpu.toUpperCase()}`]);

    const flowH = Math.max(380, top + srcs.length * rowH + 30, top + outs.length * 60 + 30);
    const showBand = L.governance.enabled || L.security.enabled;
    const H = flowH + (showBand ? 96 : 0);

    const srcNodes = srcs.map((s, i) => ({ s, x: col.src, y: top + i * rowH, r: recFor(s.id) }));
    const ingKeys = [], procKeys = [];
    srcNodes.forEach((n) => {
      if (!n.r) return;
      n.ing = n.r.chain[0];
      n.proc = n.r.chain.length > 1 ? n.r.chain.slice(1).join(">") : null;
      if (!ingKeys.includes(n.ing)) ingKeys.push(n.ing);
      if (n.proc && !procKeys.includes(n.proc)) procKeys.push(n.proc);
    });
    const spread = (keys, x, w) => {
      const span = flowH - top - 20;
      const gap = span / Math.max(keys.length, 1);
      return Object.fromEntries(keys.map((k, i) => [k, { x, w, y: top + gap * i + (gap - nodeH) / 2 }]));
    };
    const ingPos = spread(ingKeys, col.ing, cw.ing);
    const procPos = spread(procKeys, col.proc, cw.proc);
    const outPos = spread(outs.map((o) => o[0]), col.out, cw.out);
    const aiPos = spread(ais.map((o) => o[0]), col.ai, cw.ai);
    const bqY = top, bqH = flowH - top - 20;
    const needConn = srcNodes.some((n) => n.r?.needs_connectivity);
    const connSrc = srcNodes.filter((n) => n.r?.needs_connectivity);
    const connPos = { x: col.conn, y: connSrc.length ? connSrc.reduce((a, n) => a + n.y, 0) / connSrc.length : top };

    const midY = (p) => p.y + nodeH / 2;
    const curve = (x1, y1, x2, y2) => { const dx = (x2 - x1) / 2; return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`; };

    let edges = "", nodes = "";
    const node = (x, y, w, title, sub, cls = "", attrs = "") =>
      `<g class="dg-node ${cls}" ${attrs}><rect x="${x}" y="${y}" width="${w}" height="${nodeH}" rx="8"/>
        <text x="${x + 12}" y="${y + (sub ? 20 : 29)}">${esc(clip(title, w / 7.2))}</text>
        ${sub ? `<text class="sub" x="${x + 12}" y="${y + 37}">${esc(clip(sub, w / 6.2))}</text>` : ""}</g>`;

    srcNodes.forEach((n) => {
      const fc = flowClass(n.s.frequency);
      nodes += node(n.x, n.y, cw.src, n.s.name, `${freqName(n.s.frequency)} · ${fmtGB(n.s.daily_change_gb)}/day`, "src clickable", `data-src="${esc(n.s.id)}" tabindex="0" role="button" aria-label="Edit ${esc(n.s.name)}"`);
      if (!n.r) return;
      const ip = ingPos[n.ing];
      const sy = n.y + nodeH / 2;
      if (n.r.needs_connectivity) {
        edges += `<path class="dg-edge ${fc}" d="${curve(n.x + cw.src, sy, connPos.x, midY(connPos))}"/>`;
        edges += `<path class="dg-edge ${fc}" d="${curve(connPos.x + cw.conn, midY(connPos), ip.x, midY(ip))}"/>`;
      } else {
        edges += `<path class="dg-edge ${fc}" d="${curve(n.x + cw.src, sy, ip.x, midY(ip))}"/>`;
      }
      if (n.proc) {
        const pp = procPos[n.proc];
        edges += `<path class="dg-edge ${fc}" d="${curve(ip.x + ip.w, midY(ip), pp.x, midY(pp))}"/>`;
        edges += `<path class="dg-edge ${fc}" d="${curve(pp.x + pp.w, midY(pp), col.bq, midY(pp))}"/>`;
      } else {
        edges += `<path class="dg-edge ${fc}" d="${curve(ip.x + ip.w, midY(ip), col.bq, midY(ip))}"/>`;
      }
    });

    if (needConn) {
      const c = tool(plat.connectivity);
      nodes += node(connPos.x, connPos.y, cw.conn, c.name.replace("Cloud ", ""), "Private link", "");
    }
    ingKeys.forEach((k) => { const p = ingPos[k]; nodes += node(p.x, p.y, p.w, tool(k).name, k === "datastream" ? "Change data capture" : "Ingest", ""); });
    procKeys.forEach((k) => {
      const p = procPos[k];
      const names = k.split(">").map((t) => tool(t).name);
      nodes += node(p.x, p.y, p.w, names[names.length - 1], names.length > 1 ? "via " + names.slice(0, -1).join(", ") : "Process / land", "");
    });

    nodes += `<g class="dg-node bq"><rect x="${col.bq}" y="${bqY}" width="${cw.bq}" height="${bqH}" rx="10"/>
      <text x="${col.bq + 14}" y="${bqY + 26}" style="font-weight:700">BigQuery</text>
      <text class="sub" x="${col.bq + 14}" y="${bqY + 44}">${esc(result.region.id)}</text>
      <text class="sub" x="${col.bq + 14}" y="${bqY + 62}">Iceberg lakehouse</text>
      <text class="sub" x="${col.bq + 14}" y="${bqY + bqH - 46}">Raw → curated → marts</text>
      <text class="sub" x="${col.bq + 14}" y="${bqY + bqH - 28}">${esc(clip(bqModelName(), 24))}</text></g>`;

    outs.forEach(([k, t, s]) => {
      const p = outPos[k];
      edges += `<path class="dg-edge plain" d="${curve(col.bq + cw.bq, midY(p), p.x, midY(p))}"/>`;
      nodes += node(p.x, p.y, p.w, t, s, k === "mcp" || k === "bqml" ? "ai" : "platform");
    });
    ais.forEach(([k, t, s]) => {
      const p = aiPos[k];
      const from = k === "gpu" ? outPos.bqml : (outPos.mcp || outPos.bi || outPos.bqml);
      if (k !== "ge" || !aiPos.agents) edges += `<path class="dg-edge ai" d="${curve(from.x + from.w, midY(from), p.x, midY(p))}"/>`;
      nodes += node(p.x, p.y, p.w, t, s, "ai");
    });
    if (aiPos.ge && aiPos.agents) {
      const a = aiPos.agents, g = aiPos.ge;
      const x = a.x + a.w / 2;
      edges += `<path class="dg-edge ai" d="M${x},${a.y + (g.y > a.y ? nodeH : 0)} L${x},${g.y + (g.y > a.y ? 0 : nodeH)}"/>`;
    }
    if (L.bi.enabled && L.gemini_enterprise.enabled && aiPos.ge && !L.agents.enabled) {
      const b = outPos.bi; edges += `<path class="dg-edge ai" d="${curve(b.x + b.w, midY(b), aiPos.ge.x, midY(aiPos.ge))}"/>`;
    }

    // governance & security band
    let band = "";
    if (showBand) {
      const by = flowH + 6, bh = 80;
      const chips = [];
      if (L.governance.enabled) chips.push(["Knowledge Catalog (Dataplex)", "Lineage, quality, glossary"]);
      if (L.security.enabled) {
        if (L.security.sdp_discovery) chips.push(["Sensitive Data Protection", "PII discovery"]);
        chips.push(["Policy tags & masking", "Column / row security"]);
        if (L.security.cmek) chips.push(["Cloud KMS (CMEK)", "Customer-managed keys"]);
        if (L.security.vpc_sc) chips.push(["VPC Service Controls", "Exfiltration perimeter"]);
        chips.push(["IAM & Security Command Center", "Access, posture, threats"]);
      }
      const cw2 = Math.min(210, (W - 48 - (chips.length - 1) * 12) / chips.length);
      band = `<g class="dg-band"><rect x="16" y="${by}" width="${W - 32}" height="${bh}" rx="12"/>
        <text class="band-title" x="30" y="${by + 20}">Governance & security across every layer</text></g>`;
      chips.forEach(([t, s2], i) => { band += node(30 + i * (cw2 + 12), by + 26, cw2, t, s2, "gov"); });
      edges += `<path class="dg-edge plain" stroke-dasharray="3 4" d="M${col.bq + cw.bq / 2},${bqY + bqH} L${col.bq + cw.bq / 2},${by}"/>`;
    }

    const heads = [["Source systems", col.src], needConn ? ["Connectivity", col.conn] : null, ["Ingestion & CDC", col.ing], ["Processing / landing", col.proc], ["Analytics store", col.bq], ["Transform, BI & data AI", col.out], ais.length ? ["Agents & AI", col.ai] : null].filter(Boolean);
    const headSvg = heads.map(([t, x]) => `<text class="dg-col-title" x="${x}" y="22">${esc(t)}</text>`).join("");

    host.innerHTML = `<svg id="archSvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Target ingestion and agentic data architecture on BigQuery" xmlns="http://www.w3.org/2000/svg">${headSvg}${edges}${band}${nodes}</svg>`;
    $$("#archSvg [data-src]").forEach((g) => g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(g.dataset.src); } }));
  }

  function bqModelName() { return catalog.bq_models.find((m) => m.id === scenario.bq_model)?.name || ""; }
  function clip(s, n) { s = String(s); n = Math.floor(n); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  // ---------------- recommendations
  function renderRecs() {
    const host = $("#recsBody");
    if (!result || !scenario.sources.length) { host.innerHTML = `<p class="empty-note">Add source systems to see recommended GCP-native ingestion patterns.</p>`; return; }
    const p = result.platform;
    const orchTool = p.orchestration.tool === "none" ? "None required" : tool(p.orchestration.tool).name;
    let html = `<div class="platform-block"><h3>Platform blueprint</h3><dl>
      <dt>Transformation</dt><dd><a href="${tool("dataform").doc}" target="_blank" rel="noopener">Dataform</a>: ${esc(p.transformation.why)}</dd>
      <dt>Orchestration</dt><dd>${esc(orchTool)}: ${esc(p.orchestration.why)}</dd>
      <dt>Connectivity</dt><dd>${p.connectivity ? `${esc(tool(p.connectivity).name)} for ~${fmtGB(p.connectivity_gb_day)}/day from private networks.` : "Public / Google-managed endpoints only."}</dd>
      ${p.datafusion_edition ? `<dt>Data Fusion</dt><dd>One shared ${esc(p.datafusion_edition)} edition instance for all low-code pipelines.</dd>` : ""}
      <dt>Governance</dt><dd>${p.governance.map(esc).join("; ")}.</dd>
    </dl></div>`;
    html += scenario.sources.map((s) => {
      const r = recFor(s.id);
      if (!r) return "";
      const fc = flowClass(s.frequency);
      const chain = r.chain.map((t) => `<a href="${esc(tool(t).doc)}" target="_blank" rel="noopener" title="${esc(tool(t).summary)}">${esc(tool(t).name)}</a>`).join(`<span class="arrow">→</span>`)
        + `<span class="arrow">→</span><a href="https://cloud.google.com/bigquery/docs/introduction" target="_blank" rel="noopener">BigQuery</a>`;
      return `<article class="rec">
        <div class="rec-src"><b>${esc(s.name)}</b><span>${esc(catalog.source_types.find((t) => t.id === s.type)?.name || s.type)}</span>
          <span>${fmtGB(s.initial_volume_gb)} initial, ${fmtGB(s.daily_change_gb)}/day</span>
          <span class="chip ${fc}">${esc(freqName(s.frequency))}</span></div>
        <div class="rec-main">
          <h3>${esc(r.pattern)}</h3>
          <div class="chain">${chain}</div>
          <ul>${r.rationale.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          ${r.alternatives.length ? `<p class="sub">Alternatives</p><ul class="alt">${r.alternatives.map((a) => `<li><b>${esc(tool(a.tool).name)}</b>: ${esc(a.why)}</li>`).join("")}</ul>` : ""}
          ${r.caveats.length ? `<p class="sub">Check during discovery</p><ul class="caveat">${r.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
          ${s.notes ? `<p class="sub">Notes</p><p>${esc(s.notes)}</p>` : ""}
        </div></article>`;
    }).join("");
    host.innerHTML = html;
  }

  // ---------------- agentic data cloud layer
  const STORY_COST = {
    lakehouse: (svc) => svc.startsWith("BigQuery") && !svc.includes("agents"),
    bi: (svc) => svc.includes("Looker"),
    ai: (svc) => /Gemini|Agent|Vertex AI|BigQuery queries from agents/.test(svc),
    governance: (svc) => svc.includes("Knowledge Catalog"),
    security: (svc) => /Sensitive Data|KMS/.test(svc),
  };

  function storyCost(key) {
    const f = STORY_COST[key];
    if (!f || !result) return null;
    const rows = result.by_service.filter((r) => f(r.service));
    return { y1: rows.reduce((a, r) => a + r.year1, 0), y3: rows.reduce((a, r) => a + r.three_year, 0) };
  }

  function renderPlatform() {
    const host = $("#platformBody");
    if (!result) { host.innerHTML = ""; return; }
    const story = result.platform.layer.story;
    const chips = (ids) => ids.map((t) => `<a href="${esc(tool(t).doc)}" target="_blank" rel="noopener" title="${esc(tool(t).summary)}">${esc(tool(t).name)}</a>`).join("");
    let html = `<p class="lede">How the ingested data becomes an agentic data cloud: BigQuery as the governed foundation, Looker as the semantic layer, agents and Gemini Enterprise on top, and Knowledge Catalog plus security controls across every layer. Toggle components in <b>Analytics, AI &amp; governance</b>.</p><div class="story">`;
    html += story.map((b) => {
      const c = storyCost(b.key);
      const note = b.key === "bi" && scenario.platform.bi.tool === "looker" && !scenario.platform.bi.looker_annual_usd
        ? "Looker licence not included - add the customer's quote to price it."
        : c && c.y3 > 0 ? `Estimated ${money(c.y1)} in year 1, ${money(c.y3)} over 3 years.` : "";
      return `<section class="story-block ${esc(b.key)}"><h3>${esc(b.title)}</h3><div class="tool-chips">${chips(b.tools)}</div>
        <ul>${b.points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>${note ? `<p class="story-cost">${esc(note)}</p>` : ""}</section>`;
    }).join("");
    html += `</div>`;
    const demo = [
      "Load a sample customer and walk the architecture from source systems to BigQuery, pointing out CDC (dashed) versus batch flows.",
      "Open a source and change freshness or volume; the pattern, diagram and estimate update live.",
      "Switch the region (for example to Dammam me-central2) to discuss data residency and the regional price uplift.",
    ];
    if (scenario.platform.bi.enabled) demo.push("Show how Looker's semantic layer gives one set of governed metrics to dashboards, Sheets and Conversational Analytics.");
    if (scenario.platform.agents.enabled) demo.push("Explain how agents on Agent Platform query BigQuery through MCP tools under the user's own permissions, policy tags and masking.");
    if (scenario.platform.gemini_enterprise.enabled) demo.push("Close with Gemini Enterprise: employees ask business questions and run Deep Research grounded in BigQuery data.");
    if (scenario.platform.governance.enabled) demo.push("Show lineage and quality scores in Knowledge Catalog as the trust layer that makes agent answers auditable.");
    demo.push("Finish on the consumption tab: 1-year and 3-year ballpark with and without commitments, then export the proposal.");
    html += `<h3 style="margin:22px 0 8px">Suggested demo storyline</h3><ol class="demo-steps">${demo.map((d) => `<li>${esc(d)}</li>`).join("")}</ol>`;
    host.innerHTML = html;
  }

  // ---------------- cost
  function fx() { return result?.fx?.[currency] || 1; }
  function money(usd, digits) {
    const v = usd * fx();
    const d = digits ?? (Math.abs(v) >= 1000 ? 0 : 2);
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: d, minimumFractionDigits: d }).format(v); }
    catch (_) { return `${currency} ${v.toFixed(d)}`; }
  }
  function moneyShort(usd) {
    const v = usd * fx();
    const a = Math.abs(v);
    const s = a >= 1e6 ? (v / 1e6).toFixed(1) + "M" : a >= 1e3 ? (v / 1e3).toFixed(0) + "k" : v.toFixed(0);
    return `${currency === "USD" ? "$" : currency + " "}${s}`;
  }
  function fmtGB(gb) {
    gb = Number(gb) || 0;
    if (gb >= 1024 * 1024) return (gb / 1024 / 1024).toFixed(1) + " PB";
    if (gb >= 1024) return (gb / 1024).toFixed(gb >= 10240 ? 0 : 1) + " TB";
    return (gb >= 10 ? gb.toFixed(0) : +gb.toFixed(2)) + " GB";
  }

  function renderCost() {
    const host = $("#costBody");
    if (!result || !scenario.sources.length) { host.innerHTML = `<p class="empty-note">The estimate appears once at least one source system is added.</p>`; return; }
    const t = result.totals;
    const cudSave1 = t.year1_payg - t.year1_cud1, cudSave3 = t.three_year_payg - t.three_year_cud3;
    let html = `<div class="horizon">
      <div class="card"><h3>1-year consumption</h3><div class="big">${money(t.year1_payg)}</div>
        <div class="row"><span>With 1-year commitments</span><span>${money(t.year1_cud1)}</span></div>
        <div class="row"><span>Commitment saving</span><span>${money(cudSave1)}</span></div>
        <div class="range">Discussion range ${money(t.range_low_1y)} to ${money(t.range_high_1y)}</div></div>
      <div class="card"><h3>3-year consumption</h3><div class="big">${money(t.three_year_payg)}</div>
        <div class="row"><span>With 3-year commitments</span><span>${money(t.three_year_cud3)}</span></div>
        <div class="row"><span>Year 1 / 2 / 3</span><span>${moneyShort(t.year1_payg)} / ${moneyShort(t.year2_payg)} / ${moneyShort(t.year3_payg)}</span></div>
        <div class="range">Discussion range ${money(t.range_low_3y)} to ${money(t.range_high_3y)}</div></div>
    </div>`;
    html += `<h3>By capability</h3><div class="groups">${result.by_group.filter((g) => g.three_year > 0).map((g) =>
      `<div><span>${esc(g.group)}</span><b>${money(g.year1)}</b><span>year 1 · ${money(g.three_year)} over 3 years</span></div>`).join("")}</div>`;
    html += `<h3>Monthly run-rate over 36 months</h3><div class="chart-key"><span><i></i>Pay-as-you-go</span><span><i class="cud"></i>With 3-year commitments</span></div>
      <div class="chart-wrap">${chartSvg(result.monthly)}</div>`;

    const maxSvc = Math.max(...result.by_service.map((s) => s.three_year), 1);
    html += `<h3>By service</h3><div style="overflow-x:auto"><table><thead><tr><th>Service</th><th>Year 1</th><th>Year 1 (1-yr CUD)</th><th>3 years</th><th>3 years (3-yr CUD)</th></tr></thead><tbody>`
      + result.by_service.map((s) => `<tr><td>${esc(s.service)}<span class="share" style="width:${Math.max(2, 60 * s.three_year / maxSvc)}px"></span></td><td>${money(s.year1)}</td><td>${money(s.year1_cud)}</td><td>${money(s.three_year)}</td><td>${money(s.three_year_cud)}</td></tr>`).join("")
      + `</tbody><tfoot><tr><td>Total</td><td>${money(t.year1_payg)}</td><td>${money(t.year1_cud1)}</td><td>${money(t.three_year_payg)}</td><td>${money(t.three_year_cud3)}</td></tr></tfoot></table></div>`;

    html += `<h3>By source system</h3><div style="overflow-x:auto"><table><thead><tr><th>Source</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
      + result.by_source.map((s) => `<tr><td>${esc(s.name)}</td><td>${money(s.year1)}</td><td>${money(s.three_year)}</td></tr>`).join("")
      + `</tbody></table></div>`;
    html += `<p class="disclaimer">${esc(result.disclaimer)}${currency !== "USD" ? ` Converted from USD at ${fx()} ${currency}/USD.` : ""}</p>`;
    host.innerHTML = html;
  }

  function chartSvg(monthly) {
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
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly cost over 36 months">${grid}<path class="chart-line cud" d="${path("cud3")}"/><path class="chart-line payg" d="${path("payg")}"/></svg>`;
  }

  function renderAssumptions() {
    const host = $("#assumeBody");
    if (!result) { host.innerHTML = ""; return; }
    const a = result.assumptions;
    const pct = (v) => Math.round(v * 100) + "%";
    const rows = [
      ["Region price uplift vs us-central1", `x${result.region.uplift.toFixed(2)} (${esc(result.region.name)})`],
      ["Batch throughput per vCPU-hour", `${a.batch_gb_per_vcpu_hr.none} GB (no transform), ${a.batch_gb_per_vcpu_hr.light} GB (light), ${a.batch_gb_per_vcpu_hr.heavy} GB (heavy)`],
      ["Minimum per batch run", `${a.batch_min_vcpu_hr_per_run} vCPU-hour (Dataflow), ${a.datafusion_min_vcpu_hr_per_run} vCPU-hours (Data Fusion cluster), ${a.spark_min_dcu_hr_per_run} DCU-hours (Spark)`],
      ["Streaming capacity per vCPU", `${a.stream_gb_per_vcpu_day.none} / ${a.stream_gb_per_vcpu_day.light} / ${a.stream_gb_per_vcpu_day.heavy} GB per day (none / light / heavy); minimum ${a.stream_min_vcpu} vCPUs per job, always on`],
      ["Storage growth from change data", `${pct(a.net_new_ratio.cdc)} of CDC volume is net-new rows; ${pct(a.net_new_ratio.append)} for append-only sources`],
      ["Curated layers overhead", `+${pct(a.curated_layers_overhead)} storage for curated / mart tables`],
      ["Long-term storage", `${pct(a.longterm_share_after_90d)} of data older than 90 days is billed as long-term`],
      ["ELT query volume", `${a.elt_scan_multiplier}x the data ingested each month`],
      ["Analytics query volume (auto)", `${a.auto_analytics_scan_multiplier}x stored data per month when not specified`],
      ["Landing zone retention", `${a.landing_retention_days} days in Cloud Storage`],
      ["Contingency & operations", `${scenario.contingency_pct}% (monitoring, logging, dev/test, unknowns)`],
      ["Commitment discounts", "Applied to BigQuery editions slots, Dataflow streaming and Composer only"],
    ];
    host.innerHTML = `<div class="assume"><h3>Sizing assumptions</h3><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
      <h3>Price sources</h3><p>${esc(result.pricing_meta.note)} Last reviewed ${esc(result.pricing_meta.last_reviewed)}.</p>
      <ul>${result.pricing_meta.sources.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace("https://cloud.google.com/", ""))}</a></li>`).join("")}</ul>
      <p class="disclaimer">${esc(result.disclaimer)}</p></div>`;
  }

  // ------------------------------------------------------------------ exports
  const NO_DOWNLOAD = !!window.ADVISOR_NO_DOWNLOAD;

  function download(name, mime, text) {
    if (NO_DOWNLOAD) {
      const done = () => toast(`Copied ${name} to the clipboard`);
      try {
        navigator.clipboard.writeText(text).then(done, () => showCopyBox(name, text));
      } catch (_) { showCopyBox(name, text); }
      return;
    }
    const blob = new Blob([text], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function slug() { return (scenario.customer || "scenario").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scenario"; }

  function doExport(kind) {
    if (kind === "reset") {
      const prev = scenario;
      scenario = structuredClone(DEFAULT_SCENARIO);
      syncForm(); changed();
      toast("Started a new scenario", 6000, { label: "Undo", run: () => { scenario = prev; syncForm(); changed(); } });
      return;
    }
    if (kind === "json") return download(`${slug()}.json`, "application/json", JSON.stringify(scenario, null, 2));
    if (!result || !scenario.sources.length) return toast("Add at least one source first");
    if (kind === "print") { window.print(); return; }
    if (kind === "csv") return download(`${slug()}-costs.csv`, "text/csv", toCsv());
    if (kind === "md") return download(`${slug()}-proposal.md`, "text/markdown", toMarkdown());
    if (kind === "svg") return download(`${slug()}-architecture.svg`, "image/svg+xml", inlineSvg($("#archSvg")));
  }

  function toCsv() {
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const c = (v) => (v * fx()).toFixed(2);
    const lines = [[`Service`, `Year 1 (${currency})`, `Year 1 1-yr CUD`, `3 years`, `3 years 3-yr CUD`].map(q).join(",")];
    result.by_service.forEach((s) => lines.push([q(s.service), c(s.year1), c(s.year1_cud), c(s.three_year), c(s.three_year_cud)].join(",")));
    lines.push("", [q("Source"), q(`Year 1 (${currency})`), q("3 years")].join(","));
    result.by_source.forEach((s) => lines.push([q(s.name), c(s.year1), c(s.three_year)].join(",")));
    lines.push("", [q("Month"), q(`Pay-as-you-go (${currency})`), q("With 3-yr commitments")].join(","));
    result.monthly.forEach((m) => lines.push([m.month, c(m.payg), c(m.cud3)].join(",")));
    return lines.join("\n");
  }

  function toMarkdown() {
    const t = result.totals, p = result.platform;
    const L = [];
    L.push(`# BigQuery ingestion proposal${scenario.customer ? ` - ${scenario.customer}` : ""}`, "");
    L.push(`Region: **${result.region.name}** · BigQuery pricing: **${bqModelName()}** · Data growth: **${scenario.annual_growth_pct}%/yr** · Currency: **${currency}**`, "");
    L.push("## Ballpark consumption", "", "| Horizon | Pay-as-you-go | With commitments | Discussion range |", "|---|---:|---:|---|");
    L.push(`| 1 year | ${money(t.year1_payg)} | ${money(t.year1_cud1)} (1-yr) | ${money(t.range_low_1y)} - ${money(t.range_high_1y)} |`);
    L.push(`| 3 years | ${money(t.three_year_payg)} | ${money(t.three_year_cud3)} (3-yr) | ${money(t.range_low_3y)} - ${money(t.range_high_3y)} |`, "");
    L.push("### By service", "", "| Service | Year 1 | 3 years |", "|---|---:|---:|");
    result.by_service.forEach((s) => L.push(`| ${s.service} | ${money(s.year1)} | ${money(s.three_year)} |`));
    L.push("", "## Source systems and recommended patterns", "");
    scenario.sources.forEach((s) => {
      const r = recFor(s.id);
      if (!r) return;
      L.push(`### ${s.name}`, "", `*${catalog.source_types.find((x) => x.id === s.type)?.name}* · ${freqName(s.frequency)} · ${fmtGB(s.initial_volume_gb)} initial · ${fmtGB(s.daily_change_gb)}/day`, "");
      L.push(`**Pattern:** ${r.pattern}`, "", `**Services:** ${r.chain.map((x) => tool(x).name).join(" → ")} → BigQuery`, "");
      r.rationale.forEach((x) => L.push(`- ${x}`));
      if (r.alternatives.length) { L.push("", "**Alternatives**", ""); r.alternatives.forEach((a) => L.push(`- ${tool(a.tool).name}: ${a.why}`)); }
      if (r.caveats.length) { L.push("", "**Check during discovery**", ""); r.caveats.forEach((c) => L.push(`- ${c}`)); }
      if (s.notes) L.push("", `**Notes:** ${s.notes}`);
      L.push("");
    });
    L.push("## Agentic data cloud on BigQuery", "");
    p.layer.story.forEach((b) => {
      L.push(`### ${b.title}`, "", `**Services:** ${b.tools.map((x) => tool(x).name).join(", ")}`, "");
      b.points.forEach((x) => L.push(`- ${x}`));
      L.push("");
    });
    L.push("### Cost by capability", "", "| Capability | Year 1 | 3 years |", "|---|---:|---:|");
    result.by_group.forEach((g) => L.push(`| ${g.group} | ${money(g.year1)} | ${money(g.three_year)} |`));
    L.push("");
    L.push("## Platform blueprint", "");
    L.push(`- **Transformation:** Dataform - ${p.transformation.why}`);
    L.push(`- **Orchestration:** ${p.orchestration.tool === "none" ? "None required" : tool(p.orchestration.tool).name} - ${p.orchestration.why}`);
    L.push(`- **Connectivity:** ${p.connectivity ? tool(p.connectivity).name : "Google-managed / public endpoints"}`);
    if (p.datafusion_edition) L.push(`- **Data Fusion:** shared ${p.datafusion_edition} instance`);
    L.push(`- **Governance:** ${p.governance.join("; ")}`, "");
    L.push("---", "", `_${result.disclaimer}_`, "");
    return L.join("\n");
  }

  function inlineSvg(svg) {
    const clone = svg.cloneNode(true);
    const src = svg.querySelectorAll("*"), dst = clone.querySelectorAll("*");
    const props = ["fill", "stroke", "stroke-width", "stroke-dasharray", "font-family", "font-size", "font-weight"];
    src.forEach((el, i) => {
      const cs = getComputedStyle(el);
      props.forEach((p) => dst[i].setAttribute(p, cs.getPropertyValue(p)));
    });
    clone.setAttribute("style", `background:${getComputedStyle(document.body).backgroundColor}`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n` + new XMLSerializer().serializeToString(clone);
  }

  function showCopyBox(name, text) {
    const d = $("#copyDialog");
    $("#copyTitle").textContent = name;
    $("#copyText").value = text;
    d.showModal();
    $("#copyText").select();
  }

  // ------------------------------------------------------------------ toast
  let toastTimer;
  function toast(msg, ms = 2400, action) {
    const t = $("#toast");
    t.innerHTML = "";
    t.append(document.createTextNode(msg));
    if (action) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "toast-action"; b.textContent = action.label;
      b.addEventListener("click", () => { t.hidden = true; action.run(); });
      t.append(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  boot();
})();
