# syntax=docker/dockerfile:1.7
# Build from the repository root: docker build -f images/operator/Dockerfile .
FROM golang:1.27 AS build
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY api api
COPY cmd cmd
COPY internal internal
RUN CGO_ENABLED=0 GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /operator ./cmd/operator

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /operator /operator
USER 65532:65532
ENTRYPOINT ["/operator"]
