# User guide

Data Cloud Compass is built to be used live in discovery workshops, typically screen-shared. Everything recalculates as you type.

## 1. Set up the engagement

- **Customer name** (top bar): appears in exports.
- **Region**: the BigQuery home region (or US/EU multi-region). Storage, queries and shared security controls are priced here.
- **Currency**: display currency (fixed conversion rates in `pricing.json`).
- **Load sample**: three ready-made customers (KSA retail bank, telco DWH modernisation, manufacturing).
- **Discover**: build the design faster -
  - **Guided interview**: five short steps (customer & region, source systems as tap-to-add chips with a typical size, consumers such as BI / Gemini Enterprise / agents / APIs / databases, environments & security & pricing preferences, review) that create a complete first design, either as a new scenario or added to the current one;
  - **Meeting notes (AI)**: paste notes, an RFP extract or an e-mail; Gemini proposes source systems (with volumes, marked *estimated* when guessed), products with a reason each, **questions to ask the customer next** and its assumptions - tick what to add;
  - **Inventory spreadsheet**: upload a CSV/XLSX in the template layout (download the template from the dialog) and it is imported directly with no AI; any other layout is read by Gemini.
- **Sign in** (top right, when configured) to save to the cloud.

## 2. Capture source systems

Click **Add source** for each system the customer wants in BigQuery.

| Field | Meaning | Why it matters |
|---|---|---|
| Target | **Data platform** (BigQuery bronze / silver / gold), **Data lake** (Cloud Storage only) or **Operational database** (AlloyDB / Cloud SQL via Database Migration Service, for relational sources) | Decides the landing zone, the ingestion pattern and what is priced |
| Source system type | 35 types across databases, warehouses, SAP, mainframe, NoSQL, files, streams, SaaS, APIs, documents | Selects the rule set |
| Name | The customer's own name for it | Shown on the diagram and in the proposal |
| Data type | Structured, semi-structured, unstructured, events | Load format and notes |
| Where it runs | On-prem, GCP, AWS, Azure, SaaS | Connectivity (VPN / Interconnect) and egress caveats |
| Freshness needed | Real-time … monthly, or one-time migration | CDC / streaming vs batch |
| In-flight transformation | None (ELT), light, heavy | Adds processing, changes throughput |
| Processing region | Where this source's ingestion runs (default: BigQuery region) | Regional price and cross-region transfer |
| Initial volume / Daily change | Historical load and ongoing change, in KB, MB, GB, TB, PB, EB or ZB | One-time and ongoing cost, storage growth |
| IoT integration (IoT sources only) | Google Cloud native (Pub/Sub direct, MQTT broker on GKE, Manufacturing Data Engine) or ISV (Litmus Edge, ClearBlade IoT Core) | Pattern, diagram and cost (ISV licences are not costed; the MQTT broker is costed as an HA pair of VMs) |

**A product that is not in the list**: choose *Other - not in this list*, type the product name (for example *Infor M3* or *Temenos T24*) and pick **Treat it like** the closest known type (database, SaaS API, files …). Ingestion is recommended and priced as that type; the diagram, proposal and exports use the name you typed.

The colour bar shows the flow: green dashed = streaming/CDC, orange = scheduled batch, red dotted = one-time.

## 3. Environments

Choose the **Total** number of environments in the sidebar and press **Size** to open the sizing grid (or edit inline on the Consumption estimate tab under *How each environment is sized*). The first environment (normally production) is the baseline described by your sources, products and workload. Every other environment is sized as a percentage of it per capability: data volume, ingestion & pipelines, BigQuery compute, BI/AI/agent usage, APIs & databases, and platform/governance/security - plus **running hours % of the week**, which scales always-on services (streaming Dataflow, Composer, Data Fusion instance, VMs, GPU endpoints, agent runtime, Apigee environment, databases): 12 hours on weekdays is 36 %. BigQuery slots are sized per environment (see 3c). Presets give sensible starting points (development 10 %, UAT 25 %, pre-production 50 %, DR keeps 100 % of the data with little compute). Network links and the Looker licence are shared and counted once. The Consumption estimate and Workload sizing tabs show cost by environment, and the bill of materials can be filtered by environment.

