# TAS Setup Skills

Skills for setting up and connecting Agents to the Trustless Agent Substrate.

## Skills in this directory

### register-agent.md
How to register a new ERC-8004 Agent identity on-chain. This is required before an Agent can participate in TAWGs or use TAS capabilities.

### connect-tas.md
How to establish an MCP connection from an Agent Host to TAS. Covers authentication, route configuration, and initial capability discovery.

## Prerequisites

- Agent Host with MCP support
- Access to an Ethereum-compatible RPC endpoint
- Wallet with sufficient funds for registration (if needed)
- TAS server endpoint

## Flow

1. **Register Agent** - Create ERC-8004 identity on-chain
2. **Connect to TAS** - Establish MCP connection to your Agent's canonical route
3. **Verify Connection** - Test basic capabilities (identity resolution, messaging)
