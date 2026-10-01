terraform {
  # 1.12+ for the native "oci" state backend (see backend.tf.example).
  required_version = ">= 1.12.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 9.8"
    }
  }
}
