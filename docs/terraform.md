# Cloud demo environment (Terraform on Oracle Cloud Free Tier)

> **Status: written and validated, never applied.** The project runs locally only (docker compose
> and the kind cluster). The owner chose not to deploy to the internet or create a cloud account, so
> `terraform apply` has not been run. CI checks the code on every change (`fmt`, `validate`,
> Trivy, Checkov), and it is ready to use if a public environment is ever wanted.

`infra/terraform/` provisions a public demo environment: one Ampere A1 (Arm) VM in its own VCN,
bootstrapped with **k3s** (Traefik ingress) and **Argo CD**. Argo CD would deploy FraudGuard onto it
the same way it does on the local kind cluster (docs/gitops.md). Daily development stays on docker compose, and the local Kubernetes target stays kind
(docs/kubernetes.md).

```
infra/terraform/
├── main.tf / variables.tf / outputs.tf / providers.tf / versions.tf
├── modules/network            VCN, internet gateway, route table, security list (the firewall), subnet
├── modules/compute            the A1 VM (latest Ubuntu 24.04 Arm image), IMDSv2 only
├── modules/cluster-bootstrap  cloud-init: host firewall, k3s, Argo CD (pinned, checksum-verified)
├── terraform.tfvars.example   copy to terraform.tfvars (gitignored)
└── backend.tf.example         optional remote state in OCI Object Storage
```

## Cost: what is free and what is not

Everything here fits Oracle's **Always Free** resources, which cost nothing on a free-tier account and
stay free on a Pay-As-You-Go account within these limits:

| Resource | This setup | Always Free allowance |
|---|---|---|
| Ampere A1 compute (`VM.Standard.A1.Flex`) | 2 OCPU, 12 GB (configurable) | 4 OCPU and 24 GB in total, across all A1 VMs |
| Block storage (boot volume) | 100 GB | 200 GB in total |
| VCN, subnet, gateways, security list | 1 VCN | 2 VCNs |
| Ephemeral public IP | 1 | Included with the instance |
| Outbound data | small | 10 TB a month |
| Object Storage (optional remote state) | a few KB | 20 GB |

The variables refuse values above those limits (`instance_ocpus` 1-4, `instance_memory_gbs` 6-24,
`boot_volume_gbs` 50-200). Ways it **could** start costing money on a Pay-As-You-Go account:

- other A1 VMs already using the free allowance, so this one goes over it (the limits are per tenancy);
- changing `shape` to a non-free shape, or adding block volumes beyond 200 GB in total;
- leaving extra resources around after experiments.

Set a **budget alert** (Billing → Budgets, e.g. $1) on a Pay-As-You-Go account. Note that Oracle may
**reclaim idle Always Free VMs** (very low CPU, network and memory use over 7 days); recreate the VM
with `terraform apply` if that happens.

## One-time setup

1. **Oracle Cloud account** (free tier). The **home region** chosen at sign-up is the only region with
   Always Free Arm capacity.
2. **API key for Terraform:** Profile → *User settings* → *API keys* → *Add API key* → download the
   private key, then paste the shown configuration into `~/.oci/config` (or run `oci setup config`).
   The key never goes into this repository or into tfvars.
