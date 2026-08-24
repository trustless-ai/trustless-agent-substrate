# Collaboration acceptance pack

This directory is the deterministic input and public-evidence record format for the TAWG Collaboration Skill acceptance gate. It exercises Agent decisions without adding a TAS classifier, scheduler, approval service, cursor store, or message protocol.

`scenarios.json` is test-only stimulus and rubric data. Its messages are ordinary, natural-language examples for an Agent Host to interpret privately. Scenario IDs and rubric strings are not fields that people or production Chat transports must send.

`acceptance.schema.json` validates the public evidence retained after Jimmy's three-Agent run. It is a test record, not a product message protocol and not a Collaboration Message protocol. Do not turn it into a production JSON or YAML envelope.

## Automated gate

From the repository root, run:

```sh
npm test -- test/conformance/collaborationAcceptancePack.test.ts test/integration/offlineChat.test.ts
```

The conformance test checks the scenario shape, required branches, natural message examples, closed evidence schema, and runbook. The existing offline Chat integration test covers the local transport boundary; approval, classification, cursor ownership, and accepted work remain in each Agent Host.

## Human gate

Jimmy follows `THREE-AGENT-RUNBOOK.md` with three independent Agent Hosts and three isolated working directories. Use local simulation only. Replace angle-bracket placeholders with public identifiers produced by that run; never copy a value from this repository into runtime configuration.

After the run, create one record conforming to `acceptance.schema.json` and validate it with a JSON Schema 2020-12 validator. Then run the test-only semantic gate:

```sh
npx --no-install tsx test/acceptance/collaboration/validate-record.ts <acceptance-record.json>
```

The second gate validates the full closed record shape itself and then requires three distinct ERC-8004 identities, every scenario, globally unique approval evidence linked to each scenario that requires it, at least one restart boundary, all required human checks, and Jimmy's acceptance. The record may contain only the listed public evidence: public TAWG and ERC-8004 identifiers, exact public Role Skill source metadata returned by `role.get`, UUID approval/restart identifiers, `message:<sha256>` public message references, commits, transaction hashes, check outcomes, and Jimmy's acceptance decision.

Never record a secret, credential, private key, RPC URL, raw private message content, authentication header, session transcript, or unlisted field. Keep runtime-only data under the ignored acceptance directory chosen for the run, outside this pack.

Acceptance requires every scenario ID to appear in at least one round, three distinct canonical decimal Agent IDs, exactly three completed rounds, at least one restart boundary, every required check below to pass, and `accepted_by_human` set from Jimmy's actual decision. `checks[].note` is the fixed value `public-note:observed`, not free text:

- `independent-agent-state`
- `action-approval-gates`
- `message-approval-gates`
- `bounded-automation`
- `natural-language-collaboration`
- `rejected-approval-no-effect`
- `authoritative-rechecks`
- `restart-and-deduplication`
- `later-round-isolation`
