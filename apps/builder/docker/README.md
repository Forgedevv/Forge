# Builder sandbox: images and host setup

The builder runs the AI agent and the local build of each client site in a disposable
Docker container. The code that runs there is written by an AI from user input: it is
treated as hostile. Runner: `apps/builder/src/sandbox/` (`createSandboxRunner`,
`runner.run(...)`, `buildSite(...)`). Threat model: `docs/SECURITY.md` sections 2 and 4.

## Files

| File                        | Purpose                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `sandbox.Dockerfile`        | Sandbox image: Node 22 (pinned digest), pnpm, the headless agent CLI; non-root, no setuid binary |
| `egress-proxy.Dockerfile`   | Egress proxy image: runs `src/sandbox/egress-proxy.ts` (no dependency)                           |
| `review.Dockerfile`         | Visual review image: Node 22 (pinned digest), Debian Chromium, fonts, the capture script         |
| `*.Dockerfile.dockerignore` | Per-Dockerfile build contexts (only the proxy source or the capture script is sent)              |
| `build-images.sh`           | Builds the three images and prints the pinned IDs to configure                                   |
| `host-firewall.sh`          | Linux host rules (defense in depth) for the sandbox bridges                                      |

## What every sandbox container gets

Built by `buildSandboxCreateArgs` and verified token by token by
`assertHardenedSandboxArgs` right before `docker create` (any unknown flag or missing
hardening flag aborts the run):

- `--user=1000:1000` (never root), `--cap-drop=ALL`, `--security-opt=no-new-privileges=true`,
  the daemon's default seccomp profile (and `docker-default` AppArmor on Ubuntu); nothing
  `unconfined`, no `--privileged`, no device, no extra capability;
- `--read-only` root filesystem; writable: the job folder at `/workspace`, `/tmp` and `$HOME`
  as size-capped `nosuid,nodev,noexec` tmpfs. Host mounts: the job folder only, except for the
  visual review capture (below): job folder read-only, plus one separate output folder at
  `/output`, both strictly inside the jobs root;
- `--pids-limit`, `--memory` with `--memory-swap` equal (no swap), `--cpus`,
  `nofile`/`core=0`/`fsize` ulimits, `--oom-score-adj=500` (the sandbox dies first);
- private IPC, PID, UTS and cgroup namespaces, `--init`, no docker socket,
  `--log-driver=none` (output is read through `docker start --attach`, capped and
  redacted; the daemon never stores it);
- wall-clock timeout enforced twice: `docker kill` from the host, and a `timeout` wrapper
  as entrypoint inside the container (so a crashed worker cannot leave it running);
  output above 64 MiB kills the container; `cleanupStale()` removes leftovers by label;
- `--pull=never` and a content-addressed image only.

Secrets: only the job's AI gateway token (`ANTHROPIC_AUTH_TOKEN`) can enter, and only
with the `gateway` egress preset. There is no registry token: `@forge/core` and
`@forge/shared` install from the public npm registry through exact `npm:@forgedevv/...`
aliases (decision D26). The token's value is never on a command line: the docker CLI gets
it in its own environment, which is built from scratch (host secrets are not inherited).
The Anthropic key, Supabase service key, GitHub App key, Vercel token, registry tokens
(`GITHUB_PACKAGES_TOKEN`, `NODE_AUTH_TOKEN`, `NPM_TOKEN`) and every host variable with a
credential-like name are refused by name and by value, and redacted from all output.

## Network

```
sandbox ──(per-run --internal bridge "fsbx*", no host IP)──► egress proxy ──(forge-egress0)──► internet
                                                                 │
                                                                 └─ fixed TCP forward ──► AI gateway (host)
```

- `network: 'none'`: `--network=none`, loopback only. The site build always runs so.
- `network: 'allowlist'`: a per-run `--internal` network whose bridge has no IPv4 on the
  host (`inhibit_ipv4`). The sandbox has no default route and its DNS only resolves the
  proxy alias (`forge-egress`), so it cannot reach the host, another job, the metadata
  service, or use DNS to exfiltrate. Its only peer is the per-run proxy container:
  - `CONNECT host:443` only, for the hosts of the requested presets (`npm`:
    `registry.npmjs.org`, the only registry); IP literals, other ports and plain HTTP
    refused;
  - the proxy resolves the host itself, refuses private, loopback, link-local
    (169.254.169.254), CGNAT, multicast and reserved addresses, and connects to the
    vetted IP;
  - the first bytes of the tunnel must be a TLS ClientHello whose SNI equals the
    CONNECT host (no fronting to another site on the same CDN; ECH refused);
  - preset `gateway`: `ANTHROPIC_BASE_URL=http://forge-egress:8788`, a TCP forward to
    the one configured gateway upstream.
