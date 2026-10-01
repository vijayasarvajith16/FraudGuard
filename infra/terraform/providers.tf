# Credentials never appear in this code or in tfvars: the provider reads an API-key profile from the
# standard OCI config file (~/.oci/config), created by `oci setup config` or the console's
# "Add API key" (docs/terraform.md).
provider "oci" {
  region              = var.region
  config_file_profile = var.oci_config_profile
}
