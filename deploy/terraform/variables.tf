variable "project_id" {
  type        = string
  description = "Google Cloud project to deploy into."
}

variable "region" {
  type        = string
  default     = "us-central1"
  description = "Cloud Run / Artifact Registry region."
}

variable "service_name" {
  type    = string
  default = "ingestion-advisor"
}

variable "image" {
  type        = string
  description = "Container image, e.g. us-central1-docker.pkg.dev/PROJECT/ingestion-advisor/app:TAG"
}

variable "public" {
  type        = bool
  default     = true
  description = "Allow unauthenticated access. Set false and use `invokers` (or IAP) to restrict."
}

variable "invokers" {
  type        = list(string)
  default     = []
  description = "IAM members allowed to invoke the service, e.g. [\"group:architects@example.com\"]."
}

variable "github_owner" {
  type        = string
  default     = ""
  description = "GitHub owner for a Cloud Build CD trigger (leave empty to skip). The repo must be connected to Cloud Build first."
}

variable "github_repo" {
  type    = string
  default = "jithinsl27-gcp-ingestion-advisor"
}
