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
#   FORGE_SANDBOX_IMAGE         sandbox image used by the startup self-check (required
#                               unless the self-check is turned off)
#   FORGE_FIREWALL_SELF_CHECK   1 (default) runs the self-check, 0 skips it (not
#                               recommended outside a first install)
#
# Startup self-check: after the rules are applied, a throwaway container on a fresh
# --internal network (bridge named like the sandbox bridges, so the rules above apply
# to it) must fail to: resolve an external name through Docker's resolver, query a
# public DNS server directly, and open a TCP connection to the internet. If any of
# these succeeds the script exits non-zero: the sandbox could exfiltrate over DNS or
# reach the internet without the proxy, so no build may run on this host.
set -euo pipefail

GATEWAY_PORT="${FORGE_GATEWAY_PORT:-8787}"
EGRESS_IF="${FORGE_EGRESS_BRIDGE:-forge-egress0}"
SANDBOX_PREFIX="${FORGE_SANDBOX_BRIDGE_PREFIX:-fsbx}"
SANDBOX_IF="${SANDBOX_PREFIX}+"
EXTRA_ALLOWED="${FORGE_EXTRA_ALLOWED_CIDRS:-}"
SELF_CHECK="${FORGE_FIREWALL_SELF_CHECK:-1}"
SELF_CHECK_IMAGE="${FORGE_SANDBOX_IMAGE:-}"

# Must stay identical to V4_DENY in src/sandbox/egress-proxy.ts (checked by a unit test).
DENY_V4=(
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12
  192.0.0.0/24 192.0.2.0/24 192.31.196.0/24 192.52.193.0/24 192.88.99.0/24
  192.168.0.0/16 192.175.48.0/24 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24
  224.0.0.0/4 240.0.0.0/4
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
if [[ "$SELF_CHECK" != "0" && -z "$SELF_CHECK_IMAGE" ]]; then
  echo "FORGE_SANDBOX_IMAGE is required for the startup self-check" \
    "(FORGE_FIREWALL_SELF_CHECK=0 skips it, not recommended)" >&2
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

# ---------------------------------------------------------------- startup self-check
if [[ "$SELF_CHECK" == "0" ]]; then
  echo "WARNING: self-check skipped (FORGE_FIREWALL_SELF_CHECK=0)" >&2
  exit 0
fi

# Each probe that succeeds is a failure. Plain JavaScript (the sandbox image has node);
# no single quote inside, so it can sit in a single-quoted shell string.
PROBE='
const dns = require("dns");
const net = require("net");
const leaks = [];
let pending = 3;
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  if (leaks.length) { console.error("LEAK: " + leaks.join("; ")); process.exit(1); }
  console.log("isolated");
  process.exit(0);
}
function probeDone() { if (--pending === 0) finish(); }
// A probe still waiting after 20 s got no answer: that is the isolated outcome.
setTimeout(finish, 20000);
dns.lookup("registry.npmjs.org", (err) => {
  if (!err) leaks.push("the internal network resolves external names");
  probeDone();
});
const r = new dns.Resolver({ timeout: 3000, tries: 1 });
r.setServers(["1.1.1.1", "8.8.8.8"]);
r.resolve4("registry.npmjs.org", (err) => {
  if (!err) leaks.push("a public DNS server answers directly");
  probeDone();
});
let tcpDone = false;
function tcpEnd(leak) {
  if (tcpDone) return;
  tcpDone = true;
  if (leak) leaks.push("direct TCP to the internet succeeds");
  s.destroy();
  probeDone();
}
const s = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
s.on("connect", () => tcpEnd(true));
s.on("timeout", () => tcpEnd(false));
s.on("error", () => tcpEnd(false));
'

CHECK_NET="forge-fw-selfcheck-$$"
CHECK_IF="${SANDBOX_PREFIX}chk$(( $$ % 100000 ))"
cleanup_check() { docker network rm "$CHECK_NET" >/dev/null 2>&1 || true; }
trap cleanup_check EXIT

docker network create --driver=bridge --internal --ipv6=false \
  --opt=com.docker.network.bridge.inhibit_ipv4=true \
  "--opt=com.docker.network.bridge.name=${CHECK_IF}" \
  "$CHECK_NET" >/dev/null

set +e
timeout 60 docker run --rm --pull=never --network "$CHECK_NET" \
  --user 1000:1000 --cap-drop=ALL --security-opt=no-new-privileges=true --read-only \
  --entrypoint node "$SELF_CHECK_IMAGE" -e "$PROBE"
status=$?
set -e

case "$status" in
  0) echo "Self-check passed: the internal network cannot resolve or reach the outside." ;;
  1)
    echo "SELF-CHECK FAILED: the sandbox network is not isolated. Do not run builds on this host." >&2
    exit 1
    ;;
  *)
    echo "Self-check could not run (exit ${status}): fix it before running builds." >&2
    exit 1
    ;;
esac
