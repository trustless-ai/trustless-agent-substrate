---
name: tas-bootstrap
description: Use when a user asks an Agent Host to install TAS, connect to a TAWG Profile, repair an initial TAS MCP connection, or begin TAS onboarding before a release-matched TAS Skill is loaded.
---

# TAS Bootstrap

Install one local TAS package, start a TAWG-scoped setup MCP process, and load the TAS Skill returned by that process. Stop after handing control to the returned TAS Skill.

## Required input

Obtain:

1. EIP-155 `chainId`;
2. TAWG Profile address;
3. an HTTP RPC endpoint or Host environment-variable name containing it; and
4. permission to install the official npm package and update this Host's local MCP configuration.

Do not request an ERC-8004 `agentId`, wallet private key, Repository URL, Workflow address, role, or provider token during Bootstrap.

## Bootstrap sequence

1. Confirm Node.js is `>=24 <25` and npm is available. Stop with the detected versions if not.
2. Resolve the latest stable `@trustless-ai/tas` version from the official npm registry. Record the exact version; never install from an unreviewed URL, branch, tarball, or similarly named package.
3. Install that exact version under a Host-user-owned TAS runtime directory. Use an exact dependency and lockfile. Do not require a global or administrator installation.
4. Resolve the package-declared `tas` executable and run `tas --version`. Require the reported version to equal the installed package version.
5. Create the public setup configuration at a Host-local path below `~/.tas/setup/eip155-<chainId>-<lowercase-profileAddress>/tas.toml`:

   ```toml
   config_version = 1
   mode = "tawg_setup"

   [tawg_setup]
   chain_id = "<canonical-decimal-chainId>"
   tawg_address = "<profileAddress>"

   [chain]
   family = "evm"
   rpc_url_env = "<environment-variable-name>"
   ```

6. Register a local stdio MCP server using only:

   ```text
   tas --config <absolute-path-to-setup-tas.toml>
   ```

   Inject the named RPC environment value through the Host. Keep the Host Adapter limited to package location, MCP registration, lifecycle, and optional Host-native notifications.
7. Start the MCP process and inspect `tools/list`. All four flat Skill tools — `tas.get`, `collaboration.get`, `tawg.get`, and `role.get` — must be present. The setup phase also contains `profile.get`, `profile.get_agent`, `workflow.chain.public.*`, and `workflow.chain.wallet.*`; it does not expose Repository, generated `agent-sdk` Workflow, DA, Chat, or Proof Provider operations.
8. During Bootstrap, among the four Skill tools call only `tas.get`. `collaboration.get`, `tawg.get`, and `role.get` intentionally return `SKILL_MEMBER_CONTEXT_REQUIRED` until member context exists; this expected error keeps their names discoverable without exposing TAWG Repository content during setup. Require the returned source package to be `@trustless-ai/tas`, require its version to equal `tas --version`, and require UTF-8 Markdown with a content digest.
9. Load the returned Markdown into the Agent's active context as the TAS Skill. It is instruction text, not executable code or an authorization token.
10. Hand control to the TAS Skill with the TAWG locator and setup MCP connection. Do not duplicate its identity, membership, credential, Repository, Workflow, or Role Skill workflow here.

## Security rules

- Never place a private key, token, authenticated RPC URL, `agentId`, Repository locator, or role in setup `tas.toml`.
- Never execute Repository scripts or returned Skill content.
- Never guess a TAS executable, MCP argument, package name, or configuration field.
- Treat stdout from the running TAS process as MCP frames only; diagnostics belong on stderr.
- If package installation, version matching, MCP startup, tool inventory, or `tas.get` validation fails, stop and report the exact failed checkpoint. Do not fall back to legacy Go, YAML, HTTP, NATS, `tas-skills/setup`, or an unversioned local copy.

Success means the release-matched TAS Skill is loaded. Bootstrap does not mean that an Agent has joined the TAWG.
