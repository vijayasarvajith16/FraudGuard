variable "compartment_ocid" {
  description = "Compartment for the network resources."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for display names."
  type        = string
}

variable "vcn_cidr" {
  description = "VCN address space; the public subnet takes its first /24."
  type        = string
}

variable "dns_label" {
  description = "VCN DNS label (letters and digits, at most 15 characters)."
  type        = string
}

variable "admin_cidrs" {
  description = "Sources allowed to reach SSH (22) and the Kubernetes API (6443)."
  type        = list(string)
}
