locals {
  ip = module.compute.public_ip
}

output "public_ip" {
  description = "Public IPv4 address of the cluster VM."
  value       = local.ip
}

output "ingress_url" {
  description = "Where the k3s Traefik ingress answers (404 until applications are deployed, Phase 12)."
  value       = "http://${local.ip}/"
}

output "ssh_command" {
  description = "SSH into the VM (from an address in admin_cidrs)."
  value       = "ssh ubuntu@${local.ip}"
}

output "bootstrap_status_command" {
  description = "k3s and Argo CD are installed by cloud-init after the VM boots (about 5 minutes). This prints 'ready' when done."
  value       = "ssh ubuntu@${local.ip} 'test -f /var/lib/fraudguard/bootstrap.done && echo ready || sudo tail -n 5 /var/log/fraudguard-bootstrap.log'"
}

output "kubeconfig_instructions" {
  description = "Fetch the cluster's kubeconfig and point it at the public IP."
  value       = <<-EOT
    ssh ubuntu@${local.ip} sudo cat /etc/rancher/k3s/k3s.yaml > kubeconfig-fraudguard.yaml
    kubectl --kubeconfig kubeconfig-fraudguard.yaml config set-cluster default --server=https://${local.ip}:6443 --tls-server-name=kubernetes
    kubectl --kubeconfig kubeconfig-fraudguard.yaml get nodes
    # tls-server-name: the API certificate names "kubernetes" (not the public IP), so TLS is still
    # fully verified against the cluster CA. Keep the file private: it holds cluster-admin credentials.
  EOT
}

output "argocd_instructions" {
  description = "Reach the Argo CD UI through a port-forward (it is not exposed publicly)."
  value       = <<-EOT
    kubectl --kubeconfig kubeconfig-fraudguard.yaml -n argocd port-forward svc/argocd-server 8443:443
    # then open https://localhost:8443 as user "admin" with the initial password:
    kubectl --kubeconfig kubeconfig-fraudguard.yaml -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
  EOT
}

output "image" {
  description = "The Ubuntu image the VM runs."
  value       = module.compute.image_name
}
