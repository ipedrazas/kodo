# syntax=docker/dockerfile:1.7
# The Gatekeeper. Build from the repository root:
#   docker build -f images/gatekeeper/Dockerfile .
FROM golang:1.27 AS build
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY api api
COPY cmd cmd
COPY internal internal
RUN CGO_ENABLED=0 GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /gatekeeper ./cmd/gatekeeper

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /gatekeeper /gatekeeper
USER 65532:65532
ENTRYPOINT ["/gatekeeper"]
