# Trustless Agent Substrate (TAS)

A lightweight connectivity layer enabling AI agents from different hosts to collaborate trustlessly through blockchain-based identity, verification, and workflow coordination.

## Overview

The Trustless Agent Substrate (TAS) is **not** an agent runtime or workflow engine. It's a thin capability layer that connects independently operated agents through:

- **MCP (Model Context Protocol)** as the single data plane
- **ERC-8004** for agent identity
- **ERC-8301** for workflow coordination
- **NATS JetStream** for reliable messaging
- **Data Availability layer** for authoritative artifacts
- **Blockchain anchoring** for immutable commitments

```
Agent Hosts
Codex · Claude Code · OpenClaw · Hermes · Custom
                    │
                    │ MCP
                    ▼
   Trustless Agent Substrate (TAS)
Messaging · Identity · Chain · DA · Workflow
                    │
                    ▼
Trustless AI ERCs · DA Providers · Telegram · Discord
```

## Architecture

TAS v0.1 implements a **Daily Contribution TAWG** (Trustless Agent Working Group) as the first vertical slice:

1. **Continuous Flow**: Accept contribution messages from Telegram/Discord, store artifacts in DA, anchor digests on-chain
2. **Daily Cutoff**: Freeze contribution snapshot on-chain for enumerable verification
3. **Aggregation**: Verify all contributions from frozen snapshot, produce signed summary, publish results

See [TAS v2.1 Architecture Design](https://gist.github.com/JimmyShi22/5eb40e93362932afea180494fb0dcebb) for the complete design.

## Quick Start

### Prerequisites

- Go 1.22+
- Docker (for NATS and local development)
- Ethereum RPC endpoint (Alchemy, Infura, or local node)

### Setup

```bash
# Clone and setup
git clone https://github.com/trustless-ai/trustless-agent-substrate.git
cd trustless-agent-substrate

# Setup local environment
make setup-local

# Edit configuration
vi config/local.yaml

# Run TAS
make run
```

### Using Docker

```bash
# Start all services (NATS + TAS)
make docker-up

# View logs
make docker-logs

# Stop services
make docker-down
```

## Project Structure

```
trustless-agent-substrate/
├── cmd/tas/              # Main application entry
├── internal/             # Private implementation
│   ├── mcp/             # MCP server
│   ├── messaging/       # NATS JetStream client
│   ├── identity/        # ERC-8004 identity resolution
│   ├── chain/           # Blockchain client
│   ├── workflow/        # ERC-8301 workflow client
│   ├── da/              # Data Availability client
│   ├── artifacts/       # Artifact management
│   ├── verification/    # Verification capabilities
│   ├── webhooks/        # Webhook server
│   └── integrations/    # Telegram/Discord bots
├── pkg/                 # Public packages
│   ├── types/          # Shared types
│   └── errors/         # Error definitions
├── tas-skills/          # TAS setup skills
│   └── setup/          # Agent registration and connection
├── tawg/               # TAWG implementations
│   └── daily-contribution/  # Daily Contribution TAWG
│       ├── contracts/      # Solidity contracts
│       └── skills/         # TAWG-specific skills
├── config/             # Configuration files
├── docker/             # Docker files
├── scripts/            # Utility scripts
└── docs/               # Documentation
```

## Key Concepts

### Agent Identity

Every agent has a canonical ERC-8004 identity:
```
(chainId, identityRegistry, agentId)
```

And a corresponding MCP route:
```
/{chainId}/{identityRegistry}/agents/{agentId}/mcp
```

### Messaging

TAS uses NATS JetStream for at-least-once message delivery:
- `messages.receive` - Fetch messages from agent inbox
- `messages.ack` - Acknowledge processed messages
- `messages.send` - Send messages to other agents

Webhooks are optional wake-up signals; actual message payloads are always fetched via MCP.

### Data Availability

Important artifacts are stored in a DA layer with on-chain commitments:
- Content-addressed storage (CID/hash)
- Supports multiple providers (local-fs, IPFS, Arweave, Celestia)
- Hash-linked for continuity tracking
- On-chain anchoring for verification

### Verification Roadmap

TAS supports a progressive verification strategy:

1. **Phase 1: Attestation** - Signed judgment (v0.1 implementation)
2. **Phase 2: TEE** - Trusted Execution Environment attestation
3. **Phase 3: ZK** - Zero-knowledge cryptographic proofs

Different workflow stages can use different verification mechanisms.

## Development

### Build

```bash
make build
```

### Test

```bash
make test
make test-coverage
```

### Code Quality

```bash
make fmt
make lint
```

## Configuration

See `config/tas.example.yaml` for complete configuration options.

Key sections:
- **server**: HTTP server and MCP endpoint
- **messaging**: NATS JetStream configuration
- **chain**: Ethereum network configurations
- **da**: Data Availability provider settings
- **integrations**: Telegram/Discord bot settings
- **auth**: Connection authorization (TBD in v0.1)

## Documentation

- [Architecture](docs/architecture.md)
- [API Reference](docs/api/)
- [TAS Skills](tas-skills/)
- [Daily Contribution TAWG](tawg/daily-contribution/)

## Related Projects

Part of the [Trustless AI](https://github.com/trustless-ai) ecosystem:

- [agent-ercs](https://github.com/trustless-ai/agent-ercs) - ERC contracts and standards
- [agent-sdk](https://github.com/trustless-ai/agent-sdk) - Go SDK for agent-ercs
- [ccip-router](https://github.com/trustless-ai/ccip-router) - CCIP-Read coordination layer
- [recompute-kit](https://github.com/trustless-ai/recompute-kit) - Recomputation toolkit

## License

Apache-2.0

## Contributing

Contributions welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Contact

- Website: https://trustless-ai.com
- GitHub: https://github.com/trustless-ai
- ENS: trustless-ai.eth
