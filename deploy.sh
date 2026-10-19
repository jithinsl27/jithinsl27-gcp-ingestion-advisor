#!/usr/bin/env bash
# One-command deployment of Data Cloud Compass to Cloud Run (run it in Cloud Shell).
#
# Usage:
#   ./deploy.sh --project PROJECT_ID [--region us-central1] [--service data-cloud-compass]
#               [--oauth-client-id CLIENT_ID] [--allowed-domains example.com,partner.com]
#               [--firestore-location LOCATION] [--cors-origins https://you.github.io] [--private]
#               [--feedback-url https://forms.gle/...] [--admin-key KEY]
#
# What it sets up (idempotent - safe to re-run for every release):
#   * APIs: Cloud Run, Cloud Build, Artifact Registry, Firestore, Vertex AI, Cloud Billing,
#     Secret Manager, API Keys
#   * Firestore (native mode) for saved scenarios, versions and sharing
#   * a runtime service account with only what the app needs (Firestore, Vertex AI, the secret)
#   * a Cloud Billing API key (in Secret Manager) for live list prices and region availability
#   * the Cloud Run service, built from this folder
#
# Sign-in (needed for saving, sharing and the AI assist): create an OAuth client ID
# (APIs & Services -> Credentials -> Create credentials -> OAuth client ID -> Web application),
# add the Cloud Run URL (and your GitHub Pages URL) as Authorised JavaScript origins, then
# re-run with --oauth-client-id. The same client also enables "Create in my Google Drive".
set -euo pipefail

# IAM is eventually consistent: a just-created service account can take a minute to be usable.
retry() { local n=0; until "$@"; do n=$((n+1)); [[ $n -ge 8 ]] && return 1; echo "    waiting for IAM to propagate (retry $n)..."; sleep 10; done; }

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-data-cloud-compass}"
PUBLIC=true
OAUTH_CLIENT_ID="${GOOGLE_OAUTH_CLIENT_ID:-}"
ALLOWED_DOMAINS="${ALLOWED_DOMAINS:-}"
FS_LOCATION=""
CORS_ORIGINS="${CORS_ORIGINS:-https://jithinsl27.github.io}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.8-flash}"
FEEDBACK_URL="${FEEDBACK_URL:-}"
ADMIN_KEY="${ADMIN_KEY:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT_ID="$2"; shift 2 ;;
    --region)  REGION="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --private) PUBLIC=false; shift ;;
    --oauth-client-id) OAUTH_CLIENT_ID="$2"; shift 2 ;;
    --allowed-domains) ALLOWED_DOMAINS="$2"; shift 2 ;;
    --firestore-location) FS_LOCATION="$2"; shift 2 ;;
    --cors-origins) CORS_ORIGINS="$2"; shift 2 ;;
    --gemini-model) GEMINI_MODEL="$2"; shift 2 ;;
    --feedback-url) FEEDBACK_URL="$2"; shift 2 ;;
    --admin-key) ADMIN_KEY="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${PROJECT_ID}" ]]; then
  echo "No project set. Run: gcloud config set project YOUR_PROJECT_ID  (or pass --project)" >&2
  exit 1
fi
FS_LOCATION="${FS_LOCATION:-${REGION}}"
SA_NAME="compass-run"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SECRET="compass-billing-api-key"

echo "==> Project ${PROJECT_ID} | region ${REGION} | service ${SERVICE} | public ${PUBLIC}"
gcloud config set project "${PROJECT_ID}" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"

echo "==> Enabling APIs..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  firestore.googleapis.com aiplatform.googleapis.com cloudbilling.googleapis.com secretmanager.googleapis.com \
  apikeys.googleapis.com iam.googleapis.com --quiet

echo "==> Firestore (saved scenarios)..."
if ! gcloud firestore databases describe --database="(default)" >/dev/null 2>&1; then
  if ! gcloud firestore databases create --database="(default)" --location="${FS_LOCATION}" --type=firestore-native --quiet; then
    echo "    Firestore is not offered in ${FS_LOCATION}; using nam5 (US multi-region). Pass --firestore-location to choose another."
    gcloud firestore databases create --database="(default)" --location=nam5 --type=firestore-native --quiet
  fi
else
  echo "    already exists"
fi

echo "==> Runtime service account ${SA}..."
gcloud iam service-accounts describe "${SA}" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "${SA_NAME}" --display-name="Data Cloud Compass (Cloud Run)" --quiet
for role in roles/datastore.user roles/aiplatform.user roles/logging.logWriter; do
  retry gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${SA}" --role="${role}" --condition=None --quiet >/dev/null
done

echo "==> Cloud Billing API key for live prices (Secret Manager: ${SECRET})..."
SECRET_FLAG=""
if gcloud secrets describe "${SECRET}" >/dev/null 2>&1; then
  SECRET_FLAG="--set-secrets=BILLING_API_KEY=${SECRET}:latest"
else
  gcloud services api-keys create --display-name="compass-billing-catalog" \
      --api-target=service=cloudbilling.googleapis.com --quiet >/dev/null 2>&1 || true
  KEY_NAME="$(gcloud services api-keys list --filter='displayName=compass-billing-catalog' --format='value(name)' --limit=1 2>/dev/null || true)"
  if [[ -n "${KEY_NAME}" ]]; then
    KEY="$(gcloud services api-keys get-key-string "${KEY_NAME}" --format='value(keyString)')"
    printf '%s' "${KEY}" | gcloud secrets create "${SECRET}" --data-file=- --replication-policy=automatic --quiet >/dev/null
    SECRET_FLAG="--set-secrets=BILLING_API_KEY=${SECRET}:latest"
  else
    echo "    Could not create an API key - live prices will use the service account's own token instead."
  fi
