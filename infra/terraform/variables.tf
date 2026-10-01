# ---- account -----------------------------------------------------------------------------------

variable "region" {
  description = "OCI region identifier, e.g. eu-frankfurt-1. Always Free Arm capacity is only in your home region."
  type        = string
}

variable "oci_config_profile" {
  description = "Profile in ~/.oci/config holding the API key used by Terraform."
  type        = string
  default     = "DEFAULT"
}

variable "tenancy_ocid" {
  description = "Tenancy OCID (an identifier, not a secret): used to list the availability domains."
  type        = string

  validation {
    condition     = startswith(var.tenancy_ocid, "ocid1.tenancy.")
    error_message = "tenancy_ocid must be a tenancy OCID (ocid1.tenancy...)."
  }
}

variable "compartment_ocid" {
  description = "Compartment that will contain every resource. A dedicated compartment makes teardown auditing easy."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.(compartment|tenancy)\\.", var.compartment_ocid))
    error_message = "compartment_ocid must be a compartment (or tenancy) OCID."
  }
}

# ---- access ------------------------------------------------------------------------------------

variable "ssh_public_key_path" {
  description = "Path to the SSH public key installed for the ubuntu user."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "admin_cidrs" {
  description = "CIDRs allowed to reach SSH (22) and the Kubernetes API (6443), e.g. [\"203.0.113.7/32\"]: your public IP. Web traffic (80/443) is open to everyone."
  type        = list(string)

  validation {
    condition     = length(var.admin_cidrs) > 0 && alltrue([for c in var.admin_cidrs : can(cidrhost(c, 0))])
    error_message = "admin_cidrs needs at least one valid CIDR."
  }

  validation {
    condition     = !contains(var.admin_cidrs, "0.0.0.0/0")
    error_message = "Refusing to expose SSH and the Kubernetes API to the whole internet: list your own IP(s) in admin_cidrs."
  }
}

# ---- sizing (Always Free) ----------------------------------------------------------------------

variable "name_prefix" {
  description = "Prefix for resource names and the VM hostname."
  type        = string
  default     = "fraudguard"
}

variable "vcn_cidr" {
  description = "Address space of the VCN; the public subnet uses its first /24."
  type        = string
  default     = "10.20.0.0/16"
}

variable "availability_domain_index" {
  description = "Which availability domain to use (0-based). Try another if apply reports 'Out of host capacity'."
  type        = number
  default     = 0
}

variable "instance_ocpus" {
  description = "Ampere A1 OCPUs. Always Free allows 4 in total across all A1 instances."
  type        = number
  default     = 2

  validation {
    condition     = var.instance_ocpus >= 1 && var.instance_ocpus <= 4
    error_message = "instance_ocpus must be 1-4 to stay within the Always Free Ampere allowance."
  }
}

variable "instance_memory_gbs" {
  description = "Memory in GB. Always Free allows 24 GB in total across all A1 instances."
  type        = number
  default     = 12

  validation {
    condition     = var.instance_memory_gbs >= 6 && var.instance_memory_gbs <= 24
    error_message = "instance_memory_gbs must be 6-24 (k3s plus the stack needs about 6 GB; Always Free caps at 24)."
  }
}

variable "boot_volume_gbs" {
  description = "Boot volume size. Always Free includes 200 GB of block storage in total."
  type        = number
  default     = 100

  validation {
    condition     = var.boot_volume_gbs >= 50 && var.boot_volume_gbs <= 200
    error_message = "boot_volume_gbs must be 50-200 (the minimum boot volume is 50 GB; Always Free covers 200 GB in total)."
  }
}

# ---- software ----------------------------------------------------------------------------------

variable "k3s_version" {
  description = "k3s release installed by the bootstrap (stable channel when this was written)."
  type        = string
  default     = "v1.36.4+k3s1"
}

variable "argocd_version" {
  description = "Argo CD release installed by the bootstrap. Changing it requires argocd_manifest_sha256 to match."
  type        = string
  default     = "v3.5.3"
}

variable "argocd_manifest_sha256" {
  description = "SHA-256 of Argo CD's manifests/install.yaml for argocd_version; the bootstrap refuses a manifest that does not match."
  type        = string
  default     = "7efe2d6bbc03f63623640f1e4198f16c84009d510fb810ef71e56df1b7614ba9"

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.argocd_manifest_sha256))
    error_message = "argocd_manifest_sha256 must be a lowercase hex SHA-256."
  }
}
