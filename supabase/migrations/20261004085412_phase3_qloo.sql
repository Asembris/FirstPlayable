-- FirstPlayable phase 3 — the smallest forward migration real Qloo retrieval
-- and explicit influence approval actually need.
--
-- The phase 2 schema already models everything phase 3 stores: `qloo_captures`
-- holds immutable normalized retrieval evidence, `influence_decisions` is
-- append-only with a predecessor pointer, `projects.anchor` and
-- `projects.reference_capture_ids` are already declared, and
-- `append_influence_decision` already performs the revision compare-and-swap
-- that an explicit approval needs. None of that is rewritten here.
--
-- What phase 3 genuinely adds:
--
--   1. `projects.proposal_draft` — the current proposal draft, which
--      specification section 11 explicitly permits as a JSONB field on the
--      project rather than a table of its own.
--   2. `budget_buckets.last_launch_at` — the one piece of state a 250 ms
--      global launch gap needs, and which no phase 2 counter could express.
--   3. `reserve_qloo_launch` / `release_qloo_launch` — the database-backed
--      global launch policy of specification section 6. It is deliberately a
--      *separate* function from `reserve_model_budget`, operating under its
--      own `scope`, so Qloo pacing cannot corrupt model budgeting: the two
--      never touch the same row.
--   4. `confirm_project_anchor`, `set_project_references`, and
--      `set_project_proposal_draft` — three owner-checked, revision-checked
--      writes, so no phase 3 route mutates a project through a bare UPDATE.
--
-- No phase 2 migration is modified. No table is dropped. No column is removed.

-- ---------------------------------------------------------------------------
-- 1. The current proposal draft lives on the project.
-- ---------------------------------------------------------------------------

alter table public.projects
  add column if not exists proposal_draft jsonb
    constraint projects_proposal_draft_bounded
      check (proposal_draft is null or length(proposal_draft::text) <= 65536);

comment on column public.projects.proposal_draft is
  'The current bounded proposal draft. A draft is not an approval: the approval pointer is active_approvals, written only by append_influence_decision (specification section 7).';

-- A stale fallback looks for the newest capture for one exact artist and
-- domain. The phase 2 index covers the predicate; this one orders the result.
create index if not exists qloo_captures_artist_domain_captured_idx
  on public.qloo_captures (artist_entity_id, domain, captured_at desc);

-- ---------------------------------------------------------------------------
-- 2. Global Qloo launch pacing state.
-- ---------------------------------------------------------------------------

alter table public.budget_buckets
  add column if not exists last_launch_at timestamptz;

comment on column public.budget_buckets.last_launch_at is
  'When this bucket last granted an upstream launch. Only the qloo_launch scope writes it; the model-call scope leaves it null, so the two policies share a table without sharing a row.';

-- ---------------------------------------------------------------------------
-- 3. The global Qloo launch policy.
-- ---------------------------------------------------------------------------

/*
 * Grants permission to start one upstream Qloo request.
 *
 * Two conditions, both decided under one row lock, so two serverless
 * instances cannot both be granted:
 *
 *   * at most `p_max_leases` requests may be in flight at once;
 *   * at least `p_min_spacing_ms` must have elapsed since the previous grant.
 *
 * The row lock is released when this statement's transaction commits, which
 * is *before* the caller opens its socket. No database transaction is held
 * across network I/O (specification section 6).
 *
 * A refusal is a normal outcome, not an error: it carries `retry_after_ms` so
 * the caller can wait exactly as long as the policy requires. Expired leases
 * are swept on every call, so a crashed request costs concurrency for one
 * lease duration and no longer.
 */
