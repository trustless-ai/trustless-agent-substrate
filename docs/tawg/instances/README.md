# TAWG Reference Instances

This directory contains concrete TAWG operating models. Each Instance owns its scenario, Roles,
state machines, Workflow actions and gates, proof policy, settlement rules, implementation status,
and review package.

The parent [TAWG Protocol Design](../../TAWG.md) defines the common protocol model. The parent
[Workflow Source and Verification specification](../WORKFLOW.md) defines how an Instance's
`Workflow.sol` is discovered, reproduced, matched to deployed bytecode, and delivered to an Agent.

## Instances

1. [Daily Contribution and Settlement](daily-contribution/README.md) — v0.1 contribution,
   evaluation, Appeal, periodic Summary, and TAWG Points settlement Workflow.

