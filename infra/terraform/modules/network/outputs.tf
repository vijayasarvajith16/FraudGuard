output "vcn_id" {
  description = "The VCN."
  value       = oci_core_vcn.this.id
}

output "subnet_id" {
  description = "The public subnet the VM is placed in."
  value       = oci_core_subnet.public.id
}
