# syntax=docker/dockerfile:1.7
# The kernel as a deploy image: celld, esbuild and the kernel source. Run with
# the fleet's bucket in CELLD_BUCKET, S3_ENDPOINT and the AWS_* variables and
# the identity settings scripts/deploy.sh reads, it deploys the kernel; the
# fleet's nodes adopt it without restarting.
# Build from the repository root: docker build -f images/kernel/Dockerfile .
ARG CELLD_IMAGE=ghcr.io/denoland/celld:0.6.1
ARG ESBUILD_VERSION=0.28.2

FROM debian:bookworm-slim AS esbuild
ARG ESBUILD_VERSION
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    arch=$([ "$TARGETARCH" = "amd64" ] && echo x64 || echo "$TARGETARCH") && \
    curl -fsSL "https://registry.npmjs.org/@esbuild/linux-$arch/-/linux-$arch-$ESBUILD_VERSION.tgz" | \
      tar -xz -C /tmp package/bin/esbuild && \
    install -m 755 /tmp/package/bin/esbuild /usr/local/bin/esbuild

FROM ${CELLD_IMAGE}
ARG KERNEL_BUILD=dev
COPY --from=esbuild /usr/local/bin/esbuild /usr/local/bin/esbuild
COPY kernel/wrangler.jsonc /kernel/wrangler.jsonc
COPY kernel/src /kernel/src
COPY kernel/scripts/deploy.sh /kernel/scripts/deploy.sh
RUN printf 'export const KERNEL_BUILD = "%s";\n' "$KERNEL_BUILD" > /kernel/src/build.ts
ENTRYPOINT ["/kernel/scripts/deploy.sh"]
CMD []
