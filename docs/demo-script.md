# Demo script (about 15 minutes)

Uses the **Retail Bank (KSA)** sample, which opens by default on first visit.

## 1. Frame the problem (1 min)

"Core banking on Oracle, cards on SQL Server, Kafka events, regulatory files, Salesforce and app analytics. Your analysts use Power BI today, and you want governed AI agents. Let's see how it all lands on BigQuery in Dammam, what it costs, and how we'd roll it out."

## 2. Architecture (3 min) - *Architecture* tab

- Green dashed lines are CDC/streaming (Oracle, Kafka); orange lines are scheduled batch.
- On-prem systems share an HA VPN; raise core banking to 1,500 GB/day and it switches to Interconnect.
- BigQuery in me-central2 with Dataform, orchestration, BigQuery ML and reverse ETL built in.
- Right column: Looker *and* Power BI (partner, dashed, not costed), agents, Gemini Enterprise, GPU endpoint, Apigee, AlloyDB.
- **Live**: drag *Tableau* or *AWS SageMaker* from the library onto the diagram; show the new connection and that cost does not change.

## 3. Why these tools (2 min) - *Ingestion patterns* tab

Oracle → Datastream (ARCHIVELOG/supplemental logging caveat); Kafka → Dataflow template; Salesforce and GA4 → Data Transfer Service at no transfer charge.

## 4. Integrations (3 min) - *Integrations* tab

- Power BI: BigQuery connector with the Storage Read API, Import vs DirectQuery, BI Engine to control cost.
- Agents on Agent Platform call BigQuery through MCP tools under the user's own permissions; Apigee in front for quotas, token limits and Model Armor.
- AlloyDB as the low-latency serving and vector store for agents, fed by reverse ETL.
- Knowledge Catalog lineage and quality scores as the trust layer.

## 5. Regions (1 min)

Open the Vertex AI GPU endpoint and set its region to `us-central1` while BigQuery stays in Dammam; the *By region* table splits the cost. Mention data-residency review for anything leaving the Kingdom.

## 6. Commercials (2 min) - *Consumption estimate* and *Workload sizing*

- 1-year and 3-year, pay-as-you-go vs commitments, by capability and region; switch currency to SAR.
- Workload sizing: walk the customer's own numbers (pipelines, queries, dashboards, 50 TB, telemetry, 2-month ramp) and the on-demand vs editions comparison.

## 7. Roadmap (2 min) - *Roadmap* tab

Final architecture, the month-by-month plan, and ramped monthly spend vs steady state. Change squads from 2 to 3 to shorten the programme. Close by exporting the Markdown proposal.
