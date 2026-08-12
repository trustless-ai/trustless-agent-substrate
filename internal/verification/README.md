# internal/verification

Implements the "verify" half of the Daily Contribution TAWG pipeline
(freeze -> enumerate -> **verify** -> aggregate) per
[`tawg/daily-contribution/skills/enumerate-verify.md`](../../tawg/daily-contribution/skills/enumerate-verify.md).

## Why this shape

`VerifySnapshot` never trusts the frozen snapshot's own bookkeeping. For each
enumerated contribution it fetches the DA preimage and independently
recomputes `Keccak256(preimage)`, comparing against the on-chain
`ContentHash`. A contribution is only `Verified: true` if this package
recomputed the hash itself and it matched -- the same "recompute, don't
trust the label" discipline as the OTS-anchor / recompute-lens work
referenced in the TAWG channel.

It also checks the two structural failure modes the skill doc calls out
beyond per-item hashing:

- **Duplicate `ContributionID`s** -- the same contribution counted twice
  would silently inflate `contributionCount` / skew aggregation.
- **Missing indices** -- a gap in the expected `0..n-1` sequence means the
  "enumerable" guarantee `daily-cutoff.md` promised doesn't actually hold.
- **Enumeration count mismatch** -- if what got enumerated doesn't match the
  count frozen on-chain, that's flagged as its own structural failure, not
  silently treated as "verify whatever showed up."

`Passed(maxFailures)` mirrors `enumerate-verify.md` step 6's gate before
`aggregate-summary.md` runs. `maxFailures` only bounds transient **DA fetch
errors** (a provider timeout, retried and still failing) -- a hash mismatch,
duplicate ID, or missing index always blocks regardless of the threshold,
since each is a real data-integrity signal per the skill doc ("Hash mismatch
is CRITICAL... possible data corruption or attack"), not noise a tolerance
budget exists to absorb.

## Wiring it up

This package is deliberately backend-agnostic -- it takes an already
enumerated `[]Contribution` (from wherever `daily-cutoff.md` /
`workflow.getContributionByIndex` produces them) and a `DAFetcher`:

```go
type DAFetcher interface {
    Get(ctx context.Context, ref string) ([]byte, error)
}
```

Once `internal/da`'s real client exists, wrap it to satisfy this interface
and call `verification.VerifySnapshot(ctx, snapshotDate, contributionCount,
contributions, realDAClient)`. The `internal/verification/verify_test.go`
fake shows the shape a test double needs.

## Not yet covered here

- Fetching `contributions` from the real chain client (`workflow.go` /
  `internal/chain`) -- out of scope for this package, which starts from an
  already-enumerated list per `enumerate-verify.md`'s own input contract.
- Recording verification results to local storage (`localDb.verifications`
  in the skill doc) and alerting -- that's an integration-layer concern once
  `internal/artifacts` / `internal/webhooks` exist.