3. **Compartment** (recommended): Identity → *Compartments* → create `fraudguard`. Copy its OCID.
4. **SSH key:** `ssh-keygen -t ed25519` if you do not have one.
5. **Variables:** `cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars`, then fill in:
   `region`, `tenancy_ocid` (Profile → *Tenancy*), `compartment_ocid`, `ssh_public_key_path`, and
   `admin_cidrs` = your public IP as `/32` (see https://ifconfig.me). Only these addresses can reach
   SSH and the Kubernetes API; `0.0.0.0/0` is rejected.

## Apply

```bash
cd infra/terraform
terraform init
terraform plan -out tfplan        # review: 6 resources (VCN, gateway, route table, security list, subnet, VM)
terraform apply tfplan
```

"Out of host capacity" is common for free Arm VMs. Retry later, or set `availability_domain_index`
to 1 or 2 (in regions that have them).

Terraform finishes once the VM exists; **cloud-init then installs k3s and Argo CD (about 5 minutes)**.
The outputs give every next command, with the IP already filled in:

```bash
terraform output -raw bootstrap_status_command | sh      # prints "ready" when done
terraform output -raw kubeconfig_instructions            # fetch the kubeconfig, then kubectl get nodes
terraform output ingress_url                             # Traefik answers (404 until Phase 12 deploys the app)
terraform output -raw argocd_instructions                # port-forward to the Argo CD UI
```

The kubeconfig keeps TLS verification on: the API certificate names `kubernetes`, not the public
IP, so the instructions set `tls-server-name: kubernetes` instead of skipping verification. Treat
the file like a password (cluster-admin) and keep it out of the repository.

## Teardown

```bash
cd infra/terraform
terraform destroy                 # deletes the VM, its boot volume and the whole VCN
```

- `destroy` lists every resource before asking for confirmation; nothing is left behind (the boot
  volume is deleted with the instance).
- The **kubeconfig and Argo CD password become useless** with the cluster; delete the local
  `kubeconfig-fraudguard.yaml`.
- Optional manual leftovers: the compartment (empty), the API key in your OCI user, and the
  Object Storage bucket if you set up remote state. Remove them in the console if no longer needed.
- Check the console afterwards (*Compute → Instances*, *Networking → VCNs*, filter by the compartment).

## State

- **Default: local state** in `infra/terraform/terraform.tfstate`, gitignored. It holds resource IDs
  and the IP, not credentials. Losing it means deleting the resources by hand, so keep a copy if you
  keep the environment for long.
- **Remote, optional:** Terraform's native `oci` backend stores state in Object Storage (free). Create
  a private bucket, `cp backend.tf.example backend.tf`, and run `terraform init -migrate-state` with
  the bucket and your Object Storage namespace (commands in the file).
- `.terraform.lock.hcl` is committed with provider hashes for Linux, macOS and Windows (x86 and
  Arm), so every machine and CI install the same verified provider build.

## Security notes

- No credentials in code, tfvars or CI: the provider uses the `~/.oci/config` profile; CI only runs
  `fmt`, `validate` and IaC scans (`.github/workflows/terraform.yml`), never `plan` or `apply`.
- Two IaC scanners. **Trivy** (`trivy config`, HIGH/CRITICAL) covers generic Terraform rules but
  barely knows Oracle Cloud: in a test it missed a security list opening SSH to `0.0.0.0/0`.
  **Checkov's** `CKV_OCI_*` rules catch that, plus legacy metadata endpoints, unencrypted boot-volume
  traffic and hardcoded keys. The code passes all 8 applicable Checkov checks (it initially failed
  in-transit encryption, which is now enabled).
- The VCN security list is the firewall: 22 and 6443 from `admin_cidrs` only; 80 and 443 public.
  Oracle's Ubuntu image also ships a host iptables policy that rejects everything but SSH, which
  would block the ingress and pod networking. The bootstrap removes only those REJECT rules
  (`modules/cluster-bootstrap/cloud-init.yaml.tftpl`).
- The bootstrap pins k3s (installer from the release's git tag; the binary is checked against the
  release checksums) and Argo CD (manifest checked against `argocd_manifest_sha256`).
- The VM accepts only the authenticated (v2) instance metadata endpoint. Argo CD is not exposed
  publicly; reach it through `kubectl port-forward`.

## Arm images

A1 VMs are Arm (aarch64). k3s, Traefik and Argo CD publish Arm images; FraudGuard's own images are
built for linux/amd64 only (the local kind cluster). Using this environment would first need
linux/arm64 builds in CI (GitHub's native `ubuntu-24.04-arm` runners).
