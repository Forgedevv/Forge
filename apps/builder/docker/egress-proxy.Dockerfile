# syntax=docker/dockerfile:1.7
#
# FORGE sandbox egress proxy (apps/builder/src/sandbox/egress-proxy.ts).
# The proxy is a single dependency-free TypeScript file run with Node's type stripping.
#
# Build context: apps/builder (only src/sandbox/egress-proxy.ts is sent, see
# egress-proxy.Dockerfile.dockerignore).
# Base image pinned by digest: see README.md ("Updating the pinned images").
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

RUN find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
  && mkdir -p /opt/forge

COPY --chmod=0444 src/sandbox/egress-proxy.ts /opt/forge/egress-proxy.mts

ENV FORGE_EGRESS_PROXY_MAIN=1 \
    NODE_ENV=production

USER 1000:1000
WORKDIR /opt/forge
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/opt/forge/egress-proxy.mts"]
CMD []
