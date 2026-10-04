-- FirstPlayable phase 4 — harden the validated-version guard against text
-- coercion (specification section 11).
--
-- This is a forward migration. It does not edit
-- `20261004160000_phase4_compilation.sql`, which stays exactly as it was
-- applied; it replaces one check constraint that migration added.
--
-- ## The defect this fixes
--
-- `20261004160000` wrote the guard as:
--
--     (validation_summary ->> 'ok')::boolean is true
--
-- `->>` extracts the value as **text**, and `text::boolean` accepts every
-- spelling PostgreSQL's boolean input function accepts. A validation summary
-- whose `ok` is the JSON *string* `"true"` — or `"t"`, `"yes"`, `"on"`, or
-- `"1"` — therefore satisfied a constraint whose entire purpose is to make
-- "only validated versions are inserted" a database guarantee rather than a
-- convention.
--
-- It was found by probing the live database with deliberately invalid inserts
-- (`docs/PHASE4_EVIDENCE.md` §12.9). Four invalid shapes were refused and one
-- was accepted. Nothing was committed, and `scene_versions` was empty at the
-- time, so no stored row relies on the weaker form.
--
-- It is not reachable from this application: every insert goes through
-- `commit_scene_version` with a `ValidationSummaryView`, whose `ok` is a Zod
-- boolean and therefore always a JSON boolean. That is the reason it was never
-- observed, and it is not a reason to leave it: the constraint exists to be
-- the last line of defence precisely when application code is wrong.
--
-- ## The fix
--
-- Compare the JSON **value**, not a text projection of it:
--
--   * `validation_summary ? 'ok'` first, so the key's absence is a definite
--     false rather than a NULL. A check constraint accepts NULL, so this
--     ordering is load-bearing: without it, a summary with no `ok` key would
--     make `jsonb_typeof` return NULL and pass. The old constraint got this
--     right by accident, because `IS TRUE` is false for NULL.
--   * `jsonb_typeof(...) = 'boolean'` states the intent explicitly, so a
--     reader of the catalog sees that the type is part of the contract.
--   * `(validation_summary -> 'ok') = 'true'::jsonb` is the decision. It is a
--     jsonb equality against a folded literal, so no text parsing happens at
--     any point. `'"true"'::jsonb` is a different value and does not match.
--
-- `validation_summary` is `not null`, so the whole expression is total.
--
-- Nothing else changes: the `subsets` and `witnesses` requirements are carried
-- over verbatim, no column is altered, no function is created or redefined, no
-- table is created or dropped, no policy is added, and no grant moves.

-- ---------------------------------------------------------------------------
-- The replacement.
-- ---------------------------------------------------------------------------

alter table public.scene_versions
  drop constraint scene_versions_validation_passed;

alter table public.scene_versions
  add constraint scene_versions_validation_passed
  check (
    validation_summary ? 'ok'
    and jsonb_typeof(validation_summary -> 'ok') = 'boolean'
    and (validation_summary -> 'ok') = 'true'::jsonb
    and validation_summary ? 'subsets'
    and validation_summary ? 'witnesses'
  );

comment on constraint scene_versions_validation_passed on public.scene_versions is
  'Refuses an unvalidated candidate. `ok` must be the JSON boolean true, compared as a JSON value so no text coercion admits "true", "t", "yes", or "1". Failed candidate JSON lives only in a bounded operation artifact (specification section 11).';
