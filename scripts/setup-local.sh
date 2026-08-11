#!/bin/bash
set -e

echo "Setting up local TAS development environment..."

# Check prerequisites
command -v docker >/dev/null 2>&1 || { echo "Docker is required but not installed. Aborting." >&2; exit 1; }
command -v go >/dev/null 2>&1 || { echo "Go is required but not installed. Aborting." >&2; exit 1; }

# Create data directories
mkdir -p data/da
mkdir -p data/nats

# Copy local config if not exists
if [ ! -f config/local.yaml ]; then
    echo "Creating local configuration..."
    cp config/tas.example.yaml config/local.yaml
    echo "⚠️  Please edit config/local.yaml with your settings"
fi

# Start NATS via docker
echo "Starting NATS JetStream..."
docker run -d \
    --name tas-nats \
    -p 4222:4222 \
    -p 8222:8222 \
    -v $(pwd)/data/nats:/data \
    nats:latest \
    -js -m=8222

# Wait for NATS to be ready
echo "Waiting for NATS to be ready..."
sleep 3

# Install Go dependencies
echo "Installing Go dependencies..."
go mod download

echo "✅ Local environment setup complete!"
echo ""
echo "Next steps:"
echo "  1. Edit config/local.yaml with your settings"
echo "  2. Run 'make run' to start TAS"
echo "  3. Access NATS monitoring at http://localhost:8222"
echo "  4. Access TAS at http://localhost:8080"
echo ""
echo "To stop NATS: docker stop tas-nats"
echo "To remove NATS: docker rm tas-nats"
