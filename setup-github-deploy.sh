#!/usr/bin/env bash
# One-time set-up so every push to main deploys Cloud Run from GitHub Actions - no keys stored.
# Run in Cloud Shell after ./deploy.sh has created the service:
#
#   ./setup-github-deploy.sh --project PROJECT_ID [--region us-central1] [--repo owner/name] [--service ingestion-advisor]
#
# Creates a Workload Identity Federation pool + GitHub provider (trusting only this repository),
# a deployer service account with the roles `gcloud run deploy --source` needs, and - when the
# GitHub CLI is signed in (`gh auth login`) - sets the repository variables the workflow reads.
set -euo pipefail

# IAM is eventually consistent: a just-created service account can take a minute to be usable.
retry() { local n=0; until "$@"; do n=$((n+1)); [[ $n -ge 8 ]] && return 1; echo "    waiting for IAM to propagate (retry $n)..."; sleep 10; done; }

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-ingestion-advisor}"
REPO="${REPO:-$(git config --get remote.origin.url 2>/dev/null | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ -z "${PROJECT_ID}" || -z "${REPO}" ]] && { echo "Need --project and --repo owner/name" >&2; exit 1; }

POOL="github"; PROVIDER="github"; SA_NAME="compass-deployer"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RUN_SA="compass-run@${PROJECT_ID}.iam.gserviceaccount.com"
OWNER="${REPO%%/*}"
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
gcloud config set project "${PROJECT_ID}" >/dev/null
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --quiet

echo "==> Workload Identity pool and provider for ${REPO}..."
gcloud iam workload-identity-pools describe "${POOL}" --location=global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create "${POOL}" --location=global --display-name="GitHub Actions" --quiet
gcloud iam workload-identity-pools providers describe "${PROVIDER}" --location=global --workload-identity-pool="${POOL}" >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER}" --location=global --workload-identity-pool="${POOL}" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository=='${REPO}'" --quiet

echo "==> Deployer service account ${SA}..."
gcloud iam service-accounts describe "${SA}" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "${SA_NAME}" --display-name="Data Cloud Compass deployer (GitHub Actions)" --quiet
for role in roles/run.developer roles/cloudbuild.builds.editor roles/artifactregistry.writer roles/storage.admin roles/serviceusage.serviceUsageConsumer roles/logging.viewer; do
  retry gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${SA}" --role="${role}" --condition=None --quiet >/dev/null
done
# act as the runtime service account and the Cloud Build service account
retry gcloud iam service-accounts add-iam-policy-binding "${RUN_SA}" --member="serviceAccount:${SA}" --role=roles/iam.serviceAccountUser --quiet >/dev/null
retry gcloud iam service-accounts add-iam-policy-binding "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --member="serviceAccount:${SA}" --role=roles/iam.serviceAccountUser --quiet >/dev/null
retry gcloud iam service-accounts add-iam-policy-binding "${SA}" --role=roles/iam.workloadIdentityUser --quiet >/dev/null \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}"

WIF="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --format='value(status.url)' 2>/dev/null || true)"
echo ""
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  gh variable set GCP_PROJECT_ID --body "${PROJECT_ID}" --repo "${REPO}"
  gh variable set GCP_REGION --body "${REGION}" --repo "${REPO}"
  gh variable set GCP_SERVICE --body "${SERVICE}" --repo "${REPO}"
  gh variable set GCP_WIF_PROVIDER --body "${WIF}" --repo "${REPO}"
  gh variable set GCP_DEPLOY_SA --body "${SA}" --repo "${REPO}"
  [[ -n "${URL}" ]] && gh variable set COMPASS_API_URL --body "${URL}" --repo "${REPO}"
  echo "GitHub variables set on ${REPO}. Every push to main now tests and deploys."
else
  echo "Set these GitHub repository variables (Settings -> Secrets and variables -> Actions -> Variables):"
  echo "  GCP_PROJECT_ID   = ${PROJECT_ID}"
  echo "  GCP_REGION       = ${REGION}"
  echo "  GCP_SERVICE      = ${SERVICE}"
  echo "  GCP_WIF_PROVIDER = ${WIF}"
  echo "  GCP_DEPLOY_SA    = ${SA}"
  [[ -n "${URL}" ]] && echo "  COMPASS_API_URL  = ${URL}"
  echo "(or run 'gh auth login' and re-run this script)"
fi
