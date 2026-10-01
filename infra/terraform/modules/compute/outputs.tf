output "instance_id" {
  description = "The VM."
  value       = oci_core_instance.this.id
}

output "public_ip" {
  description = "Public IPv4 address of the VM (ephemeral: it changes if the VM is recreated)."
  value       = oci_core_instance.this.public_ip
}

output "private_ip" {
  description = "Private IPv4 address of the VM."
  value       = oci_core_instance.this.private_ip
}

output "image_name" {
  description = "The Ubuntu image the VM was created from."
  value       = data.oci_core_images.ubuntu.images[0].display_name
}
