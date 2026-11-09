#!/usr/bin/env bash
set -Eeuo pipefail

ROLE="${1:-}"
if [[ "$ROLE" != "app" && "$ROLE" != "coordinator" ]]; then
  echo "Usage: sudo $0 app|coordinator" >&2
  exit 2
fi
if (( EUID != 0 )); then
  echo "Run this bootstrap as root on a fresh Ubuntu 24.04 server." >&2
  exit 1
fi

KEY_SOURCE=''
for candidate in /root/.ssh/authorized_keys /home/ubuntu/.ssh/authorized_keys /home/hyperops/.ssh/authorized_keys; do
  if [[ -s "$candidate" ]]; then
    KEY_SOURCE="$candidate"
    break
  fi
done
if [[ -z "$KEY_SOURCE" ]]; then
  echo "No provisioning SSH public key was found. Attach a key or install one before continuing." >&2
  echo "SSH and firewall settings have not been changed." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg git jq ufw fail2ban unattended-upgrades restic sqlite3 rclone s3cmd

install -m 0755 -d /etc/apt/keyrings
if [[ ! -s /etc/apt/keyrings/docker.asc ]]; then
  curl --proto '=https' --tlsv1.2 -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi

# shellcheck disable=SC1091
source /etc/os-release
cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Merge logging and native IPv6 NAT settings without discarding other daemon settings.
mkdir -p /etc/docker
if [[ -s /etc/docker/daemon.json ]]; then
  cp -a /etc/docker/daemon.json "/etc/docker/daemon.json.pre-hypershield.$(date +%s)"
else
  echo '{}' > /etc/docker/daemon.json
fi
jq '. + {
  "log-driver": "json-file",
  "log-opts": {"max-size": "50m", "max-file": "4"},
  "ip6tables": true
}' /etc/docker/daemon.json > /etc/docker/daemon.json.hypershield
mv /etc/docker/daemon.json.hypershield /etc/docker/daemon.json

systemctl enable --now docker fail2ban unattended-upgrades
systemctl restart docker

cat > /etc/fail2ban/jail.d/hypershield-sshd.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl restart fail2ban

if ! id hyperops >/dev/null 2>&1; then
  adduser --disabled-password --gecos 'HyperShield operator' hyperops
fi
usermod -aG docker hyperops
install -d -m 0700 -o hyperops -g hyperops /home/hyperops/.ssh
if [[ ! -s /home/hyperops/.ssh/authorized_keys ]]; then
  install -m 0600 -o hyperops -g hyperops "$KEY_SOURCE" \
    /home/hyperops/.ssh/authorized_keys
fi
if [[ ! -s /home/hyperops/.ssh/authorized_keys ]]; then
  echo "Refusing to continue without a usable hyperops SSH key." >&2
  exit 1
fi
install -d -m 0755 -o hyperops -g hyperops /opt/hypershield
install -d -m 0700 /opt/hypershield/backups

if [[ "$ROLE" == app && ! -s /swapfile ]]; then
  # Prevents an occasional worker or database spike from immediately OOM-killing a small VPS.
  fallocate -l 2G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

cat > /etc/ssh/sshd_config.d/00-hypershield.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t
SSHD_EFFECTIVE="$(sshd -T)"
grep -qx 'passwordauthentication no' <<< "$SSHD_EFFECTIVE"
grep -qx 'kbdinteractiveauthentication no' <<< "$SSHD_EFFECTIVE"
grep -Eq '^permitrootlogin (prohibit-password|without-password)$' <<< "$SSHD_EFFECTIVE"
unset SSHD_EFFECTIVE

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
if [[ "$ROLE" == app ]]; then
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 443/udp
else
  ufw allow 443/tcp
  ufw allow 443/udp
  ufw allow 14900/udp
fi
ufw --force enable
systemctl reload ssh

cat <<EOF
Bootstrap complete for the $ROLE role.
Log in as hyperops with the SSH key you assigned in the provider console.
Keep passwords, access keys, and payment details out of chat and out of Git.
EOF
