# One Always Free Ampere A1 (Arm) VM running the latest Ubuntu 24.04 image, bootstrapped by cloud-init.

terraform {
  required_providers {
    oci = { source = "oracle/oci" }
  }
}

data "oci_identity_availability_domains" "this" {
  compartment_id = var.tenancy_ocid
}

# Newest Ubuntu 24.04 Arm image compatible with the shape (the regular image, not "Minimal", which
# lacks the iptables persistence files the bootstrap edits).
data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = var.shape
  state                    = "AVAILABLE"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"

  filter {
    name   = "display_name"
    values = ["^Canonical-Ubuntu-24\\.04-aarch64-[0-9]"]
    regex  = true
  }
}

locals {
  availability_domains = data.oci_identity_availability_domains.this.availability_domains
}

resource "oci_core_instance" "this" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domains[var.availability_domain_index].name
  display_name        = var.name
  shape               = var.shape

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gbs
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gbs
  }

  create_vnic_details {
    subnet_id        = var.subnet_id
    assign_public_ip = true
    hostname_label   = var.name
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = var.user_data
  }

  # Only the authenticated (v2) instance metadata endpoint.
  instance_options {
    are_legacy_imds_endpoints_disabled = true
  }

  # Encrypt boot-volume traffic between the host and the block storage service (data at rest is
  # always encrypted by OCI).
  launch_options {
    is_pv_encryption_in_transit_enabled = true
  }

  lifecycle {
    # A newer Ubuntu image must not force a rebuild of a running cluster; recreate deliberately with
    # `terraform apply -replace=module.compute.oci_core_instance.this`.
    ignore_changes = [source_details[0].source_id, metadata["user_data"]]

    precondition {
      condition     = length(data.oci_core_images.ubuntu.images) > 0
      error_message = "No Ubuntu 24.04 aarch64 image for ${var.shape} in this region/compartment."
    }

    precondition {
      condition     = var.availability_domain_index < length(local.availability_domains)
      error_message = "availability_domain_index is out of range for this region."
    }
  }
}