## 3b. Lakehouse layers

The **Lakehouse layers** panel controls the Cloud Storage **raw zone** (on/off, which sources land there, retention and storage class) and the size of the BigQuery **silver** and **gold** layers as a share of bronze. The diagram shows the raw zone and the three layers with their size at month 12.

## 3c. Engagement settings

Team skill set (drives batch tool choice), orchestration, analytics scan volume, growth, contingency, environment, and the **processing region** for shared services (orchestration, Data Fusion, network).

**BigQuery compute** (in Engagement settings):

- **On-demand (per TiB)** or **Editions (slots)**. A hint shows which is cheaper for this design.
- With editions, pick **Recommend for me** (the edition the architecture needs: Enterprise for VPC-SC, CMEK, column/row security, BigQuery ML, BI Engine; Enterprise Plus for Assured Workloads / managed DR; otherwise Standard) or a specific edition.
- Slots are **auto-sized per environment** - a **baseline** (always on; the only part a 1- or 3-year commitment discounts) and a **max** (baseline + autoscaling, billed pay-as-you-go while queries run). Grey numbers are the auto values; type over any of them to override, clear it to go back to auto, or **Reset all to auto**. Standard edition has no baseline and stops at 1,600 slots. Part-time non-production environments get autoscaling only.
- **Sizing & calibration** opens the details: average and busiest-hour demand, the hourly profile with baseline and max, the cost of on-demand and every edition for pay-as-you-go / 1-year / 3-year, why an edition is needed, which data the scan volume is based on (rule of thumb from data volume, the **Workload sizing** tab, or **measured** usage), every sizing assumption (editable), and an `INFORMATION_SCHEMA.JOBS` query to run in the customer's project - enter the measured TiB and slot-hours and the estimate is calibrated to them.

**Commercial terms**: negotiated discount %, Google Cloud **Customer Care** plan (Standard / Enhanced / Premium - tiered % of list spend with a monthly minimum) and the discussion range (low % applied to the cheapest commitment price, high % to pay-as-you-go).

**Consumption pricing** (above the headline figures): pay-as-you-go, 1-year or 3-year commitment. Every figure, breakdown, environment cost, the bill of materials and the exports follow it, with the saving versus pay-as-you-go. Click any headline figure for the products and pricing behind it.

**Availability**: if a service is not offered in the region it is placed in, a warning appears under the headline figures with one-click options to run it in a nearby region. On Cloud Run availability is checked daily against Google's price catalog; otherwise unverified services are listed.

## 4. Products: BI, AI, APIs, databases, governance and security

At the top of the **Architecture** tab, type a product name in the search box (e.g. *power*, *spanner*, *sage*, *kms*). Results are ranked by name and show the category, how it connects, and whether it is costed.

- **Enter** or **Add** puts the product into the architecture; **Remove** takes it out. Clicking results keeps the list open so you can add several; you can also drag a result onto the diagram.
- Selected products appear as **pills** under the search box. **×** removes a product; clicking its name opens its settings (users, models, nodes, API calls …, and the **region** for Google services).
- **Governance and security are products too** - Knowledge Catalog, Collibra, Alation, Atlan, Informatica, Sensitive Data Protection, Cloud KMS (CMEK), VPC Service Controls, policy tags & masking, Security Command Center, Assured Workloads. The band at the bottom of the diagram shows only what you add.
- **Google Cloud products are costed; partner products** (Power BI, Tableau, SageMaker, Databricks, Collibra …) are drawn with a dashed border and a *Partner* tag and never costed.

### Gemini Enterprise and Apigee wiring

Customers use these differently, so the connection is flexible:

- **Gemini Enterprise** can be grounded on **BigQuery** (federated data store), on **Looker**'s semantic layer, on **both**, or reach data only **through agents**. Drag its node on the diagram onto Looker, BigQuery or an agent, or pick *Connects to* in its settings or on the Integrations tab. Grounding on Looker adds Looker if it is missing.
- **Apigee** can be the **integration layer** (in front of application, SaaS and API sources, and publishing data products as APIs), the **AI gateway** for agents, or both. Drag it onto the source systems or an agent, or pick *Used as*.

