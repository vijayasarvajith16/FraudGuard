# FraudGuard demo environment on Oracle Cloud's Always Free tier: one Ampere A1 VM in its own VCN,
# bootstrapped with k3s (Traefik ingress) and Argo CD. Usage, costs and teardown: docs/terraform.md.

module "network" {
  source = "./modules/network"

  compartment_ocid = var.compartment_ocid
  name_prefix      = var.name_prefix
  vcn_cidr         = var.vcn_cidr
  dns_label        = substr(replace(var.name_prefix, "/[^a-z0-9]/", ""), 0, 15)
  admin_cidrs      = var.admin_cidrs
}

module "cluster_bootstrap" {
  source = "./modules/cluster-bootstrap"

  k3s_version            = var.k3s_version
  argocd_version         = var.argocd_version
  argocd_manifest_sha256 = var.argocd_manifest_sha256
}

module "compute" {
  source = "./modules/compute"

  tenancy_ocid              = var.tenancy_ocid
  compartment_ocid          = var.compartment_ocid
  subnet_id                 = module.network.subnet_id
  name                      = var.name_prefix
  availability_domain_index = var.availability_domain_index
  ocpus                     = var.instance_ocpus
  memory_gbs                = var.instance_memory_gbs
  boot_volume_gbs           = var.boot_volume_gbs
  ssh_public_key            = trimspace(file(pathexpand(var.ssh_public_key_path)))
  user_data                 = module.cluster_bootstrap.user_data
}
