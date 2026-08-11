# TAS v0.1 Project Structure

## Created: 2026-08-11

This directory structure was created based on the TAS v2.1 Architecture Design and v0.1 Prototype Addendum.

## Structure Overview

### Core Application (`cmd/`, `internal/`, `pkg/`)
- **cmd/tas/**: Main entry point for TAS server
- **internal/**: Private implementation modules
  - `mcp/`: MCP server implementation
  - `messaging/`: NATS JetStream client
  - `identity/`: ERC-8004 identity resolution
  - `chain/`: Blockchain client wrapper
  - `workflow/`: ERC-8301 workflow client
  - `da/`: Data Availability layer client
  - `artifacts/`: Artifact management and verification
  - `verification/`: Verification capabilities integration
  - `webhooks/`: Optional webhook server
  - `integrations/telegram|discord/`: Bot integrations
  - `config/`: Configuration loading
- **pkg/**: Exportable public packages
  - `types/`: Shared type definitions
  - `errors/`: Error types

### Skills
- **tas-skills/setup/**: Infrastructure skills for agent registration and TAS connection
- **tawg/daily-contribution/skills/**: Business logic skills for Daily Contribution TAWG
  - `handle-mention.md`: Process Telegram/Discord mentions
  - `process-contribution.md`: Store and anchor contributions
  - `daily-cutoff.md`: Execute daily snapshot freeze
  - `enumerate-verify.md`: Verify frozen contributions
  - `aggregate-summary.md`: Produce and publish daily summary

### TAWG Implementation
- **tawg/daily-contribution/**:
  - `contracts/`: Solidity contracts extending agent-ercs
  - `skills/`: TAWG-specific agent skills
  - `deployments/`: Contract deployment records

### Configuration & Deployment
- **config/**: YAML configuration files
  - `tas.example.yaml`: Full configuration template
  - `local.yaml`: Local development config
- **docker/**: Docker and docker-compose files
- **scripts/**: Setup and utility scripts

### Documentation & Testing
- **docs/**: Architecture and API documentation
- **test/**: Integration tests and fixtures

## Next Steps

1. **Implement Core Modules**
   - Start with foundational types in `pkg/types/`
   - Implement configuration loading in `internal/config/`
   - Build messaging layer with NATS
   - Integrate agent-sdk for chain and identity

2. **Develop MCP Server**
   - Route handlers for `/{chainId}/{registry}/agents/{agentId}/mcp`
   - Capability endpoints (messages, identity, chain, workflow, da)

3. **Create Daily Contribution TAWG**
   - Write Solidity contracts
   - Implement business logic
   - Deploy and test end-to-end flow

4. **Documentation**
   - Architecture deep-dive
   - API reference
   - Deployment guide

## Design References

- [TAS v2.1 Architecture](https://gist.github.com/JimmyShi22/5eb40e93362932afea180494fb0dcebb)
- [TAS v0.1 Prototype Addendum](https://gist.github.com/JimmyShi22/5eb40e93362932afea180494fb0dcebb#gistcomment-5197916)
- [TAWG Funding Design](https://gist.github.com/TMerlini/8737d15d1519ed263de7d5ef0ea485ba)

## Ecosystem

Part of [trustless-ai](https://github.com/trustless-ai):
- agent-ercs: ERC contracts
- agent-sdk: Go SDK
- ccip-router: CCIP-Read coordination
- recompute-kit: Verification toolkit
