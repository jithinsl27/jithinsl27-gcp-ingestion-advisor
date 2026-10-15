/* Data Cloud Compass - front end (no build step, no framework).
 *
 * The page talks to the backend through `api`. In the static demo build the
 * engine runs in the browser (demo/engine.js) and sets window.ADVISOR_API,
 * so this file works unchanged in both modes.
 */
(() => {
  "use strict";

  const post = (url) => (body) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(okJson);

  const api = window.ADVISOR_API || {
    catalog: () => fetch("/api/catalog").then(okJson),
    samples: () => fetch("/api/samples").then(okJson),
    estimate: post("/api/estimate"),
    workload: post("/api/workload"),
    plan: post("/api/plan"),
  };

  async function okJson(r) {
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try { const j = await r.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch (_) { /* keep status */ }
      throw new Error(msg);
    }
    return r.json();
  }

  const STORE_KEY = "ingestion-advisor:scenario:v2";
  const STREAMING = new Set(["realtime", "near_realtime"]);
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  let DEFAULT_SCENARIO = {
    customer: "", region: "me-central2", processing_region: "", skill: "sql", orchestration: "auto", environment: "production",
    bq_model: "ondemand", bq_slots: 100, analytics_tib_month: null, annual_growth_pct: 20, contingency_pct: 10,
    sources: [], components: [], security: {}, workload: {},
    environments: [{ id: "prod", name: "Production", preset: "prod" }], lakehouse: {},
  };

  let catalog = null;
  let scenario = clone(DEFAULT_SCENARIO);
  let result = null;
  let wlResult = null;
  let planResult = null;
  let currency = "USD";
  let editingId = null;
  let editingComp = null;
  let estimateTimer = null;
  let seq = 0, wlSeq = 0, planSeq = 0, wlTimer = null;

  // ------------------------------------------------------------------ scenario defaults
  function deepMerge(base, over) {
    if (Array.isArray(base) || typeof base !== "object" || base === null) return over === undefined || over === null ? base : over;
    const out = { ...base };
    for (const [k, v] of Object.entries(over || {})) out[k] = k in base ? deepMerge(base[k], v) : v;
    return out;
  }

  function legacyToComponents(p) {
    const comps = [];
    let i = 0;
    const push = (type, settings) => comps.push({ id: `c${++i}`, type, settings });
    const strip = (o) => { const c = { ...(o || {}) }; delete c.enabled; return c; };
    const bi = p.bi || {};
    if (bi.enabled !== false) {
      const s = { users: bi.users ?? 50 };
      if ((bi.tool || "looker") === "looker") s.annual_quote_usd = bi.looker_annual_usd ?? 0;
      push(bi.tool || "looker", s);
    }
    if ((p.agents || {}).enabled !== false) push("agent_platform", strip(p.agents));
    if ((p.gemini_enterprise || {}).enabled !== false) push("gemini_enterprise", strip(p.gemini_enterprise));
    if ((p.gpu || {}).enabled) push("vertex_gpu", strip(p.gpu));
    if ((p.governance || {}).enabled !== false) push("knowledge_catalog", strip(p.governance));
    return { comps, sec: { ...catalog.default_security, ...(p.security || {}) } };
  }

  function withDefaults(sc) {
    sc = clone(sc || {});
    if (!sc.components && sc.platform) {
      const { comps, sec } = legacyToComponents(sc.platform);
      sc.components = comps;
      sc.security = sec;
    }
    delete sc.platform;
    const out = { ...clone(DEFAULT_SCENARIO), ...sc };
    out.components = (sc.components || clone(DEFAULT_SCENARIO.components)).filter((c) => compMeta(c.type))
      .map((c) => ({ id: c.id || uid("c"), type: c.type, included: c.included !== false, settings: { ...compDefaults(c.type), ...(c.settings || {}) } }));
    out.excluded_services = Array.isArray(sc.excluded_services) ? sc.excluded_services : [];
    const hasSec = out.components.some((c) => compMeta(c.type).category === "security");
    if (sc.security && !hasSec) out.components.push(...legacySecurityComponents({ ...catalog.default_security, ...sc.security }));
    delete out.security;
    out.sources = (out.sources || []).map((s) => ({ ...s, included: s.included !== false }));
    out.workload = deepMerge(catalog.default_workload, sc.workload || {});
    out.processing_region = sc.processing_region || "";
    out.plan = { teams: 2, ...(sc.plan || {}) };
    out.lakehouse = { ...catalog.lakehouse_defaults, ...(sc.lakehouse || {}) };
    out.environments = normEnvs(Array.isArray(sc.environments) && sc.environments.length ? sc.environments : catalog.default_environments);
    out.workload_units = { ...(sc.workload_units || {}) };
    return out;
  }

  // ------------------------------------------------------------------ environments
  const ENV_ORDER = ["prod", "dev", "uat", "preprod", "dr", "sandbox"];
  const presetOf = (id) => catalog.environment_presets.find((p) => p.id === id);
  const FACTOR_IDS = () => catalog.environment_factors.map((f) => f.id);
  function normEnvs(list) {
    return clone(list).map((e, i) => {
      const p = presetOf(e.preset) || presetOf(i ? "dev" : "prod");
      const out = { id: e.id || uid("env"), name: e.name || p.name, preset: e.preset || p.id, included: e.included !== false };
      FACTOR_IDS().forEach((f) => (out[f] = e[f] ?? p[f]));
      if (i === 0) FACTOR_IDS().forEach((f) => (out[f] = 100));
      out.bq_slots = e.bq_slots ?? null;
      return out;
    });
  }
  function newEnvFrom(list) {
    const used = new Set(list.map((e) => e.preset));
    const pid = ENV_ORDER.find((id) => !used.has(id)) || "dev";
    const p = presetOf(pid);
    let name = p.name, k = 2;
    while (list.some((e) => e.name === name)) name = `${p.name} ${k++}`;
    return normEnvs([{ id: "x" }, { id: uid("env"), name, preset: pid }])[1];
  }

  function setEnvCount(n) {
    const prev = clone(scenario.environments);
    while (scenario.environments.length < n) scenario.environments.push(newEnvFrom(scenario.environments));
    if (scenario.environments.length > n) {
      scenario.environments = scenario.environments.slice(0, n);
      toast(`${prev.length - n} environment${prev.length - n > 1 ? "s" : ""} removed`, 5000, { label: "Undo", run: () => { scenario.environments = prev; renderEnvs(); changed(); } });
    }
    renderEnvs();
    changed();
  }

  const envCost = (id) => result?.environments?.find((e) => e.id === id);
  function renderEnvs() {
    if (!catalog) return;
    $("#envCount").value = String(scenario.environments.length);
    const short = { data_pct: "data", ingestion_pct: "ingest", compute_pct: "compute", ai_pct: "AI/BI", apps_pct: "APIs/DB", platform_pct: "platform" };
    $("#envList").innerHTML = scenario.environments.map((e, i) => {
      const c = envCost(e.id);
      const sizing = i === 0 ? "Baseline - sized by your inputs" : FACTOR_IDS().map((f) => `${short[f]} ${+e[f]}%`).join(" · ");
      return `<li><button type="button" class="env-item" data-env="${esc(e.id)}"><span class="env-dot e${Math.min(i, 5)}"></span>
        <div><b>${esc(e.name)}</b><span>${esc(sizing)}</span></div><div class="tool">${c ? moneyShort(c.year1) + "/yr" : ""}</div></button></li>`;
    }).join("");
  }

  let envDraft = [];
  function openEnvDialog() {
    envDraft = clone(scenario.environments);
    renderEnvGrid();
    $("#envDialog").showModal();
  }
  function renderEnvGrid() {
    const editions = scenario.bq_model !== "ondemand";
    const head = `<thead><tr><th>Capability</th>${envDraft.map((e, i) => `<th>
        <input type="text" data-env-i="${i}" data-env-k="name" value="${esc(e.name)}" aria-label="Environment name" maxlength="60">
        ${i === 0 ? `<span class="env-base">Baseline</span>` : `<select data-env-i="${i}" data-env-k="preset" aria-label="Preset">${opt(catalog.environment_presets, e.preset)}</select>
        <button type="button" class="link-btn" data-env-rm="${i}">Remove</button>`}</th>`).join("")}</tr></thead>`;
    const rows = catalog.environment_factors.map((f) => `<tr><th scope="row">${esc(f.name)}</th>${envDraft.map((e, i) =>
      `<td><input type="number" min="0" max="1000" step="5" data-env-i="${i}" data-env-k="${f.id}" value="${esc(e[f.id])}" ${i === 0 ? "disabled" : ""} aria-label="${esc(e.name)} ${esc(f.name)}"></td>`).join("")}</tr>`).join("");
    const slots = editions ? `<tr><th scope="row">BigQuery slots (editions; blank = scale by compute %)</th>${envDraft.map((e, i) =>
      `<td><input type="number" min="0" step="50" data-env-i="${i}" data-env-k="bq_slots" value="${i === 0 ? esc(scenario.bq_slots) : esc(e.bq_slots ?? "")}" ${i === 0 ? "disabled" : ""} placeholder="auto"></td>`).join("")}</tr>` : "";
    const cost = result?.environments ? `<tr class="env-cost"><th scope="row">Current estimate, year 1</th>${envDraft.map((e) => `<td>${envCost(e.id) ? money(envCost(e.id).year1) : "new"}</td>`).join("")}</tr>` : "";
    $("#envGrid").innerHTML = head + `<tbody>${rows}${slots}${cost}</tbody>`;
  }
  function onEnvGridChange(e) {
    const el = e.target.closest("[data-env-i]");
    if (!el) return;
    const env = envDraft[Number(el.dataset.envI)], k = el.dataset.envK;
    if (k === "name") env.name = el.value.trim() || env.name;
    else if (k === "preset") {
      const p = presetOf(el.value);
      env.preset = p.id;
      FACTOR_IDS().forEach((f) => (env[f] = p[f]));
      if (!envDraft.some((x, j) => x !== env && x.name === p.name)) env.name = p.name;
      renderEnvGrid();
    } else if (k === "bq_slots") env.bq_slots = el.value === "" ? null : Math.max(0, Number(el.value));
    else env[k] = Math.max(0, Number(el.value) || 0);
  }
  function saveEnvDialog() {
    $$("#envGrid [data-env-k=name]").forEach((el) => { const env = envDraft[Number(el.dataset.envI)]; env.name = el.value.trim() || env.name; });
    scenario.environments = normEnvs(envDraft);
    $("#envDialog").close();
    renderEnvs();
    toast(`${scenario.environments.length} environment${scenario.environments.length > 1 ? "s" : ""} sized`);
    changed();
  }

  function legacySecurityComponents(sec) {
    if (sec.enabled === false) return [];
    const out = [];
    [["sdp_discovery", "sdp"], ["cmek", "cmek"], ["vpc_sc", "vpc_sc"]].forEach(([flag, type]) => { if (sec[flag] !== false) out.push(type); });
    out.push("policy_tags", "scc");
    return out.map((type) => ({ id: uid("c"), type, settings: compDefaults(type) }));
  }

  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const compMeta = (type) => catalog.components.find((c) => c.id === type);
  const compDefaults = (type) => Object.fromEntries((compMeta(type)?.settings || []).map((f) => [f.key, f.default]));

  // ------------------------------------------------------------------ boot
  async function boot() {
    try {
      catalog = await api.catalog();
    } catch (e) {
      toast(`Could not load the catalog: ${e.message}`, 8000);
      return;
    }
    DEFAULT_SCENARIO = {
      ...DEFAULT_SCENARIO,
      components: clone(catalog.default_components),
      security: clone(catalog.default_security),
      workload: clone(catalog.default_workload),
    };
    scenario = withDefaults({});
    fillSelects();
    if (window.ADVISOR_NO_DOWNLOAD) {
      $$('[data-export="print"]').forEach((b) => (b.hidden = true));
      $$("#exportMenu [data-export]").forEach((b) => { if (["md", "csv", "json", "svg"].includes(b.dataset.export)) b.textContent = "Copy " + b.textContent.charAt(0).toLowerCase() + b.textContent.slice(1); });
    }
    if (window.ADVISOR_DEMO) document.body.classList.add("demo");
    restore();
    bindEvents();
    bindGoogleExport();
    loadServerConfig();
    loadSamples();
    syncForm();
    renderAll();
    scheduleEstimate(0);
  }

  function opt(list, sel) {
    return list.map((o) => `<option value="${esc(o.id)}"${o.id === sel ? " selected" : ""}>${esc(o.name)}</option>`).join("");
  }

  function regionOptions(sameLabel) {
    const byGeo = {};
    catalog.regions.forEach((r) => (byGeo[r.geo] = byGeo[r.geo] || []).push(r));
    return (sameLabel ? `<option value="">${esc(sameLabel)}</option>` : "") + Object.entries(byGeo).map(([g, rs]) =>
      `<optgroup label="${esc(g)}">${rs.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}</optgroup>`).join("");
  }
  const regionName = (id) => catalog.regions.find((r) => r.id === id)?.name || id;

  function fillSelects() {
    $("#region").innerHTML = regionOptions();
    $("#processing_region").innerHTML = regionOptions("Same as BigQuery region");
    $("#f_region").innerHTML = regionOptions("Same as BigQuery region");
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
    $("#currency").innerHTML = ["USD", "SAR", "AED", "EUR", "GBP", "INR"].map((c) => `<option>${c}</option>`).join("");
    $("#envCount").innerHTML = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}">${n}</option>`).join("");
    $("#lk_raw_storage_class").innerHTML = opt(catalog.storage_classes);
    $("#f_iot_option").innerHTML = opt(catalog.iot_options.map((o) => ({ id: o.id, name: o.name })));
    const units = catalog.volume_units.map((u) => `<option>${u.id}</option>`).join("");
    $("#f_initial_unit").innerHTML = units;
    $("#f_daily_unit").innerHTML = units;
  }

  // ------------------------------------------------------------------ volume units (KB ... ZB, stored as GB)
  const unitGb = (u) => (catalog.volume_units.find((x) => x.id === u) || { gb: 1 }).gb;
  function bestUnit(gb) {
    gb = Math.abs(Number(gb) || 0);
    if (!gb) return "GB";
    let best = "KB";
    for (const u of catalog.volume_units) if (gb / u.gb >= 1) best = u.id;
    return best;
  }
  const inUnit = (gb, u) => +((Number(gb) || 0) / unitGb(u)).toPrecision(6);

  // ------------------------------------------------------------------ persistence
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ scenario, currency })); } catch (_) { /* storage unavailable */ }
  }
  let restored = false;
  function restore() {
    try {
      const raw = localStorage.getItem(STORE_KEY) || localStorage.getItem("ingestion-advisor:scenario:v1");
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
    $("#processing_region").value = scenario.processing_region || "";
    $("#currency").value = currency;
    ["skill", "orchestration", "bq_model", "environment"].forEach((k) => ($("#" + k).value = scenario[k]));
    ["bq_slots", "annual_growth_pct", "contingency_pct"].forEach((k) => ($("#" + k).value = scenario[k] ?? ""));
    $("#analytics_tib_month").value = scenario.analytics_tib_month ?? "";
    $("#slotsField").hidden = scenario.bq_model === "ondemand";
    const lk = scenario.lakehouse;
    $("#lk_raw_zone").checked = lk.raw_zone !== false;
    ["raw_scope", "raw_storage_class"].forEach((k) => ($("#lk_" + k).value = lk[k]));
    ["raw_retention_months", "silver_pct", "gold_pct"].forEach((k) => ($("#lk_" + k).value = lk[k]));
    renderEnvs();
    renderWorkloadForm();
  }

  // ------------------------------------------------------------------ events
  function bindEvents() {
    $("#customer").addEventListener("input", (e) => { scenario.customer = e.target.value; save(); renderSummary(); });
    $("#region").addEventListener("change", (e) => { scenario.region = e.target.value; changed(); });
    $("#processing_region").addEventListener("change", (e) => { scenario.processing_region = e.target.value; changed(); });
    $("#currency").addEventListener("change", (e) => { currency = e.target.value; save(); renderSummary(); renderCost(); renderPlatform(); renderWorkloadResults(); renderRoadmap(); });
    ["skill", "orchestration", "bq_model", "environment"].forEach((k) =>
      $("#" + k).addEventListener("change", (e) => { scenario[k] = e.target.value; $("#slotsField").hidden = scenario.bq_model === "ondemand"; changed(); }));
    ["bq_slots", "annual_growth_pct", "contingency_pct", "analytics_tib_month"].forEach((k) =>
      $("#" + k).addEventListener("input", (e) => {
        const v = e.target.value === "" ? null : Number(e.target.value);
        scenario[k] = k === "analytics_tib_month" ? v : (v ?? 0);
        changed();
      }));
    $$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
    // lakehouse layers
    $("#lk_raw_zone").addEventListener("change", (e) => { scenario.lakehouse.raw_zone = e.target.checked; changed(); });
    ["raw_scope", "raw_storage_class"].forEach((k) => $("#lk_" + k).addEventListener("change", (e) => { scenario.lakehouse[k] = e.target.value; changed(); }));
    ["raw_retention_months", "silver_pct", "gold_pct"].forEach((k) => $("#lk_" + k).addEventListener("input", (e) => {
      const v = Number(e.target.value);
      if (e.target.value === "" || !(v >= 0)) return;
      scenario.lakehouse[k] = k === "raw_retention_months" ? Math.max(1, Math.round(v)) : v;
      changed();
    }));
    // environments
    $("#envCount").addEventListener("change", (e) => setEnvCount(Number(e.target.value)));
    $("#envConfigure").addEventListener("click", openEnvDialog);
    $("#envList").addEventListener("click", (e) => { if (e.target.closest("[data-env]")) openEnvDialog(); });
    $("#envAdd").addEventListener("click", () => { envDraft.push(newEnvFrom(envDraft)); renderEnvGrid(); });
    $("#envCancel").addEventListener("click", () => $("#envDialog").close());
    $("#envForm").addEventListener("submit", (e) => { e.preventDefault(); saveEnvDialog(); });
    $("#envGrid").addEventListener("change", onEnvGridChange);
    $("#envGrid").addEventListener("click", (e) => {
      const rm = e.target.closest("[data-env-rm]");
      if (rm) { envDraft.splice(Number(rm.dataset.envRm), 1); renderEnvGrid(); }
    });
    // source dialog units
    ["initial", "daily"].forEach((k) => $(`#f_${k}_unit`).addEventListener("change", (e) => {
      const inp = $(k === "initial" ? "#f_initial_volume_gb" : "#f_daily_change_gb");
      const prev = inp.dataset.unit || "GB";
      inp.value = inUnit(Number(inp.value) * unitGb(prev), e.target.value);
      inp.dataset.unit = e.target.value;
    }));
    $("#addSourceBtn").addEventListener("click", () => openDialog(null));
    $("#sourceList").addEventListener("click", (e) => {
      if (e.target.closest("[data-include]")) return;
      const li = e.target.closest("[data-id]");
      if (li) openDialog(li.dataset.id);
    });
    const diagram = $("#diagram");
    diagram.addEventListener("click", (e) => {
      if (suppressClick) return;
      if (e.target.closest("[data-lake]")) { const lp = $("#lakePanel"); lp.open = true; lp.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
      const n = e.target.closest("[data-src]");
      if (n) return openDialog(n.dataset.src);
      const c = e.target.closest("[data-comp]");
      if (c) openComp(c.dataset.comp);
    });
    diagram.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const n = e.target.closest("[data-src],[data-comp]");
      if (!n) return;
      e.preventDefault();
      if (n.dataset.src) openDialog(n.dataset.src); else openComp(n.dataset.comp);
    });
    // drag & drop from the component library onto the diagram
    let dragging = null;
    diagram.addEventListener("dragover", (e) => { if (dragging) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; diagram.classList.add("drop-active"); } });
    diagram.addEventListener("dragleave", (e) => { if (!diagram.contains(e.relatedTarget)) diagram.classList.remove("drop-active"); });
    diagram.addEventListener("drop", (e) => {
      const type = dragging || e.dataTransfer.getData("text/plain");
      dragging = null;
      diagram.classList.remove("drop-active", "drop-ready");
      if (type) {
        e.preventDefault();
        const tgt = e.target.closest?.("[data-drop]")?.dataset.drop;
        const existing = scenario.components.find((c) => c.type === type);
        if (existing && DROP_MODES[type] && tgt) applyDropMode(existing, tgt);
        else addComponent(type, modeForDrop(type, tgt));
      }
    });
    bindDiagramDrag();
    // product search picker
    const search = $("#compSearch"), results = $("#compResults");
    search.addEventListener("input", () => renderResults(search.value));
    search.addEventListener("focus", () => renderResults(search.value));
    search.addEventListener("keydown", (e) => {
      const rows = $$(".res", results);
      let i = rows.findIndex((r) => r.classList.contains("active"));
      if (e.key === "ArrowDown") { e.preventDefault(); i = Math.min(rows.length - 1, i + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); i = Math.max(0, i - 1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (rows[Math.max(0, i)]) toggleComponent(rows[Math.max(0, i)].dataset.type);
        search.value = "";
        closeResults();
        return;
      }
      else if (e.key === "Escape") { closeResults(); return; }
      else return;
      rows.forEach((r, k) => r.classList.toggle("active", k === i));
      rows[i]?.scrollIntoView({ block: "nearest" });
    });
    results.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the search box
    results.addEventListener("click", (e) => {
      const r = e.target.closest(".res");
      if (r) toggleComponent(r.dataset.type);
    });
    results.addEventListener("dragstart", (e) => {
      const r = e.target.closest(".res");
      if (!r) return;
      dragging = r.dataset.type;
      e.dataTransfer.setData("text/plain", r.dataset.type);
      e.dataTransfer.effectAllowed = "copy";
      diagram.classList.add("drop-ready");
    });
    results.addEventListener("dragend", () => { dragging = null; diagram.classList.remove("drop-ready", "drop-active"); });
    document.addEventListener("click", (e) => { if (!e.target.closest(".search-box")) closeResults(); });
    $("#selectedPills").addEventListener("change", (e) => {
      const cb = e.target.closest("[data-price]");
      if (!cb) return;
      const c = scenario.components.find((x) => x.id === cb.dataset.price);
      if (c) { c.included = cb.checked; toast(`${compMeta(c.type).name} ${cb.checked ? "included in" : "left out of"} pricing`); changed(); }
    });
    $("#costBody").addEventListener("click", (e) => {
      const b = e.target.closest("[data-bom-env]");
      if (b) { bomEnv = b.dataset.bomEnv; renderCost(); }
    });
    $("#costBody").addEventListener("change", (e) => {
      const cb = e.target.closest("[data-svc]");
      if (!cb) return;
      const svc = cb.dataset.svc;
      const set = new Set(scenario.excluded_services);
      if (cb.checked) set.delete(svc); else set.add(svc);
      scenario.excluded_services = [...set];
      changed();
    });
    $("#selectedPills").addEventListener("click", (e) => {
      if (e.target.closest("[data-price]")) return;
      const rm = e.target.closest("[data-remove]");
      if (rm) return removeComponent(rm.dataset.remove);
      const b = e.target.closest("[data-comp]");
      if (b) openComp(b.dataset.comp);
    });
    // source include / exclude for phased estimates
    $("#sourceList").addEventListener("change", (e) => {
      const cb = e.target.closest("[data-include]");
      if (!cb) return;
      const s = scenario.sources.find((x) => x.id === cb.dataset.include);
      if (s) { s.included = cb.checked; changed(); }
    });
    $("#srcAll").addEventListener("click", () => { scenario.sources.forEach((s) => (s.included = true)); changed(); });
    $("#srcNone").addEventListener("click", () => { scenario.sources.forEach((s) => (s.included = false)); changed(); });
    $("#platformBody").addEventListener("change", (e) => {
      const sel = e.target.closest("[data-mode-comp]");
      if (!sel) return;
      const c = scenario.components.find((x) => x.id === sel.dataset.modeComp);
      if (!c) return;
      const key = compMeta(c.type).modes.key;
      c.settings[key] = sel.value;
      if (c.type === "gemini_enterprise" && ["looker", "both"].includes(sel.value) && !scenario.components.some((x) => x.type === "looker")) addComponent("looker", null, true);
      changed();
    });
    $("#platformBody").addEventListener("click", (e) => {
      const b = e.target.closest("[data-comp]");
      if (b) openComp(b.dataset.comp);
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
    $("#f_type").addEventListener("change", () => ($("#f_iot_wrap").hidden = $("#f_type").value !== "iot"));
    ["f_frequency", "f_location", "f_transform", "f_type"].forEach((id) => $("#" + id).addEventListener("change", updateHint));

    $("#c_cancel").addEventListener("click", () => $("#compDialog").close());
    $("#c_delete").addEventListener("click", () => { $("#compDialog").close(); removeComponent(editingComp); });
    $("#compForm").addEventListener("submit", (e) => { e.preventDefault(); saveComp(); });

    $("#roadmapBody").addEventListener("change", (e) => {
      if (e.target.id === "rmTeams") { scenario.plan.teams = Number(e.target.value); save(); runPlan(); }
    });
    $("#workloadBody").addEventListener("input", onWorkloadInput);
    $("#workloadBody").addEventListener("change", onWorkloadInput);
    $("#workloadBody").addEventListener("click", (e) => {
      if (e.target.closest("#slotApply") && wlResult?.slots) {
        const sl = wlResult.slots;
        const prev = { m: scenario.bq_model, s: scenario.bq_slots };
        if (sl.model === "editions") { scenario.bq_model = sl.edition; scenario.bq_slots = effectiveSlots(sl); }
        else scenario.bq_model = "ondemand";
        syncForm(); changed();
        toast(sl.model === "editions" ? `Estimate now uses ${EDITION_NAME[sl.edition]} edition with ${scenario.bq_slots} average slots` : "Estimate now uses on-demand pricing", 6000,
          { label: "Undo", run: () => { scenario.bq_model = prev.m; scenario.bq_slots = prev.s; syncForm(); changed(); } });
        return;
      }
      if (e.target.closest("#wlReset")) {
        scenario.workload = clone(catalog.default_workload);
        renderWorkloadForm();
        changed();
        toast("Workload reset to the example values");
      }
    });

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
    $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === id)));
    $$(".tabpanel").forEach((p) => (p.hidden = p.id !== "tab-" + id));
    $("#summaryStrip").hidden = id === "workload";
  }

  function changed() {
    save();
    renderSources();
    renderPills();
    if (!$("#compResults").hidden) renderResults($("#compSearch").value);
    scheduleEstimate(250);
  }

  function scheduleEstimate(delay) {
    clearTimeout(estimateTimer);
    estimateTimer = setTimeout(() => { runEstimate(); runWorkload(); runPlan(); }, delay);
  }

  function payload() {
    const p = clone(scenario);
    p.analytics_tib_month = p.analytics_tib_month || null;
    if (!p.processing_region) delete p.processing_region;
    p.sources.forEach((s) => { if (!s.region) delete s.region; });
    p.components.forEach((c) => { if (!c.settings.region) delete c.settings.region; });
    ["data_region", "pipelines_region", "streaming_region"].forEach((k) => { if (!p.workload[k]) p.workload[k] = null; });
    return p;
  }

  async function runEstimate() {
    const my = ++seq;
    try {
      const r = await api.estimate(payload());
      if (my !== seq) return;
      result = r;
      renderAll();
    } catch (e) {
      toast(`Estimate failed: ${e.message}`, 6000);
    }
  }

  async function runWorkload() {
    const my = ++wlSeq;
    try {
      const r = await api.workload(payload());
      if (my !== wlSeq) return;
      wlResult = r;
      renderWorkloadResults();
    } catch (e) {
      toast(`Workload sizing failed: ${e.message}`, 6000);
    }
  }

  async function runPlan() {
    const my = ++planSeq;
    try {
      const r = await api.plan(payload());
      if (my !== planSeq) return;
      planResult = r;
      renderRoadmap();
    } catch (e) {
      toast(`Roadmap failed: ${e.message}`, 6000);
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
    let h;
    if (t?.cdc && STREAMING.has(freq)) h = "Log-based CDC will be recommended - confirm the DBA can enable it on the source.";
    else if (freq === "one_time") h = "Only the initial load is costed; ongoing ingestion is excluded.";
    else if (STREAMING.has(freq)) h = "Streaming pipelines run 24x7 and are costed as always-on.";
    else h = "Scheduled batch: cost scales with runs per month and volume per run.";
    if ($("#f_region").value && $("#f_region").value !== scenario.region) h += " Processing outside the BigQuery region adds cross-region transfer cost - check data-residency rules.";
    $("#f_hint").textContent = h;
  }

  function openDialog(id) {
    editingId = id;
    const s = id ? scenario.sources.find((x) => x.id === id) : null;
    $("#dlgTitle").textContent = s ? "Edit source system" : "Add source system";
    $("#f_save").textContent = s ? "Save changes" : "Add source";
    $("#f_delete").hidden = !s;
    const setVol = (inpSel, unitSel, gb, unit) => {
      const u = unit || bestUnit(gb);
      $(unitSel).value = u;
      $(inpSel).dataset.unit = u;
      $(inpSel).value = inUnit(gb, u);
    };
    if (s) {
      ["type", "name", "data_type", "location", "frequency", "transform", "notes", "region"]
        .forEach((k) => ($("#f_" + k).value = s[k] ?? ""));
      setVol("#f_initial_volume_gb", "#f_initial_unit", s.initial_volume_gb, s.units?.initial);
      setVol("#f_daily_change_gb", "#f_daily_unit", s.daily_change_gb, s.units?.daily);
      $("#f_iot_option").value = s.iot_option || "native";
    } else {
      $("#f_type").value = "oracle"; $("#f_name").value = ""; $("#f_notes").value = ""; $("#f_region").value = "";
      $("#f_transform").value = "none";
      setVol("#f_initial_volume_gb", "#f_initial_unit", 500, "GB");
      setVol("#f_daily_change_gb", "#f_daily_unit", 5, "GB");
      $("#f_iot_option").value = "native";
      applyTypeDefaults();
    }
    $("#f_iot_wrap").hidden = $("#f_type").value !== "iot";
    updateHint();
    $("#sourceDialog").showModal();
    $("#f_type").focus();
  }

  function saveSource() {
    const v = (k) => $("#f_" + k).value;
    const typeName = catalog.source_types.find((s) => s.id === v("type"))?.name || v("type");
    const src = {
      id: editingId || uid("s"),
      name: v("name").trim() || typeName,
      type: v("type"), data_type: v("data_type"), location: v("location"),
      frequency: v("frequency"), transform: v("transform"),
      initial_volume_gb: Math.max(0, (Number(v("initial_volume_gb")) || 0) * unitGb(v("initial_unit"))),
      daily_change_gb: Math.max(0, (Number(v("daily_change_gb")) || 0) * unitGb(v("daily_unit"))),
      units: { initial: v("initial_unit"), daily: v("daily_unit") },
      notes: v("notes"),
      region: v("region") || "",
    };
    if (src.type === "iot") src.iot_option = v("iot_option");
    const prevSrc = editingId && scenario.sources.find((x) => x.id === editingId);
    if (prevSrc) { src.included = prevSrc.included !== false; if (prevSrc.start_month) src.start_month = prevSrc.start_month; }
    if (editingId) scenario.sources = scenario.sources.map((s) => (s.id === editingId ? src : s));
    else scenario.sources.push(src);
    $("#sourceDialog").close();
    toast(editingId ? "Source updated" : "Source added");
    changed();
  }

  // ------------------------------------------------------------------ components
  const MULTI_INSTANCE = new Set(["vertex_gpu", "agent_platform"]);

  function addComponent(type, mode, quiet) {
    const meta = compMeta(type);
    if (!meta) return;
    const existing = scenario.components.find((c) => c.type === type);
    if (existing && !MULTI_INSTANCE.has(type)) {
      if (!quiet) toast(`${meta.name} is already in the architecture`);
      return;
    }
    const settings = compDefaults(type);
    if (mode && DROP_MODES[type]) settings[DROP_MODES[type].key] = mode;
    scenario.components.push({ id: uid("c"), type, settings });
    if (type === "gemini_enterprise" && (mode === "looker") && !scenario.components.some((c) => c.type === "looker")) scenario.components.push({ id: uid("c"), type: "looker", settings: compDefaults("looker") });
    if (!quiet) toast(`${meta.name} added${mode ? ` (${DROP_MODES[type].msg[mode] ? DROP_MODES[type].msg[mode].replace(/^.*? now /, "") : mode})` : ""}${meta.vendor === "partner" ? " (partner product - not costed)" : ""}`);
    changed();
  }

  function removeComponent(id) {
    const c = scenario.components.find((x) => x.id === id);
    if (!c) return;
    const prev = clone(scenario.components);
    scenario.components = scenario.components.filter((x) => x.id !== id);
    changed();
    toast(`${compMeta(c.type).name} removed`, 5000, { label: "Undo", run: () => { scenario.components = prev; changed(); } });
  }

  function openComp(id) {
    const c = scenario.components.find((x) => x.id === id);
    if (!c) return;
    editingComp = id;
    const meta = compMeta(c.type);
    $("#compTitle").textContent = meta.name;
    $("#compVendor").textContent = meta.vendor === "google" ? "Google Cloud" : "Partner - not costed";
    $("#compVendor").className = "vendor-badge " + meta.vendor;
    $("#compMethod").textContent = meta.method;
    let fields = meta.settings.map((f) => {
      const v = c.settings[f.key] ?? f.default;
      const input = f.type === "select"
        ? `<select data-ck="${esc(f.key)}">${opt(f.options, v)}</select>`
        : `<input type="number" min="0" step="${esc(f.step ?? 1)}" data-ck="${esc(f.key)}" value="${esc(v)}">`;
      return `<label>${esc(f.label)}${input}</label>`;
    }).join("");
    if (meta.costed) {
      fields += `<label class="toggle span2"><input type="checkbox" data-ck="included" ${c.included !== false ? "checked" : ""}> Include in pricing</label>`;
      fields += `<label class="span2">Region for this service<select data-ck="region">${regionOptions("Same as BigQuery region")}</select></label>`;
    }
    $("#compFields").innerHTML = fields || `<p class="hint span2">No settings - this component is shown for the integration design only.</p>`;
    const rs = $("#compFields [data-ck=region]");
    if (rs) rs.value = c.settings.region || "";
    $("#compSteps").innerHTML = meta.steps.map((s) => `<li>${esc(s)}</li>`).join("");
    $("#compNotes").innerHTML = meta.notes.map((s) => `<li>${esc(s)}</li>`).join("");
    $("#compDoc").href = meta.doc;
    $("#compDialog").showModal();
  }

  function saveComp() {
    const c = scenario.components.find((x) => x.id === editingComp);
    if (!c) return;
    $$("#compFields [data-ck]").forEach((el) => {
      if (el.dataset.ck === "included") { c.included = el.checked; return; }
      c.settings[el.dataset.ck] = el.type === "number" ? Math.max(0, Number(el.value) || 0) : el.value;
    });
    $("#compDialog").close();
    toast(`${compMeta(c.type).name} updated`);
    changed();
  }

  function closeResults() {
    $("#compResults").hidden = true;
    $("#compSearch").setAttribute("aria-expanded", "false");
  }

  function toggleComponent(type) {
    const existing = scenario.components.find((c) => c.type === type);
    if (existing) removeComponent(existing.id);
    else addComponent(type);
  }

  function renderResults(q) {
    const list = $("#compResults");
    const terms = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    const catName = (id) => catalog.component_categories.find((c) => c.id === id).name;
    const hay = (c) => `${c.name} ${c.id} ${catName(c.category)} ${c.vendor === "partner" ? "partner" : "google"} ${c.method}`.toLowerCase();
    const score = (c) => {
      const name = c.name.toLowerCase();
      const words = name.split(/[^a-z0-9]+/);
      let sc = 0;
      for (const t of terms) {
        if (words.some((w) => w.startsWith(t))) sc += 100;
        else if (name.includes(t)) sc += 60;
        else if (`${c.id} ${catName(c.category)}`.toLowerCase().includes(t)) sc += 25;
        else if (hay(c).includes(t)) sc += 5;
        else return -1;
      }
      return sc;
    };
    const used = new Set(scenario.components.map((c) => c.type));
    const row = (c) => `<li class="res" role="option" draggable="true" data-type="${esc(c.id)}" aria-selected="${used.has(c.id)}">
        <span class="res-name">${esc(c.name)}<small>${esc(catName(c.category))} · ${esc(c.method)}</small></span>
        <span class="vendor-badge ${c.vendor}">${c.vendor === "google" ? (c.costed ? "Google Cloud" : "Google · no charge") : "Partner · not costed"}</span>
        <span class="res-btn ${used.has(c.id) ? "remove" : ""}">${used.has(c.id) ? "Remove" : "Add"}</span></li>`;
    let html = "";
    if (terms.length) {
      const ranked = catalog.components.map((c) => [c, score(c)]).filter(([, sc]) => sc >= 0).sort((x, y) => y[1] - x[1]).map(([c]) => c);
      html = ranked.length ? ranked.map(row).join("")
        : `<li class="res-empty">No product matches "${esc(q)}". Try a product name such as Looker, Power BI, Spanner or Collibra.</li>`;
    } else {
      for (const cat of catalog.component_categories) {
        const items = catalog.components.filter((c) => c.category === cat.id);
        html += `<li class="res-cat" role="presentation">${esc(cat.name)}</li>` + items.map(row).join("");
      }
    }
    list.innerHTML = html;
    list.hidden = false;
    $("#compSearch").setAttribute("aria-expanded", "true");
  }

  function renderPills() {
    const host = $("#selectedPills");
    if (!scenario.components.length) {
      host.innerHTML = `<span class="pills-hint">No products selected yet - search above to add BI, AI, API, database, governance or security products.</span>`;
      return;
    }
    const order = catalog.component_categories.map((c) => c.id);
    const comps = [...scenario.components].sort((a, b) => order.indexOf(compMeta(a.type).category) - order.indexOf(compMeta(b.type).category));
    host.innerHTML = comps.map((c) => {
      const m = compMeta(c.type);
      const priced = c.included !== false;
      return `<span class="pill ${m.vendor} cat-${m.category}${priced ? "" : " unpriced"}">
        ${m.costed ? `<input type="checkbox" class="pill-price" data-price="${esc(c.id)}" ${priced ? "checked" : ""} title="${priced ? "Priced - untick to leave out of the estimate" : "Not priced - tick to include in the estimate"}" aria-label="Include ${esc(m.name)} in pricing">` : `<span class="dot"></span>`}
        <button type="button" data-comp="${esc(c.id)}" title="Configure ${esc(m.name)}">${esc(m.name)}${m.costed && c.settings.region ? ` · ${esc(c.settings.region)}` : ""}${priced ? "" : " · not priced"}</button>
        <button type="button" class="pill-x" data-remove="${esc(c.id)}" aria-label="Remove ${esc(m.name)}">×</button></span>`;
    }).join("");
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
        scenario = withDefaults(samples[+b.dataset.i].scenario);
        $("#samplesMenu").hidden = true;
        syncForm();
        changed();
        toast("Sample scenario loaded");
      });
      if (!restored && !scenario.sources.length && samples.length) {
        const first = samples.find((s) => s.file === "retail-bank-ksa.json") || samples[0];
        scenario = withDefaults(first.scenario);
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
    renderEnvs();
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

  function flowClass(freq) { return freq === "one_time" ? "once" : STREAMING.has(freq) ? "stream" : "batch"; }
  function recFor(id) { return result?.recommendations.find((r) => r.source_id === id); }
  function tool(id) { return catalog.tools[id] || { name: id, doc: "#" }; }
  function freqName(id) { return catalog.frequencies.find((f) => f.id === id)?.name || id; }

  function renderSources() {
    const list = $("#sourceList");
    const n = scenario.sources.length, inc = scenario.sources.filter((s) => s.included !== false).length;
    $("#sourceEmpty").hidden = n > 0;
    $("#srcBulk").hidden = n === 0;
    $("#srcCount").textContent = `${inc} of ${n} in this estimate`;
    list.innerHTML = scenario.sources.map((s) => {
      const r = recFor(s.id);
      const on = s.included !== false;
      const reg = s.region && s.region !== scenario.region ? ` · ${esc(s.region)}` : "";
      return `<li class="${on ? "" : "excluded"}"><label class="src-check" title="${on ? "Included" : "Excluded"} - untick to leave out of this phase">
          <input type="checkbox" data-include="${esc(s.id)}" ${on ? "checked" : ""} aria-label="Include ${esc(s.name)} in the estimate"></label>
        <button class="source-item" data-id="${esc(s.id)}" type="button">
        <i class="bar ${flowClass(s.frequency)}"></i>
        <div><b>${esc(s.name)}</b><span>${esc(freqName(s.frequency))} · ${fmtGB(s.daily_change_gb)}/day${reg}${on ? "" : " · not in this phase"}</span></div>
        <div class="tool">${r ? esc(tool(r.primary).name) : on ? "" : "Later phase"}</div>
      </button></li>`;
    }).join("");
  }

  function renderSummary() {
    const el = $("#summaryStrip");
    if (!result || !scenario.sources.length) { el.innerHTML = ""; return; }
    const t = result.totals;
    const nReg = result.by_region?.length || 1;
    el.innerHTML = `
      <div class="fig"><b>${money(t.avg_monthly_year1)}</b><span>Average per month, year 1</span></div>
      <div class="fig"><b>${money(t.year1_payg)}</b><span>1-year, pay-as-you-go</span></div>
      <div class="fig"><b>${money(t.three_year_payg)}</b><span>3-year, pay-as-you-go</span></div>
      <div class="note">BigQuery in ${esc(result.region.name)}${nReg > 1 ? ` · ${nReg} regions in use` : ""} · ${result.recommendations.length} of ${scenario.sources.length} sources in this estimate</div>`;
  }

  // ---------------- architecture diagram
  const INTEGRATION_CATS = new Set(["api", "saas_other", "saas_salesforce", "sap"]);
  const GE_LABEL = { bigquery: "Grounded on BigQuery", looker: "Grounded on Looker semantic layer", both: "Grounded on BigQuery + Looker", agents: "Via data agents" };
  const APIGEE_LABEL = { integration: "Integration layer · data APIs", agents: "AI gateway & tools for agents", both: "Integration layer + AI gateway" };

  function renderDiagram() {
    const host = $("#diagram");
    const srcs = scenario.sources;
    const W = 1440;
    if (!srcs.length || !result) {
      host.innerHTML = `<svg viewBox="0 0 ${W} 220" role="img" aria-label="Empty architecture"><text class="dg-empty" x="${W / 2}" y="110" text-anchor="middle">Add a source system to start drawing the target architecture.</text></svg>`;
      return;
    }
    const plat = result.platform;
    const lake = plat.lakehouse || { raw_zone: false, layers: [] };
    const rowH = 66, top = 46, nodeH = 48;
    const col = { src: 16, conn: 234, ing: 354, proc: 544, raw: 734, bq: 872, out: 1112 };
    const cw = { src: 204, conn: 108, ing: 172, proc: 172, raw: 118, bq: 222, out: 290 };

    const comps = scenario.components.map((c) => ({ c, m: compMeta(c.type) }));
    const CONSUME_CATS = ["bi", "ai", "integration", "database"];
    const consume = CONSUME_CATS.flatMap((cat) => comps.filter((x) => x.m.category === cat));
    const govComps = [...comps.filter((x) => x.m.category === "governance"), ...comps.filter((x) => x.m.category === "security")];
    const groupGap = 22;
    const nGroups = CONSUME_CATS.filter((cat) => comps.some((x) => x.m.category === cat)).length;
    const apigee = comps.find((x) => x.c.type === "apigee");
    const apigeeRole = apigee ? apigee.c.settings.role || "both" : null;
    const ge = comps.find((x) => x.c.type === "gemini_enterprise");
    const geMode = ge ? ge.c.settings.grounding || "bigquery" : null;

    const flowH = Math.max(400, top + srcs.length * rowH + 30, top + consume.length * 58 + groupGap * Math.max(0, nGroups - 1) + 40);
    const H = flowH + 100;

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
      const gap = (flowH - top - 20) / Math.max(keys.length, 1);
      return Object.fromEntries(keys.map((k, i) => [k, { x, w, y: top + gap * i + (gap - nodeH) / 2 }]));
    };
    const ingPos = spread(ingKeys, col.ing, cw.ing);
    const procPos = spread(procKeys, col.proc, cw.proc);
    const bqY = top, bqH = flowH - top - 20;
    const midY = (p) => p.y + nodeH / 2;
    const avgY = (list) => list.reduce((a, n) => a + n.y, 0) / list.length;
    const connSrc = srcNodes.filter((n) => n.r?.needs_connectivity);
    const connPos = { x: col.conn, y: connSrc.length ? avgY(connSrc) : top };
    // Apigee as the integration layer in front of application / SaaS / API sources
    const apiSrc = apigee && apigeeRole !== "agents" ? srcNodes.filter((n) => n.r && !n.r.needs_connectivity && INTEGRATION_CATS.has(catalog.source_types.find((t) => t.id === n.s.type)?.category)) : [];
    const apiPos = { x: col.conn, y: apiSrc.length ? avgY(apiSrc) : 0 };
    if (apiSrc.length && connSrc.length && Math.abs(apiPos.y - connPos.y) < nodeH + 10) apiPos.y = Math.min(flowH - nodeH - 24, connPos.y + nodeH + 14);
    const apiSet = new Set(apiSrc.map((n) => n.s.id));
    const curve = (x1, y1, x2, y2) => { const dx = (x2 - x1) / 2; return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`; };

    let edges = "", nodes = "", over = "";
    const node = (x, y, w, title, sub, cls = "", attrs = "", tag = "", h = nodeH) =>
      `<g class="dg-node ${cls}" ${attrs}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>
        <text x="${x + 12}" y="${y + (sub ? 20 : 29)}">${esc(clip(title, (w - (tag ? 60 : 0)) / 7.2))}</text>
        ${sub ? `<text class="sub" x="${x + 12}" y="${y + 37}">${esc(clip(sub, w / 6.1))}</text>` : ""}
        ${tag ? `<text class="tag" x="${x + w - 10}" y="${y + 17}" text-anchor="end">${esc(tag)}</text>` : ""}</g>`;

    // which flows land in the Cloud Storage raw zone first
    const RAW_ENG = ["files_transfer", "dataflow_batch", "datafusion", "dataproc", "cloud_run", "app_integration", "dts_migration"];
    const inRaw = (s) => lake.raw_zone && s.included !== false && (lake.raw_scope === "all" || (!STREAMING.has(s.frequency) && (recFor(s.id)?.engine || "").split("+").some((e) => RAW_ENG.includes(e))));
    const flows = [];
    srcNodes.forEach((n) => {
      const fc = flowClass(n.s.frequency);
      const reg = n.s.region && n.s.region !== scenario.region ? ` · ${n.s.region}` : "";
      const off = n.s.included === false;
      const iotOpt = n.s.type === "iot" ? catalog.iot_options.find((o) => o.id === (n.s.iot_option || "native")) : null;
      const sub = off ? "Later phase - not in this estimate" : `${freqName(n.s.frequency)} · ${fmtGB(n.s.daily_change_gb)}/day${reg}`;
      nodes += node(n.x, n.y, cw.src, n.s.name, iotOpt && !off ? `${iotOpt.vendor === "partner" ? "ISV" : "Native"} · ${fmtGB(n.s.daily_change_gb)}/day` : sub,
        `src clickable${off ? " excluded" : ""}`, `data-src="${esc(n.s.id)}" data-drop="sources" tabindex="0" role="button" aria-label="Edit ${esc(n.s.name)}"`);
      if (!n.r) return;
      const hops = [];
      if (n.r.needs_connectivity) hops.push({ x: connPos.x, w: cw.conn, y: midY(connPos) });
      else if (apiSet.has(n.s.id)) hops.push({ x: apiPos.x, w: cw.conn, y: midY(apiPos), cls: "ai" });
      const ip = ingPos[n.ing];
      hops.push({ x: ip.x, w: ip.w, y: midY(ip) });
      if (n.proc) { const pp = procPos[n.proc]; hops.push({ x: pp.x, w: pp.w, y: midY(pp) }); }
      flows.push({ n, fc, hops, raw: inRaw(n.s) });
    });
    const rawFlows = flows.filter((f) => f.raw);
    let rawPos = null;
    if (rawFlows.length) {
      const ys = rawFlows.map((f) => f.hops[f.hops.length - 1].y);
      const y0 = Math.max(top, Math.min(...ys) - nodeH / 2 - 8), y1 = Math.min(flowH - 20, Math.max(...ys) + nodeH / 2 + 8);
      const h = Math.max(104, y1 - y0);
      rawPos = { x: col.raw, y: Math.min(y0, flowH - 20 - h), h };
    }
    flows.forEach((f) => {
      let x = f.n.x + cw.src, y = f.n.y + nodeH / 2;
      f.hops.forEach((h) => { edges += `<path class="dg-edge ${h.cls || f.fc}" d="${curve(x, y, h.x, h.y)}"/>`; x = h.x + h.w; y = h.y; });
      if (f.raw && rawPos) {
        const ry = Math.max(rawPos.y + 12, Math.min(rawPos.y + rawPos.h - 12, y));
        edges += `<path class="dg-edge ${f.fc}" d="${curve(x, y, col.raw, ry)}"/>`;
        edges += `<path class="dg-edge ${f.fc}" d="${curve(col.raw + cw.raw, ry, col.bq, ry)}"/>`;
      } else {
        over += `<path class="dg-edge ${f.fc}" d="${curve(x, y, col.bq, y)}"/>`;  // bypasses the raw zone (CDC / streaming)
      }
    });
    if (connSrc.length) nodes += node(connPos.x, connPos.y, cw.conn, tool(plat.connectivity).name.replace("Cloud ", ""), "Private link", "");
    if (apiSrc.length) nodes += node(apiPos.x, apiPos.y, cw.conn, "Apigee", "Integration layer", "comp clickable google integration", `data-comp="${esc(apigee.c.id)}" data-dragmode="apigee" tabindex="0" role="button" aria-label="Configure Apigee"`);
    ingKeys.forEach((k) => { const p = ingPos[k]; nodes += node(p.x, p.y, p.w, tool(k).name, k === "datastream" ? "Change data capture" : ["litmus", "clearblade"].includes(k) ? "Partner (ISV) · not costed" : "Ingest", ["litmus", "clearblade"].includes(k) ? "partner" : "", `data-drop="sources"`); });
    procKeys.forEach((k) => {
      const p = procPos[k];
      const names = k.split(">").map((t) => tool(t).name);
      nodes += node(p.x, p.y, p.w, names[names.length - 1], names.length > 1 ? "via " + names.slice(0, -1).join(", ") : "Process / land", "");
    });
    if (rawPos) {
      const cls = catalog.storage_classes.find((c) => c.id === lake.raw_storage_class)?.name.split(" (")[0] || lake.raw_storage_class;
      nodes += `<g class="dg-node raw clickable" data-lake="1" tabindex="0" role="button" aria-label="Configure the raw zone"><rect x="${rawPos.x}" y="${rawPos.y}" width="${cw.raw}" height="${rawPos.h}" rx="8"/>
        <text x="${rawPos.x + 10}" y="${rawPos.y + 20}" style="font-weight:700">Cloud Storage</text>
        <text class="sub" x="${rawPos.x + 10}" y="${rawPos.y + 37}">Raw zone</text>
        <text class="sub" x="${rawPos.x + 10}" y="${rawPos.y + 54}">${esc(cls)} · ${esc(lake.raw_retention_months)} mo</text>
        <text class="sub" x="${rawPos.x + 10}" y="${rawPos.y + 71}">${esc(fmtGB(lake.raw_gib_month12))} (M12)</text></g>`;
    }

    // BigQuery: medallion layers + built-in capabilities
    const orch = plat.orchestration.tool;
    const inside = ["Dataform ELT", "BigQuery ML & AI", "Reverse ETL"];
    if (orch !== "none") inside.splice(1, 0, orch === "composer" ? "Cloud Composer" : "Workflows");
    const bandH = 30, bandY = bqY + 56;
    const layers = (lake.layers || []).map((l, i) => `<g class="bq-layer ${esc(l.id)}"><rect x="${col.bq + 12}" y="${bandY + i * (bandH + 4)}" width="${cw.bq - 24}" height="${bandH}" rx="5"/>
        <text x="${col.bq + 22}" y="${bandY + i * (bandH + 4) + 19}"><tspan style="font-weight:700">${esc(l.name)}</tspan> · ${esc(fmtGB(l.gib_month12))}</text><title>${esc(l.name)}: ${esc(l.role)} (${esc(l.pct)}% of bronze)</title></g>`).join("");
    const chipY = bandY + (lake.layers || []).length * (bandH + 4) + 10;
    const chipH = Math.min(24, Math.max(18, (bqY + bqH - 34 - chipY) / inside.length - 4));
    nodes += `<g class="dg-node bq" data-drop="bigquery"><rect x="${col.bq}" y="${bqY}" width="${cw.bq}" height="${bqH}" rx="10"/>
      <text x="${col.bq + 14}" y="${bqY + 26}" style="font-weight:700">BigQuery</text>
      <text class="sub" x="${col.bq + 14}" y="${bqY + 44}">${esc(result.region.id)} · Iceberg lakehouse</text>
      ${layers}
      ${inside.map((t, i) => `<g class="bq-chip"><rect x="${col.bq + 12}" y="${chipY + i * (chipH + 4)}" width="${cw.bq - 24}" height="${chipH}" rx="5"/><text x="${col.bq + 22}" y="${chipY + i * (chipH + 4) + chipH / 2 + 4}">${esc(t)}</text></g>`).join("")}
      <text class="sub" x="${col.bq + 14}" y="${bqY + bqH - 12}">${esc(clip(bqModelName(), 34))}</text></g>`;

    // consume column: BI, AI, APIs, databases
    if (consume.length) {
      const avail = flowH - top - 20 - groupGap * Math.max(0, nGroups - 1);
      const step = Math.min(64, avail / consume.length);
      let y = top + 4;
      const pos = {};
      let prevCat = null;
      consume.forEach(({ c, m }) => {
        if (prevCat && m.category !== prevCat) {
          y += groupGap - 6;
          nodes += `<text class="dg-group-label" x="${col.out}" y="${y + 4}">${esc(catalog.component_categories.find((k) => k.id === m.category).name)}</text>`;
          y += 6;
        }
        prevCat = m.category;
        const reg = m.costed && c.settings.region ? ` · ${c.settings.region}` : "";
        const off = c.included === false;
        const cls = `comp clickable ${m.vendor} ${m.category}${off ? " excluded" : ""}`;
        let sub = (off ? "Not priced · " : "") + "via " + m.method + reg;
        if (c.type === "gemini_enterprise") sub = (off ? "Not priced · " : "") + GE_LABEL[geMode] + (geMode !== "bigquery" && geMode !== "agents" && !comps.some((x) => x.c.type === "looker") ? " (add Looker)" : "");
        if (c.type === "apigee") sub = (off ? "Not priced · " : "") + APIGEE_LABEL[apigeeRole];
        const fromBq = !(c.type === "gemini_enterprise" && (geMode === "looker" || geMode === "agents")) && !(c.type === "apigee" && apigeeRole === "agents");
        if (fromBq) edges += `<path class="dg-edge ${m.vendor === "partner" ? "partner" : m.category === "ai" || m.category === "integration" ? "ai" : "plain"}" d="${curve(col.bq + cw.bq, y + nodeH / 2, col.out, y + nodeH / 2)}"/>`;
        let attrs = `data-comp="${esc(c.id)}" tabindex="0" role="button" aria-label="Configure ${esc(m.name)}"`;
        if (c.type === "looker") attrs += ` data-drop="looker"`;
        if (c.type === "agent_platform") attrs += ` data-drop="agents"`;
        if (c.type === "gemini_enterprise") attrs += ` data-dragmode="gemini_enterprise"`;
        if (c.type === "apigee") attrs += ` data-dragmode="apigee"`;
        nodes += node(col.out, y, cw.out, m.name, sub, cls, attrs, m.vendor === "partner" ? "Partner" : "");
        if (!(c.type in pos)) pos[c.type] = y;
        y += step;
      });
      // side connectors (outside the column, to the right)
      let lane = 0;
      const side = (ya, yb, title) => {
        const xr = col.out + cw.out, x = xr + 7 + lane++ * 7;
        edges += `<path class="dg-edge ai side" d="M${xr},${ya + nodeH / 2} H${x} V${yb + nodeH / 2} H${xr}"><title>${esc(title)}</title></path>`;
      };
      if (pos.agent_platform !== undefined && pos.gemini_enterprise !== undefined) side(pos.agent_platform, pos.gemini_enterprise, "Data agents are registered in Gemini Enterprise");
      if (pos.looker !== undefined && pos.gemini_enterprise !== undefined && (geMode === "looker" || geMode === "both")) side(pos.looker, pos.gemini_enterprise, "Gemini Enterprise answers from Looker's governed semantic layer");
      if (pos.agent_platform !== undefined && pos.apigee !== undefined && (apigeeRole === "agents" || apigeeRole === "both")) side(pos.agent_platform, pos.apigee, "Agents call models and tools through Apigee (AI gateway)");
    } else {
      nodes += `<g class="dg-hint"><rect x="${col.out}" y="${top}" width="${cw.out}" height="${flowH - top - 20}" rx="10"/>
        <text x="${col.out + cw.out / 2}" y="${top + (flowH - top) / 2 - 8}" text-anchor="middle">Drop BI, AI, API, database</text>
        <text x="${col.out + cw.out / 2}" y="${top + (flowH - top) / 2 + 12}" text-anchor="middle">or governance components here</text></g>`;
    }

    let band = "";
    {
      const by = flowH + 6, bh = 84;
      const chips = govComps.map(({ c, m }) => ({ t: m.name, s: c.included === false ? "Not priced" : m.category === "security" ? "Security & compliance" : m.vendor === "partner" ? "Partner catalog" : "Lineage, quality, glossary",
        cls: `gov clickable ${m.vendor} ${m.category}${c.included === false ? " excluded" : ""}`, attrs: `data-comp="${esc(c.id)}" tabindex="0" role="button" aria-label="Configure ${esc(m.name)}"`, tag: m.vendor === "partner" ? "Partner" : "" }));
      band = `<g class="dg-band"><rect x="16" y="${by}" width="${W - 32}" height="${bh}" rx="12"/>
        <text class="band-title" x="30" y="${by + 20}">Governance & security across every layer</text></g>`;
      if (chips.length) {
        const cw2 = Math.min(220, (W - 48 - (chips.length - 1) * 8) / chips.length);
        chips.forEach((ch, i) => { band += node(30 + i * (cw2 + 8), by + 28, cw2, ch.t, ch.s, ch.cls, ch.attrs, ch.tag); });
      } else {
        band += `<text class="dg-band-hint" x="${W / 2}" y="${by + 54}" text-anchor="middle">Search for governance or security products (Knowledge Catalog, CMEK, VPC Service Controls, Collibra …) to add them here</text>`;
      }
      edges += `<path class="dg-edge plain" stroke-dasharray="3 4" d="M${col.bq + cw.bq / 2},${bqY + bqH} L${col.bq + cw.bq / 2},${by}"/>`;
    }

    const heads = [["Source systems", col.src], connSrc.length || apiSrc.length ? ["Connect", col.conn] : null, ["Ingestion & CDC", col.ing], ["Processing", col.proc],
      rawPos ? ["Raw zone", col.raw] : null, ["Lakehouse", col.bq],
      [consume.length ? catalog.component_categories.find((k) => k.id === consume[0].m.category).name : "Consumers", col.out]].filter(Boolean);
    const headSvg = heads.map(([t, x]) => `<text class="dg-col-title" x="${x}" y="22">${esc(t)}</text>`).join("");

    host.innerHTML = `<svg id="archSvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Target data and AI architecture on Google Cloud" xmlns="http://www.w3.org/2000/svg">${headSvg}${edges}${band}${nodes}${over}</svg>`;
    $("#canvasTip").hidden = !(ge || apigee);
  }

  // ---------------- drag Gemini Enterprise / Apigee onto a target to change how they connect
  const DROP_MODES = {
    gemini_enterprise: { key: "grounding", map: { looker: "looker", bigquery: "bigquery", agents: "agents" },
      msg: { looker: "Gemini Enterprise now answers from Looker's semantic layer", bigquery: "Gemini Enterprise now grounded on BigQuery", agents: "Gemini Enterprise now reaches data through agents" } },
    apigee: { key: "role", map: { sources: "integration", bigquery: "integration", agents: "agents" },
      msg: { integration: "Apigee is now the integration layer for applications and data APIs", agents: "Apigee is now the AI gateway for agents" } },
  };
  function modeForDrop(type, target) {
    const d = DROP_MODES[type];
    return d && target ? d.map[target] : null;
  }
  function applyDropMode(comp, target) {
    const d = DROP_MODES[comp.type];
    const v = modeForDrop(comp.type, target);
    if (!d || !v) return false;
    const prev = comp.settings[d.key];
    if (prev === v) { toast("Already connected that way"); return true; }
    comp.settings[d.key] = v;
    if (comp.type === "gemini_enterprise" && v !== "bigquery" && v !== "agents" && !scenario.components.some((c) => c.type === "looker")) addComponent("looker", null, true);
    changed();
    toast(d.msg[v], 5000, { label: "Undo", run: () => { comp.settings[d.key] = prev; changed(); } });
    return true;
  }

  function bindDiagramDrag() {
    const diagram = $("#diagram");
    let drag = null;
    diagram.addEventListener("pointerdown", (e) => {
      const g = e.target.closest("[data-dragmode]");
      if (!g || e.button !== 0) return;
      drag = { type: g.dataset.dragmode, id: g.dataset.comp, x: e.clientX, y: e.clientY, active: false, ghost: null };
    });
    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
        drag.active = true;
        drag.ghost = document.createElement("div");
        drag.ghost.className = "drag-ghost";
        drag.ghost.textContent = compMeta(drag.type).name.split(" API")[0];
        document.body.appendChild(drag.ghost);
        const valid = Object.keys(DROP_MODES[drag.type].map);
        $$("[data-drop]", diagram).forEach((n) => n.classList.toggle("drop-target", valid.includes(n.dataset.drop)));
        diagram.classList.add("dragging-mode");
      }
      drag.ghost.style.left = e.clientX + 12 + "px";
      drag.ghost.style.top = e.clientY + 12 + "px";
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop]");
      $$(".drop-hover", diagram).forEach((n) => n.classList.remove("drop-hover"));
      if (over && over.classList.contains("drop-target")) over.classList.add("drop-hover");
    });
    window.addEventListener("pointerup", (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.active) return;
      d.ghost.remove();
      diagram.classList.remove("dragging-mode");
      $$(".drop-target,.drop-hover", diagram).forEach((n) => n.classList.remove("drop-target", "drop-hover"));
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 50);
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-drop]");
      const comp = scenario.components.find((c) => c.id === d.id);
      if (comp && over && !applyDropMode(comp, over.dataset.drop)) toast("Drop it on Looker, BigQuery, an agent or the source systems");
    });
  }
  let suppressClick = false;

  function bqModelName() { return catalog.bq_models.find((m) => m.id === scenario.bq_model)?.name || ""; }
  function clip(s, n) { s = String(s); n = Math.floor(n); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  // ---------------- recommendations
  function renderRecs() {
    const host = $("#recsBody");
    if (!result || !scenario.sources.length) { host.innerHTML = `<p class="empty-note">Add source systems to see recommended GCP-native ingestion patterns.</p>`; return; }
    const p = result.platform;
    const orchTool = p.orchestration.tool === "none" ? "None required" : tool(p.orchestration.tool).name;
    const procReg = p.processing_region && p.processing_region !== scenario.region ? ` (runs in ${esc(regionName(p.processing_region))})` : "";
    let html = `<div class="platform-block"><h3>Platform blueprint</h3><dl>
      <dt>Transformation</dt><dd><a href="${tool("dataform").doc}" target="_blank" rel="noopener">Dataform</a>: ${esc(p.transformation.why)}</dd>
      <dt>Orchestration</dt><dd>${esc(orchTool)}${procReg}: ${esc(p.orchestration.why)}</dd>
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
      const cross = s.region && s.region !== scenario.region
        ? `<li>Processing runs in ${esc(regionName(s.region))} while BigQuery is in ${esc(regionName(scenario.region))}: cross-region transfer is costed; confirm data-residency rules allow it.</li>` : "";
      return `<article class="rec">
        <div class="rec-src"><b>${esc(s.name)}</b><span>${esc(catalog.source_types.find((t) => t.id === s.type)?.name || s.type)}</span>
          <span>${fmtGB(s.initial_volume_gb)} initial, ${fmtGB(s.daily_change_gb)}/day</span>
          <span>Region: ${esc(s.region || scenario.region)}</span>
          <span class="chip ${fc}">${esc(freqName(s.frequency))}</span></div>
        <div class="rec-main">
          <h3>${esc(r.pattern)}</h3>
          <div class="chain">${chain}</div>
          <ul>${r.rationale.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          ${r.alternatives.length ? `<p class="sub">Alternatives</p><ul class="alt">${r.alternatives.map((a) => `<li><b>${esc(tool(a.tool).name)}</b>: ${esc(a.why)}</li>`).join("")}</ul>` : ""}
          ${r.caveats.length || cross ? `<p class="sub">Check during discovery</p><ul class="caveat">${cross}${r.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
          ${s.notes ? `<p class="sub">Notes</p><p>${esc(s.notes)}</p>` : ""}
        </div></article>`;
    }).join("");
    host.innerHTML = html;
  }

  // ---------------- integrations (components)
  const COMP_COST = {
    looker: /Looker licence/, looker_studio_pro: /Looker Studio Pro/, gemini_enterprise: /^Gemini Enterprise$/,
    agent_platform: /Agent Engine|tokens \(agents\)|queries from agents/, vertex_gpu: /Vertex AI endpoint/,
    knowledge_catalog: /Knowledge Catalog/, apigee: /^Apigee/, alloydb: /^AlloyDB$/, cloudsql: /^Cloud SQL$/, spanner: /^Spanner$/,
    bigtable: /^Bigtable$/, firestore: /^Firestore$/, memorystore: /^Memorystore$/,
  };
  function compCost(type) {
    const re = COMP_COST[type];
    if (!re || !result) return null;
    const rows = result.by_service.filter((r) => re.test(r.service));
    return { y1: rows.reduce((a, r) => a + r.year1, 0), y3: rows.reduce((a, r) => a + r.three_year, 0) };
  }

  function renderPlatform() {
    const host = $("#platformBody");
    if (!result) { host.innerHTML = ""; return; }
    const chips = (ids) => ids.map((t) => `<a href="${esc(tool(t).doc)}" target="_blank" rel="noopener" title="${esc(tool(t).summary)}">${esc(tool(t).name)}</a>`).join("");
    const story = result.platform.layer.story;
    const block = (b) => `<section class="story-block ${esc(b.key)}"><h3>${esc(b.title)}</h3><div class="tool-chips">${chips(b.tools)}</div>
      <ul>${b.points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></section>`;
    let html = `<p class="lede">How each tool the customer chose connects to BigQuery. Google Cloud components are costed; partner products are shown with their integration path but not costed. Click a card to configure it, or add tools from the library on the Architecture tab.</p>`;
    const lake = story.find((b) => b.key === "lakehouse");
    if (lake) html += `<div class="story">${block(lake)}</div>`;
    for (const cat of catalog.component_categories) {
      const items = scenario.components.filter((c) => compMeta(c.type).category === cat.id);
      if (!items.length) continue;
      html += `<h3 class="cat-head">${esc(cat.name)}</h3><div class="story">`;
      html += items.map((c) => {
        const m = compMeta(c.type);
        const cost = compCost(c.type);
        let note;
        if (m.vendor === "partner") note = "";
        else if (c.type === "looker" && !c.settings.annual_quote_usd) note = "Licence is quote-based - add the customer's quote to include it.";
        else if (cost && cost.y3 > 0) note = `Estimated ${money(cost.y1)} in year 1, ${money(cost.y3)} over 3 years${c.settings.region ? ` (${esc(c.settings.region)})` : ""}.`;
        else note = "No separate charge; consumption appears under BigQuery.";
        return `<section class="story-block comp ${m.vendor} ${m.category}">
          <div class="comp-head"><h3>${esc(m.name)}</h3><span class="vendor-badge ${m.vendor}">${m.vendor === "google" ? "Google Cloud" : "Partner"}</span></div>
          <p class="comp-method">${esc(m.method)}</p>
          ${m.modes ? `<div class="mode-box"><label>${esc(m.settings.find((f) => f.key === m.modes.key).label)}
            <select data-mode-comp="${esc(c.id)}">${opt(m.settings.find((f) => f.key === m.modes.key).options, c.settings[m.modes.key])}</select></label>
            <p>${esc(m.modes.notes[c.settings[m.modes.key]] || "")}</p></div>` : ""}
          <ol>${m.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
          ${m.notes.length ? `<ul class="comp-notes">${m.notes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
          ${note ? `<p class="story-cost">${note}</p>` : ""}
          <div class="comp-actions"><button type="button" class="btn ghost small" data-comp="${esc(c.id)}">Configure</button>
          <a href="${esc(m.doc)}" target="_blank" rel="noopener">Integration docs</a></div></section>`;
      }).join("");
      html += `</div>`;
    }
    const has = (t) => scenario.components.some((c) => c.type === t);
    const partners = scenario.components.filter((c) => compMeta(c.type).vendor === "partner").map((c) => compMeta(c.type).name);
    const demo = [
      "Walk the architecture from source systems to BigQuery, pointing out CDC (dashed) versus batch flows.",
      "Drag the customer's own tools from the component library onto the diagram and show how each connects to BigQuery.",
    ];
    if (partners.length) demo.push(`Show how ${partners.join(", ")} ${partners.length > 1 ? "connect" : "connects"} to BigQuery through native connectors, under the same IAM, policy tags and masking as Google tools.`);
    if (has("looker")) demo.push("Show Looker's semantic layer giving one set of governed metrics to dashboards, Sheets and Conversational Analytics.");
    if (has("agent_platform")) demo.push("Explain how agents on Agent Platform query BigQuery through MCP tools under the user's own permissions.");
    const geC = scenario.components.find((c) => c.type === "gemini_enterprise");
    if (geC) demo.push(`Close with Gemini Enterprise: employees ask business questions and run Deep Research ${({ bigquery: "grounded in BigQuery", looker: "answered from Looker's governed metrics", both: "over BigQuery and Looker's governed metrics", agents: "through the registered data agents" })[geC.settings.grounding || "bigquery"]}.`);
    const apC = scenario.components.find((c) => c.type === "apigee");
    if (apC) demo.push(`Show Apigee as ${({ integration: "the integration layer that exposes data products as governed APIs", agents: "the AI gateway agents use for models and MCP tools", both: "both the integration layer for data APIs and the AI gateway for agents" })[apC.settings.role || "both"]}; drag it on the canvas to switch roles.`);
    if (has("knowledge_catalog")) demo.push("Show lineage and quality scores in Knowledge Catalog as the trust layer for every consumer.");
    demo.push("Use Workload sizing to price the customer's pipelines, queries and dashboards, then export the proposal.");
    html += `<h3 class="cat-head">Suggested demo storyline</h3><ol class="demo-steps">${demo.map((d) => `<li>${esc(d)}</li>`).join("")}</ol>`;
    host.innerHTML = html;
  }

  // ---------------- cost
  function fx() { return (result || wlResult)?.fx?.[currency] || 1; }
  const GROUP_COLORS = {
    "Data ingestion & CDC": "#F9AB00", "BigQuery": "#1A73E8", "Analytics & AI": "#9334E6", "APIs & databases": "#E52592",
    "Governance & security": "#12A4AF", "Platform & network": "#34A853", "Contingency": "#9AA0A6",
  };
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

  function regionTable(rows) {
    if (!rows || rows.length < 1) return "";
    return `<h3>By region</h3><div style="overflow-x:auto"><table><thead><tr><th>Region</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
      + rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${money(r.year1)}</td><td>${money(r.three_year)}</td></tr>`).join("")
      + `</tbody></table></div>`;
  }

  function renderCost() {
    const host = $("#costBody");
    if (bomEnv && bomEnv !== "all" && !(result?.environments || []).some((e) => e.id === bomEnv)) bomEnv = null;
    if (!result || !scenario.sources.length) { host.innerHTML = `<p class="empty-note">The estimate appears once at least one source system is added. For a workload-based estimate without sources, use Workload sizing.</p>`; return; }
    const t = result.totals;
    let html = `<div class="horizon">
      <div class="card"><h3>1-year consumption</h3><div class="big">${money(t.year1_payg)}</div>
        <div class="row"><span>With 1-year commitments</span><span>${money(t.year1_cud1)}</span></div>
        <div class="row"><span>Commitment saving</span><span>${money(t.year1_payg - t.year1_cud1)}</span></div>
        <div class="range">Discussion range ${money(t.range_low_1y)} to ${money(t.range_high_1y)}</div></div>
      <div class="card"><h3>3-year consumption</h3><div class="big">${money(t.three_year_payg)}</div>
        <div class="row"><span>With 3-year commitments</span><span>${money(t.three_year_cud3)}</span></div>
        <div class="row"><span>Year 1 / 2 / 3</span><span>${moneyShort(t.year1_payg)} / ${moneyShort(t.year2_payg)} / ${moneyShort(t.year3_payg)}</span></div>
        <div class="range">Discussion range ${money(t.range_low_3y)} to ${money(t.range_high_3y)}</div></div>
    </div>`;
    html += `<h3>By capability</h3><div class="groups">${result.by_group.filter((g) => g.three_year > 0).map((g) =>
      `<div><span>${esc(g.group)}</span><b>${money(g.year1)}</b><span>year 1 · ${money(g.three_year)} over 3 years</span></div>`).join("")}</div>`;
    const envs = result.environments || [];
    if (envs.length > 1) {
      const maxE = Math.max(...envs.map((e) => e.three_year), 1);
      html += `<h3>By environment</h3><div style="overflow-x:auto"><table class="env-table"><thead><tr><th>Environment</th><th>Sizing vs ${esc(envs[0].name)}</th><th>Per month (yr 1)</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
        + envs.map((e, i) => `<tr><td><span class="env-dot e${Math.min(i, 5)}"></span>${esc(e.name)}<span class="share" style="width:${Math.max(2, 60 * e.three_year / maxE)}px"></span></td>
          <td class="env-f">${i === 0 ? "Baseline" : catalog.environment_factors.map((f) => `${esc(f.name.replace(" %", ""))} ${+e.factors[f.id]}%`).join(" · ") + (e.bq_slots != null && scenario.bq_model !== "ondemand" ? ` · ${e.bq_slots} slots` : "")}</td>
          <td>${money(e.monthly_year1)}</td><td>${money(e.year1)}</td><td>${money(e.three_year)}</td></tr>`).join("")
        + `</tbody></table></div><p class="hint">Change the number of environments and their sizing in the sidebar (Environments → Size).</p>`;
    }
    html += `<h3>Monthly run-rate over 36 months</h3><div class="chart-key"><span><i></i>Pay-as-you-go</span><span><i class="cud"></i>With 3-year commitments</span></div>
      <div class="chart-wrap">${chartSvg(result.monthly)}</div>`;
    html += bomSection();
    const maxSvc = Math.max(...result.by_service.map((s) => s.three_year), 1);
    html += `<h3>By service</h3><p class="hint">Untick a service to leave it out of every total, the roadmap and workload sizing; tick it again to bring it back.</p>
      <div style="overflow-x:auto"><table class="svc-table"><thead><tr><th>Service</th><th>Year 1</th><th>Year 1 (1-yr CUD)</th><th>3 years</th><th>3 years (3-yr CUD)</th></tr></thead><tbody>`
      + result.by_service.map((s) => `<tr><td><label class="svc-toggle"><input type="checkbox" data-svc="${esc(s.service)}" checked aria-label="Include ${esc(s.service)} in pricing"> ${esc(s.service)}</label><span class="share" style="width:${Math.max(2, 60 * s.three_year / maxSvc)}px"></span></td><td>${money(s.year1)}</td><td>${money(s.year1_cud)}</td><td>${money(s.three_year)}</td><td>${money(s.three_year_cud)}</td></tr>`).join("")
      + scenario.excluded_services.map((svc) => `<tr class="svc-off"><td><label class="svc-toggle"><input type="checkbox" data-svc="${esc(svc)}" aria-label="Include ${esc(svc)} in pricing"> ${esc(svc)}</label></td><td colspan="4">Not priced</td></tr>`).join("")
      + `</tbody><tfoot><tr><td>Total</td><td>${money(t.year1_payg)}</td><td>${money(t.year1_cud1)}</td><td>${money(t.three_year_payg)}</td><td>${money(t.three_year_cud3)}</td></tr></tfoot></table></div>`;
    html += regionTable(result.by_region);
    html += `<h3>By source system</h3><div style="overflow-x:auto"><table><thead><tr><th>Source</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
      + result.by_source.map((s) => `<tr><td>${esc(s.name)}</td><td>${money(s.year1)}</td><td>${money(s.three_year)}</td></tr>`).join("")
      + `</tbody></table></div>`;
    const partners = scenario.components.filter((c) => compMeta(c.type).vendor === "partner").map((c) => compMeta(c.type).name);
    if (partners.length) html += `<p class="hint">Not costed (partner products): ${esc(partners.join(", "))}.</p>`;
    const unpriced = scenario.components.filter((c) => c.included === false).map((c) => compMeta(c.type).name);
    if (unpriced.length) html += `<p class="hint">Left out of pricing by choice: ${esc(unpriced.join(", "))}.</p>`;
    html += `<p class="disclaimer">${esc(result.disclaimer)}${currency !== "USD" ? ` Converted from USD at ${fx()} ${currency}/USD.` : ""}</p>`;
    host.innerHTML = html;
  }

  let bomEnv = null;   // null = primary environment
  const fmtQty = (q) => q == null ? "-" : q >= 1e6 ? (q / 1e6).toFixed(2) + "M" : q >= 1e4 ? Math.round(q).toLocaleString() : (+q.toPrecision(4)).toLocaleString();
  function unitPrice(p) {
    if (p == null) return "-";
    const v = p * fx();
    const d = v >= 100 ? 0 : v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
    return money(p, d);
  }
  function bomRows() {
    if (!bomEnv) bomEnv = result?.environments?.[0]?.id || "all";
    return (result?.bom || []).filter((b) => bomEnv === "all" || b.environment === bomEnv);
  }
  function bomSection() {
    const envs = result.environments || [];
    const rows = bomRows();
    const multi = envs.length > 1;
    let html = `<h3>Bill of materials</h3><p class="hint">Every priced product with its quantity, effective unit price, cost and why it is needed. Quantities are for month 12 (run-rate) and year 1; unit price is the blended year-1 price including regional uplift and tiers.</p>`;
    if (multi) html += `<div class="bom-filter" role="group" aria-label="Environment">${[{ id: "all", name: "All environments" }, ...envs].map((e) =>
      `<button type="button" class="chip-btn${bomEnv === e.id ? " on" : ""}" data-bom-env="${esc(e.id)}">${esc(e.name)}</button>`).join("")}</div>`;
    let lastGroup = null, lastEnv = null;
    const body = rows.map((b) => {
      let head = "";
      if (multi && bomEnv === "all" && b.environment !== lastEnv) { head += `<tr class="bom-env"><th colspan="8">${esc(b.environment_name)}</th></tr>`; lastGroup = null; }
      if (b.group !== lastGroup) head += `<tr class="bom-group"><th colspan="8"><i style="background:${GROUP_COLORS[b.group] || "#9AA0A6"}"></i>${esc(b.group)}</th></tr>`;
      lastGroup = b.group; lastEnv = b.environment;
      return head + `<tr><td class="bom-prod"><b>${esc(b.service)}</b><span>${esc(b.why)}</span></td>
        <td>${fmtQty(b.qty_month12)}</td><td>${fmtQty(b.qty_year1)}</td><td class="bom-unit">${esc(b.unit || "-")}</td><td>${unitPrice(b.unit_price)}</td>
        <td>${money(b.month12)}</td><td>${money(b.year1)}</td><td>${money(b.three_year)}</td></tr>`;
    }).join("");
    const sum = (k) => rows.reduce((a, b) => a + b[k], 0);
    html += `<div style="overflow-x:auto"><table class="bom-table"><thead><tr><th>Product &amp; why it is needed</th><th>Qty / month (M12)</th><th>Qty, year 1</th><th>Unit</th><th>Unit price</th><th>Month 12</th><th>Year 1</th><th>3 years</th></tr></thead>
      <tbody>${body}</tbody><tfoot><tr><td>Total${bomEnv !== "all" ? " - " + esc(envs.find((e) => e.id === bomEnv)?.name || "") : ""}</td><td></td><td></td><td></td><td></td><td>${money(sum("month12"))}</td><td>${money(sum("year1"))}</td><td>${money(sum("three_year"))}</td></tr></tfoot></table></div>`;
    return html;
  }

  function chartSvg(monthly, marker) {
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

  // ---------------- workload sizing
  const QUERY_ROWS = [["simple", "Simple queries"], ["complex", "Complex queries"], ["heavy", "Heavy / periodic queries"], ["adhoc", "Ad-hoc reports"]];

  function wlGet(path) { return path.split(".").reduce((o, k) => (o == null ? o : o[k]), scenario.workload); }
  function wlSet(path, v) {
    const ks = path.split(".");
    let o = scenario.workload;
    ks.slice(0, -1).forEach((k) => (o = o[k] = o[k] || {}));
    o[ks[ks.length - 1]] = v;
  }

  function renderWorkloadForm() {
    const host = $("#workloadBody");
    if (!catalog || !scenario.workload) return;
    const n = (path, label, step = 1, attrs = "") => `<label>${esc(label)}<input type="number" min="0" step="${step}" data-w="${path}" value="${esc(wlGet(path))}" ${attrs}></label>`;
    const sel = (path, label, options) => `<label>${esc(label)}<select data-w="${path}">${opt(options, wlGet(path) ?? "")}</select></label>`;
    const chk = (path, label) => `<label class="toggle"><input type="checkbox" data-w="${path}" ${wlGet(path) ? "checked" : ""}> ${esc(label)}</label>`;
    const wu = scenario.workload_units || (scenario.workload_units = {});
    const unitSel = (path, base) => {
      const u = wu[path] || base;
      return `<select data-wunit="${path}" data-base="${base}" aria-label="Unit">${catalog.volume_units.map((x) => `<option${x.id === u ? " selected" : ""}>${x.id}</option>`).join("")}</select>`;
    };
    const volIn = (path, base, label) => {
      const u = wu[path] || base;
      return `<span class="vol"><input type="number" min="0" step="any" data-w="${path}" data-base="${base}" data-unit="${u}" value="${esc(+((Number(wlGet(path)) || 0) * unitGb(base) / unitGb(u)).toPrecision(6))}"${label ? ` aria-label="${esc(label)}"` : ""}>${unitSel(path, base)}</span>`;
    };
    const vol = (path, label, base) => `<label>${esc(label)}${volIn(path, base)}</label>`;
    const regSel = (path, label) => `<label>${esc(label)}<select data-w="${path}">${regionOptions("Same as BigQuery region (" + scenario.region + ")")}</select></label>`;
    const freqs = catalog.query_frequencies;
    host.innerHTML = `
      <p class="lede">Size consumption from what the customer will run, independent of the source-by-source design. Values below are the example you described; change any of them.</p>
      <div class="wl-layout">
        <form class="wl-form" id="wlForm" onsubmit="return false">
          <fieldset><legend>Data estate (steady state)</legend><div class="grid3">
            ${vol("data.structured_tb", "Structured data", "TB")}${vol("data.semi_structured_tb", "Semi-structured data", "TB")}${vol("data.unstructured_tb", "Unstructured data", "TB")}
            ${n("data.annual_growth_pct", "Annual growth %", 5)}${n("data.tables", "Number of tables", 50)}
          </div></fieldset>
          <fieldset><legend>Telemetry / streaming</legend><div class="grid3">
            ${vol("telemetry.volume_gb", "Telemetry volume", "GB")}
            ${sel("telemetry.per", "Per", [{ id: "day", name: "Per day" }, { id: "month", name: "Per month" }])}
            ${n("telemetry.retention_months", "Retention (months)", 1)}
            <div class="span3">${chk("telemetry.transform", "Transform in flight (Dataflow streaming)")}</div>
          </div></fieldset>
          <fieldset><legend>Pipelines</legend><div class="grid3">
            ${n("pipelines.simple", "Simple pipelines", 5)}${n("pipelines.medium", "Medium pipelines", 5)}${n("pipelines.complex", "Complex pipelines", 5)}
            ${n("pipelines.runs_per_day", "Runs per day (each)", 1)}
            ${sel("pipelines.engine", "Pipeline engine", [{ id: "elt", name: "ELT in BigQuery (Dataform)" }, { id: "etl", name: "ETL on Dataflow" }])}
          </div></fieldset>
          <fieldset><legend>Queries &amp; reports</legend>
            <div class="qtable" role="table">
              <div class="qrow qhead" role="row"><span>Workload</span><span>Count</span><span>Runs</span><span>Scanned / run</span></div>
              ${QUERY_ROWS.map(([k, label]) => `<div class="qrow" role="row"><span>${esc(label)}</span>
                <input type="number" min="0" step="1" data-w="queries.${k}.count" value="${esc(wlGet(`queries.${k}.count`))}" aria-label="${esc(label)} count">
                <select data-w="queries.${k}.frequency" aria-label="${esc(label)} frequency">${opt(freqs, wlGet(`queries.${k}.frequency`))}</select>
                ${volIn(`queries.${k}.gb`, "GB", `${label} data scanned`)}</div>`).join("")}
            </div>
          </fieldset>
          <fieldset><legend>Dashboards</legend><div class="grid3">
            ${n("dashboards.count", "Dashboards", 1)}${n("dashboards.refreshes_per_day", "Refreshes per day", 1)}${n("dashboards.queries_per_refresh", "Queries per refresh", 1)}
            ${vol("dashboards.gb_per_query", "Scanned per query", "GB")}${n("dashboards.cache_pct", "Served from cache / BI Engine %", 5)}
          </div></fieldset>
          <fieldset><legend>Ramp-up phase</legend><div class="grid3">
            ${n("ramp.months", "Months", 1)}${vol("ramp.data_gb", "Total data during ramp", "GB")}
            ${n("ramp.pipelines", "Pipelines during ramp", 1)}${n("ramp.reports", "Reports / dashboards during ramp", 1)}
          </div></fieldset>
          <fieldset><legend>BigQuery slot sizing</legend><div class="grid3">
            ${n("slots.batch_window_hours", "Batch window (hours)", 1)}${n("slots.business_hours", "Business hours / day", 1)}${n("slots.peak_concurrency", "Peak hour vs average (x)", 0.1)}
            ${n("slots.heavy_target_minutes", "Heavy query target (minutes)", 5)}
            ${sel("slots.edition", "Edition", [{ id: "auto", name: "Recommend for me" }, { id: "standard", name: "Standard" }, { id: "enterprise", name: "Enterprise" }, { id: "enterprise_plus", name: "Enterprise Plus" }])}
          </div></fieldset>
          <fieldset><legend>Regions &amp; pricing</legend><div class="grid3">
            ${regSel("data_region", "Data & queries")}${regSel("pipelines_region", "Pipelines & orchestration")}${regSel("streaming_region", "Streaming")}
            ${sel("bq_model", "BigQuery compute", catalog.bq_models)}
            <span data-show-editions>${n("slot_hours_per_tib", "Slot-hours per TiB scanned", 5)}</span>
            ${n("contingency_pct", "Contingency %", 5)}
            <div class="span3">${chk("include_components", "Include the analytics, AI & governance components from the Architecture tab")}</div>
          </div></fieldset>
          <button type="button" class="btn ghost small" id="wlReset">Reset to example values</button>
        </form>
        <div class="wl-results" id="wlResults" aria-live="polite"></div>
      </div>`;
    ["data_region", "pipelines_region", "streaming_region"].forEach((k) => { const el = $(`[data-w="${k}"]`, host); if (el) el.value = wlGet(k) || ""; });
    toggleEditionsField();
    renderWorkloadResults();
  }

  function toggleEditionsField() {
    const el = $("[data-show-editions]");
    if (el) el.hidden = scenario.workload.bq_model === "ondemand";
  }

  function onWorkloadInput(e) {
    const us = e.target.closest("[data-wunit]");
    if (us) {
      if (e.type !== "change") return;
      const path = us.dataset.wunit;
      scenario.workload_units[path] = us.value;
      const inp = us.parentElement.querySelector("input");
      inp.dataset.unit = us.value;
      inp.value = +((Number(wlGet(path)) || 0) * unitGb(us.dataset.base) / unitGb(us.value)).toPrecision(6);
      save();
      return;
    }
    const el = e.target.closest("[data-w]");
    if (!el) return;
    let v;
    if (el.type === "checkbox") v = el.checked;
    else if (el.type === "number") {
      v = el.value === "" ? 0 : Math.max(0, Number(el.value));
      if (el.dataset.base) v = v * unitGb(el.dataset.unit || el.dataset.base) / unitGb(el.dataset.base);
    } else v = el.value || null;
    wlSet(el.dataset.w, v);
    if (el.dataset.w === "bq_model") toggleEditionsField();
    save();
    clearTimeout(wlTimer);
    wlTimer = setTimeout(runWorkload, 250);
  }

  function renderWorkloadResults() {
    const host = $("#wlResults");
    if (!host) return;
    if (!wlResult) { host.innerHTML = `<p class="hint">Calculating…</p>`; return; }
    const r = wlResult, t = r.totals;
    const rampN = r.ramp_months;
    let html = `<div class="wl-kpis">
      ${rampN ? `<div><span>Ramp-up, months 1-${rampN}</span><b>${money(t.ramp_monthly)}</b><span>per month</span></div>` : ""}
      <div><span>Steady state, month ${rampN + 1}</span><b>${money(t.steady_monthly)}</b><span>per month</span></div>
      <div><span>1 year</span><b>${money(t.year1_payg)}</b><span>${money(t.year1_cud1)} with commitments</span></div>
      <div><span>3 years</span><b>${money(t.three_year_payg)}</b><span>${money(t.three_year_cud3)} with commitments</span></div>
    </div>`;
    html += `<h3>By category</h3><div style="overflow-x:auto"><table><thead><tr><th>Category</th><th>Steady month</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
      + r.by_category.map((c) => `<tr><td>${esc(c.category)}</td><td>${money(c.steady_month)}</td><td>${money(c.year1)}</td><td>${money(c.three_year)}</td></tr>`).join("")
      + `</tbody><tfoot><tr><td>Total</td><td>${money(t.steady_monthly)}</td><td>${money(t.year1_payg)}</td><td>${money(t.three_year_payg)}</td></tr></tfoot></table></div>`;
    html += `<h3>Monthly consumption</h3><div class="chart-key"><span><i></i>Pay-as-you-go</span><span><i class="cud"></i>With 3-year commitments</span></div>
      <div class="chart-wrap">${chartSvg(r.monthly, rampN ? rampN + 1 : 0)}</div>`;
    html += `<h3>Compute model comparison</h3><p class="hint">For the ${r.scan_tib_steady_month.toLocaleString()} TiB scanned in the first steady-state month. Editions assume ${r.assumptions.slot_hours_per_tib} slot-hours per TiB - measure with INFORMATION_SCHEMA.JOBS once workloads run.</p>
      <div style="overflow-x:auto"><table><thead><tr><th>Model</th><th>Per month</th><th>1-yr commit</th><th>3-yr commit</th></tr></thead><tbody>`
      + r.compute_comparison.map((c) => `<tr><td>${esc(c.model)}</td><td>${money(c.monthly)}</td><td>${c.commit1 == null ? "-" : money(c.commit1)}</td><td>${c.commit3 == null ? "-" : money(c.commit3)}</td></tr>`).join("")
      + `</tbody></table></div>`;
    html += slotSection(r.slots);
    if ((r.environments || []).length > 1) {
      html += `<h3>By environment</h3><div style="overflow-x:auto"><table><thead><tr><th>Environment</th><th>Per month (yr 1)</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
        + r.environments.map((e, i) => `<tr><td><span class="env-dot e${Math.min(i, 5)}"></span>${esc(e.name)}</td><td>${money(e.monthly_year1)}</td><td>${money(e.year1)}</td><td>${money(e.three_year)}</td></tr>`).join("")
        + `</tbody></table></div>`;
    }
    html += `<h3>Line items</h3><div style="overflow-x:auto"><table><thead><tr><th>Workload</th><th>Service</th><th>Steady month</th><th>Year 1</th><th>3 years</th></tr></thead><tbody>`
      + r.lines.filter((l) => l.three_year > 0).map((l) => `<tr><td>${esc(l.item)}</td><td>${esc(l.service)}</td><td>${money(l.steady_month)}</td><td>${money(l.year1)}</td><td>${money(l.three_year)}</td></tr>`).join("")
      + `</tbody></table></div>`;
    html += regionTable(r.by_region);
    html += `<p class="disclaimer">${esc(r.disclaimer)}</p>`;
    host.innerHTML = html;
  }

  const EDITION_NAME = { standard: "Standard", enterprise: "Enterprise", enterprise_plus: "Enterprise Plus" };
  function effectiveSlots(sl) {
    return Math.max(sl.baseline_slots, Math.ceil(((sl.baseline_slots * 730 + sl.costs.autoscale_slot_hours_month) / 730) / 50) * 50, 50);
  }
  function slotSection(sl) {
    if (!sl) return "";
    const c = sl.costs;
    let html = `<h3 id="slotHead">BigQuery slot sizing &amp; recommendation</h3>
      <p class="hint">Sized from the data volume, job types and frequencies above at ${sl.slot_hours_per_tib} slot-hours per TiB scanned: pipelines and heavy jobs in a ${sl.inputs.batch_window_hours}-hour batch window, dashboards and queries over ${sl.inputs.business_hours} business hours.</p>
      <div class="wl-kpis slot-kpis">
        <div><span>Average demand</span><b>${sl.avg_slots.toLocaleString()} slots</b><span>over the month</span></div>
        <div><span>Peak hour</span><b>${Math.round(sl.peak_slots).toLocaleString()} slots</b><span>${sl.heavy_burst_slots > sl.peak_slots ? `heavy query burst ${Math.round(sl.heavy_burst_slots)}` : "busiest hour"}</span></div>
        <div><span>Reservation</span><b>${sl.baseline_slots} → ${sl.max_slots}</b><span>baseline → max autoscale</span></div>
        <div><span>Recommended</span><b>${sl.model === "editions" ? esc(EDITION_NAME[sl.edition]) : "On-demand"}</b><span>${sl.model === "editions" ? money(c.recommended_month) + "/month" : money(c.ondemand_month) + "/month"}</span></div>
      </div>
      <div class="slot-grid"><div><div class="chart-wrap">${slotProfileSvg(sl)}</div><p class="hint">Average slot demand by hour of day (busiest-hour factor applied in business hours); dashed line = recommended baseline.</p></div>
      <div><ul class="slot-recs">${sl.recommendations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <p class="sub">Edition</p><ul class="slot-recs reasons">${sl.edition_reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <button type="button" class="btn primary small" id="slotApply">Use in the consumption estimate</button></div></div>`;
    html += `<div style="overflow-x:auto"><table><thead><tr><th>Job type</th><th>TiB / month</th><th>Slot-hours / month</th><th>Avg slots</th></tr></thead><tbody>`
      + sl.by_class.map((b) => `<tr><td>${esc(b.class)}</td><td>${b.tib_month.toLocaleString()}</td><td>${b.slot_hours_month.toLocaleString()}</td><td>${b.avg_slots}</td></tr>`).join("")
      + `</tbody></table></div>`;
    html += `<div style="overflow-x:auto"><table><thead><tr><th>Pricing option (per month)</th><th>Cost</th></tr></thead><tbody>
      <tr><td>On-demand (per TiB scanned)</td><td>${money(c.ondemand_month)}</td></tr>
      <tr><td>${esc(EDITION_NAME[sl.edition])} - autoscaling only (pay as you go)</td><td>${money(c.autoscale_only_month)}</td></tr>
      ${sl.edition !== "standard" ? `<tr><td>${esc(EDITION_NAME[sl.edition])} - ${sl.baseline_slots} baseline slots on 1-year commitment + autoscaling</td><td>${money(c.recommended_month)}</td></tr>
      <tr><td>${esc(EDITION_NAME[sl.edition])} - same on 3-year commitment</td><td>${money(c.recommended_month_3yr)}</td></tr>` : ""}</tbody></table></div>`;
    if (sl.by_environment.length > 1) html += `<div style="overflow-x:auto"><table><thead><tr><th>Environment</th><th>Baseline slots</th><th>Max slots</th></tr></thead><tbody>`
      + sl.by_environment.map((e) => `<tr><td>${esc(e.name)}</td><td>${e.baseline_slots}</td><td>${e.max_slots}</td></tr>`).join("") + `</tbody></table></div>`;
    return html;
  }
  function slotProfileSvg(sl) {
    const W = 520, H = 180, L = 40, R = 8, T = 10, B = 24;
    const max = Math.max(...sl.profile, sl.baseline_slots, 1) * 1.1;
    const bw = (W - L - R) / 24;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    let g = "";
    for (let k = 0; k <= 3; k++) { const v = (max / 3) * k; g += `<line class="chart-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`; }
    sl.profile.forEach((v, h) => {
      g += `<rect class="slot-bar" x="${L + h * bw + 2}" y="${y(v)}" width="${bw - 4}" height="${Math.max(0, y(0) - y(v))}"><title>${String(h).padStart(2, "0")}:00 - ${v} slots</title></rect>`;
      if (h % 3 === 0) g += `<text class="chart-axis" x="${L + h * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${String(h).padStart(2, "0")}h</text>`;
    });
    if (sl.baseline_slots) g += `<line class="chart-marker" x1="${L}" x2="${W - R}" y1="${y(sl.baseline_slots)}" y2="${y(sl.baseline_slots)}"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Slot demand by hour">${g}</svg>`;
  }

  // ---------------- roadmap: final architecture + month-by-month ramp-up
  function renderRoadmap() {
    const host = $("#roadmapBody");
    if (!host) return;
    if (!planResult || !result || !scenario.sources.length) { host.innerHTML = `<p class="empty-note">Add source systems to generate the ramp-up roadmap.</p>`; return; }
    const p = planResult, t = p.totals;
    const teamsOpt = [1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}"${n === p.teams ? " selected" : ""}>${n} squad${n > 1 ? "s" : ""}</option>`).join("");
    const allLive = Math.max(...p.waves.map((w) => w.go_live_month), 1);
    let html = `<div class="rm-controls"><label>Delivery capacity<select id="rmTeams">${teamsOpt}</select></label>
      <p class="hint">Sources are built by parallel squads, quick wins first; each service starts consuming in the month it goes live.</p></div>`;
    html += `<div class="rm-kpis">
      <div><span>Programme length</span><b>${p.horizon} months</b><span>all sources live by month ${allLive}</span></div>
      <div><span>Year 1 with ramp-up</span><b>${money(t.ramped_year1)}</b><span>vs ${money(t.steady_year1)} if everything ran from month 1</span></div>
      <div><span>3 years with ramp-up</span><b>${money(t.ramped_three_year)}</b><span>${money(t.ramped_three_year_cud3)} with 3-yr commitments</span></div>
      <div><span>Steady-state run-rate</span><b>${money(p.months[p.months.length - 1].total)}</b><span>per month from month ${p.horizon}</span></div>
    </div>`;

    // final architecture
    const arch = $("#archSvg");
    html += `<h3>Final target architecture</h3><div class="rm-arch"><div class="diagram-wrap">${arch ? arch.outerHTML.replace('id="archSvg"', 'id="archSvgRoadmap"') : ""}</div></div>`;
    const ingTools = [...new Set(result.recommendations.flatMap((r) => r.chain.map((x) => tool(x).name)))];
    const byCat = (cat) => scenario.components.filter((c) => compMeta(c.type).category === cat).map((c) => compMeta(c.type).name + (compMeta(c.type).vendor === "partner" ? " (partner)" : ""));
    const consumers = [...byCat("bi"), ...byCat("ai"), ...byCat("integration"), ...byCat("database")];
    const govList = [...byCat("governance"), ...byCat("security")];
    const orch = result.platform.orchestration.tool;
    const layer = (cls, title, items) => `<div class="rm-layer ${cls}"><h4>${esc(title)}</h4><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("") || "<li>None selected</li>"}</ul></div>`;
    html += `<div class="rm-layers">
      ${layer("l-src", `Sources in this phase (${result.recommendations.length})`, scenario.sources.filter((s) => s.included !== false).map((s) => s.name))}
      ${layer("l-ing", "Ingestion & CDC", ingTools)}
      ${layer("l-bq", "BigQuery platform", [`BigQuery in ${regionName(scenario.region)}`, bqModelName(), "Dataform ELT", orch !== "none" ? tool(orch).name : null, "BigQuery ML & AI functions"].filter(Boolean))}
      ${layer("l-use", "BI, AI, APIs & databases", consumers)}
      ${layer("l-gov", "Governance & security", govList)}
    </div>`;

    // gantt
    html += `<h3>Ramp-up plan</h3><div class="gantt-wrap">${ganttSvg(p)}</div>`;

    // month-by-month cost
    html += `<h3>Consumption month by month</h3><div class="stack-legend">${p.group_order.filter((g) => p.months.some((m) => m.by_group[g])).map((g) => `<span><i style="background:${GROUP_COLORS[g]}"></i>${esc(g)}</span>`).join("")}<span><i style="background:none;border-top:2px dashed var(--ink-2);height:0;border-radius:0"></i>Steady state (no ramp)</span></div>
      <div class="chart-wrap">${rampChart(p)}</div>`;
    let cum = 0;
    html += `<div style="overflow-x:auto"><table class="rm-table"><thead><tr><th>Month</th><th style="text-align:left">Goes live this month</th><th>Ramped cost</th><th>Steady state</th><th>Cumulative</th></tr></thead><tbody>`
      + p.months.map((m) => {
        cum += m.total;
        const ms = p.milestones.filter((x) => x.month === m.month).map((x) => x.name);
        const live = [...ms, ...m.sources_live, ...m.components_started].join(" · ") || "-";
        return `<tr><td>M${m.month}</td><td class="live">${esc(live)}</td><td>${money(m.total)}</td><td>${money(m.steady)}</td><td>${money(cum)}</td></tr>`;
      }).join("") + `</tbody></table></div>`;
    html += `<p class="disclaimer">Plan assumes ${p.assumptions.foundation_weeks} weeks of foundation and build effort per pattern (e.g. ${p.assumptions.effort_weeks.dts_free} weeks for a Data Transfer Service source, ${p.assumptions.effort_weeks.datastream} for Datastream CDC, ${p.assumptions.effort_weeks.dts_migration} for a warehouse migration), plus extra time for heavy transforms and loads over 100 TB. Adjust squads to see the effect on timeline and cost.</p>`;
    host.innerHTML = html;
  }

  function ganttSvg(p) {
    const rows = p.phases;
    const L = 250, R = 16, T = 30, rowH = 26, W = 1000;
    const H = T + rows.length * rowH + 30;
    const mw = (W - L - R) / p.horizon;
    const x = (m) => L + (m - 1) * mw;
    let g = "";
    for (let m = 1; m <= p.horizon; m++) {
      g += `<text class="gt-month" x="${x(m) + mw / 2}" y="18" text-anchor="middle">M${m}</text>`;
      g += `<line class="gt-grid" x1="${x(m)}" x2="${x(m)}" y1="${T - 6}" y2="${H - 24}"/>`;
    }
    rows.forEach((r, i) => {
      const y = T + i * rowH;
      const cls = `gt-bar ${r.key} ${r.category || ""} ${r.vendor || ""}`;
      g += `<text class="gt-label" x="10" y="${y + 16}">${esc(clip(r.name, 34))}</text>`;
      g += `<rect class="${cls}" x="${x(r.start) + 2}" y="${y + 5}" width="${Math.max(8, (r.end - r.start + 1) * mw - 4)}" height="${rowH - 10}" rx="5"><title>${esc(r.name)}: M${r.start}-M${r.end}. ${esc(r.items.join("; "))}</title></rect>`;
    });
    const my = H - 14;
    const seen = {};
    p.milestones.forEach((ms) => {
      const cx = x(ms.month) + mw / 2;
      const k = seen[ms.month] = (seen[ms.month] || 0) + 1;
      if (k === 1) g += `<path class="gt-ms" d="M${cx},${my - 6} L${cx + 6},${my} L${cx},${my + 6} L${cx - 6},${my}Z"><title>${esc(p.milestones.filter((z) => z.month === ms.month).map((z) => z.name).join(", "))}</title></path>`;
    });
    g += `<text class="gt-ms-label" x="10" y="${my + 4}">Milestones</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ramp-up plan by month">${g}</svg>`;
  }

  function rampChart(p) {
    const W = 900, H = 260, L = 64, R = 12, T = 12, B = 30;
    const months = p.months;
    const max = Math.max(...months.map((m) => Math.max(m.total, m.steady)), 1) * 1.08;
    const bw = (W - L - R) / months.length;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    let g = "";
    for (let k = 0; k <= 4; k++) {
      const v = (max / 4) * k;
      g += `<line class="chart-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="chart-axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${esc(moneyShort(v))}</text>`;
    }
    months.forEach((m, i) => {
      let acc = 0;
      const x0 = L + i * bw + bw * 0.18, w = bw * 0.64;
      p.group_order.forEach((grp) => {
        const v = m.by_group[grp] || 0;
        if (!v) return;
        g += `<rect x="${x0}" y="${y(acc + v)}" width="${w}" height="${Math.max(0, y(acc) - y(acc + v))}" fill="${GROUP_COLORS[grp]}"><title>M${m.month} ${esc(grp)}: ${esc(money(v))}</title></rect>`;
        acc += v;
      });
      g += `<text class="chart-axis" x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">M${m.month}</text>`;
    });
    const line = months.map((m, i) => `${i ? "L" : "M"}${(L + i * bw + bw / 2).toFixed(1)},${y(m.steady).toFixed(1)}`).join(" ");
    g += `<path d="${line}" fill="none" stroke="var(--ink-2)" stroke-width="2" stroke-dasharray="5 4"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly consumption during ramp-up">${g}</svg>`;
  }

  // ---------------- assumptions
  function renderAssumptions() {
    const host = $("#assumeBody");
    if (!result) { host.innerHTML = ""; return; }
    const a = result.assumptions;
    const pct = (v) => Math.round(v * 100) + "%";
    const rows = [
      ["BigQuery region price uplift vs us-central1", `x${result.region.uplift.toFixed(2)} (${esc(result.region.name)}); each source and component is priced in its own region`],
      ["Cross-region data transfer", "Charged when a source or streaming workload runs in a different region from BigQuery (~$0.02/GiB within a continent, ~$0.08/GiB between continents)"],
      ["Batch throughput per vCPU-hour", `${a.batch_gb_per_vcpu_hr.none} GB (no transform), ${a.batch_gb_per_vcpu_hr.light} GB (light), ${a.batch_gb_per_vcpu_hr.heavy} GB (heavy)`],
      ["Minimum per batch run", `${a.batch_min_vcpu_hr_per_run} vCPU-hour (Dataflow), ${a.datafusion_min_vcpu_hr_per_run} vCPU-hours (Data Fusion cluster), ${a.spark_min_dcu_hr_per_run} DCU-hours (Spark)`],
      ["Streaming capacity per vCPU", `${a.stream_gb_per_vcpu_day.none} / ${a.stream_gb_per_vcpu_day.light} / ${a.stream_gb_per_vcpu_day.heavy} GB per day (none / light / heavy); minimum ${a.stream_min_vcpu} vCPUs per job, always on`],
      ["Storage growth from change data", `${pct(a.net_new_ratio.cdc)} of CDC volume is net-new rows; ${pct(a.net_new_ratio.append)} for append-only sources`],
      ["Curated layers overhead", `+${pct(a.curated_layers_overhead)} storage for curated / mart tables`],
      ["Long-term storage", `${pct(a.longterm_share_after_90d)} of data older than 90 days is billed as long-term`],
      ["ELT query volume", `${a.elt_scan_multiplier}x the data ingested each month`],
      ["Analytics query volume (auto)", `${a.auto_analytics_scan_multiplier}x stored data per month when not specified`],
      ["Partner products", "Power BI, Tableau, MicroStrategy, Qlik, ThoughtSpot, DataRobot, Dataiku, SageMaker, Azure ML, Databricks, Collibra, Alation, Atlan, Informatica are drawn and explained but never costed"],
      ["Contingency & operations", `${scenario.contingency_pct}% (monitoring, logging, dev/test, unknowns)`],
      ["Commitment discounts", "Applied to BigQuery editions slots, Dataflow streaming, Composer, Agent Engine and Knowledge Catalog premium processing"],
    ];
    host.innerHTML = `<div class="assume"><h3>Sizing assumptions</h3><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>
      <h3>Price sources</h3><p>${esc(result.pricing_meta.note)} Last reviewed ${esc(result.pricing_meta.last_reviewed)}.</p>
      <ul>${result.pricing_meta.sources.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace("https://cloud.google.com/", ""))}</a></li>`).join("")}</ul>
      <p class="disclaimer">${esc(result.disclaimer)}</p></div>`;
  }

  // ------------------------------------------------------------------ exports
  const NO_DOWNLOAD = !!window.ADVISOR_NO_DOWNLOAD;

  function download(name, mime, text) {
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
  function slug() { return (scenario.customer || "scenario").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scenario"; }

  function doExport(kind) {
    if (kind === "reset") {
      const prev = scenario;
      scenario = withDefaults({});
      syncForm(); changed();
      toast("Started a new scenario", 6000, { label: "Undo", run: () => { scenario = prev; syncForm(); changed(); } });
      return;
    }
    if (kind === "json") return download(`${slug()}.json`, "application/json", JSON.stringify(scenario, null, 2));
    if (!result || !scenario.sources.length) return toast("Add at least one source first");
    if (kind === "print") { window.print(); return; }
    if (kind === "gsheets") return openGoogleExport("sheets");
    if (kind === "gslides") return openGoogleExport("slides");
    if (kind === "csv") return download(`${slug()}-costs.csv`, "text/csv", toCsv());
    if (kind === "md") return download(`${slug()}-proposal.md`, "text/markdown", toMarkdown());
    if (kind === "svg") return download(`${slug()}-architecture.svg`, "image/svg+xml", inlineSvg($("#archSvg")));
  }

  function toCsv() {
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const c = (v) => (v * fx()).toFixed(2);
    const lines = [[`Service`, `Year 1 (${currency})`, `Year 1 1-yr CUD`, `3 years`, `3 years 3-yr CUD`].map(q).join(",")];
    result.by_service.forEach((s) => lines.push([q(s.service), c(s.year1), c(s.year1_cud), c(s.three_year), c(s.three_year_cud)].join(",")));
    lines.push("", [q("Region"), q(`Year 1 (${currency})`), q("3 years")].join(","));
    (result.by_region || []).forEach((s) => lines.push([q(s.name), c(s.year1), c(s.three_year)].join(",")));
    lines.push("", [q("Source"), q(`Year 1 (${currency})`), q("3 years")].join(","));
    result.by_source.forEach((s) => lines.push([q(s.name), c(s.year1), c(s.three_year)].join(",")));
    lines.push("", [q("Month"), q(`Pay-as-you-go (${currency})`), q("With 3-yr commitments")].join(","));
    result.monthly.forEach((m) => lines.push([m.month, c(m.payg), c(m.cud3)].join(",")));
    if (result.bom?.length) {
      lines.push("", ["Environment", "Product / service", "Why it is needed", "Qty / month (M12)", "Qty, year 1", "Unit", `Unit price (${currency})`, `Month 12 (${currency})`, `Year 1 (${currency})`, `3 years (${currency})`].map(q).join(","));
      result.bom.forEach((b) => lines.push([q(b.environment_name), q(b.service), q(b.why), b.qty_month12 ?? "", b.qty_year1 ?? "", q(b.unit || ""), b.unit_price == null ? "" : (b.unit_price * fx()).toFixed(6), c(b.month12), c(b.year1), c(b.three_year)].join(",")));
    }
    if (wlResult) {
      lines.push("", [q("Workload sizing - line item"), q("Service"), q(`Steady month (${currency})`), q("Year 1"), q("3 years")].join(","));
      wlResult.lines.forEach((l) => lines.push([q(l.item), q(l.service), c(l.steady_month), c(l.year1), c(l.three_year)].join(",")));
    }
    return lines.join("\n");
  }

  function toMarkdown() {
    const t = result.totals, p = result.platform;
    const L = [];
    L.push(`# Data Cloud Compass - Google Cloud data & AI platform proposal${scenario.customer ? ` for ${scenario.customer}` : ""}`, "");
    L.push(`BigQuery region: **${result.region.name}** · BigQuery pricing: **${bqModelName()}** · Data growth: **${scenario.annual_growth_pct}%/yr** · Currency: **${currency}**`, "");
    L.push("## Ballpark consumption (source-based)", "", "| Horizon | Pay-as-you-go | With commitments | Discussion range |", "|---|---:|---:|---|");
    L.push(`| 1 year | ${money(t.year1_payg)} | ${money(t.year1_cud1)} (1-yr) | ${money(t.range_low_1y)} - ${money(t.range_high_1y)} |`);
    L.push(`| 3 years | ${money(t.three_year_payg)} | ${money(t.three_year_cud3)} (3-yr) | ${money(t.range_low_3y)} - ${money(t.range_high_3y)} |`, "");
    L.push("### By service", "", "| Service | Year 1 | 3 years |", "|---|---:|---:|");
    result.by_service.forEach((s) => L.push(`| ${s.service} | ${money(s.year1)} | ${money(s.three_year)} |`));
    if ((result.environments || []).length > 1) {
      L.push("", "### By environment", "", "| Environment | Year 1 | 3 years |", "|---|---:|---:|");
      result.environments.forEach((e) => L.push(`| ${e.name} | ${money(e.year1)} | ${money(e.three_year)} |`));
    }
    if (result.bom?.length) {
      L.push("", `### Bill of materials (${result.environments?.[0]?.name || "primary environment"})`, "", "| Product | Qty / month | Unit | Unit price | Year 1 | Why it is needed |", "|---|---:|---|---:|---:|---|");
      result.bom.filter((b) => b.environment === result.environments?.[0]?.id).forEach((b) => L.push(`| ${b.service} | ${fmtQty(b.qty_month12)} | ${b.unit || "-"} | ${unitPrice(b.unit_price)} | ${money(b.year1)} | ${b.why} |`));
    }
    if ((result.by_region || []).length > 1) {
      L.push("", "### By region", "", "| Region | Year 1 | 3 years |", "|---|---:|---:|");
      result.by_region.forEach((r) => L.push(`| ${r.name} | ${money(r.year1)} | ${money(r.three_year)} |`));
    }
    L.push("", "## Source systems and recommended patterns", "");
    const later = scenario.sources.filter((s) => s.included === false).map((s) => s.name);
    if (later.length) L.push(`_Not in this phase (excluded from the estimate): ${later.join(", ")}._`, "");
    scenario.sources.forEach((s) => {
      const r = recFor(s.id);
      if (!r) return;
      L.push(`### ${s.name}`, "", `*${catalog.source_types.find((x) => x.id === s.type)?.name}* · ${freqName(s.frequency)} · ${fmtGB(s.initial_volume_gb)} initial · ${fmtGB(s.daily_change_gb)}/day · region ${s.region || scenario.region}`, "");
      L.push(`**Pattern:** ${r.pattern}`, "", `**Services:** ${r.chain.map((x) => tool(x).name).join(" → ")} → BigQuery`, "");
      r.rationale.forEach((x) => L.push(`- ${x}`));
      if (r.alternatives.length) { L.push("", "**Alternatives**", ""); r.alternatives.forEach((a) => L.push(`- ${tool(a.tool).name}: ${a.why}`)); }
      if (r.caveats.length) { L.push("", "**Check during discovery**", ""); r.caveats.forEach((c) => L.push(`- ${c}`)); }
      if (s.notes) L.push("", `**Notes:** ${s.notes}`);
      L.push("");
    });
    L.push("## BI, AI and governance integrations", "");
    scenario.components.forEach((c) => {
      const m = compMeta(c.type);
      L.push(`### ${m.name} (${m.vendor === "google" ? "Google Cloud" : "partner - not costed"})`, "", `**Integration:** ${m.method}`, "");
      m.steps.forEach((x, i) => L.push(`${i + 1}. ${x}`));
      m.notes.forEach((x) => L.push(`- ${x}`));
      L.push("", `Docs: ${m.doc}`, "");
    });
    const sec = p.layer.story.find((b) => b.key === "security");
    if (sec) { L.push("### Security & compliance", ""); sec.points.forEach((x) => L.push(`- ${x}`)); L.push(""); }
    L.push("### Cost by capability", "", "| Capability | Year 1 | 3 years |", "|---|---:|---:|");
    result.by_group.forEach((g) => L.push(`| ${g.group} | ${money(g.year1)} | ${money(g.three_year)} |`));
    L.push("", "## Platform blueprint", "");
    L.push(`- **Transformation:** Dataform - ${p.transformation.why}`);
    L.push(`- **Orchestration:** ${p.orchestration.tool === "none" ? "None required" : tool(p.orchestration.tool).name} - ${p.orchestration.why}`);
    L.push(`- **Connectivity:** ${p.connectivity ? tool(p.connectivity).name : "Google-managed / public endpoints"}`);
    if (p.datafusion_edition) L.push(`- **Data Fusion:** shared ${p.datafusion_edition} instance`);
    L.push("");
    if (wlResult) {
      const w = wlResult, wt = w.totals, W = w.workload;
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
    if (planResult) {
      const pr = planResult;
      L.push("## Ramp-up roadmap", "", `${pr.teams} delivery squad(s); programme length ${pr.horizon} months.`, "");
      L.push("| Phase | Months | Notes |", "|---|---|---|");
      pr.phases.forEach((ph) => L.push(`| ${ph.name} | M${ph.start}${ph.end !== ph.start ? `-M${ph.end}` : ""} | ${ph.items.join("; ")} |`));
      L.push("", "| Month | Goes live | Ramped cost | Steady state |", "|---|---|---:|---:|");
      pr.months.forEach((m) => L.push(`| M${m.month} | ${[...pr.milestones.filter((x) => x.month === m.month).map((x) => x.name), ...m.sources_live, ...m.components_started].join(", ") || "-"} | ${money(m.total)} | ${money(m.steady)} |`));
      L.push("", `Year 1 with ramp-up: **${money(pr.totals.ramped_year1)}** (vs ${money(pr.totals.steady_year1)} at full run-rate); 3 years: **${money(pr.totals.ramped_three_year)}**.`, "");
    }
    L.push("---", "", `_${result.disclaimer}_`, "");
    return L.join("\n");
  }

  function inlineSvg(svg, white) {
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
  const GCLIENT_KEY = "data-cloud-compass:google-client-id";
  let gKind = null, serverClientId = "";
  function googleClientId() {
    let local = "";
    try { local = localStorage.getItem(GCLIENT_KEY) || ""; } catch (_) { /* storage unavailable */ }
    return (window.COMPASS_CONFIG && window.COMPASS_CONFIG.googleClientId) || serverClientId || local;
  }
  async function loadServerConfig() {
    if (window.ADVISOR_API) return;
    try { const r = await fetch("/api/config"); if (r.ok) serverClientId = (await r.json()).google_client_id || ""; } catch (_) { /* optional */ }
  }

  function openGoogleExport(kind) {
    gKind = kind;
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

  async function buildGoogleFile(kind) {
    if (kind === "sheets") return { blob: await window.CompassExports.xlsx(await workbookSpec()), name: `${slug()}-data-cloud-compass.xlsx` };
    return { blob: await buildDeck(), name: `${slug()}-data-cloud-compass.pptx` };
  }

  function bindGoogleExport() {
    $("#gClose").addEventListener("click", () => $("#gDialog").close());
    $("#gClientId").addEventListener("change", (e) => { try { localStorage.setItem(GCLIENT_KEY, e.target.value.trim()); } catch (_) { /* ignore */ } });
    $("#gDownload").addEventListener("click", async () => {
      $("#gStatus").textContent = "Building…";
      try {
        const f = await buildGoogleFile(gKind);
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
        const f = await buildGoogleFile(gKind);
        const title = `${scenario.customer || "Customer"} - Data Cloud Compass ${gKind === "sheets" ? "sizing" : "proposal"}`;
        const res = await window.CompassExports.driveUpload(f.blob, title, gKind, id);
        $("#gStatus").innerHTML = `Created <a href="${esc(res.webViewLink)}" target="_blank" rel="noopener">${esc(res.name)}</a> in your Google Drive.`;
      } catch (err) { $("#gStatus").textContent = `Google Drive export failed: ${err.message}. You can still use Download.`; }
    });
  }

  const cur = (usd) => Math.round(usd * fx() * 100) / 100;
  async function diagramPng(sel, width) {
    const el = $(sel);
    if (!el) return null;
    try { return await window.CompassExports.svgToPng(inlineSvg(el, true), width, 2); } catch (_) { return null; }
  }

  async function workbookSpec() {
    const S = window.CompassExports.STYLE;
    const t = result.totals, ccy = currency;
    const H = (labels) => labels.map((v) => ({ v, s: S.head }));
    const M = (usd) => ({ v: cur(usd), s: S.money });
    const sheets = [];
    const today = new Date().toISOString().slice(0, 10);

    // Summary
    const groups = result.by_group.filter((g) => g.three_year > 0);
    const sum = [
      [{ v: `Data Cloud Compass - ${scenario.customer || "Customer"}`, s: S.title }],
      [{ v: `BigQuery region ${result.region.name} · ${bqModelName()} · growth ${scenario.annual_growth_pct}%/yr · ${scenario.environments.length} environment(s) · currency ${ccy} · ${today}`, s: S.sub }],
      [],
      H(["Horizon", `Pay-as-you-go (${ccy})`, `With commitments (${ccy})`, "Discussion range low", "Discussion range high"]),
      ["1 year", M(t.year1_payg), M(t.year1_cud1), M(t.range_low_1y), M(t.range_high_1y)],
      ["3 years", M(t.three_year_payg), M(t.three_year_cud3), M(t.range_low_3y), M(t.range_high_3y)],
      [],
      H(["Capability", `Year 1 (${ccy})`, `3 years (${ccy})`]),
      ...groups.map((g) => [g.group, M(g.year1), M(g.three_year)]),
      [{ v: "Total", s: S.bold }, { v: cur(t.year1_payg), s: S.moneyBold }, { v: cur(t.three_year_payg), s: S.moneyBold }],
      [],
      [{ v: result.disclaimer, s: S.sub }],
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
    const comps = scenario.components.map((c) => ({ c, m: compMeta(c.type) }));
    const catName = (id) => catalog.component_categories.find((k) => k.id === id).name;
    const lake = result.platform.lakehouse;
    if (lake?.raw_zone) archRows.push(["Raw zone", "Cloud Storage", "Google Cloud", `${lake.raw_storage_class} class, ${lake.raw_retention_months} months, ${lake.raw_scope === "all" ? "all sources" : "batch & file sources"}`, scenario.region, "Yes"]);
    (lake?.layers || []).forEach((l) => archRows.push(["BigQuery lakehouse", `${l.name} layer`, "Google Cloud", `${l.role} (${l.pct}% of bronze, ~${fmtGB(l.gib_month12)} at month 12)`, scenario.region, "Yes"]));
    comps.forEach(({ c, m }) => {
      const mode = m.modes ? ` - ${m.settings.find((f) => f.key === m.modes.key).options.find((o) => o.id === c.settings[m.modes.key])?.name || ""}` : "";
      archRows.push([catName(m.category), m.name, m.vendor === "google" ? "Google Cloud" : "Partner", { v: m.method + mode, s: S.wrap }, m.costed ? (c.settings.region || scenario.region) : "-", m.costed ? (c.included === false ? "No (excluded)" : "Yes") : "Not costed"]);
    });
    sheets.push({ name: "Architecture", rows: archRows, widths: [22, 34, 14, 70, 16, 14],
      images: arch ? [{ png: arch.bytes, name: "Target architecture", anchor: { col: 0, row: 2, cols: 6, rows: imgRows } }] : [] });

    // Sources & ingestion patterns
    const srcRows = [H(["Source", "Type", "Freshness", "Initial volume", "Daily change", "Region", "In this phase", "Pattern", "Services", "IoT integration"])];
    scenario.sources.forEach((s) => {
      const r = recFor(s.id);
      srcRows.push([s.name, catalog.source_types.find((x) => x.id === s.type)?.name || s.type, freqName(s.frequency), fmtGB(s.initial_volume_gb), fmtGB(s.daily_change_gb) + "/day",
        s.region || scenario.region, s.included === false ? "No (later phase)" : "Yes", { v: r ? r.pattern : "-", s: S.wrap }, r ? r.chain.map((x) => tool(x).name).join(" → ") + " → BigQuery" : "-",
        s.type === "iot" ? (catalog.iot_options.find((o) => o.id === (s.iot_option || "native"))?.name || "") : ""]);
    });
    sheets.push({ name: "Sources & patterns", rows: srcRows, widths: [28, 24, 14, 14, 14, 16, 14, 50, 50, 36], freeze: 1 });

    // Bill of materials
    const bom = result.bom || [];
    const bomRows = [H(["Environment", "Capability", "Product / service", "Why it is needed", "Qty / month (M12)", "Qty, year 1", "Unit", `Unit price (${ccy})`, `Month 12 (${ccy})`, `Year 1 (${ccy})`, `3 years (${ccy})`])];
    bom.forEach((b) => bomRows.push([b.environment_name, b.group, b.service, { v: b.why, s: S.wrap },
      b.qty_month12 == null ? "-" : { v: b.qty_month12, s: S.num }, b.qty_year1 == null ? "-" : { v: b.qty_year1, s: S.num }, b.unit || "-",
      b.unit_price == null ? "-" : { v: Math.round(b.unit_price * fx() * 10000) / 10000, s: S.price }, M(b.month12), M(b.year1), M(b.three_year)]));
    const n = bom.length;
    bomRows.push([{ v: "Total", s: S.bold }, "", "", "", "", "", "", "", { f: `SUM(I2:I${n + 1})`, s: S.moneyBold }, { f: `SUM(J2:J${n + 1})`, s: S.moneyBold }, { f: `SUM(K2:K${n + 1})`, s: S.moneyBold }]);
    sheets.push({ name: "Bill of materials", rows: bomRows, widths: [16, 22, 36, 70, 16, 16, 16, 16, 16, 16, 16], freeze: 1 });

    // Monthly
    const mon = [H(["Month", `Pay-as-you-go (${ccy})`, `With 3-year commitments (${ccy})`])];
    result.monthly.forEach((m) => mon.push([`M${m.month}`, M(m.payg), M(m.cud3)]));
    sheets.push({ name: "Monthly", rows: mon, widths: [10, 24, 28], freeze: 1,
      charts: [{ type: "line", title: `Monthly consumption, 36 months (${ccy})`, catCol: 0, firstRow: 1, lastRow: 36, series: [{ col: 1, color: "1A73E8" }, { col: 2, color: "188038", dash: true }], anchor: { col: 4, row: 1, cols: 10, rows: 20 } }] });

    // Environments
    const envs = result.environments || [];
    const envRows = [H(["Environment", ...catalog.environment_factors.map((f) => f.name), "BigQuery slots", `Per month, yr 1 (${ccy})`, `Year 1 (${ccy})`, `3 years (${ccy})`])];
    envs.forEach((e) => envRows.push([e.name, ...catalog.environment_factors.map((f) => ({ v: e.factors[f.id] / 100, s: S.pct })), e.bq_slots ?? "auto", M(e.monthly_year1), M(e.year1), M(e.three_year)]));
    const nf = catalog.environment_factors.length;
    sheets.push({ name: "Environments", rows: envRows, widths: [22, ...catalog.environment_factors.map(() => 16), 14, 20, 18, 18], freeze: 1,
      charts: envs.length ? [{ type: "bar", title: `Consumption by environment (${ccy})`, catCol: 0, firstRow: 1, lastRow: envs.length, series: [{ col: nf + 3, color: "1A73E8" }, { col: nf + 4, color: "F9AB00" }], anchor: { col: 0, row: envs.length + 3, cols: 8, rows: 16 } }] : [] });

    // Workload sizing + slots
    if (wlResult) {
      const w = wlResult, wt = w.totals;
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
    if (planResult) {
      const p = planResult;
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
    const a = result.assumptions;
    sheets.push({ name: "Assumptions", rows: [H(["Assumption", "Value"]),
      ["BigQuery region / uplift", `${result.region.name} x${result.region.uplift.toFixed(2)}`],
      ["Lakehouse", `Raw zone ${lake?.raw_zone ? "on" : "off"}; silver ${lake?.silver_pct}% and gold ${lake?.gold_pct}% of bronze`],
      ["Long-term storage", `${Math.round(a.longterm_share_after_90d * 100)}% of data older than 90 days`],
      ["ELT scan", `${a.elt_scan_multiplier}x data ingested per month`],
      ["Contingency", `${scenario.contingency_pct}%`],
      ["Environments", scenario.environments.map((e) => e.name).join(", ")],
      ["Partner products", "Never costed (Power BI, Tableau, Litmus, ClearBlade, Collibra …)"],
      ["Prices", `${result.pricing_meta.note} Reviewed ${result.pricing_meta.last_reviewed}.`],
      ["Disclaimer", { v: result.disclaimer, s: S.wrap }]], widths: [30, 110] });
    return sheets;
  }

  async function buildDeck() {
    const P = new window.PptxGenJS();
    P.layout = "LAYOUT_WIDE";
    P.author = "Data Cloud Compass";
    P.title = `${scenario.customer || "Customer"} - Google Cloud data & AI platform`;
    const FONT = "Roboto", INK = "202124", MUTED = "5F6368", BLUE = "1A73E8";
    const t = result.totals, ccy = currency;
    P.defineSlideMaster({ title: "COMPASS", background: { color: "FFFFFF" },
      objects: [
        { rect: { x: 0, y: 0, w: 3.33, h: 0.08, fill: { color: "4285F4" } } }, { rect: { x: 3.33, y: 0, w: 3.33, h: 0.08, fill: { color: "EA4335" } } },
        { rect: { x: 6.66, y: 0, w: 3.33, h: 0.08, fill: { color: "FBBC04" } } }, { rect: { x: 9.99, y: 0, w: 3.34, h: 0.08, fill: { color: "34A853" } } },
        { text: { text: `${scenario.customer || "Customer"} · Data Cloud Compass`, options: { x: 0.4, y: 7.05, w: 8, h: 0.3, fontFace: FONT, fontSize: 9, color: MUTED } } },
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
      s.addText(scenario.customer || "Customer", { x: 0.6, y: 1.8, w: 12, h: 0.6, fontFace: FONT, fontSize: 20, color: BLUE, bold: true });
      s.addText("Data & AI platform on Google Cloud", { x: 0.6, y: 2.4, w: 12, h: 1.0, fontFace: FONT, fontSize: 40, bold: true, color: INK });
      s.addText(`Target architecture, ingestion patterns, sizing and 1- / 3-year consumption · BigQuery in ${result.region.name} · ${new Date().toLocaleDateString(undefined, { year: "numeric", month: "long" })}`,
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
      const s = slide("Recommended ingestion patterns", `${result.recommendations.length} source systems in this phase · GCP-native ETL / ELT per source`);
      const rows = [head(["Source", "Freshness", "Volume", "Pattern", "Services"])];
      scenario.sources.filter((x) => recFor(x.id)).slice(0, 12).forEach((x) => {
        const r = recFor(x.id);
        rows.push([x.name, freqName(x.frequency), `${fmtGB(x.initial_volume_gb)} + ${fmtGB(x.daily_change_gb)}/day`, r.pattern, r.chain.map((k) => tool(k).name).join(" → ")]);
      });
      s.addTable(rows, { ...tableOpts([2.6, 1.4, 1.8, 3.9, 2.8]), fontSize: 9 });
    }
    // 4. Integrations
    {
      const s = slide("BI, AI, API and governance integrations", "How each product connects to BigQuery - partner products are shown but not costed");
      const rows = [head(["Product", "Category", "Vendor", "How it connects / role"])];
      scenario.components.slice(0, 14).forEach((c) => {
        const m = compMeta(c.type);
        const mode = m.modes ? (m.modes.notes[c.settings[m.modes.key]] || m.method) : m.method;
        rows.push([m.name, catalog.component_categories.find((k) => k.id === m.category).name, m.vendor === "google" ? "Google Cloud" : "Partner", mode]);
      });
      s.addTable(rows, { ...tableOpts([2.9, 2.0, 1.3, 6.3]), fontSize: 9 });
    }
    // 5. Consumption summary
    {
      const s = slide("Ballpark consumption", `${bqModelName()} · ${scenario.annual_growth_pct}% annual data growth · ${scenario.contingency_pct}% contingency · ${ccy}`);
      kpi(s, 0.4, "Average per month, year 1", money(t.avg_monthly_year1), "pay-as-you-go");
      kpi(s, 3.5, "1 year", money(t.year1_payg), `${money(t.year1_cud1)} with 1-yr commitments`, BLUE);
      kpi(s, 6.6, "3 years", money(t.three_year_payg), `${money(t.three_year_cud3)} with 3-yr commitments`, BLUE);
      kpi(s, 9.7, "Discussion range, 3 years", `${moneyShort(t.range_low_3y)} - ${moneyShort(t.range_high_3y)}`, "commitments to contingency");
      const g = result.by_group.filter((x) => x.three_year > 0);
      s.addChart(P.ChartType.bar, [{ name: `Year 1 (${ccy})`, labels: g.map((x) => x.group), values: g.map((x) => cv(x.year1)) }, { name: `3 years (${ccy})`, labels: g.map((x) => x.group), values: g.map((x) => cv(x.three_year)) }],
        { x: 0.4, y: 3.0, w: 6.3, h: 3.9, barDir: "bar", chartColors: [BLUE, "F9AB00"], showLegend: true, legendPos: "b", legendFontFace: FONT, catAxisLabelFontFace: FONT, valAxisLabelFormatCode: "#,##0", catAxisLabelFontSize: 9, valAxisLabelFontSize: 8, showTitle: true, title: "By capability", titleFontSize: 12, titleFontFace: FONT });
      s.addChart(P.ChartType.line, [{ name: "Pay-as-you-go", labels: result.monthly.map((m) => `M${m.month}`), values: result.monthly.map((m) => cv(m.payg)) }, { name: "With 3-yr commitments", labels: result.monthly.map((m) => `M${m.month}`), values: result.monthly.map((m) => cv(m.cud3)) }],
        { x: 6.9, y: 3.0, w: 6.0, h: 3.9, chartColors: [BLUE, "188038"], lineDataSymbol: "none", lineSize: 2, showLegend: true, legendPos: "b", legendFontFace: FONT, valAxisLabelFormatCode: "#,##0", catAxisLabelFontSize: 8, valAxisLabelFontSize: 8, showTitle: true, title: `Monthly run-rate (${ccy})`, titleFontSize: 12, titleFontFace: FONT });
    }
    // 6. Environments
    const envs = result.environments || [];
    if (envs.length > 1) {
      const s = slide("Environments", `${envs.length} environments, each sized as a share of ${envs[0].name}`);
      const rows = [head(["Environment", "Sizing", "Per month (yr 1)", "Year 1", "3 years"])];
      envs.forEach((e, i) => rows.push([e.name, i === 0 ? "Baseline" : catalog.environment_factors.map((f) => `${f.name.replace(" %", "")} ${e.factors[f.id]}%`).join(", "), money(e.monthly_year1), money(e.year1), money(e.three_year)]));
      s.addTable(rows, { ...tableOpts([2.2, 5.6, 1.6, 1.5, 1.6]), fontSize: 9 });
      s.addChart(P.ChartType.bar, [{ name: `3 years (${ccy})`, labels: envs.map((e) => e.name), values: envs.map((e) => cv(e.three_year)) }],
        { x: 0.4, y: 1.6 + 0.32 * (envs.length + 1), w: 7, h: Math.max(2.2, 5.2 - 0.32 * (envs.length + 1)), barDir: "col", chartColors: [BLUE], showLegend: false, valAxisLabelFormatCode: "#,##0", catAxisLabelFontFace: FONT, dataLabelFormatCode: "#,##0", showValue: true, dataLabelFontSize: 9 });
    }
    // 7. Bill of materials (top lines, per environment)
    {
      const bom = (result.bom || []).filter((b) => b.environment === (envs[0]?.id || b.environment)).sort((a, b) => b.year1 - a.year1);
      const pages = [bom.slice(0, 13), bom.slice(13, 26)].filter((p) => p.length);
      pages.forEach((page, pi) => {
        const s = slide(`Bill of materials${pages.length > 1 ? ` (${pi + 1}/${pages.length})` : ""}`, `${envs[0]?.name || "Production"} · products ranked by year-1 cost · quantities at month 12${envs.length > 1 ? " · other environments in the Sheets export" : ""}`);
        const rows = [head(["Product", "Why it is needed", "Qty / month", "Unit", "Unit price", "Year 1", "3 years"])];
        page.forEach((b) => rows.push([b.service, b.why.length > 150 ? b.why.slice(0, 147) + "…" : b.why, fmtQty(b.qty_month12), b.unit || "-", unitPrice(b.unit_price), money(b.year1), money(b.three_year)]));
        s.addTable(rows, { ...tableOpts([2.5, 5.0, 1.0, 1.15, 0.95, 1.0, 0.9]), fontSize: 8 });
      });
    }
    // 8. Slot sizing
    const sl = wlResult?.slots;
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
    if (planResult) {
      const p = planResult;
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
      const lake = result.platform.lakehouse;
      const pts = [
        `Ballpark from public list prices (reviewed ${result.pricing_meta.last_reviewed}) with regional uplift for ${result.region.name}; excludes taxes, support, partner licences and negotiated discounts.`,
        `Lakehouse: ${lake?.raw_zone ? `Cloud Storage raw zone (${lake.raw_storage_class}, ${lake.raw_retention_months} months)` : "no raw zone"}; BigQuery silver ${lake?.silver_pct}% and gold ${lake?.gold_pct}% of bronze.`,
        `Environments: ${scenario.environments.map((e) => e.name).join(", ")}.`,
        "Validate volumes, change rates and query patterns with source owners; confirm CDC prerequisites (supplemental logging, replication slots).",
        "Run a 4-6 week pilot on one quick-win source and one CDC source, measure slot usage with INFORMATION_SCHEMA, then right-size commitments.",
        "Confirm data-residency and security controls (VPC Service Controls, CMEK, Assured Workloads) with the customer's risk team.",
        "Validate pricing with the Google Cloud Pricing Calculator before any formal proposal.",
      ];
      s.addText(pts.map((x) => ({ text: x, options: { bullet: true, breakLine: true } })), { x: 0.5, y: 1.3, w: 12.3, h: 5.5, fontFace: FONT, fontSize: 15, color: INK, valign: "top", paraSpaceAfter: 10 });
    }
    return P.write({ outputType: "blob" });
  }

  function showCopyBox(name, text) {
    $("#copyTitle").textContent = name;
    $("#copyText").value = text;
    $("#copyDialog").showModal();
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
