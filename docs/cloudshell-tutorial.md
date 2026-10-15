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

Run the deployment script. It enables the APIs, builds the container with Cloud Build and deploys it to Cloud Run:

```sh
./deploy.sh
```

Options:

- `--region me-central2` deploys to another region (default `us-central1`).
- `--private` keeps the service private (IAM authentication required).
- `--service my-name` changes the Cloud Run service name.

The first build takes about 3 minutes.

## Open the app

When the script finishes it prints the service URL. Open it, click **Load sample** and pick a customer scenario to see the tool in action.

If you deployed with `--private`, open it through a local proxy:

```sh
gcloud run services proxy ingestion-advisor --region us-central1
```

and then use the web preview on port 8080 <walkthrough-web-preview-icon></walkthrough-web-preview-icon>.

## Done

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>

Data Cloud Compass is running. To update it later, pull the latest code and run `./deploy.sh` again.

- Update list prices in `app/data/pricing.json` and regions in `app/data/regions.json`.
- Set up continuous deployment with `cloudbuild.yaml` (see `docs/deployment.md`).
