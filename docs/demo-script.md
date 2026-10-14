# Demo script (about 15 minutes)

Uses the **Retail Bank (KSA)** sample, which opens by default on first visit.

## 1. Frame the problem (1 min)

"You have core banking on Oracle, cards on SQL Server, Kafka events, regulatory files, Salesforce and app analytics. Let's see how each lands in BigQuery, what you can build on top, and what it costs in Dammam."

## 2. Architecture walk-through (3 min) - *Architecture* tab

- Dashed green lines: Oracle and Kafka are continuous (CDC / streaming). Amber lines: scheduled batch.
- On-prem systems share an HA VPN; switch the daily volume of core banking to 1,500 GB/day and show it moving to Interconnect.
- BigQuery in me-central2, then Dataform, Looker, BigQuery ML, data agents, reverse ETL, and on the right the Agent Platform, Gemini Enterprise and a GPU endpoint.
- The green band: Knowledge Catalog, Sensitive Data Protection, policy tags, CMEK, VPC-SC, IAM/SCC across every layer.

## 3. Why these tools (3 min) - *Ingestion patterns* tab

- Oracle → Datastream: log-based CDC, backfill included; caveat about ARCHIVELOG and supplemental logging.
- Kafka → Dataflow Kafka template; alternatives Managed Kafka and Pub/Sub import topics.
- Salesforce and GA4 → Data Transfer Service at no transfer charge.
- Live change: open *Cards & payments*, set freshness to **Daily** and transformation to **Heavy**: it moves from CDC to a Dataflow batch pipeline. Then set *Team skill set* to **Low-code**: it moves to Data Fusion and the shared instance cost appears in the estimate.

## 4. Agentic data cloud (4 min) - *AI, governance & security* tab

- Looker semantic layer feeding dashboards and Conversational Analytics with the same metrics.
- Agents on Agent Platform calling BigQuery through MCP tools under the user's own permissions and masking.
- Gemini Enterprise putting those agents in front of 300 employees.
- Fraud model on two L4 GPU endpoints, called from BigQuery as a remote model.
- Knowledge Catalog lineage and quality scores as the trust layer for agent answers.

## 5. Commercials (3 min) - *Consumption estimate* tab

- 1-year and 3-year totals, pay-as-you-go versus commitments, and the discussion range.
- By capability: ingestion versus BigQuery versus AI.
- Switch currency to SAR. Switch region to `us-central1` to show the regional difference, then back.
- Switch BigQuery to on-demand to compare with Enterprise edition slots.

## 6. Close (1 min)

Export the Markdown proposal and scenario JSON; agree next steps: confirm volumes, CDC prerequisites, licences (Looker quote, SAP SLT), and a Pricing Calculator validation.
