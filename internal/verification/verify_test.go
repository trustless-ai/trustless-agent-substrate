package verification

import (
	"context"
	"errors"
	"testing"
)

// fakeDA is an in-memory DAFetcher for tests -- maps a reference string
// directly to its preimage bytes, with an optional per-reference error to
// simulate a DA fetch failure.
type fakeDA struct {
	preimages map[string][]byte
	errs      map[string]error
}

func (f *fakeDA) Get(_ context.Context, ref string) ([]byte, error) {
	if err, ok := f.errs[ref]; ok {
		return nil, err
	}
	if p, ok := f.preimages[ref]; ok {
		return p, nil
	}
	return nil, errors.New("not found")
}

func contrib(idx int, id string, content []byte, ref string) Contribution {
	return Contribution{
		Index:          idx,
		ContributionID: id,
		ContentHash:    Keccak256Hex(content),
		DAReference:    ref,
	}
}

func TestVerifySnapshot_AllVerified(t *testing.T) {
	da := &fakeDA{preimages: map[string][]byte{
		"ref0": []byte("hello contribution 0"),
		"ref1": []byte("hello contribution 1"),
	}}
	contribs := []Contribution{
		contrib(0, "c0", []byte("hello contribution 0"), "ref0"),
		contrib(1, "c1", []byte("hello contribution 1"), "ref1"),
	}

	sum := VerifySnapshot(context.Background(), "2026-08-11", 2, contribs, da)

	if sum.Total != 2 || sum.Verified != 2 || sum.Failed != 0 {
		t.Fatalf("expected 2/2 verified, got total=%d verified=%d failed=%d", sum.Total, sum.Verified, sum.Failed)
	}
	if !sum.Passed(0) {
		t.Fatalf("expected Passed(0) true for a clean snapshot")
	}
}

func TestVerifySnapshot_HashMismatchIsCritical(t *testing.T) {
	da := &fakeDA{preimages: map[string][]byte{
		// Preimage doesn't match what the on-chain hash was computed from --
		// simulates tampered or corrupted DA content.
		"ref0": []byte("TAMPERED"),
	}}
	contribs := []Contribution{
		contrib(0, "c0", []byte("original content"), "ref0"),
	}

	sum := VerifySnapshot(context.Background(), "2026-08-11", 1, contribs, da)

	if sum.Mismatches != 1 {
		t.Fatalf("expected 1 mismatch, got %d", sum.Mismatches)
	}
	if sum.Results[0].Verified {
		t.Fatalf("mismatched contribution must not be marked verified")
	}
	if sum.Results[0].ComputedHash == sum.Results[0].ContentHash {
		t.Fatalf("computed and content hash should differ on a real mismatch")
	}
	// Per enumerate-verify.md: a mismatch is never an acceptable failure,
	// regardless of how generous the threshold is.
	if sum.Passed(100) {
		t.Fatalf("a hash mismatch must never pass, even with a large maxFailures budget")
	}
}

func TestVerifySnapshot_DAErrorIsNotAMismatch(t *testing.T) {
	da := &fakeDA{errs: map[string]error{
		"ref0": errors.New("timeout fetching from provider"),
	}}
	contribs := []Contribution{
		contrib(0, "c0", []byte("whatever"), "ref0"),
	}

	sum := VerifySnapshot(context.Background(), "2026-08-11", 1, contribs, da)

	if sum.DAErrors != 1 {
		t.Fatalf("expected 1 DA error, got %d", sum.DAErrors)
	}
	if sum.Mismatches != 0 {
		t.Fatalf("a DA fetch failure must not be double-counted as a hash mismatch, got %d", sum.Mismatches)
	}
	if sum.Results[0].ComputedHash != "" {
		t.Fatalf("no computed hash should exist when the preimage was never fetched")
	}
}

func TestVerifySnapshot_DuplicateContributionIDBlocksRegardlessOfThreshold(t *testing.T) {
	content := []byte("same content twice")
	da := &fakeDA{preimages: map[string][]byte{
		"ref0": content,
		"ref1": content,
	}}
	contribs := []Contribution{
		contrib(0, "dup", content, "ref0"),
		contrib(1, "dup", content, "ref1"), // same ContributionID, different index/ref
	}

	sum := VerifySnapshot(context.Background(), "2026-08-11", 2, contribs, da)

	if len(sum.Duplicates) != 1 || sum.Duplicates[0] != "dup" {
		t.Fatalf("expected duplicate 'dup' detected, got %v", sum.Duplicates)
	}
	// Both individual items hash-verify fine -- the point is that a clean
	// per-item pass must not silently paper over a duplicate ID.
	if sum.Passed(100) {
		t.Fatalf("a duplicate contributionId must block Passed() even with generous threshold")
	}
}

func TestVerifySnapshot_MissingIndexGapBlocksRegardlessOfThreshold(t *testing.T) {
	da := &fakeDA{preimages: map[string][]byte{
		"ref0": []byte("a"),
		"ref2": []byte("c"),
	}}
	// Index 1 is missing -- enumeration returned 0 and 2 but not 1, a real
	// gap the daily-cutoff snapshot should never allow.
	contribs := []Contribution{
		contrib(0, "c0", []byte("a"), "ref0"),
		contrib(2, "c2", []byte("c"), "ref2"),
	}

	sum := VerifySnapshot(context.Background(), "2026-08-11", 2, contribs, da)

	if len(sum.MissingIndex) != 1 || sum.MissingIndex[0] != 1 {
		t.Fatalf("expected missing index [1], got %v", sum.MissingIndex)
	}
	if sum.Passed(100) {
		t.Fatalf("a missing index must block Passed() even with generous threshold")
	}
}

func TestVerifySnapshot_EnumerationCountMismatchIsFlagged(t *testing.T) {
	da := &fakeDA{preimages: map[string][]byte{"ref0": []byte("a")}}
	contribs := []Contribution{
		contrib(0, "c0", []byte("a"), "ref0"),
	}

	// Frozen snapshot claims 5 contributions but only 1 was actually
	// enumerated -- a structural integrity failure distinct from any
	// per-item hash check.
	sum := VerifySnapshot(context.Background(), "2026-08-11", 5, contribs, da)

	found := false
	for _, r := range sum.Results {
		if r.Index == -1 && r.Error != "" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a structural count-mismatch result, got %+v", sum.Results)
	}
}

func TestVerifySnapshot_EmptySnapshotIsCleanPass(t *testing.T) {
	da := &fakeDA{}
	sum := VerifySnapshot(context.Background(), "2026-08-11", 0, nil, da)

	if sum.Total != 0 || !sum.Passed(0) {
		t.Fatalf("an empty, correctly-frozen (count=0) snapshot should pass cleanly, got %+v", sum)
	}
}

func TestKeccak256Hex_MatchesKnownVector(t *testing.T) {
	// keccak256("") is a well-known reference vector (distinct from
	// SHA3-256's empty-string digest -- this confirms we're using Ethereum's
	// legacy Keccak, not standard SHA-3, matching every on-chain contentHash
	// this package will ever compare against).
	got := Keccak256Hex(nil)
	want := "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
	if got != want {
		t.Fatalf("Keccak256Hex(nil) = %s, want %s", got, want)
	}
}
