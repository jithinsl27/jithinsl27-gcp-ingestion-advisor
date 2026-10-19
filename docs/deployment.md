# Deployment guide

Data Cloud Compass is one container (FastAPI + a no-build ES-module UI) on Cloud Run, with:

| Piece | Used for | Set up by |
|---|---|---|
| Cloud Run | the app and the API | `deploy.sh` |
| Firestore (native) | saved scenarios, versions, sharing; shared live-price cache | `deploy.sh` |
| Cloud Billing Catalog API + API key in Secret Manager | live list prices and regional availability, refreshed daily | `deploy.sh` |
| Vertex AI (Gemini) | AI assist: meeting notes / spreadsheets → sources and products | `deploy.sh` (API + role) |
| OAuth web client | Google sign-in (saving, sharing, AI assist) and "Create in my Google Drive" | you, once, in the console |
| Workload Identity Federation | keyless deploys from GitHub on every push | `setup-github-deploy.sh` |

It scales to zero; running cost is typically a few dollars a month plus Gemini calls (cents each).

## Prerequisites

- A Google Cloud project with billing enabled.
- Roles for the person running the scripts: Owner, or Editor + Security Admin (to grant the service-account roles) + Secret Manager Admin.
- Organisation policies: if domain-restricted sharing (`iam.allowedPolicyMemberDomains`) is enforced, public (`allUsers`) access is blocked - deploy with `--private` (see *Restricting access*).

## 1. Deploy from Cloud Shell

```bash
git clone https://github.com/jithinsl27/jithinsl27-gcp-ingestion-advisor.git
cd jithinsl27-gcp-ingestion-advisor
./deploy.sh --project YOUR_PROJECT --region us-central1
```

Options:

| Option | Default | Meaning |
|---|---|---|
| `--project` | current gcloud project | where to deploy |
| `--region` | `us-central1` | Cloud Run region (e.g. `me-central2` for KSA) |
| `--service` | `data-cloud-compass` | Cloud Run service name |
| `--oauth-client-id` | none | turns on Google sign-in (saving, sharing, AI assist, Drive export) |
| `--allowed-domains` | any Google account | comma-separated e-mail domains allowed to sign in |
| `--firestore-location` | same as `--region` (falls back to `nam5`) | where saved scenarios are stored |
| `--cors-origins` | `https://jithinsl27.github.io` | origins allowed to call the API (your GitHub Pages demo) |
| `--gemini-model` | `gemini-3.8-flash` | Gemini model for the AI assist (falls back to `gemini-2.5-flash`) |
| `--private` | public | require IAM to invoke the service |

The script is idempotent - re-run it for every release (or let GitHub deploy, section 3). In order it: enables the APIs; creates Firestore; creates the runtime service account `compass-run` with `roles/datastore.user`, `roles/aiplatform.user` and `roles/logging.logWriter`; creates an API key restricted to the Cloud Billing API and stores it in Secret Manager (`compass-billing-api-key`, readable only by `compass-run`); builds the Dockerfile with Cloud Build and deploys.

### Turn on Google sign-in

1. Console → **APIs & Services → OAuth consent screen**: configure it (*Internal* for Workspace organisations). Enable the **Google Drive API** if you want Drive exports.
2. **Credentials → Create credentials → OAuth client ID → Web application**. Authorised JavaScript origins: your Cloud Run URL and your GitHub Pages origin (`https://<owner>.github.io`).
3. `./deploy.sh --project YOUR_PROJECT --region REGION --oauth-client-id CLIENT_ID --allowed-domains yourcompany.com`

The browser signs in with Google Identity Services and sends the ID token; the service verifies it against the client ID and the allow-list. Without a client ID the app works fully for estimating - only saving, sharing and the AI assist are off (Export → Save scenario JSON still works).

### Live prices and availability

