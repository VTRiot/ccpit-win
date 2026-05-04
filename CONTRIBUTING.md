# Contributing to CCPIT

This document captures invariants and review checklists that have been earned the hard way through past incidents.

## Schema invariants for "user-explicit intent"

CCPIT treats *user-explicit intent* (a user manually editing a Protocol Marker) as a first-class concept that must survive automated re-scans. The history of these edits is the source of truth.

The 034-B incident taught us that splitting this concept across two storage representations (`projects.json.confirmed` flag + `protocol.json.detection_confidence:'explicit'`) is a structural bug source — the two representations drift out of sync, and an automated process that consults only one of them silently destroys the other.

### Invariants

When adding any field that records "the user explicitly chose X":

1. **There is exactly one canonical field for explicit intent**, and it lives in `<projectPath>/.ccpit/protocol.json` as a `ProtocolHistoryEntry` with `source: 'manual'`.
2. **Do not introduce parallel "is this user-confirmed?" flags** in other JSON files (especially not in `projects.json`).
3. **The append-only history is the source of truth.** Any "current state" is *derived* from the history (see `getCurrentMarker` in `protocolReader.ts`).
4. **Writes must use `appendProtocolEntry(path, source, marker)`.** Direct `writeProtocol` (overwrite) is deprecated and must not be used in new code.
5. **`ProtocolEntrySource` is a closed union (`'auto' | 'manual'`).** Adding a new source category is a deliberate schema change and requires updating every consumer of `getCurrentMarker` to confirm the priority order is still correct.

### Review checklist (when changing protocol/projects schema)

- [ ] Does this PR add a boolean / enum field to `ProjectEntry` that records user intent? **If yes, stop and reconsider.** Use the history instead.
- [ ] Does this PR call `writeProtocol` in non-test code? **If yes, replace with `appendProtocolEntry`.**
- [ ] Does this PR widen the `ProtocolEntrySource` union? **If yes, the priority logic in `getCurrentMarker` and the migration in `runProtocolHistoryV2Migration` need explicit re-review.**
- [ ] Does this PR add a "destructive" operation (an action that loses past data)? **If yes, restate it as an additive operation that records what the user wanted.**

These invariants are also enforced by tests in `src/main/services/protocol/__tests__/protocolHistorySchema.test.ts`. If you find yourself updating a test to relax these checks, the change is almost certainly wrong — talk to the maintainers first.

## Past incidents that earned these rules

- **034 (R3b display + Full Re-scan)**: shipped `confirmed` boolean on `ProjectEntry` as a Lazy-migration field. Existing manually-edited markers had `confirmed: undefined` and were unprotected. Full Re-scan destroyed all of them.
- **034-A (investigation)**: identified the structural cause as "two parallel representations of explicit intent that don't synchronise."
- **034-B (this fix)**: replaced both representations with a single append-only event log in `protocol.json` v2. Bugs of the same shape are now structurally impossible.
