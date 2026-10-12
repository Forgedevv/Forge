# syntax=docker/dockerfile:1.7
#
# FORGE visual review image: runs the capture of the visual review
# (src/pipeline/review/capture.mjs), i.e. `next start` of the site built by the first agent pass
# and a headless Chromium on it, with no network at all (loopback only), no secret, the job folder
# read-only and one output folder. Everything executed in it is treated as hostile: the hardening
# lives in the `docker create` flags of apps/builder/src/sandbox/args.ts, as for the sandbox image,
# and its output is validated on the host (src/pipeline/review/capture-output.ts).
#
# A separate image on purpose: the agent, install and build runs never get a browser, and this one
# has no agent CLI and no pnpm. The runner only starts it with network `none` and no secret.
#
# Build context: apps/builder (only the capture script is sent, see
# review.Dockerfile.dockerignore).
# Base image pinned by digest: see README.md ("Updating the pinned images").
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# Chromium and fonts from Debian bookworm, installed at image build time (host network). The
# pinned image ID fixes their versions; rebuild to take browser security updates. No setuid or
# setgid binary is left (Chromium's own sandbox helper included: the container is the sandbox).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       chromium \
       fonts-liberation \
       fonts-dejavu-core \
       fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /tmp/* \
  && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
  && test -x /usr/bin/timeout \
  && test -x /usr/bin/chromium \
  && chromium --version \
  && mkdir -p /opt/forge/review

COPY --chmod=0444 src/pipeline/review/capture.mjs /opt/forge/review/capture.mjs

ENV NEXT_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    HOME=/home/node

USER 1000:1000
WORKDIR /workspace
# The runner always sets the entrypoint (the `timeout` wrapper) and the command.
ENTRYPOINT []
CMD ["node", "--version"]
