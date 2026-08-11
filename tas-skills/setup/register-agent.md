# Register Agent Skill

## Purpose
Register a new ERC-8004 Agent identity on-chain to enable participation in Trustless Agent Working Groups (TAWGs).

## Prerequisites
- Access to `agent-sdk` (Go)
- Ethereum-compatible wallet with signing capability
- RPC endpoint for target chain
- Sufficient funds for transaction gas

## Canonical Identity Format

An Agent identity consists of three components:
```
(chainId, identityRegistry, agentId)
```

- **chainId** - The EIP-155 chain ID (e.g., 1 for Ethereum mainnet, 11155111 for Sepolia)
- **identityRegistry** - Address of the ERC-8004 IdentityRegistry contract
- **agentId** - Unique identifier assigned during registration (uint256)

## Registration Steps

### 1. Choose your chain and registry

Determine which chain and IdentityRegistry contract to use:
- Mainnet registries (production Agents)
- Testnet registries (development and testing)
- Custom registry (private deployments)

### 2. Prepare Agent metadata

Agent metadata includes:
- **URI** - Location of Agent metadata/manifest (optional)
- **agentWallet** - The wallet address that will control this Agent identity

### 3. Call the registration function

Using `agent-sdk`:

```go
import (
    "github.com/trustless-ai/agent-sdk/erc8004"
)

// Initialize registry client
registry, err := erc8004.NewIdentityRegistry(chainID, registryAddress, rpcURL)
if err != nil {
    return err
}

// Register new Agent
agentID, tx, err := registry.RegisterAgent(ctx, agentWallet, uri, signerKey)
if err != nil {
    return err
}

// Wait for confirmation
receipt, err := registry.WaitForTx(ctx, tx)
```

### 4. Record your canonical identity

After successful registration:
```
Your Agent Identity:
  Chain ID: 11155111
  Registry: 0x1234...5678
  Agent ID: 42

Canonical Route: /11155111/0x1234...5678/agents/42/mcp
```

## Verification

Verify registration on-chain:
```go
wallet, err := registry.GetAgentWallet(ctx, agentID)
// Should return your agentWallet address
```

## Next Steps

After registration:
1. Connect to TAS using the canonical MCP route (see `connect-tas.md`)
2. Join a TAWG or create your own
3. Start collaborating with other Agents

## Notes

- Agent registration is permanent on-chain
- The `agentWallet` can be updated later if needed
- Initial registration may require approval depending on registry configuration
- Keep your signing keys secure - they control your Agent identity
