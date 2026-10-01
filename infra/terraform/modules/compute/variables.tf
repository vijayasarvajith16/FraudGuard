variable "tenancy_ocid" {
  description = "Tenancy OCID, used to list the availability domains."
  type        = string
}

variable "compartment_ocid" {
  description = "Compartment for the instance."
  type        = string
}

variable "subnet_id" {
  description = "Subnet for the instance's primary VNIC."
  type        = string
}

variable "name" {
  description = "Display name and hostname label of the VM."
  type        = string
}

variable "shape" {
  description = "Instance shape. VM.Standard.A1.Flex is the Always Free Ampere shape."
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "availability_domain_index" {
  description = "0-based index into the region's availability domains."
  type        = number
}

variable "ocpus" {
  description = "OCPUs for the flexible shape."
  type        = number
}

variable "memory_gbs" {
  description = "Memory in GB for the flexible shape."
  type        = number
}

variable "boot_volume_gbs" {
  description = "Boot volume size in GB."
  type        = number
}

variable "ssh_public_key" {
  description = "OpenSSH public key for the ubuntu user."
  type        = string
}

variable "user_data" {
  description = "Base64-encoded cloud-init."
  type        = string
}