create or replace function public.reserve_qloo_launch(
  p_scope text,
  p_bucket_key text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_max_leases integer,
  p_min_spacing_ms integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := clock_timestamp();
  v_bucket public.budget_buckets;
  v_lease_id uuid := gen_random_uuid();
  v_kept jsonb;
  v_active integer;
  v_since_ms numeric;
  v_wait_ms integer;
  v_next_free timestamptz;
begin
  if p_max_leases < 1 or p_max_leases > 8 then
    raise exception 'max leases out of range' using errcode = 'check_violation';
  end if;
  if p_min_spacing_ms < 0 or p_min_spacing_ms > 60000 then
    raise exception 'spacing out of range' using errcode = 'check_violation';
  end if;
  if p_lease_seconds < 1 or p_lease_seconds > 600 then
    raise exception 'lease seconds out of range' using errcode = 'check_violation';
  end if;

  insert into public.budget_buckets (scope, bucket_key, window_start, window_end, call_limit)
  values (p_scope, p_bucket_key, p_window_start, p_window_end, p_max_leases)
  on conflict (scope, bucket_key, window_start) do nothing;

  select * into v_bucket
  from public.budget_buckets
  where scope = p_scope and bucket_key = p_bucket_key and window_start = p_window_start
  for update;

  -- Sweep the leases whose request never released.
  select
    coalesce(
      jsonb_agg(lease) filter (where (lease ->> 'expires_at')::timestamptz > v_now),
      '[]'::jsonb
    ),
    coalesce(
      min((lease ->> 'expires_at')::timestamptz) filter (
        where (lease ->> 'expires_at')::timestamptz > v_now
      ),
      v_now
    )
  into v_kept, v_next_free
  from jsonb_array_elements(v_bucket.active_leases) as lease;

  v_active := jsonb_array_length(v_kept);

  if v_active >= p_max_leases then
    update public.budget_buckets
    set active_leases = v_kept,
        reserved_calls = v_active,
        call_limit = p_max_leases,
        updated_at = v_now
    where id = v_bucket.id;

    return jsonb_build_object(
      'granted', false,
      'reason', 'concurrency',
      'active_leases', v_active,
      'max_leases', p_max_leases,
      'retry_after_ms',
        greatest(1, least(5000, ceil(extract(epoch from (v_next_free - v_now)) * 1000)::integer))
    );
  end if;

  v_since_ms := case
    when v_bucket.last_launch_at is null then null
    else extract(epoch from (v_now - v_bucket.last_launch_at)) * 1000
  end;

  if v_since_ms is not null and v_since_ms < p_min_spacing_ms then
    v_wait_ms := greatest(1, ceil(p_min_spacing_ms - v_since_ms)::integer);

    update public.budget_buckets
    set active_leases = v_kept,
        reserved_calls = v_active,
        call_limit = p_max_leases,
        updated_at = v_now
    where id = v_bucket.id;

    return jsonb_build_object(
      'granted', false,
      'reason', 'spacing',
      'active_leases', v_active,
      'max_leases', p_max_leases,
      'retry_after_ms', v_wait_ms
    );
  end if;

  update public.budget_buckets
  set active_leases = v_kept || jsonb_build_array(jsonb_build_object(
        'id', v_lease_id,
        'calls', 1,
        'tokens', 0,
        'expires_at', v_now + make_interval(secs => p_lease_seconds)
      )),
      reserved_calls = v_active + 1,
      call_limit = p_max_leases,
      last_launch_at = v_now,
      updated_at = v_now
  where id = v_bucket.id;

  return jsonb_build_object(
    'granted', true,
    'lease_id', v_lease_id,
    'active_leases', v_active + 1,
    'max_leases', p_max_leases,
    'lease_expires_at', v_now + make_interval(secs => p_lease_seconds),
    'launched_at', v_now
  );
end;
$func$;

comment on function public.reserve_qloo_launch(text, text, timestamptz, timestamptz, integer, integer, integer) is
  'Grants one global Qloo launch under a row lock: at most N in flight, and at least M milliseconds since the previous grant. Refusal carries retry_after_ms and is a normal outcome.';

/*
 * Releases one launch lease. Scoped, so it cannot remove a model-budget lease
 * even if given its id. Releasing twice, or releasing a swept lease, is a
 * no-op rather than an error, and never drives a counter negative.
 */
create or replace function public.release_qloo_launch(
  p_scope text,
  p_lease_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := clock_timestamp();
  v_bucket public.budget_buckets;
  v_kept jsonb;
begin
  select * into v_bucket
  from public.budget_buckets
  where scope = p_scope
    and active_leases @> jsonb_build_array(jsonb_build_object('id', p_lease_id))
  for update;

  if v_bucket.id is null then
    return jsonb_build_object('released', false, 'reason', 'lease_not_found');
  end if;

  select coalesce(
    jsonb_agg(lease) filter (where lease ->> 'id' <> p_lease_id::text),
    '[]'::jsonb
  )
  into v_kept
  from jsonb_array_elements(v_bucket.active_leases) as lease;

  update public.budget_buckets
  set active_leases = v_kept,
      reserved_calls = jsonb_array_length(v_kept),
      updated_at = v_now
  where id = v_bucket.id;

  return jsonb_build_object('released', true, 'active_leases', jsonb_array_length(v_kept));
end;
$func$;

comment on function public.release_qloo_launch(text, uuid) is
  'Releases one Qloo launch lease inside its own scope. Idempotent, and cannot touch a model-budget lease.';

-- ---------------------------------------------------------------------------
-- 4. Owner-checked, revision-checked project writes.
-- ---------------------------------------------------------------------------

/*
 * Freezes the artist the creator explicitly confirmed.
 *
 * Changing the anchor once cultural work exists is not a quiet overwrite. The
 * call is refused with `rebranch_required` unless the caller passes
 * `p_rebranch`, and a rebranch:
 *
 *   * appends one immutable `remove` decision per occupied slot, so the
 *     invalidation is itself an auditable append-only record rather than a
 *     silent deletion of approved text;
 *   * clears the approval pointers, the reference capture pointers, and the
 *     proposal draft, because they belonged to a different artist.
 *
 * Historical decision rows are never deleted or rewritten. An approval made
 * against another artist simply stops being current (specification sections 7
 * and 9).
 */
create or replace function public.confirm_project_anchor(
  p_project_id uuid,
  p_owner_session_id uuid,
  p_expected_revision integer,
  p_anchor jsonb,
  p_rebranch boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := now();
  v_project public.projects;
  v_previous_entity text;
  v_next_entity text;
  v_has_cultural_work boolean;
  v_slot text;
  v_cleared text[] := '{}'::text[];
  v_decision_id uuid;
begin
  if p_anchor is null or jsonb_typeof(p_anchor) <> 'object' then
    raise exception 'an anchor object is required' using errcode = 'check_violation';
  end if;

  v_next_entity := p_anchor ->> 'entity_id';
  if v_next_entity is null or v_next_entity = '' then
    raise exception 'the anchor must name a confirmed entity id' using errcode = 'check_violation';
  end if;

  select * into v_project
  from public.projects
  where id = p_project_id and owner_session_id = p_owner_session_id
  for update;

  if v_project.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_project.revision <> p_expected_revision then
    return jsonb_build_object(
      'outcome', 'revision_conflict',
      'current_revision', v_project.revision
    );
  end if;

  v_previous_entity := v_project.anchor ->> 'entity_id';
  v_has_cultural_work :=
    coalesce(array_length(v_project.reference_capture_ids, 1), 0) > 0
    or v_project.active_approvals <> '{}'::jsonb
    or v_project.proposal_draft is not null;

  if v_previous_entity is not null
     and v_previous_entity <> v_next_entity
     and v_has_cultural_work
     and coalesce(p_rebranch, false) is not true then
    -- The creator must say explicitly that the existing cultural work is to be
    -- invalidated. Nothing is changed on this path.
    return jsonb_build_object(
      'outcome', 'rebranch_required',
      'current_revision', v_project.revision,
      'previous_entity_id', v_previous_entity,
      'occupied_slots', (
        select coalesce(jsonb_agg(key), '[]'::jsonb)
        from jsonb_object_keys(v_project.active_approvals) as key
      )
    );
  end if;

  if v_previous_entity is not null and v_previous_entity <> v_next_entity and v_has_cultural_work then
    for v_slot in select key from jsonb_object_keys(v_project.active_approvals) as key loop
      insert into public.influence_decisions (
        project_id, decision_kind, slot, proposal_snapshot,
        selected_evidence_ids, creator_text, predecessor_id
      )
      values (
        p_project_id,
        'remove',
        v_slot,
        jsonb_build_object(
          'kind', 'remove',
          'reason', 'anchor_rebranch',
          'previous_entity_id', v_previous_entity,
          'next_entity_id', v_next_entity,
          'decided_at', v_now,
          'project_revision', v_project.revision
        ),
        '{}'::text[],
        null,
        (v_project.active_approvals ->> v_slot)::uuid
      )
      returning id into v_decision_id;
      v_cleared := array_append(v_cleared, v_slot);
    end loop;

    update public.projects
    set active_approvals = '{}'::jsonb,
        reference_capture_ids = '{}'::uuid[],
        proposal_draft = null
    where id = v_project.id;
  end if;

  update public.projects
  set anchor = p_anchor,
      workflow_state = 'ANCHOR_CONFIRMED',
      revision = v_project.revision + 1,
      updated_at = v_now
  where id = v_project.id
  returning * into v_project;

  return jsonb_build_object(
    'outcome', 'confirmed',
    'revision', v_project.revision,
    'anchor_entity_id', v_next_entity,
    'invalidated', array_length(v_cleared, 1) is not null,
    'cleared_slots', to_jsonb(v_cleared)
  );
end;
$func$;

comment on function public.confirm_project_anchor(uuid, uuid, integer, jsonb, boolean) is
  'Freezes an explicitly confirmed artist. Changing it after cultural work exists requires an explicit rebranch, which records one append-only remove decision per occupied slot.';

/*
 * Attaches the two first-hop capture pointers to the project.
 *
 * `p_anchor_entity_id` must still equal the project's confirmed anchor, so a
 * capture retrieved for one artist can never be attached to a project that has
 * since confirmed another. Writing new references clears the proposal draft:
 * a draft over superseded evidence is not a draft over these references.
 *
 * This does not increment the revision. It is a retrieval checkpoint, not a
 * creator decision; the revision counter stays a count of consequential
 * creator edits, and the expected-revision check still rejects a stale write.
 */
create or replace function public.set_project_references(
  p_project_id uuid,
  p_owner_session_id uuid,
  p_expected_revision integer,
  p_anchor_entity_id text,
  p_capture_ids uuid[]
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := now();
  v_project public.projects;
begin
  select * into v_project
  from public.projects
  where id = p_project_id and owner_session_id = p_owner_session_id
  for update;

  if v_project.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_project.revision <> p_expected_revision then
    return jsonb_build_object(
      'outcome', 'revision_conflict',
      'current_revision', v_project.revision
    );
  end if;

  if coalesce(v_project.anchor ->> 'entity_id', '') <> coalesce(p_anchor_entity_id, '') then
    return jsonb_build_object('outcome', 'anchor_mismatch');
  end if;

  update public.projects
  set reference_capture_ids = coalesce(p_capture_ids, '{}'::uuid[]),
      proposal_draft = null,
      workflow_state = 'REFERENCES_READY',
      updated_at = v_now
  where id = v_project.id
  returning * into v_project;

  return jsonb_build_object(
    'outcome', 'updated',
    'revision', v_project.revision,
    'capture_ids', to_jsonb(v_project.reference_capture_ids)
  );
end;
$func$;

comment on function public.set_project_references(uuid, uuid, integer, text, uuid[]) is
  'Attaches first-hop capture pointers, only while the project still holds the same confirmed anchor. Clears any proposal draft over superseded evidence.';

/*
 * Stores the current proposal draft.
 *
 * A draft is explicitly not an approval. This function never writes
 * `active_approvals`: only `append_influence_decision` does, and only when the
 * creator has acted. The default approved count is therefore zero by
 * construction, not by convention (specification section 7).
 */
create or replace function public.set_project_proposal_draft(
  p_project_id uuid,
  p_owner_session_id uuid,
  p_expected_revision integer,
  p_anchor_entity_id text,
  p_draft jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := now();
  v_project public.projects;
begin
  select * into v_project
  from public.projects
  where id = p_project_id and owner_session_id = p_owner_session_id
  for update;

  if v_project.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_project.revision <> p_expected_revision then
    return jsonb_build_object(
      'outcome', 'revision_conflict',
      'current_revision', v_project.revision
    );
  end if;

  if coalesce(v_project.anchor ->> 'entity_id', '') <> coalesce(p_anchor_entity_id, '') then
    return jsonb_build_object('outcome', 'anchor_mismatch');
  end if;

  update public.projects
  set proposal_draft = p_draft,
      workflow_state = 'PROPOSALS_READY',
      updated_at = v_now
  where id = v_project.id
  returning * into v_project;

  return jsonb_build_object('outcome', 'updated', 'revision', v_project.revision);
end;
$func$;

comment on function public.set_project_proposal_draft(uuid, uuid, integer, text, jsonb) is
  'Stores the current bounded proposal draft. It cannot write an approval pointer; only an explicit creator decision does that.';

-- ---------------------------------------------------------------------------
-- 5. Function privileges: the server secret key's role only.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.reserve_qloo_launch(text, text, timestamptz, timestamptz, integer, integer, integer),
  public.release_qloo_launch(text, uuid),
  public.confirm_project_anchor(uuid, uuid, integer, jsonb, boolean),
  public.set_project_references(uuid, uuid, integer, text, uuid[]),
  public.set_project_proposal_draft(uuid, uuid, integer, text, jsonb)
from public, anon, authenticated;

grant execute on function
  public.reserve_qloo_launch(text, text, timestamptz, timestamptz, integer, integer, integer),
  public.release_qloo_launch(text, uuid),
  public.confirm_project_anchor(uuid, uuid, integer, jsonb, boolean),
  public.set_project_references(uuid, uuid, integer, text, uuid[]),
  public.set_project_proposal_draft(uuid, uuid, integer, text, jsonb)
to service_role;
