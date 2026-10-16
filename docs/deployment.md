# Deployment guide

Data Cloud Compass is a single stateless container (FastAPI + static UI) that runs on Cloud Run. It stores no customer data server-side, needs no database and scales to zero when idle, so running cost is typically a few dollars a month or less.

## Prerequisites

- A Google Cloud project with billing enabled.
- Roles: Owner/Editor, or Cloud Run Admin + Cloud Build Editor + Artifact Registry Admin + Service Usage Admin + Service Account User.
- Organisation policies: if `iam.allowedPolicyMemberDomains` (domain restricted sharing) is enforced, public (`allUsers`) access is blocked. Deploy with `--private` and use IAP or `gcloud run services proxy` instead.

## 1. Cloud Shell (fastest)

Click **Open in Cloud Shell** in the README, or:

```bash
git clone https://github.com/jithinsl27/jithinsl27-gcp-ingestion-advisor.git
cd jithinsl27-gcp-ingestion-advisor
gcloud config set project YOUR_PROJECT_ID
./deploy.sh [--region REGION] [--service NAME] [--private]
```

`deploy.sh` runs `gcloud services enable run cloudbuild artifactregistry` and `gcloud run deploy --source .`, which builds the `Dockerfile` remotely with Cloud Build and stores the image in Artifact Registry (`cloud-run-source-deploy` repository).

## 2. Run on Google Cloud button

The README button uses [Cloud Run Button](https://github.com/GoogleCloudPlatform/cloud-run-button). It clones the repo in Cloud Shell, reads `app.json` and deploys. The repository must be public for the button to clone it.

## 3. Cloud Build CI/CD

`cloudbuild.yaml` runs the tests, builds and pushes the image to Artifact Registry and deploys to Cloud Run.

Manual run:

```bash
gcloud builds submit --config cloudbuild.yaml --substitutions=_REGION=me-central2
```

Trigger on every push to `main`:

1. Console → Cloud Build → Repositories → **Connect repository** → GitHub → select `jithinsl27-gcp-ingestion-advisor`.
2. Grant the Cloud Build service account `roles/run.admin` and `roles/iam.serviceAccountUser` (and `roles/artifactregistry.admin` if the repository does not exist yet).
3. Create a trigger: event *Push to branch* `^main$`, configuration `cloudbuild.yaml`.

Substitutions: `_REGION`, `_SERVICE`, `_REPO`, `_ALLOW_UNAUTH` (set to `--no-allow-unauthenticated` for a private service).

## 4. Terraform

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars   # edit values
# build an image first (step 3) and put its URL in `image`
terraform init
terraform apply
```

Creates: required APIs, Artifact Registry repository, a dedicated runtime service account, the Cloud Run v2 service (with startup probe on `/healthz`), invoker IAM (public or a list of groups) and, if `github_owner` is set, a Cloud Build trigger.

## 5. GitHub Actions

- `ci.yml` runs tests and a Docker build on every push and pull request.
- `pages.yml` rebuilds the static demo on every push to `main` and publishes it to the `gh-pages` branch (GitHub Pages: *Settings → Pages → Deploy from a branch → gh-pages / root*).
- `deploy.yml` deploys to Cloud Run on tags `v*` or manually. Configure Workload Identity Federation once:

```bash
PROJECT_ID=your-project; REPO=jithinsl27/jithinsl27-gcp-ingestion-advisor
gcloud iam service-accounts create gh-deployer
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:gh-deployer@$PROJECT_ID.iam.gserviceaccount.com --role=roles/run.admin
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:gh-deployer@$PROJECT_ID.iam.gserviceaccount.com --role=roles/cloudbuild.builds.editor
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:gh-deployer@$PROJECT_ID.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:gh-deployer@$PROJECT_ID.iam.gserviceaccount.com --role=roles/artifactregistry.admin
gcloud projects add-iam-policy-binding $PROJECT_ID --member=serviceAccount:gh-deployer@$PROJECT_ID.iam.gserviceaccount.com --role=roles/storage.admin
gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc github --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository \
  --attribute-condition="assertion.repository=='$REPO'"
gcloud iam service-accounts add-iam-policy-binding gh-deployer@$PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"
```

Then add repository variables `GCP_PROJECT_ID`, `GCP_REGION` and secrets `GCP_WIF_PROVIDER` (`projects/NUMBER/locations/global/workloadIdentityPools/github/providers/github`) and `GCP_DEPLOY_SA`.

## Restricting access

- **IAM only**: deploy with `--private`, grant `roles/run.invoker` to a group; users open it with `gcloud run services proxy`.
- **Identity-Aware Proxy (browser sign-in)**: Cloud Run supports IAP directly:

```bash
gcloud beta run services update ingestion-advisor --region REGION --iap
gcloud beta iap web add-iam-policy-binding --resource-type=cloud-run --service=ingestion-advisor --region=REGION \
  --member=group:architects@example.com --role=roles/iap.httpsResourceAccessor
```

## Trial link for business users

Business users without Google Cloud console access can use the public demo: **https://jithinsl27.github.io/jithinsl27-gcp-ingestion-advisor/**. It runs entirely in the browser (no sign-in, no data leaves the browser) and is rebuilt on every push to `main`. A Cloud Run deployment with `--allow-unauthenticated` (the `deploy.sh` default) gives the same experience on your own URL.

### Feedback button

Create a Google Form, then set its link in `app/static/config.js` (`feedbackUrl`) and push - the live demo shows a **Feedback** button. On Cloud Run you can instead set `FEEDBACK_URL` (`gcloud run services update ingestion-advisor --region REGION --update-env-vars FEEDBACK_URL=https://forms.gle/...`).

## Google Sheets / Slides export

Exports are built in the browser. **Download** always works. **Create in my Google Drive** uploads the file to the signed-in user's Drive and converts it to Google Sheets / Slides using Google Identity Services with the narrow `drive.file` scope (the app only sees files it creates). To enable it:

1. In the Google Cloud console, open **APIs & Services → OAuth consent screen** and configure it (Internal for Workspace organisations).
2. Enable the **Google Drive API**.
3. **Credentials → Create credentials → OAuth client ID → Web application**; add your Cloud Run URL (and `https://jithinsl27.github.io` for the live demo) as **Authorised JavaScript origins**.
4. Deploy with `./deploy.sh --oauth-client-id CLIENT_ID` (sets `GOOGLE_OAUTH_CLIENT_ID`, served to the page by `/api/config`), or paste the client ID in the export dialog (stored in that browser only).

No tokens or files touch the Cloud Run service.

## Data residency

The app processes only what the architect types in the browser and keeps no state server-side. Deploying in a local region (for example `me-central2` Dammam) keeps traffic in-country if required.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `PERMISSION_DENIED` enabling services | Ask a project owner to run `deploy.sh` once, or grant Service Usage Admin |
| Build fails pulling base image | Check egress/VPC-SC on Cloud Build; allow `docker.io` or mirror `python:3.12-slim` to Artifact Registry |
| `allUsers` binding fails | Domain-restricted sharing policy; redeploy with `--private` and use IAP |
| Fonts look different | The UI loads Instrument Sans from Google Fonts; offline it falls back to system fonts |
| 403 opening the URL | Service is private; use `gcloud run services proxy` or grant `roles/run.invoker` |
