# HyperShield independent deployment

This directory contains HyperShield's independent production configuration. It does not use
ShieldBattery accounts, databases, coordinator tenants, storage buckets, or hosted application
servers.

**Current state:** `angelicgaming.gg` is registered and domain-specific secrets have been generated
locally. The application and coordinator Droplets are active and hardened, and their deployment
configurations are staged. Both private Spaces buckets and both encrypted restic repositories have
been created. All application images and the single-region coordinator/relay images have been
pulled onto their VPSs. Database migrations and the first application backup have completed
successfully. The coordinator and single relay are online with valid TLS and enrolled tenant keys,
and both backup timers are enabled. Mailgun is active and verified with all required DNS records.
The application is online, synthetic login and email-verification flows pass, and the live relay
passed a two-player turn-delivery test with 240/240 deliveries and no duplicates. Mailgun accepted
a real verification email, Cloud Vision SafeSearch works, and both backup timers are enabled.
Synthetic smoke accounts have been removed. Spaces now has a HyperShield-only CORS rule for
`https://play.angelicgaming.gg`, and the rendered home page has been verified in a browser. The
initial deployment uses a single relay on the coordinator VPS and does not require an AWS account.

**Selected target:** DigitalOcean US, `angelicgaming.gg`, and a $100/month design target. The
current target allocates about $69.32/month to the two VPSs, Spaces, and the domain, leaving about
$30.68 for variable relay and service usage.

**Live resources:**

- `hypershield-app`: `167.71.250.228`, `s-4vcpu-8gb` in `nyc3`
- `hypershield-coordinator`: `159.203.114.113`, `s-1vcpu-2gb` in `nyc3`
- `angelicgaming-hypershield-files`: private application bucket
- `angelicgaming-hypershield-backups`: private backup bucket with separate app/coordinator
  restic repositories and scoped keys

## Architecture

- One application VPS runs the Node app, Rust GraphQL/matchmaking service, PostgreSQL, Redis,
  nginx, and Let's Encrypt.
- One coordinator VPS runs HyperShield's own rally-point2 coordinator and one New York relay for
  the initial single-region launch.
- The `rally-point2` repository retains an optional seven-region AWS Fargate configuration for later
  expansion. AWS provisioning and its relay ledger are disabled during the single-region launch.
- DigitalOcean Spaces stores public assets and private uploads. Replays and bug reports use real
  signed URLs; local-filesystem storage is not suitable for those private objects in production.
- A separate private Spaces bucket stores encrypted restic backups.
- GitHub Container Registry and AWS ECR hold HyperShield's own application and relay images.

HyperShield uses `play.angelicgaming.gg`, with its support services namespaced as `gql.play`,
`rp2.play`, and `mg.play`. The apex domain and other subdomains remain available for unrelated
projects.

The coordinator must be exposed directly on TCP/443. Do not put a reverse proxy or Cloudflare
proxy in front of it. Application HTTP/HTTPS can use ordinary DNS records without a CDN initially.

## Paid accounts and private setup

Create these accounts directly with each provider. Never send card details, passwords, API keys, or
JSON credentials in chat.

1. **Domain registrar:** register the chosen domain with WHOIS privacy where available.
2. **VPS provider:** two Ubuntu 24.04 x86-64 servers. An 8-GB application server is recommended; 4
   GB can be used for a very small initial test. A 2-GB coordinator is sufficient initially. Attach
   only your SSH public key during creation.
3. **AWS (later expansion only):** not required for the initial single-region launch. If global
   relays are added later, enable the seven configured regions and create a budget alert before
   applying Terraform. Budget alerts do not stop spending.
4. **DigitalOcean:** create a standard Spaces bucket for application files and a separate private
   bucket for backups. Bucket names are global, so replace `angelicgaming-hypershield-files` and
   `angelicgaming-hypershield-backups` if necessary. Use separate access keys scoped to each bucket.
5. **Mailgun:** configure `mg.play.angelicgaming.gg` and its DNS records. Account verification and
   recovery will not work without email.
6. **Google Cloud:** enable Cloud Vision and create a service-account JSON key for the application's
   image-safety checks. Store it only as `appserver/google-credentials.json` with restrictive
   permissions.
7. **GitHub:** use the existing `saintromuald/ShieldBattery` and `saintromuald/rally-point2` forks.
   Keep packages private with a read-only deploy token, or make the image packages public. Never
   commit registry tokens.

Set billing alerts at the VPS provider, AWS, DigitalOcean, and Google Cloud. Keep a cash reserve for
several months; donations should not be required to pay the next bill.

## DNS

After the VPS addresses are known, create:

| Name | Type | Target |
| --- | --- | --- |
| `play` | A | Application IPv4 |
| `gql.play` | A | Application IPv4 |
| `rp2.play` | A | Coordinator IPv4 |

Use AAAA records only after confirming working native IPv6 routing. For the coordinator, Docker 27+
with native `ip6tables` is required; the bootstrap installs and configures it. Add Mailgun's exact
records separately. Replace every `hypershield.example` placeholder with the registered domain.