The diagram edges, the Integrations narrative, the bill of materials and the exports follow the choice.

### Choosing what is priced

- **Sources**: tick or untick each source in the sidebar (or use **Select all** / **Clear all**). Unticked sources stay in the scenario, appear dimmed as *Later phase* on the diagram, and are left out of recommendations, the estimate and the roadmap - useful for pricing phase 1 first.
- **Products**: the checkbox on each costed pill (or *Include in pricing* in its settings) keeps the product in the architecture but takes it out of the numbers; it shows as *Not priced*.
- **Service lines**: on the Consumption estimate tab, untick any service (e.g. Datastream, Composer, contingency) to leave it out of every total, the roadmap and workload sizing; unticked lines stay listed so you can tick them back.

## 5. Modules

The app is organised as modules in the left-hand navigation. Click a module to open it; each one starts with a short description and a row of **insights** (the key figures for that module), and the navigation shows a badge with the count or headline figure.

| Module | What you see |
|---|---|
| **Overview** | One card per module with its key insight - click a card to open that module, or a pricing figure to open that plan |
| **Use cases** | The top 5 use cases recommended from the customer's data, plus the customer's own list (feeds the proposal and exports) |
| **Source systems** | Add, edit, import and include / exclude sources; each card shows its target and ingestion chain |
| **Architecture** | Product picker and the presentation-ready diagram (targets: BigQuery lakehouse, Cloud Storage data lake, AlloyDB / Cloud SQL) |
| **Ingestion patterns** | Per-source pattern, rationale, alternatives and discovery checks |
| **Platform & integrations** | How each selected product connects to BigQuery |
| **Workload** | What the customer will run - data, pipelines, reports, dashboards and queries - in plain terms, and what it means for BigQuery |
| **BigQuery slots** | Slots per environment: demand, recommended baseline / commitment for each plan, max, monthly cost and assumptions |
| **Environments** | Cost per environment and the per-environment sizing |
| **Pricing** | The three commercial plans with the recommended specification per environment and the editable bill of materials (below) |
| **Roadmap** | See section 7 |
| **Kickoff** | Pre-kickoff checklist for customer and partner, milestones with exit criteria, team size and skills |
| **Proposal** | Generate a customer proposal of up to 15 pages |
| **Charge-back** | Negotiated price book and pricing of department requests (below) |
| **Usage (admin)** | Who uses the tool and what they do (admin key) |
| **Settings** | Engagement settings, BigQuery model, commercial terms, lakehouse layers and assumptions |

### Pricing plans

The **Pricing** module opens on three plan cards for the **whole programme**:

1. **Pay as you go - 1 year** - the **monthly consumption ramp-up** for months 1-12, no commitment;
2. **1-year commitment (all services)** - the same months with 1-year committed-use pricing, with the saving;
3. **3-year commitment (all services)** - 36 months, with **what you pay in year 1, year 2 and year 3** and the saving against pay as you go over 3 years.

For the chosen plan you get the **recommended specification per environment**: the monthly cost, the BigQuery edition with the baseline / commitment and max slots *for that plan*, the main products with quantity per month, unit price and monthly cost, and the sizing assumptions (share of production, running hours). Above the cards, the whole-project BigQuery commitment and max are summarised.

**Click the plan total** (or any headline figure) to open the **bill of materials**: every product per environment with region, unit, quantity per month, unit price, monthly cost and the plan total. **Edit a quantity or a unit price** and press **Apply** - the engine recalculates everything (plans, environments, roadmap, exports, proposal); edited lines are marked and can be reset one by one or all at once. Edits are saved with the scenario.

Each plan also shows a stacked monthly chart by capability, year tiles, and a **product table** with product name, unit, quantity, unit price, cost and saving. Switch the table to the **month × product matrix** to see cost or quantity per product per month (pick the year for 3-year plans), and **Download CSV**. Toggle **With ramp-up plan** (services start consuming when the roadmap brings them live; BigQuery compute starts at the first data-platform go-live) or **Full scope from month 1**, and filter by environment. **Detailed breakdown** keeps the earlier views (by capability, service, region, source and the bill of materials).