fi
if [[ -n "${SECRET_FLAG}" ]]; then
  retry gcloud secrets add-iam-policy-binding "${SECRET}" --member="serviceAccount:${SA}" \
    --role=roles/secretmanager.secretAccessor --quiet >/dev/null
fi

# Cloud Build (deploy --source) builds with the default compute service account
CB_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for role in roles/storage.objectViewer roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${CB_SA}" --role="${role}" --condition=None --quiet >/dev/null 2>&1 || true
done

# Keep the feedback link and admin key from the previous deploy unless new ones are given
existing_env() {   # $1 = variable, $2 = service (default: this one)
  gcloud run services describe "${2:-${SERVICE}}" --region "${REGION}" --format=json 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    env = {e['name']: e.get('value', '') for e in d['spec']['template']['spec']['containers'][0].get('env', [])}
    print(env.get('$1', ''))
except Exception:
    print('')" 2>/dev/null || true
}
[[ -z "${FEEDBACK_URL}" ]] && FEEDBACK_URL="$(existing_env FEEDBACK_URL)"
[[ -z "${ADMIN_KEY}" ]] && ADMIN_KEY="$(existing_env ADMIN_KEY)"
# moving from the old service name (ingestion-advisor): carry its settings over
[[ -z "${FEEDBACK_URL}" ]] && FEEDBACK_URL="$(existing_env FEEDBACK_URL ingestion-advisor)"
[[ -z "${ADMIN_KEY}" ]] && ADMIN_KEY="$(existing_env ADMIN_KEY ingestion-advisor)"
[[ -z "${ADMIN_KEY}" ]] && ADMIN_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')"

AUTH_FLAG="--no-allow-unauthenticated"
${PUBLIC} && AUTH_FLAG="--allow-unauthenticated"
VERSION="$(git rev-parse --short HEAD 2>/dev/null || echo 2.0.0)"
# ^@^ = use @ between variables, so values may contain commas
ENV_VARS="^@^APP_VERSION=${VERSION}@STORE=firestore@GOOGLE_CLOUD_PROJECT=${PROJECT_ID}@GEMINI_MODEL=${GEMINI_MODEL}@GEMINI_LOCATION=global@LIVE_PRICING=auto"
ENV_VARS="${ENV_VARS}@GOOGLE_OAUTH_CLIENT_ID=${OAUTH_CLIENT_ID}@ALLOWED_DOMAINS=${ALLOWED_DOMAINS}@CORS_ORIGINS=${CORS_ORIGINS}"
ENV_VARS="${ENV_VARS}@FEEDBACK_URL=${FEEDBACK_URL}@ADMIN_KEY=${ADMIN_KEY}"

echo "==> Building and deploying (about 3 minutes the first time)..."
gcloud run deploy "${SERVICE}" \
  --source . \
  --region "${REGION}" \
  --platform managed \
  ${AUTH_FLAG} \
  --service-account "${SA}" \
  --memory 1Gi --cpu 1 \
  --min-instances 0 --max-instances 5 \
  --set-env-vars "${ENV_VARS}" \
  ${SECRET_FLAG} \
  --quiet

URL="$(gcloud run services describe "${SERVICE}" --region "${REGION}" --format='value(status.url)')"
echo ""
echo "Deployed: ${URL}"
echo "Live prices load in the background after the first request: ${URL}/api/pricing/status"
echo ""
echo "Share this link with business users (no console access needed): ${URL}"
echo "Usage admin key (open Usage (admin) in the app): ${ADMIN_KEY}"
echo "Request logs: Cloud Logging, filter  jsonPayload.kind=\"compass_request\""
[[ -z "${FEEDBACK_URL}" ]] && echo "Feedback button: re-run with --feedback-url https://forms.gle/... to show it"
if [[ -z "${OAUTH_CLIENT_ID}" ]]; then
  echo ""
  echo "Sign-in is off (saving, sharing and the AI assist need it). To turn it on:"
  echo "  1. Console -> APIs & Services -> Credentials -> Create credentials -> OAuth client ID -> Web application"
  echo "  2. Authorised JavaScript origins: ${URL}  and  ${CORS_ORIGINS}"
  echo "  3. ./deploy.sh --project ${PROJECT_ID} --region ${REGION} --oauth-client-id <CLIENT_ID> [--allowed-domains yourcompany.com]"
else
  echo "Sign-in is on. ${URL} and ${CORS_ORIGINS} must be Authorised JavaScript origins of the OAuth client."
fi
echo ""
echo "Point the public demo (GitHub Pages) at this service, once:"
echo "  gh variable set COMPASS_API_URL --body '${URL}'   (or GitHub -> Settings -> Secrets and variables -> Actions -> Variables)"
echo "Automatic deploys from GitHub on every push to main:  ./setup-github-deploy.sh --project ${PROJECT_ID} --region ${REGION}"
if ! ${PUBLIC}; then
  echo "The service is private: open it with  gcloud run services proxy ${SERVICE} --region ${REGION}"
fi
