FROM golang:1.22-alpine AS builder

WORKDIR /build

# Install dependencies
RUN apk add --no-cache git make

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Build
RUN make build

FROM alpine:latest

RUN apk add --no-cache ca-certificates

WORKDIR /app

# Copy binary
COPY --from=builder /build/bin/tas /app/tas

# Copy default config
COPY config/tas.example.yaml /app/config/tas.yaml

EXPOSE 8080 9090

ENTRYPOINT ["/app/tas"]
CMD ["--config", "/app/config/tas.yaml"]
