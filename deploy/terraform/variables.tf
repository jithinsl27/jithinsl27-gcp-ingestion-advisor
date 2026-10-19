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
  default = "data-cloud-compass"
}

variable "image" {
  type        = string
  description = "Container image, e.g. us-central1-docker.pkg.dev/PROJECT/data-cloud-compass/app:TAG"
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

variable "firestore_location" {
  type        = string
  default     = "nam5"
  description = "Firestore location for saved scenarios (a region such as me-central2, or nam5 / eur3)."
}

variable "oauth_client_id" {
  type        = string
  default     = ""
  description = "OAuth web client ID for Google sign-in (saving, sharing, AI assist, Drive export). Empty = sign-in off."
}

variable "allowed_domains" {
  type        = string
  default     = ""
  description = "Comma-separated e-mail domains allowed to sign in (empty = any Google account)."
}

variable "cors_origins" {
  type        = string
  default     = "https://jithinsl27.github.io"
  description = "Origins allowed to call the API (the GitHub Pages demo)."
}

variable "gemini_model" {
  type    = string
  default = "gemini-3.8-flash"
}
