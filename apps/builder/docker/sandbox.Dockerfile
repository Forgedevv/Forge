# syntax=docker/dockerfile:1.7
#
# FORGE sandbox image: runs the builder agent (headless CLI) and the local build of a
# client site. Everything executed in it is treated as hostile; the hardening lives in
# the `docker create` flags of apps/builder/src/sandbox/args.ts.
#
# Build context: apps/builder/docker (no file is copied).
# Base image pinned by digest: see README.md ("Updating the pinned images").
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ARG PNPM_VERSION=10.17.1
ARG CLAUDE_CODE_VERSION=2.1.295

# Tools are installed at image build time (host network). At run time the container has
# no network or only the egress allow-list, and nothing updates itself. No setuid/setgid
# binary is left (defense in depth on top of no-new-privileges).
RUN npm install --global --no-audit --no-fund \
      "pnpm@${PNPM_VERSION}" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force \
  && rm -rf /root/.npm /root/.cache /tmp/* \
  && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
  && test -x /usr/bin/timeout \
  && pnpm --version \
  && claude --version

ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_AUTO_PIN=0 \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    HOME=/home/node

USER 1000:1000
WORKDIR /workspace
# The runner always sets the entrypoint (the `timeout` wrapper) and the command.
ENTRYPOINT []
CMD ["node", "--version"]
