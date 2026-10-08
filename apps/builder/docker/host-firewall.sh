#!/usr/bin/env bash
#
# Host firewall for the FORGE sandbox on a Linux VPS (defense in depth).
#
# The sandbox itself has no route out: its per-run network is --internal and its
# bridge has no host IP. Only the egress proxy containers, on the shared bridge
# "forge-egress0", reach the outside. The proxy already refuses private and
# reserved destinations; these rules make the kernel refuse them too, in case the
# proxy process is ever compromised:
#
#   - from forge-egress0, new connections to private / reserved / metadata ranges
#     are dropped (FORWARD path, DOCKER-USER chain);
#   - from forge-egress0, the host only accepts the AI gateway port (INPUT path);
#   - from any sandbox bridge (fsbx*), the host accepts nothing (INPUT path) and
#     nothing is forwarded out of the bridge (FORWARD path).
#
# Run as root after Docker has started (e.g. a systemd unit with After=docker.service),
# and again after Docker restarts. Idempotent. Variables:
#   FORGE_GATEWAY_PORT          AI gateway port on the host (default 8787)
#   FORGE_EGRESS_BRIDGE         egress bridge interface (default forge-egress0)
#   FORGE_SANDBOX_BRIDGE_PREFIX per-run bridge prefix (default fsbx)
#   FORGE_EXTRA_ALLOWED_CIDRS   space-separated private CIDRs the proxy must still
#                               reach (e.g. a private DNS resolver), default none
set -euo pipefail

GATEWAY_PORT="${FORGE_GATEWAY_PORT:-8787}"
EGRESS_IF="${FORGE_EGRESS_BRIDGE:-forge-egress0}"
SANDBOX_IF="${FORGE_SANDBOX_BRIDGE_PREFIX:-fsbx}+"
EXTRA_ALLOWED="${FORGE_EXTRA_ALLOWED_CIDRS:-}"

DENY_V4=(
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12
  192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15
  198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4
)

if [[ "$(id -u)" -ne 0 ]]; then
  echo "host-firewall.sh must run as root" >&2
  exit 1
fi
if ! [[ "$GATEWAY_PORT" =~ ^[0-9]+$ ]]; then
  echo "FORGE_GATEWAY_PORT must be a number" >&2
  exit 1
fi
if ! iptables -n -L DOCKER-USER >/dev/null 2>&1; then
  echo "DOCKER-USER chain not found: start Docker first" >&2
  exit 1
fi

# (Re)creates a chain and makes sure it is jumped to once from <parent> with <match>.
ensure_chain() {
  local table_cmd="$1" chain="$2" parent="$3"
  shift 3
  "$table_cmd" -N "$chain" 2>/dev/null || "$table_cmd" -F "$chain"
  if ! "$table_cmd" -C "$parent" "$@" -j "$chain" 2>/dev/null; then
    "$table_cmd" -I "$parent" 1 "$@" -j "$chain"
  fi
}

# FORWARD path: egress proxies may not open connections to private ranges.
ensure_chain iptables FORGE-EGRESS-FWD DOCKER-USER -i "$EGRESS_IF"
iptables -A FORGE-EGRESS-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for cidr in $EXTRA_ALLOWED; do
  iptables -A FORGE-EGRESS-FWD -d "$cidr" -j RETURN
done
for cidr in "${DENY_V4[@]}"; do
  iptables -A FORGE-EGRESS-FWD -d "$cidr" -j DROP
done
iptables -A FORGE-EGRESS-FWD -j RETURN

# FORWARD path: nothing leaves a sandbox bridge (traffic to the proxy stays on it).
ensure_chain iptables FORGE-SANDBOX-FWD DOCKER-USER -i "$SANDBOX_IF"
iptables -A FORGE-SANDBOX-FWD -o "$SANDBOX_IF" -j RETURN
iptables -A FORGE-SANDBOX-FWD -j DROP

# INPUT path: from the egress bridge, only the AI gateway port on the host.
ensure_chain iptables FORGE-EGRESS-IN INPUT -i "$EGRESS_IF"
iptables -A FORGE-EGRESS-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A FORGE-EGRESS-IN -p tcp --dport "$GATEWAY_PORT" -j ACCEPT
iptables -A FORGE-EGRESS-IN -j DROP

# INPUT path: sandbox bridges never reach the host.
ensure_chain iptables FORGE-SANDBOX-IN INPUT -i "$SANDBOX_IF"
iptables -A FORGE-SANDBOX-IN -j DROP

# IPv6: the sandbox networks are created without IPv6; drop anyway.
if command -v ip6tables >/dev/null 2>&1 && ip6tables -n -L INPUT >/dev/null 2>&1; then
  for parent in INPUT FORWARD; do
    for iface in "$EGRESS_IF" "$SANDBOX_IF"; do
      if ! ip6tables -C "$parent" -i "$iface" -j DROP 2>/dev/null; then
        ip6tables -I "$parent" 1 -i "$iface" -j DROP
      fi
    done
  done
fi

echo "FORGE sandbox firewall rules applied (gateway port ${GATEWAY_PORT})."
