output "user_data" {
  description = "Base64-encoded cloud-init for the instance metadata."
  value       = base64encode(local.cloud_init)
}

output "cloud_init" {
  description = "The rendered cloud-init (for review: terraform output -raw ... or the plan)."
  value       = local.cloud_init
}