### Use cases

The **Use cases** module recommends the **top 5 use cases** from the data in scope (for example Customer 360 when CRM and transaction systems are present, predictive maintenance for IoT, warehouse modernisation for Teradata / Hadoop), each with the value, why it was picked (which sources) and the products that deliver it. Add them to the customer's list, type the customer's own use cases with notes, and reorder them; the list appears in the proposal and in the Sheets export.

### Workload and BigQuery slots

**Workload** asks in plain terms what the customer will run: how much data, pipelines, reports and queries, and dashboards. Changing any number switches on **Use these numbers to size BigQuery and pricing**, so BigQuery compute, slots and every plan follow it; *What this means* shows the data scanned per month, the computing power needed and the BigQuery cost. Working hours, regions and the standalone workload-only estimate are under *Advanced*.

**BigQuery slots** explains slots and shows, per environment: average and busiest-hour demand, the recommended **baseline / commitment for pay as you go, 1-year and 3-year**, the max with autoscaling, the monthly cost of each plan and how the environment is sized. Rules: a baseline or commitment starts at **100 slots** and grows in steps of **50**; autoscaling adds slots in steps of 50 and is always pay as you go. Where a commitment does not pay off (demand only part of the day), the page shows what a 100-slot commitment would cost instead. Override any baseline or max per environment, switch on-demand / editions, and read the assumptions (slot-hours per TiB, scan by job type, batch window, business hours, reference month).

### Charge-back

For the CFO / CDO once the customer has bought Google Cloud with its discounts:

1. **Price book** - *Download template (Excel)* lists every service the tool prices with its unit and list price. Enter the negotiated unit prices and upload the file - or upload a **CSV**, paste a **Google Sheets link** (shared as *Anyone with the link can view*), or upload a **PDF quote or a scanned / photographed price sheet** (read with Gemini 3.8 Flash). Review the prices and the matching to the tool's services, then **Save price book** (shared with everyone using Charge-back).
2. **Price a request** - department, request, the data sources to ingest (kind, how many, new data per day, history), pipelines, dashboards, report users, ad-hoc reports and AI use cases. The services, quantity per month, negotiated unit price (list price struck through) and monthly cost update as you type. Shared platform items (network, encryption keys, data discovery) are paid centrally unless you include them.
3. **Ledger** - save requests; the ledger totals the monthly charge per department and downloads as CSV.

### Who is using the tool

On the first visit everyone is asked for their **name and work email** (no sign-in); the initials appear in the top bar (click to change). Every API call is logged in Cloud Logging, and visits, module opens, exports and charge-back actions are kept as usage events. **Usage (admin)** shows people, first and last activity, active days, top actions and recent activity - enter the admin key printed by `deploy.sh`.

### Architecture diagram

The diagram follows the enterprise reference flow left to right: **sources → private connectivity / Apigee → ingestion & CDC → land (Cloud Storage raw zone) → processing → BigQuery lakehouse (bronze / silver / gold) → BI, AI, APIs and operational databases**. Batch and file flows land in the raw zone first; CDC and streaming go straight to bronze. Columns that are not needed disappear, ingestion and processing boxes sit next to the sources they serve so lines do not cross, and labels are fitted to their boxes (hover any box for its full text).

Every box carries an icon for its kind of service; install Google's official product icons with `tools/install_gcp_icons.py` (see [deployment](deployment.md#official-product-icons)) to show them instead. Below the diagram, **Products in this architecture** lists and counts every product - connectivity, ingestion and processing, storage, transformation and orchestration, analytics / AI / APIs / databases, governance and security, and the platform foundation - and *How the bronze, silver and gold sizes are calculated* explains the layer volumes.

Underneath are two bands:

- **Governance & security** - the controls you added, plus dashed *Recommended* chips for enterprise controls that are still missing (Knowledge Catalog, policy tags / masking, CMEK, VPC Service Controls, Sensitive Data Protection). Click one to add it - it is priced and appears in the checklist.
- **Platform foundation & operations** - the landing-zone practices every enterprise deployment needs (org policies and projects per environment, IAM and Workload Identity, Terraform + Cloud Build, Logging & Monitoring, backup & DR, FinOps guardrails). They are not separately priced.