## 1. Bootstrap both VPSs

Copy `bootstrap-server.sh` to each new server and run it as root:

```sh
# On the application VPS
bash bootstrap-server.sh app

# On the coordinator VPS
bash bootstrap-server.sh coordinator
```

The script installs Docker, configures key-only SSH, creates the `hyperops` user, enables UFW and
Fail2ban, configures automatic security updates, and adds swap on the application host. Confirm that
SSH works as `hyperops` before closing the root session.

Clone the intended HyperShield revision on each host as `hyperops`:

```sh
git clone https://github.com/saintromuald/ShieldBattery.git /opt/hypershield/src
```

Check out the reviewed deployment commit on both hosts. Do not deploy an arbitrary moving branch.

`hyperops` deliberately has no sudo access. Run later commands that use `sudo` from the preserved
root session. Protect its SSH key carefully: membership in the `docker` group can control the host.

If the GHCR packages are private, authenticate on each VPS as `hyperops` before pulling images:

```sh
read -rsp 'GHCR read-only token: ' GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username YOUR_GITHUB_USERNAME --password-stdin
unset GHCR_TOKEN
```

Use a read-only deploy token. Do not place it in `.env`, shell history, or Git. Public packages do
not need this step.

## 2. Publish HyperShield images

Commit and push the reviewed HyperShield source first.

- Run **HyperShield server images** in `saintromuald/ShieldBattery` with the version from
  `package.json`.
- Run **Publish coordinator image** in `saintromuald/rally-point2`, then promote the tested full
  commit SHA with **Promote coordinator image to stable**.
- The relay image is published after the AWS account stack creates its ECR repositories and IAM
  publisher role.

Pin `SB_VERSION` and coordinator `RP2_REF` to reviewed versions or digests rather than `latest` for
the public deployment.

## 3. Generate local deployment secrets

On the operator machine, from `deployment/hypershield`:

```sh
node generate-secrets.mjs your-domain.example
```

This creates `appserver/.env` and `coordinator/.env` with mode 0600 and writes the tenant's public
key into `coordinator/config/tenants.json`. It refuses to overwrite existing `.env` files and does
not print generated secrets.

Fill the remaining Mailgun, Spaces, and AWS placeholders locally using a private editor. Securely
copy only the application configuration to the application host and only the coordinator
configuration to the coordinator host. Remove temporary local copies after verifying the backups.

Prepare the coordinator's writable data directory on its VPS:

```sh
sudo install -d -o 65532 -g 65532 \
  /opt/hypershield/src/deployment/hypershield/coordinator/data
```

Place the Cloud Vision key and legally obtained `unit/` and `tileset/` sprite data at:

```text
appserver/google-credentials.json
appserver/bw_sprite_data/unit/
appserver/bw_sprite_data/tileset/
```

Do not commit either directory.

## 4. Optional later expansion: create AWS relay infrastructure

Skip this section for the initial single-region deployment. The coordinator uses
`config/regions.single.json` and the out-of-band `relay` service instead. Apply this section only
when real latency requirements justify the additional account and usage-based cost.

The Terraform configuration lives in the `rally-point2` repository under
`infra/terraform/hypershield`. Create a private, versioned, encrypted S3 bucket for Terraform state.
Copy each `.sample` backend file to the same directory without the `.sample` suffix and set that
bucket name. Backend files and Terraform plans must stay out of Git.

Install Terraform 1.10 or newer and authenticate the AWS CLI using an administrative bootstrap
identity. The Terraform resources create narrowly scoped runtime identities; do not use those
runtime keys for Terraform itself.

### Account stack

From `infra/terraform/account`:

```sh
terraform init -backend-config=../hypershield/account.s3.tfbackend
terraform plan -var-file=../hypershield/account.tfvars -out=../hypershield/account.tfplan
```

Review the plan and expected cost. Only after explicit approval:

```sh
terraform apply ../hypershield/account.tfplan
```

Set the `publisher_role_arn` output as the GitHub repository variable `RELAY_ECR_ROLE_ARN` in
`saintromuald/rally-point2`. Run **Publish relay image**, wait for replication to all seven regions,
then run **Promote relay image to stable** with the full tested commit SHA.

### Production fleet

Set the real coordinator hostname in `hypershield/prod.tfvars`. Pass the generated bootstrap secret
without printing it:

```sh
export TF_VAR_coordinator_bootstrap_secret="$(sed -n \
  's/^COORDINATOR_BOOTSTRAP_SECRET=//p' /secure/path/coordinator/.env)"
```

From `infra/terraform/fleet`:

```sh
terraform init -backend-config=../hypershield/prod.s3.tfbackend
terraform plan -var-file=../hypershield/prod.tfvars -out=../hypershield/prod.tfplan
```

Review regional availability, task sizing, public IPv4 use, and cost. No NAT gateways or always-warm
regional relays should appear. A fresh coordinator launches each region for backbone-latency
measurements, so budget for an initial seven-task coverage run and possible retries even before the
first player joins. Only after explicit approval:

