# Deploy Data Cloud Compass

## Welcome

This tutorial deploys Data Cloud Compass to **Cloud Run** in your Google Cloud project. It takes about 5 minutes.

Click **Start** to begin.

## Choose your project

Select the project to deploy into:

<walkthrough-project-setup></walkthrough-project-setup>

Then set it for the command line:

```sh
gcloud config set project <walkthrough-project-id/>
```

You need the **Owner** or **Editor** role (or Cloud Run Admin, Cloud Build Editor, Artifact Registry Admin and Service Usage Admin).

## Deploy

Run the deployment script. It enables the APIs, creates Firestore (saved scenarios), a runtime service account and a Cloud Billing API key for live prices, builds the container with Cloud Build and deploys it to Cloud Run:

```sh
./deploy.sh --project <walkthrough-project-id/>
```

Options:

- `--region me-central2` deploys to another region (default `us-central1`).
- `--oauth-client-id CLIENT_ID` turns on Google sign-in for saving, sharing and the AI assist (create the client under APIs & Services → Credentials; see `docs/deployment.md`).
- `--allowed-domains yourcompany.com` limits sign-in to your domains.
- `--private` keeps the service private (IAM authentication required).

The first build takes about 3 minutes.

## Open the app

When the script finishes it prints the service URL. Open it, click **Load sample** and pick a customer scenario to see the tool in action.

If you deployed with `--private`, open it through a local proxy:

```sh
gcloud run services proxy data-cloud-compass --region us-central1
```

and then use the web preview on port 8080 <walkthrough-web-preview-icon></walkthrough-web-preview-icon>.

## Done

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>

Data Cloud Compass is running. To update it later, pull the latest code and run `./deploy.sh` again.

- Prices refresh daily from the Cloud Billing Catalog (`/api/pricing/status`); `app/data/pricing.json` is the reviewed fallback.
- Deploy automatically on every push to GitHub: `./setup-github-deploy.sh --project <walkthrough-project-id/>` (see `docs/deployment.md`).
- Point the public demo at this service: set the GitHub repository variable `COMPASS_API_URL` to the URL.
