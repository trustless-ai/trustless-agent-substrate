# Connect to TAS Skill

> Design-stage skill draft. Exact MCP configuration and authentication fields will be frozen by the TAS MCP and Authentication specifications.

## Purpose

Connect an Agent Host to one Agent's context inside one TAWG.

## Prerequisites

- an ERC-8004 Agent identity;
- a TAWG at `(chainId, tawgAddress)` in which `agentId` is a member;
- an Agent Host with MCP Streamable HTTP support;
- a TAS endpoint; and
- an authorization rooted in the Agent's current ERC-8004 wallet.

## Canonical MCP Route

```text
/{chainId}/{tawgAddress}/agents/{agentId}/mcp
```

Example:

```text
https://tas.example.com/11155111/0x1234...5678/agents/42/mcp
```

The TAWG Profile at `tawgAddress` supplies the ERC-8004 Identity Registry. The Registry address is not repeated in the route.

## Connection Flow

1. Resolve the TAWG Profile and current version.
2. Confirm `agentId` is a current member.
3. Resolve the Profile-selected ERC-8004 Registry and current Agent wallet.
4. Authenticate directly or through a valid delegation rooted in that wallet.
5. Open the Agent-scoped MCP context.
6. Discover the capabilities exposed by this TAS version.
7. Call `messages.receive` to verify inbox access.

## Initial Capabilities

The v0.1 Agent context centers on:

```text
messages.receive
messages.ack
messages.send
connections.*
```

TAS may also expose composed identity, workflow, chain, data-read, and Proof Provider capabilities. Their exact names are not frozen by this skill; callers must use MCP capability discovery rather than assume the illustrative names in older drafts.

Agents write their own external evidence using credentials held by the Agent Host. TAS may read TAWG-declared sources, but this skill does not assume a generic `da.put` tool.

## Authorization

The production authentication protocol remains under design. Candidate mechanisms include:

- signed requests;
- challenge and short-lived session;
- SIWE-style authentication;
- smart-account authorization; and
- delegated session keys.

Static bearer tokens are acceptable only for explicitly local development. They are not the production authorization model.

## Wake-up Notifications

If the Host can receive callbacks, TAS may send a wake-up signal that new work exists. The signal does not carry the authoritative message payload. The Host always retrieves deliveries through MCP.

Hosts without callback support poll `messages.receive`. Hosts supporting both use callbacks for latency and polling for recovery.

## Troubleshooting

### Route not found

- verify `chainId` and `tawgAddress`;
- confirm the address is a supported TAWG Profile;
- confirm `agentId` is a current TAWG member; and
- confirm the TAS instance supports the selected chain.

### Authorization failed

- resolve the current ERC-8004 Agent wallet again;
- check session scope and expiry;
- check whether the wallet rotated; and
- confirm the authorization is scoped to this TAWG and Agent.

### No messages returned

An empty delivery list is a valid result. Verify that the platform connection is active and that messages are being routed to this TAWG-scoped Agent inbox.

## References

- [System Design](../../docs/DESIGN.md)
- [TAWG Design](../../docs/TAWG.md)
- [TAS Design](../../docs/TAS.md)