```sh
terraform apply ../hypershield/prod.tfplan
```

Generate coordinator configuration without displaying the sensitive outputs:

```sh
terraform output -raw ecs_json > /secure/path/coordinator/config/ecs.json
terraform output -raw regions_json > /secure/path/coordinator/config/regions.json
```

Copy the restricted coordinator IAM access-key outputs directly into the coordinator `.env` through
a private editor or a file-to-file secret workflow. Do not print them in chat or commit them.

## 5. Start and verify

Start the coordinator and its single relay first. UDP/14900 and UDP/443 must be allowed by the
coordinator firewall in addition to TCP/443:

```sh
cd /opt/hypershield/src/deployment/hypershield/coordinator
docker compose pull
docker compose up -d
docker compose ps
curl -fsS https://rp2.play.your-domain.example/regions
```

Then start the application:

```sh
cd /opt/hypershield/src/deployment/hypershield/appserver
docker compose pull
docker compose up -d
docker compose ps
curl -fsS https://play.your-domain.example/ >/dev/null
```

Inspect logs if any container repeatedly restarts. Do not bypass authentication, make the private
bucket public, disable TLS checks, or use ShieldBattery credentials as a shortcut.

The minimum real launch test is:

1. Create two isolated test accounts and verify email recovery.
2. Build the desktop client with `https://play.your-domain.example` as its server URL.
3. Complete a two-client multiplayer match and confirm results.
4. Test a cold relay start and measure its delay. Exercise other regions only as needed; coordinated
   testing costs real relay-hours.
5. Upload a replay as one user and verify that an unauthorized user cannot download it.
6. Verify a signed download expires and that public assets remain accessible.
7. Complete a backup restoration drill on a fresh test database. Verify that a restored public map
   image is accessible, while a restored private replay remains inaccessible to unauthorized users.

## 6. Enable encrypted backups

Create `/opt/hypershield/backup.env` from `backup.env.sample`, using the separate backup bucket and
its limited write credentials. On the application host, also configure the read-only application
bucket key. The application backup copies objects into `objects/current`; changed or deleted objects
are retained under dated `objects/versions/` paths for 90 days.

Create `/opt/hypershield/restic-password` with a secure random value and store a copy in an offline
password manager. Each host has a separate repository suffix and can use a different password. Label
each password clearly. Losing both the backup data and its password makes restoration impossible.

Initialize each repository once:

```sh
# Application host
sudo bash -c 'set -a; source /opt/hypershield/backup.env; set +a; export RESTIC_REPOSITORY="${RESTIC_REPOSITORY_BASE%/}/app"; restic init'

# Coordinator host
sudo bash -c 'set -a; source /opt/hypershield/backup.env; set +a; export RESTIC_REPOSITORY="${RESTIC_REPOSITORY_BASE%/}/coordinator"; restic init'
```

Install and test the appropriate timer:

```sh
sudo /opt/hypershield/src/deployment/hypershield/install-backup.sh app
sudo systemctl start hypershield-backup@app.service

# Or, on the coordinator:
sudo /opt/hypershield/src/deployment/hypershield/install-backup.sh coordinator
sudo systemctl start hypershield-backup@coordinator.service
```

Check `systemctl status`, `journalctl`, and the backup bucket's object copies. List restic snapshots
with the repository selected explicitly:

```sh
sudo bash -c 'set -a; source /opt/hypershield/backup.env; set +a; export RESTIC_REPOSITORY="${RESTIC_REPOSITORY_BASE%/}/app"; restic snapshots'
# Use /coordinator instead of /app on the coordinator host.
```

After the manual service succeeds, enable its timer:

```sh
sudo systemctl enable --now hypershield-backup@app.timer
# Or hypershield-backup@coordinator.timer on the coordinator host.
```

Restic retention is 7 daily, 4 weekly, and 3 monthly snapshots; changed or deleted object versions
are retained for 90 days.

Backup object copies are private. After restoring them into an empty application bucket, reapply
`public-read` only to prefixes in `public-object-prefixes.txt`. For example, with `s3cmd` privately
configured for the application bucket:

```sh
s3cmd setacl --acl-public --recursive s3://angelicgaming-hypershield-files/public/
s3cmd setacl --acl-public --recursive s3://angelicgaming-hypershield-files/map_images/
s3cmd setacl --acl-public --recursive s3://angelicgaming-hypershield-files/user-avatars/
```

Repeat only for the other listed prefixes. Never apply public access to `maps/`, `replays/`,
`bug-reports/`, the whole bucket, or the backup bucket.

## Operations

- Apply updates in this order: coordinator, relay, application.
- Do not run the relay load generator against production without a coordinated test plan and budget.
- Watch disk usage, container restarts, relay task-hours, public IPv4 hours, storage, and bandwidth.
- Raise `COORDINATOR_MAX_SESSIONS` only after measuring actual relay capacity and cost.
- Test restoration after major migrations and before opening public registration.