A legend explains the line styles. AI components show the Gemini model in use - **Gemini 3.8 Flash** by default (Gemini 3.5 Flash-Lite and Gemini 3.1 Pro preview can be chosen per agent component).

### Kickoff readiness

The **Kickoff** module turns the finalised architecture into what must be ready before the project starts:

- **Kickoff checklist** - grouped by area (programme & commercial, cloud foundation, network, each source system, data platform, security & governance, analytics & AI, operations) with owner (**Customer, Partner or Joint**), why it matters, when it is due and whether it is **critical**. Items appear only when the architecture needs them - for example CDC prerequisites per database, SLT for SAP, Interconnect lead time for on-prem sources, CMEK key owners when CMEK is added, an AI evaluation set when agents are added. Tick items as they are done (saved with the scenario) and filter by owner to send each party its list.
- **Milestones** - from mobilisation and landing zone to first data live, first dashboards, first agents, all sources live, the commitment decision and hypercare, each with exit criteria and deliverables, following the Roadmap months.
- **Team & skills** - partner roles (architect, platform, data and analytics engineers, BI, AI / ML, API, security, QA) with head-count, skills taken from the chosen patterns and products, and when they are needed; plus the customer roles. Change the number of squads on the Roadmap to trade speed for team size.

**Download CSV** exports the checklist, milestones and team; the Sheets export adds *Kickoff readiness* and *Team & skills* sheets, the Slides deck adds *Kickoff readiness & delivery team* and *Milestones & exit criteria*, and the proposal's last page summarises the team and the critical items.

### Proposal (up to 15 pages)

Open **Proposal**, fill in who prepared it (name and company) and tick the sections to include: cover, executive summary, current landscape & scope, target architecture, ingestion & data movement, lakehouse / governance / security, analytics / AI / integration, environments, BigQuery capacity, commercial options, product breakdown, monthly ramp-up, roadmap, assumptions and next steps. The preview is laid out as A4 pages and is capped at **15 pages** - long tables are trimmed with a pointer to the exports. Download it as **PDF** (print), **Word (.docx)** or create it in **Google Docs**.

### Feedback