After the first request the service downloads the public SKUs it needs from the Cloud Billing Catalog in the background, applies them (a live price is only accepted within 3× of the reviewed price, guarding against a wrong SKU match) and caches the result in Firestore for 24 hours. Check `GET /api/pricing/status`: `source`, `fetched_at`, which price points matched and which did not, and any error. Until a refresh succeeds the app uses `app/data/pricing.json` and says so in the summary bar. To tune the SKU mapping, see [pricing-model.md](pricing-model.md#live-prices).

## 2. Public demo on GitHub Pages

The demo is the same front end, calling your Cloud Run service from GitHub Pages:

1. GitHub → Settings → Pages → Deploy from a branch → `gh-pages` / root.
2. Set the repository variable `COMPASS_API_URL` to the Cloud Run URL (`gh variable set COMPASS_API_URL --body https://...run.app`).
3. The `pages.yml` workflow rebuilds and publishes on every push to `main`.

The service must allow the Pages origin (`--cors-origins`, default `https://jithinsl27.github.io`). Estimate endpoints are open and store nothing; signed-in endpoints work from the demo too when the Pages origin is an authorised origin of the OAuth client.

## 3. Deploy automatically from GitHub

Run once in Cloud Shell, after `deploy.sh`:

```bash
./setup-github-deploy.sh --project YOUR_PROJECT --region us-central1   # --repo owner/name if not detected
```

It creates a Workload Identity pool and GitHub provider trusting only this repository, a deployer service account (`compass-deployer`: Cloud Run developer, Cloud Build editor, Artifact Registry writer, act-as on the runtime account) and - if the GitHub CLI is signed in - sets the repository variables `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_SERVICE`, `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA` and `COMPASS_API_URL`. No service-account keys are created.

From then on, `deploy.yml` runs the tests and deploys on every push to `main` (and tags `v*`), then smoke-tests `/healthz` and `/api/estimate`. Environment variables and secrets set by `deploy.sh` are preserved. `ci.yml` runs unit, API and browser (Playwright) tests plus a Docker build on every push and pull request.

## 4. Other options

- **Run on Google Cloud button** (README) - quick trial: deploys the container without Firestore, live prices or sign-in.
- **Cloud Build** - `gcloud builds submit --config cloudbuild.yaml --substitutions=_REGION=me-central2` (tests, build, push, deploy). Run `deploy.sh` once first so the service account, secret and environment exist.
- **Terraform** - `deploy/terraform/`: APIs, Artifact Registry, Firestore, runtime service account and roles, Cloud Run v2 service with environment, invoker IAM, optional Cloud Build trigger. Build an image first and pass it as `image`; add the Billing API key secret with `deploy.sh` or your own module.

## Trial for business users

Colleagues without Google Cloud console access can use the app straight from its **Cloud Run URL** - no console, no `gcloud`:

1. Deploy as in section 1 (`./deploy.sh --region us-central1`). The service is public by default (`--allow-unauthenticated`); estimating, pricing plans, exports to file and the proposal work without signing in.
2. Share the URL `deploy.sh` prints (`https://data-cloud-compass-….run.app`). To see it again: `gcloud run services describe data-cloud-compass --region us-central1 --format='value(status.url)'`.
3. **Feedback button** - create a Google Form, then either
   - set it on the service: `gcloud run services update data-cloud-compass --region us-central1 --update-env-vars FEEDBACK_URL=https://forms.gle/…`, or
   - set `feedbackUrl` in `app/static/config.js` and redeploy (this also applies to the GitHub Pages demo).

   A **Feedback** button then appears in the header for every user.

4. **Who used it** - the first visit asks for name and email. `deploy.sh` prints an **admin key**; open *Usage (admin)* in the app and enter it to see people and activity. It is kept across redeploys (pass `--admin-key` to set your own, `--feedback-url` to set the form). Request logs are in Cloud Logging: `jsonPayload.kind="compass_request"`. Set `IDENTITY_PROMPT=off` to stop asking for name and email.

Saving to the cloud, sharing and Drive export still need Google sign-in (an OAuth client, see above); trial users can save and reopen scenarios as JSON files instead. To stop the trial, turn on `--private` or an allow-list (below).

## Official product icons

The diagram ships with its own icons. To show Google's official product icons instead:

1. Download the Google Cloud icon pack (zip of SVGs) from https://cloud.google.com/icons and check its terms of use.
2. In Cloud Shell, in the repository: `python3 tools/install_gcp_icons.py ~/google-cloud-icons.zip` - it copies the icons that match the products used by the tool into `app/static/icons/` and writes `manifest.json`.
3. Redeploy (`./deploy.sh ...`). Products without a matching icon keep the built-in one.

## Charge-back data

The price book (Firestore `system/pricebook`) and charge-back requests (`chargeback` collection) are shared by everyone who opens the module. Reading PDFs and images uses Gemini on Vertex AI in the deployment's project (`GEMINI_MODEL`, default `gemini-3.8-flash`); Excel, CSV and Google Sheets links do not.

## Restricting access

- **Allow-list in the app** (recommended): `--allowed-domains` (or `ALLOWED_EMAILS`) restricts who can sign in, save and use the AI assist; estimates stay open.
- **IAM only**: `--private`, grant `roles/run.invoker` to a group; users open it with `gcloud run services proxy`. The GitHub Pages demo cannot reach a private service.
- **Identity-Aware Proxy**: `gcloud beta run services update data-cloud-compass --region REGION --iap` and grant `roles/iap.httpsResourceAccessor`. As with `--private`, the Pages demo cannot reach it.

## Data residency

Choose `--region` and `--firestore-location` in-country (for example `me-central2`). Saved scenarios stay in Firestore in that location. The AI assist sends the pasted notes to Gemini through Vertex AI in your project (`GEMINI_LOCATION`, default `global`; set a regional endpoint where your model is offered if residency requires it).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `PERMISSION_DENIED` enabling services or granting roles | Ask a project owner to run `deploy.sh` once |
| `/api/pricing/status` shows `last_error` | Check the `compass-billing-api-key` secret and that `cloudbilling.googleapis.com` is enabled; the app keeps using the reviewed prices meanwhile |
| Sign-in button does nothing / `origin_mismatch` | Add the exact page origin (Cloud Run URL or GitHub Pages) to the OAuth client's Authorised JavaScript origins |
| "not allowed on this deployment" after sign-in | The account's domain is not in `--allowed-domains` |
| AI assist: model not found | Pass `--gemini-model` with a model available in your project; the service also tries `gemini-2.5-flash` |
| Demo shows "not connected" | Set the `COMPASS_API_URL` repository variable and re-run the Pages workflow |
| Demo: requests blocked by CORS | Add the Pages origin with `--cors-origins` and redeploy |
| `allUsers` binding fails | Domain-restricted sharing policy; use `--private` or IAP |
