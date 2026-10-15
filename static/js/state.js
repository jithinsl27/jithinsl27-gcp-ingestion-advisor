/* Data Cloud Compass - shared mutable state (single object so every module sees updates). */

export const S = {
  DEFAULT_SCENARIO: {
    customer: "", region: "me-central2", processing_region: "", skill: "sql", orchestration: "auto", environment: "production",
    bq: { mode: "ondemand", edition: "auto" }, commercial: {}, pricing_option: "payg", analytics_tib_month: null, annual_growth_pct: 20, contingency_pct: 10,
    sources: [], components: [], security: {}, workload: {},
    environments: [{ id: "prod", name: "Production", preset: "prod" }], lakehouse: {},
  },
  catalog: null,
  scenario: null,                 // set by boot()
  result: null,
  wlResult: null,
  planResult: null,
  currency: "USD",
  editingId: null,
  editingComp: null,
  estimateTimer: null,
  seq: 0,
  wlSeq: 0,
  planSeq: 0,
  wlTimer: null,
  envDraft: [],
  slotsDraft: null,
  restored: false,
  suppressClick: false,
  bomEnv: null,
  gKind: null,
  serverClientId: "",
  config: {},
  samples: [],                     // /api/config: sign-in, storage, AI assist, live prices
  idToken: null,                  // Google ID token when signed in
  user: null,                     // {email, name, picture}
  cloud: null,                    // saved scenario this session is editing: {id, version, title, role, updated_at}
  dirty: false,                   // unsaved changes since the last cloud save
  readOnlyVersion: null,          // viewing an old version (number) - Save restores it as a new version
  toastTimer: undefined,
};
