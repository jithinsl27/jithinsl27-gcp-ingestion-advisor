# Infrastructure-as-code deployment of GCP Ingestion Advisor.
#
# 1. Build the image once:   gcloud builds submit --config cloudbuild.yaml   (or use deploy.sh)
# 2. terraform init && terraform apply -var project_id=... -var image=REGION-docker.pkg.dev/PROJECT/ingestion-advisor/app:TAG
#
# Optionally creates a Cloud Build trigger on your GitHub repository for continuous deployment.

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = { source = "hashicorp/google", version = ">= 5.30" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "apis" {
  for_each           = toset(["run.googleapis.com", "artifactregistry.googleapis.com", "cloudbuild.googleapis.com"])
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "repo" {
  location      = var.region
  repository_id = "ingestion-advisor"
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}

resource "google_service_account" "run" {
  account_id   = "ingestion-advisor-run"
  display_name = "Ingestion Advisor (Cloud Run runtime)"
}

resource "google_cloud_run_v2_service" "app" {
  name     = var.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.run.email
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    containers {
      image = var.image
      ports { container_port = 8080 }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
      startup_probe {
        http_get { path = "/healthz" }
      }
    }
  }
  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count    = var.public ? 1 : 0
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "invokers" {
  for_each = toset(var.invokers)
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.value
}

resource "google_cloudbuild_trigger" "main" {
  count    = var.github_owner != "" ? 1 : 0
  name     = "ingestion-advisor-main"
  location = "global"
  github {
    owner = var.github_owner
    name  = var.github_repo
    push { branch = "^main$" }
  }
  filename       = "cloudbuild.yaml"
  substitutions  = { _REGION = var.region, _SERVICE = var.service_name }
  depends_on     = [google_project_service.apis]
}

output "url" {
  value = google_cloud_run_v2_service.app.uri
}
