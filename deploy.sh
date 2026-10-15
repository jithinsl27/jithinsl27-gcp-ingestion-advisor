#!/usr/bin/env bash
# One-command deployment of Data Cloud Compass to Cloud Run.
#
# Usage:  ./deploy.sh [--project PROJECT_ID] [--region REGION] [--service NAME] [--private]
#
# * Uses the active gcloud project if --project is not given.
# * Enables the required APIs, builds the container with Cloud Build
#   (no local Docker needed) and deploys it to Cloud Run.
# * --private  : require IAM authentication (no public URL access).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-ingestion-advisor}"
PUBLIC=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT_ID="$2"; shift 2 ;;
    --region)  REGION="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --private) PUBLIC=false; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${PROJECT_ID}" ]]; then
  echo "No project set. Run: gcloud config set project YOUR_PROJECT_ID  (or pass --project)" >&2
  exit 1
fi

echo "==> Project: ${PROJECT_ID} | Region: ${REGION} | Service: ${SERVICE} | Public: ${PUBLIC}"
gcloud config set project "${PROJECT_ID}" >/dev/null

echo "==> Enabling APIs (Cloud Run, Cloud Build, Artifact Registry)..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --quiet

AUTH_FLAG="--no-allow-unauthenticated"
${PUBLIC} && AUTH_FLAG="--allow-unauthenticated"

echo "==> Building and deploying (takes ~3 minutes the first time)..."
gcloud run deploy "${SERVICE}" \
  --source . \
  --region "${REGION}" \
  --platform managed \
  ${AUTH_FLAG} \
  --memory 512Mi --cpu 1 \
  --min-instances 0 --max-instances 3 \
  --set-env-vars "APP_VERSION=$(git rev-parse --short HEAD 2>/dev/null || echo 1.0.0)" \
  --quiet

URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --format='value(status.url)')"
echo ""
echo "Deployed: ${URL}"
if ! ${PUBLIC}; then
  echo "The service is private. Open it with:  gcloud run services proxy ${SERVICE} --region ${REGION}"
  echo "or put it behind Identity-Aware Proxy (see docs/deployment.md)."
fi
