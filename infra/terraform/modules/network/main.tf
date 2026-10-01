# A VCN with one public subnet. The security list is the cluster's firewall: SSH and the Kubernetes
# API only from the admin CIDRs, HTTP/HTTPS (the ingress) from anywhere.

terraform {
  required_providers {
    oci = { source = "oracle/oci" }
  }
}

resource "oci_core_vcn" "this" {
  compartment_id = var.compartment_ocid
  display_name   = "${var.name_prefix}-vcn"
  cidr_blocks    = [var.vcn_cidr]
  dns_label      = var.dns_label
}

resource "oci_core_internet_gateway" "this" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.name_prefix}-igw"
  enabled        = true
}

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.name_prefix}-public-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.this.id
  }
}

resource "oci_core_security_list" "public" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.this.id
  display_name   = "${var.name_prefix}-public-sl"

  # Outbound: package mirrors, the k3s and Argo CD releases, container registries, the model registry.
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
    description = "All outbound traffic"
  }

  dynamic "ingress_security_rules" {
    for_each = { for pair in setproduct(var.admin_cidrs, [22, 6443]) : "${pair[0]}-${pair[1]}" => pair }
    content {
      source      = ingress_security_rules.value[0]
      protocol    = "6" # TCP
      description = ingress_security_rules.value[1] == 22 ? "SSH from an admin network" : "Kubernetes API from an admin network"
      tcp_options {
        min = ingress_security_rules.value[1]
        max = ingress_security_rules.value[1]
      }
    }
  }

  dynamic "ingress_security_rules" {
    for_each = toset([80, 443])
    content {
      source      = "0.0.0.0/0"
      protocol    = "6"
      description = "Public web traffic to the ingress controller"
      tcp_options {
        min = ingress_security_rules.value
        max = ingress_security_rules.value
      }
    }
  }

  # ICMP "fragmentation needed": required for path-MTU discovery.
  ingress_security_rules {
    source      = "0.0.0.0/0"
    protocol    = "1"
    description = "Path MTU discovery"
    icmp_options {
      type = 3
      code = 4
    }
  }

  ingress_security_rules {
    source      = var.vcn_cidr
    protocol    = "1"
    description = "ICMP within the VCN"
    icmp_options {
      type = 3
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.this.id
  display_name               = "${var.name_prefix}-public"
  cidr_block                 = cidrsubnet(var.vcn_cidr, 8, 0)
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.public.id]
  prohibit_public_ip_on_vnic = false
}