When a feedback form is configured (see [deployment](deployment.md#trial-for-business-users)), a **Feedback** button appears in the header and opens the form in a new tab.

## 5b. Tabs (detail)

The **Consumption estimate** tab includes cost **by environment** and the **bill of materials**: product, quantity per month (month 12) and for year 1, unit, blended unit price, month-12 / year-1 / 3-year cost, and why the service is needed (with the sources that drive it).

| Tab | Use it to |
|---|---|
| **Architecture** | Search and add products; walk the end-to-end flow on the white, presentation-ready canvas |
| **Ingestion patterns** | Explain per-source choices: pattern, service chain, rationale, alternatives, discovery checks |
| **Integrations** | Show how each selected tool connects to BigQuery, with cost for Google services |
| **Consumption estimate** | 1-year and 3-year totals with commitments, by capability, service, region and source |
| **Workload sizing** | Estimate from what the customer will run (see below) |
| **Roadmap** | Final architecture, month-by-month plan and ramped consumption (see below) |
| **Assumptions** | Every sizing constant and price source |

## 6. Workload sizing

Use when the customer describes workloads rather than systems, e.g. *"100 pipelines, 25 complex and 20 simple queries, 100 yearly heavy queries, 10 ad-hoc reports, 25 dashboards, 50 TB (20 TB unstructured, 10 TB semi-structured), 100 GB telemetry, and for the first two months 110 GB and one report"*. The defaults are exactly that example.

- **Data estate**: TB by type. Structured and semi-structured go to BigQuery; unstructured to Cloud Storage with BigQuery object tables.
- **Telemetry**: GB per day or month, retention, optional in-flight transform (Dataflow).
- **Pipelines**: counts by complexity, runs per day, and engine (ELT in BigQuery or ETL on Dataflow).
- **Queries & reports**: count, frequency (hourly … yearly) and GB scanned per run for simple, complex, heavy/periodic and ad-hoc.
- **Dashboards**: count, refreshes, queries per refresh, GB per query, cache / BI Engine hit rate.
- **Ramp-up phase**: months, data volume, pipelines and reports during ramp-up.
- **Regions & pricing**: separate regions for data & queries, pipelines and streaming; on-demand or editions (with slot-hours per TiB); option to include the components from the Architecture tab.

Every volume field has a unit selector (KB … ZB).

Results: ramp-up and steady-state monthly cost, 1-year and 3-year totals, by category, monthly chart, on-demand vs editions comparison, line items and by region.

### BigQuery slot sizing

From the same inputs the tool sizes slots: each job type's monthly TiB × slot-hours per TiB, placed in an average day (pipelines and heavy periodic jobs in the batch window, dashboards, interactive and ad-hoc queries over business hours, with a busiest-hour factor). It reports average and peak slots, the burst a heavy query needs to finish in the target time, the **max autoscale** reservation (50-slot steps) and the **baseline** that minimises baseline-commitment + autoscaling cost. The **edition** is chosen from the architecture (Enterprise for VPC-SC, CMEK, column/row security, BigQuery ML, BI Engine; Enterprise Plus for Assured Workloads / managed DR; Standard otherwise - Standard has no baseline or commitments and a 1,600-slot limit), and on-demand is recommended when it is cheaper. **Use in the consumption estimate** makes the main estimate size BigQuery from this workload (scan basis *Workload sizing tab*) with the recommended model, so the two views agree.

## 7. Roadmap

Generated automatically from the sources and components:

- **Month 1** foundation (landing zone, IAM, networking, VPC-SC, CMEK, datasets, Dataform CI/CD, catalog).
- **Source waves** built by parallel **delivery squads** (selectable), quick wins first; each source goes live in the month its build ends.
- **Component rollout**: BI with the first live source, databases a month later, agents / GPU serving / Apigee once half the sources are live, Gemini Enterprise a month after agents, governance from month 1.
- **Ramped consumption**: each service starts costing when it goes live, shown as a stacked monthly chart against the steady-state run-rate, plus a month table with what goes live and cumulative spend.

## 8. Export and save

**Export**:

- **Google Sheets** - a workbook with summary, the architecture picture and layer list, sources and patterns, bill of materials, monthly consumption, **pricing plans** (plus one sheet per plan - PAYG 1 year, 1-year commitment, 3-year commitment - with every product per month), environments, workload and slot sizing, roadmap and assumptions, with native charts.
- **Google Slides** - a customer deck: title, target architecture, ingestion patterns, integrations, consumption KPIs and charts, **commercial options** (PAYG vs 1- and 3-year commitments by year), environments, bill of materials, slot sizing, roadmap, assumptions and next steps.

Choose **Create in my Google Drive** to upload and convert to Sheets / Slides (needs an OAuth client ID once - see [deployment](deployment.md#google-sheets--slides-export)), or **Download** the .xlsx / .pptx and open it with Google Sheets / Slides.

Also: Markdown proposal, CSV (includes the bill of materials), scenario JSON, architecture SVG, print/PDF. **Open scenario** reloads a saved JSON.

**Scenarios** (signed in):

- **Save** (Ctrl/⌘ S) stores the scenario in the cloud; every save is a new **version** with an optional note. The menu shows the title, version and whether there are unsaved changes.
- **Save as a copy** creates an option B to work on separately.
- **Open saved scenario** lists your scenarios and those shared with you, with year-1 and 3-year totals.
- **Version history**: view any earlier version (Save then restores it as a new version - nothing is overwritten) or compare it with the current one.
- **Share** with people (view or edit) or with anyone signed in who has the link; the link opens the scenario directly. If someone else saved meanwhile, you are offered to save a copy instead of overwriting.
- **Compare scenarios**: any two of - the current scenario, the current one with on-demand or editions BigQuery, production only, saved scenarios, versions and samples - side by side for every pricing option, with BigQuery set-up, capability totals and the products that differ most.

## Good practice

- Present numbers as a **range** and state region, growth and commitment assumptions.
- Keep data residency in mind when choosing different regions per service; the tool flags cross-region processing.
- Validate in the Pricing Calculator before a formal proposal.
