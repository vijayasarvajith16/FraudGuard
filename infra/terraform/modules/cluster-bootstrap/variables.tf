variable "k3s_version" {
  description = "k3s release to install, e.g. v1.36.4+k3s1."
  type        = string

  validation {
    condition     = can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+\\+k3s[0-9]+$", var.k3s_version))
    error_message = "k3s_version must look like v1.36.4+k3s1."
  }
}

variable "argocd_version" {
  description = "Argo CD release to install, e.g. v3.5.3."
  type        = string

  validation {
    condition     = can(regex("^v[0-9]+\\.[0-9]+\\.[0-9]+$", var.argocd_version))
    error_message = "argocd_version must look like v3.5.3."
  }
}

variable "argocd_manifest_sha256" {
  description = "Expected SHA-256 of Argo CD's manifests/install.yaml for argocd_version."
  type        = string
}
