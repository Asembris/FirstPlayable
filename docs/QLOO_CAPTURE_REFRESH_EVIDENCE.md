# Qloo capture refresh provenance

The unique index `qloo_captures_fingerprint_key` and the gateway's conflict-ignore
upsert retained the first capture forever. A cache miss followed by successful
retrieval returned new content with that historical row's ID.

Migration `20261007120000_qloo_capture_refresh.sql` drops only that standalone
unique index and creates the non-unique index
`(request_fingerprint, captured_at desc, id desc)`. Historical migrations,
capture rows, primary keys, immutable UPDATE trigger, and decision pointers are
unchanged. Apply this migration before releasing the changed gateway. Neither
the migration nor the application was deployed during this work.

Each insert returns its own row directly. Captured time is the upstream
snapshot's retrieval time. Fingerprint reads select the newest capture with a
UUID tie-break; cache reads additionally filter expiry strictly greater than
request time before choosing a row. Bulk reads use parallel bounded lookups so
one fingerprint's growing history cannot consume PostgREST's result cap and
hide another fingerprint. By-ID reads ignore TTL. Existing stale fallback still
requires consent, exact artist/domain, and the 30-day bound. Audition scores
continue to keep the artist column null, excluding them from that fallback.

Concurrent refreshes can create multiple rows for one fingerprint. This is
intentional and harmless: each response ID belongs to its own persisted
payload, while subsequent cache reads choose one deterministic newest row.
No old row is updated, deleted, or relabelled.

Regression coverage exercises actual artist and audition route refetches,
repeat cache hits with zero extra provider calls, immutable historical reads
and confirmations, first-hop bulk lookups and stale fallback after refresh,
short-lived expired searches over older still-fresh searches, concurrent
inserts with different contents, production gateway HTTP semantics, and the
forward migration's index replacement.

## Validation on 2026-10-07

- Typecheck passed.
- Full unit/server/presentation/engine suite: 46 files, 846 tests passed.
- Fixture verification passed.
- Migration static checks passed as part of the full suite.
- Production build passed.
- Source and built-asset secret scans passed.
- Production dependency audit passed: zero vulnerabilities.
- No browser code changed; browser tests were not required for this server fix.

## Bounded real attempt

Node required Windows system CA trust (`NODE_USE_SYSTEM_CA=1`); TLS verification
remained enabled. A read-only query found expired artist capture
`64583c09-ea7d-407b-b86e-7f20c0cb5ad3`, captured
`2026-10-04 09:00:18.167918+00`, expired `2026-10-05 09:00:18.845+00`.
The real gateway treated its fingerprint as a cache miss. Exactly one real
Qloo HTTP retrieval succeeded, with quota and launch accounting reconciled.
The attempted isolated temporary-table repro then failed: the management API
runs database queries in a read-only transaction and rejected CREATE TABLE.
No fresh capture was persisted, and no production schema or historical capture
was changed. No second Qloo retrieval was attempted.

A subsequent read-only catalog check confirmed the production fingerprint
unique index remains applied. Consequently the full real persisted-row proof
is **incomplete**. Unit/transport regressions pass, but this is not a claim
that production has been repaired or that live persistence has been verified.

The committed `scripts/smoke-qloo-provenance.ts` now checks that the migration
is applied before spending any Qloo quota. After an authorized deployment of
the migration, it performs one bounded real refresh through the production
gateway, retains its new evidence row, verifies both IDs, unchanged historical
content, exact fresh timestamps/expiry, and newest-fresh cache selection. It
never applies DDL. Its preflight was run and correctly refused with zero
additional Qloo calls because the migration is not applied.

No push, PR, or deployment was performed. `phase6-handoff/` was never read,
modified, staged, or committed.
