# Renders the first-boot cloud-init that turns a plain Ubuntu VM into a k3s cluster with Argo CD.
# No resources: the output is passed to the compute module as instance user_data.

locals {
  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    k3s_version            = var.k3s_version
    k3s_version_urlencoded = replace(var.k3s_version, "+", "%2B")
    argocd_version         = var.argocd_version
    argocd_manifest_sha256 = var.argocd_manifest_sha256
  })
}
