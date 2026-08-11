// Package verification implements the enumerate-and-verify step of the Daily
// Contribution TAWG pipeline (freeze -> enumerate -> verify -> aggregate), per
// tawg/daily-contribution/skills/enumerate-verify.md.
//
// It is deliberately backend-agnostic: it takes an already-enumerated list of
// Contribution references (whatever produced them — a real on-chain frozen
// snapshot today, a fixture in a test) and a DAFetcher to resolve each
// reference's preimage, then independently recomputes Keccak256(preimage) and
// compares it against the on-chain ContentHash. Nothing here trusts the
// snapshot's own bookkeeping: a contribution is only "verified" if this
// package recomputed the hash itself and it matched.
package verification

import (
	"context"
	"fmt"

	"golang.org/x/crypto/sha3"
)

// Contribution is one enumerated entry from a frozen daily snapshot, per
// enumerate-verify.md's per-item shape.
type Contribution struct {
	Index          int    `json:"index"`
	ContributionID string `json:"contributionId"`
	ContentHash    string `json:"contentHash"` // 0x-prefixed hex, as recorded on-chain
	DAReference    string `json:"daReference"`
	Timestamp      int64  `json:"timestamp"`
}

// DAFetcher resolves a DA reference to its raw preimage bytes. Production
// callers wire this to the real DA client (internal/da); tests wire it to an
// in-memory fake. Errors are surfaced as DA failures, never as hash
// mismatches — the two are a different failure class per enumerate-verify.md
// step 4 (mismatches are CRITICAL data-integrity signals, DA errors may be
// transient).
type DAFetcher interface {
	Get(ctx context.Context, ref string) ([]byte, error)
}

// Result is one contribution's verification outcome, matching
// enumerate-verify.md's per-item result shape.
type Result struct {
	Index          int    `json:"index"`
	ContributionID string `json:"contributionId"`
	Verified       bool   `json:"verified"`
	ContentHash    string `json:"contentHash,omitempty"`
	ComputedHash   string `json:"computedHash,omitempty"`
	DAReference    string `json:"daReference,omitempty"`
	Error          string `json:"error,omitempty"`
}

// Summary is the aggregate verification outcome, matching enumerate-verify.md's
// documented "Output" shape (status/summary/failures).
type Summary struct {
	SnapshotDate string   `json:"snapshotDate"`
	Total        int      `json:"total"`
	Verified     int      `json:"verified"`
	Failed       int      `json:"failed"`
	Mismatches   int      `json:"mismatches"`
	DAErrors     int      `json:"daErrors"`
	Duplicates   []string `json:"duplicates,omitempty"`   // contributionIDs seen more than once
	MissingIndex []int    `json:"missingIndex,omitempty"` // gaps in the expected 0..n-1 sequence
	Results      []Result `json:"results"`
}

// Keccak256Hex computes the Ethereum-style Keccak-256 digest of data and
// returns it 0x-prefixed lowercase hex, matching the on-chain ContentHash
// format contributions are recorded with.
func Keccak256Hex(data []byte) string {
	h := sha3.NewLegacyKeccak256()
	h.Write(data)
	return fmt.Sprintf("0x%x", h.Sum(nil))
}

// VerifySnapshot implements enumerate-verify.md steps 3-4: for every
// contribution, fetch its DA preimage, independently recompute the hash, and
// compare against the on-chain ContentHash. It also detects the two
// structural failure modes step 4 calls out beyond per-item hash mismatches:
// duplicate ContributionIDs and gaps in the expected index sequence
// (contributionCount frozen on-chain implies a contiguous 0..n-1 range).
//
// contributionCount is the on-chain-frozen count from the snapshot (the
// enumerate-verify.md input); it is checked against len(contributions)
// independently of any individual hash — a short/long enumeration relative to
// the frozen count is itself a structural integrity failure, not just a
// counting nuisance.
func VerifySnapshot(ctx context.Context, snapshotDate string, contributionCount int, contributions []Contribution, da DAFetcher) Summary {
	sum := Summary{
		SnapshotDate: snapshotDate,
		Results:      make([]Result, 0, len(contributions)),
	}

	if len(contributions) != contributionCount {
		// Not a per-item result -- a structural mismatch between the frozen
		// count and what was actually enumerated. Surface it plainly rather
		// than silently verifying a partial/over-long list.
		sum.Results = append(sum.Results, Result{
			Index:    -1,
			Verified: false,
			Error: fmt.Sprintf(
				"enumeration count mismatch: frozen snapshot says %d, got %d contributions",
				contributionCount, len(contributions),
			),
		})
		sum.Total = len(contributions)
		sum.Failed++
	}

	seenIDs := map[string]int{}
	seenIndex := map[int]bool{}
	maxIndex := -1

	for _, c := range contributions {
		sum.Total++
		seenIndex[c.Index] = true
		if c.Index > maxIndex {
			maxIndex = c.Index
		}
		seenIDs[c.ContributionID]++

		preimage, err := da.Get(ctx, c.DAReference)
		if err != nil {
			sum.Failed++
			sum.DAErrors++
			sum.Results = append(sum.Results, Result{
				Index:          c.Index,
				ContributionID: c.ContributionID,
				Verified:       false,
				DAReference:    c.DAReference,
				Error:          fmt.Sprintf("DA fetch failed: %v", err),
			})
			continue
		}

		computed := Keccak256Hex(preimage)
		if computed != c.ContentHash {
			sum.Failed++
			sum.Mismatches++
			sum.Results = append(sum.Results, Result{
				Index:          c.Index,
				ContributionID: c.ContributionID,
				Verified:       false,
				ContentHash:    c.ContentHash,
				ComputedHash:   computed,
				DAReference:    c.DAReference,
				Error:          "hash mismatch",
			})
			continue
		}

		sum.Verified++
		sum.Results = append(sum.Results, Result{
			Index:          c.Index,
			ContributionID: c.ContributionID,
			Verified:       true,
			ContentHash:    c.ContentHash,
			ComputedHash:   computed,
			DAReference:    c.DAReference,
		})
	}

	for id, n := range seenIDs {
		if n > 1 {
			sum.Duplicates = append(sum.Duplicates, id)
		}
	}

	for i := 0; i <= maxIndex; i++ {
		if !seenIndex[i] {
			sum.MissingIndex = append(sum.MissingIndex, i)
		}
	}

	return sum
}

// Passed reports whether the summary clears an acceptable-failure-rate bar,
// mirroring enumerate-verify.md step 6's gate before invoking
// aggregate-summary.md. maxFailures bounds ONLY DA-fetch failures (transient,
// per enumerate-verify.md step 4/error-handling) -- hash mismatches,
// duplicate ContributionIDs, and missing indices always block regardless of
// maxFailures, since each is a real data-integrity/structural-corruption
// signal (per step 4: "Hash mismatch is CRITICAL", "possible data corruption
// or attack"), not the kind of noise a tolerance threshold exists to absorb.
func (s Summary) Passed(maxFailures int) bool {
	if s.Mismatches > 0 || len(s.Duplicates) > 0 || len(s.MissingIndex) > 0 {
		return false
	}
	return s.DAErrors <= maxFailures
}