- Proxy containers sit on the shared bridge `forge-egress-out` (interface
  `forge-egress0`), created with inter-container communication disabled.

`github.com` is deliberately not allow-listed: pushes are done by the builder on the host
after the scan, never from the sandbox.

Residual risk: data can still be sent to an allow-listed host (e.g. publishing to the
npm registry with an attacker's token). This is why the build step runs with no network,
the install step runs no repository code (`--ignore-scripts --ignore-pnpmfile`, frozen
lockfile, no registry token), and the only secret in reach is short-lived (gateway token,
per-job budget).

## Visual review capture (`BUILDER_VISUAL_REVIEW=on`)

After the first agent pass of a new site has been scanned and built, the pipeline
(`src/pipeline/review/`) runs one more container from the review image to see the site:

- image `FORGE_SANDBOX_REVIEW_IMAGE` (`review.Dockerfile`), separate from the sandbox image so
  the agent, install and build runs never get a browser; the runner refuses it with any network
  other than `none` or with a secret;
- `--network=none` (loopback only), no secret, the same hardening flags as every sandbox run,
  `--pids-limit=1024`, 3 GiB, 2 CPUs, 5 minutes;
- the pass 1 job folder mounted read-only at `/workspace`; a fresh output folder (inside the jobs
  root, separate from the job folder) at `/output`, the only writable host path;
- command: `node /opt/forge/review/capture.mjs --site /workspace --out /output ...`. The script
  (plain Node ESM, no dependency) starts `next start` on `127.0.0.1:3000`, then headless Chromium
  (`--no-sandbox`: the container is the sandbox) driven over the DevTools protocol. Every
  external request is intercepted: the Jupiter data API gets empty lists (day-one market), the
  rest fails; host names do not resolve. Pages `/`, `/create-pool`, `/about`, `/creator-fees`, at
  1440x900 and 390x844 with real mobile emulation, full page up to 4000 px in 2000 px parts, plus
  `report.json` (horizontal overflow measured per element, console errors).

Everything in `/output` is untrusted: the host reads only the expected names, never through a
link, with size caps, parses the report with zod, and rebuilds each PNG from its critical chunks
after checking its structure and size. The second agent pass then runs as usual (gateway only,
job token), its result goes through the same scan and build, and any failure keeps the first
pass. The same script runs on a laptop with a local Chrome or Edge (`pnpm site-test capture`,
apps/builder/README.md).

## Updating the pinned images

1. Base image: `docker pull node:22-bookworm-slim`, then
   `docker inspect --format '{{index .RepoDigests 0}}' node:22-bookworm-slim` and replace
   the `@sha256:...` of the `FROM` line in **all three** Dockerfiles. Keep the major version in
   line with `.nvmrc`. The review image takes Chromium from Debian at build time: rebuild it
   regularly for browser security updates.
2. Tool versions: `PNPM_VERSION` (keep it equal to the root `packageManager`) and the agent
   CLI version are build args at the top of `sandbox.Dockerfile`.
3. Run `apps/builder/docker/build-images.sh` and set the printed values as
   `FORGE_SANDBOX_IMAGE` / `FORGE_SANDBOX_PROXY_IMAGE` / `FORGE_SANDBOX_REVIEW_IMAGE`. Local image IDs change at every
   rebuild (builds are not bit-for-bit reproducible): to share one image across machines,
   push it to a registry and pin `name@sha256:<digest>` instead.
4. Run the integration test (below) before switching production.

## Configuration (environment of the builder)

| Variable                                  | Required      | Meaning                                                                             |
| ----------------------------------------- | ------------- | ----------------------------------------------------------------------------------- |
| `FORGE_SANDBOX_IMAGE`                     | yes           | Sandbox image, `sha256:<id>` or `name@sha256:<digest>`                              |
| `FORGE_SANDBOX_PROXY_IMAGE`               | yes           | Egress proxy image, pinned the same way                                             |
| `FORGE_SANDBOX_JOBS_ROOT`                 | yes           | Absolute folder; only folders strictly inside it are mounted                        |
| `FORGE_SANDBOX_REVIEW_IMAGE`              | for review    | Visual review image, pinned the same way; needed by `BUILDER_VISUAL_REVIEW=on`      |
| `FORGE_SANDBOX_GATEWAY_UPSTREAM`          | for the agent | `host:port` of the AI gateway seen from the proxy, e.g. `host.docker.internal:8787` |
| `FORGE_SANDBOX_RUNTIME`                   | no            | `runc` (default) or `runsc` (gVisor, recommended when installed)                    |
| `FORGE_SANDBOX_UID` / `FORGE_SANDBOX_GID` | no            | Sandbox user (default 1000:1000, never 0)                                           |
| `FORGE_DOCKER_BIN`                        | no            | docker CLI path                                                                     |

## Linux VPS (production)

- Run `host-firewall.sh` as root after Docker starts (systemd unit `After=docker.service`)
  and after every Docker restart. It drops, at the kernel level, anything the proxy
  should never do (private ranges, metadata, host ports other than the gateway) and
  anything leaving a sandbox bridge. Set `FORGE_EXTRA_ALLOWED_CIDRS` if the host's DNS
  resolver is on a private address. Its IPv4 deny list must stay identical to `V4_DENY`
  in `src/sandbox/egress-proxy.ts` (a unit test compares them).
- Startup self-check: right after applying the rules, `host-firewall.sh` creates a
  throwaway `--internal` network (bridge named with the sandbox prefix, so the sandbox
  rules apply) and runs the sandbox image on it (`FORGE_SANDBOX_IMAGE`, required). The
  container must fail to resolve an external name through Docker's resolver, to query a
  public DNS server directly, and to open a TCP connection to the internet. If any of
  these succeeds, or the check cannot run, the script exits non-zero and the systemd unit
  fails: do not start the builder worker until it passes (make the worker unit
  `Requires=` the firewall unit). `FORGE_FIREWALL_SELF_CHECK=0` skips it (first install
  only).
- AI gateway: `host.docker.internal` is mapped to the Docker host (`host-gateway`, the
  `docker0` address, usually `172.17.0.1`) in the proxy container only. Make the gateway
  listen on that address (not `0.0.0.0`), port `FORGE_GATEWAY_PORT`.
- Job folders: the sandbox writes as uid 1000. Create each job folder owned by that uid
  (or set `FORGE_SANDBOX_UID` to the builder user). Put `FORGE_SANDBOX_JOBS_ROOT` on a
  size-limited filesystem (separate partition or XFS project quota): it is the only place
  a hostile build can fill on disk.
- Stronger isolation, recommended: install gVisor and set `FORGE_SANDBOX_RUNTIME=runsc`;
  optionally enable `userns-remap` in the daemon (then chown job folders to the remapped
  uid).
- Access to the docker daemon is root-equivalent: keep VPS 1 dedicated to the builder;
  the docker socket is never mounted into any container.

## Windows / Docker Desktop (development)

The design works unchanged and the integration test passes on Docker Desktop (WSL 2).
Differences:

- `host-firewall.sh` does not apply: the Docker VM's firewall is not managed by us.
  Isolation relies on the internal network (no route) and on the proxy's own checks.
- `host.docker.internal` reaches services bound to the Windows host's loopback, so the
  gateway can stay on `127.0.0.1`.
- Bind mounts go through the VM's file sharing: uid ownership is not enforced (any uid
  can write) and installs are slower than on Linux.
- No AppArmor; seccomp, capabilities, no-new-privileges and cgroup limits do apply.
- From Git Bash, set `MSYS_NO_PATHCONV=1` before running docker commands by hand
  (container paths like `/workspace` are otherwise rewritten).

## Integration test

```
FORGE_SANDBOX_INTEGRATION=1 pnpm --filter @forge/builder exec vitest run src/sandbox/sandbox.integration.test.ts
```

It builds both images (or uses `FORGE_SANDBOX_IMAGE` / `FORGE_SANDBOX_PROXY_IMAGE`),
resolves and installs a tiny sample project through the proxy, builds it with no
network, and checks: registry reachable, every other destination refused (other host,
IP literal, metadata, port 80, SNI mismatch, direct routes, DNS), the gateway forward
works with the job token, writes outside `/workspace` and `/tmp` fail, the token
printed by the container is redacted, a hung command is killed at its timeout and no
container or network is left behind.
