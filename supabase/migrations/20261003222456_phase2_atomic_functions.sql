-- FirstPlayable phase 2 — the atomic primitives of specification section 11.
--
-- Three primitives, and nothing more:
--   1. operation / idempotency reservation, with a bounded lease;
--   2. append-only decision with a project revision compare-and-swap;
--   3. model budget reservation and reconciliation.
--
-- Each one takes a row lock and does its whole decision inside one statement's
-- transaction, so two concurrent callers cannot both win. There is no job
-- queue, no worker table, and no polling loop: these are persistence
-- primitives that a later phase's bounded controller calls once per request.
--
-- Every function is SECURITY INVOKER and executable only by `service_role`.
-- A function with a `p_owner_session_id` argument re-checks ownership itself,
-- so a forged project id cannot be used through the RPC surface either.

-- ---------------------------------------------------------------------------
-- Bounded projection of an operation row. Nothing here is a provider header,
-- an error object, or any other diagnostic the browser must not see.
-- ---------------------------------------------------------------------------

create or replace function public.operation_summary(p_operation public.operations)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $func$
  select jsonb_build_object(
    'id', p_operation.id,
    'project_id', p_operation.project_id,
    'stage', p_operation.stage,
    'status', p_operation.status,
    'input_revision', p_operation.input_revision,
    'input_hash', p_operation.input_hash,
    'attempts', p_operation.attempts,
    'max_attempts', p_operation.max_attempts,
    'idempotency_key', p_operation.idempotency_key,
    'lease_expires_at', p_operation.lease_expires_at,
    'result', p_operation.result,
    'created_at', p_operation.created_at,
    'updated_at', p_operation.updated_at
  );
$func$;

comment on function public.operation_summary(public.operations) is
  'Bounded owner-safe projection of an operation row. Excludes the error object and every provider diagnostic.';

-- ---------------------------------------------------------------------------
-- 1. Operation reservation.
-- ---------------------------------------------------------------------------

create or replace function public.reserve_operation(
  p_project_id uuid,
  p_owner_session_id uuid,
  p_stage text,
  p_input_revision integer,
  p_input_hash text,
  p_idempotency_key text,
  p_lease_seconds integer,
  p_max_attempts integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := now();
  v_owns boolean;
  v_operation public.operations;
begin
  if p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'lease seconds out of range' using errcode = 'check_violation';
  end if;

  -- Ownership is enforced here as well as in the repository, because the
  -- secret key bypasses row-level security.
  select true into v_owns
  from public.projects
  where id = p_project_id and owner_session_id = p_owner_session_id;

  if v_owns is not true then
    -- A foreign project and a nonexistent project produce the same answer.
    return jsonb_build_object('outcome', 'not_found');
  end if;

  insert into public.operations (
    project_id, owner_session_id, stage, status,
    input_revision, input_hash, attempts, max_attempts,
    idempotency_key, lease_expires_at
  )
  values (
    p_project_id, p_owner_session_id, p_stage, 'reserved',
    p_input_revision, p_input_hash, 1, p_max_attempts,
    p_idempotency_key, v_now + make_interval(secs => p_lease_seconds)
  )
  on conflict (idempotency_key) do nothing
  returning * into v_operation;

  if v_operation.id is not null then
    return jsonb_build_object(
      'outcome', 'reserved',
      'created', true,
      'operation', public.operation_summary(v_operation)
    );
  end if;

  -- The key already exists. Lock the row and decide deterministically.
  select * into v_operation
  from public.operations
  where idempotency_key = p_idempotency_key
  for update;

  if v_operation.owner_session_id is distinct from p_owner_session_id
     or v_operation.project_id is distinct from p_project_id then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_operation.status in ('succeeded', 'failed') then
    -- A replay of a settled stage returns the committed result and makes no
    -- new attempt, so a client retry cannot cause a second upstream call.
    return jsonb_build_object(
      'outcome', 'settled',
      'created', false,
      'operation', public.operation_summary(v_operation)
    );
  end if;

  if v_operation.lease_expires_at is not null and v_operation.lease_expires_at > v_now then
    return jsonb_build_object(
      'outcome', 'lease_held',
      'created', false,
      'operation', public.operation_summary(v_operation)
    );
  end if;

  if v_operation.attempts >= v_operation.max_attempts then
    update public.operations
    set status = 'expired', lease_expires_at = null, updated_at = v_now
    where id = v_operation.id
    returning * into v_operation;

    return jsonb_build_object(
      'outcome', 'attempts_exhausted',
      'created', false,
      'operation', public.operation_summary(v_operation)
    );
  end if;

  update public.operations
  set attempts = v_operation.attempts + 1,
      status = 'reserved',
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      updated_at = v_now
  where id = v_operation.id
  returning * into v_operation;

  return jsonb_build_object(
    'outcome', 'reserved',
    'created', false,
    'recovered_expired_lease', true,
    'operation', public.operation_summary(v_operation)
  );
end;
$func$;

comment on function public.reserve_operation(uuid, uuid, text, integer, text, text, integer, integer) is
  'Atomically reserves one idempotent stage. A duplicate key never creates a second attempt while a lease is held or the stage is settled.';

create or replace function public.complete_operation(
  p_operation_id uuid,
  p_owner_session_id uuid,
  p_status text,
  p_result jsonb,
  p_error jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := now();
  v_operation public.operations;
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'terminal status required' using errcode = 'check_violation';
  end if;

  select * into v_operation
  from public.operations
  where id = p_operation_id and owner_session_id = p_owner_session_id
  for update;

  if v_operation.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_operation.status in ('succeeded', 'failed') then
    return jsonb_build_object(
      'outcome', 'already_settled',
      'operation', public.operation_summary(v_operation)
    );
  end if;

  update public.operations
  set status = p_status,
      result = p_result,
      error = p_error,
      lease_expires_at = null,
      updated_at = v_now
  where id = v_operation.id
  returning * into v_operation;

  return jsonb_build_object(
    'outcome', 'settled',
    'operation', public.operation_summary(v_operation)
  );
end;
$func$;

comment on function public.complete_operation(uuid, uuid, text, jsonb, jsonb) is
  'Owner-checked terminal transition for one operation. Settling twice is a no-op that returns the first committed result.';

-- ---------------------------------------------------------------------------
-- 2. Append-only decision with a project revision compare-and-swap.
-- ---------------------------------------------------------------------------

create or replace function public.append_influence_decision(
  p_project_id uuid,
  p_owner_session_id uuid,
  p_expected_revision integer,
  p_decision_kind text,
  p_slot text,
  p_proposal_snapshot jsonb,
  p_selected_evidence_ids text[],
  p_creator_text text,
  p_predecessor_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := now();
  v_project public.projects;
  v_decision public.influence_decisions;
  v_approvals jsonb;
begin
  select * into v_project
  from public.projects
  where id = p_project_id and owner_session_id = p_owner_session_id
  for update;

  if v_project.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_project.revision <> p_expected_revision then
    -- The creator's choices moved under this request; the caller must reread.
    return jsonb_build_object(
      'outcome', 'revision_conflict',
      'current_revision', v_project.revision
    );
  end if;

  insert into public.influence_decisions (
    project_id, decision_kind, slot, proposal_snapshot,
    selected_evidence_ids, creator_text, predecessor_id
  )
  values (
    p_project_id, p_decision_kind, p_slot, p_proposal_snapshot,
    coalesce(p_selected_evidence_ids, '{}'::text[]), p_creator_text, p_predecessor_id
  )
  returning * into v_decision;

  -- The current approval is a project pointer. Historical approved text is
  -- never mutated; it stays in its own immutable decision row.
  v_approvals := v_project.active_approvals;
  if p_slot is not null then
    if p_decision_kind in ('accept', 'edit', 'replace') then
      v_approvals := v_approvals || jsonb_build_object(p_slot, v_decision.id);
    elsif p_decision_kind in ('reject', 'remove') then
      v_approvals := v_approvals - p_slot;
    end if;
  end if;

  update public.projects
  set revision = v_project.revision + 1,
      active_approvals = v_approvals,
      updated_at = v_now
  where id = v_project.id
  returning * into v_project;

  return jsonb_build_object(
    'outcome', 'appended',
    'decision_id', v_decision.id,
    'created_at', v_decision.created_at,
    'revision', v_project.revision,
    'active_approvals', v_project.active_approvals
  );
end;
$func$;

comment on function public.append_influence_decision(uuid, uuid, integer, text, text, jsonb, text[], text, uuid) is
  'Appends one immutable decision and advances the project revision under a compare-and-swap. Phase 2 provides the primitive; phase 3 drives it.';

-- ---------------------------------------------------------------------------
-- 3. Model budget reservation and reconciliation.
-- ---------------------------------------------------------------------------

create or replace function public.reserve_model_budget(
  p_scope text,
  p_bucket_key text,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_call_limit integer,
  p_calls integer,
  p_tokens bigint,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := now();
  v_bucket public.budget_buckets;
  v_lease_id uuid := gen_random_uuid();
  v_kept jsonb;
  v_expired_calls integer;
  v_expired_tokens bigint;
  v_reserved_calls integer;
  v_reserved_tokens bigint;
  v_limit integer;
begin
  if p_calls < 1 then
    raise exception 'a reservation must claim at least one call' using errcode = 'check_violation';
  end if;
  if p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'lease seconds out of range' using errcode = 'check_violation';
  end if;

  insert into public.budget_buckets (scope, bucket_key, window_start, window_end, call_limit)
  values (p_scope, p_bucket_key, p_window_start, p_window_end, p_call_limit)
  on conflict (scope, bucket_key, window_start) do nothing;

  -- One writer at a time per window. This row lock, not an in-memory counter,
  -- is what makes the cap hold across serverless instances.
  select * into v_bucket
  from public.budget_buckets
  where scope = p_scope and bucket_key = p_bucket_key and window_start = p_window_start
  for update;

  -- Sweep leases whose request never reconciled back out of the reserved counters.
  select
    coalesce(
      jsonb_agg(lease) filter (where (lease ->> 'expires_at')::timestamptz > v_now),
      '[]'::jsonb
    ),
    coalesce(
      sum((lease ->> 'calls')::integer) filter (where (lease ->> 'expires_at')::timestamptz <= v_now),
      0
    ),
    coalesce(
      sum((lease ->> 'tokens')::bigint) filter (where (lease ->> 'expires_at')::timestamptz <= v_now),
      0
    )
  into v_kept, v_expired_calls, v_expired_tokens
  from jsonb_array_elements(v_bucket.active_leases) as lease;

  v_reserved_calls := greatest(v_bucket.reserved_calls - v_expired_calls, 0);
  v_reserved_tokens := greatest(v_bucket.reserved_tokens - v_expired_tokens, 0);

  -- The configured cap may be lowered by configuration at any time; it is
  -- never raised here beyond what the caller was configured with.
  v_limit := p_call_limit;

  if v_bucket.used_calls + v_reserved_calls + p_calls > v_limit then
    update public.budget_buckets
    set active_leases = v_kept,
        reserved_calls = v_reserved_calls,
        reserved_tokens = v_reserved_tokens,
        call_limit = v_limit,
        updated_at = v_now
    where id = v_bucket.id;

    return jsonb_build_object(
      'granted', false,
      'reason', 'budget_exhausted',
      'call_limit', v_limit,
      'used_calls', v_bucket.used_calls,
      'reserved_calls', v_reserved_calls,
      'remaining_calls', greatest(v_limit - v_bucket.used_calls - v_reserved_calls, 0),
      'window_start', v_bucket.window_start,
      'window_end', v_bucket.window_end
    );
  end if;

  update public.budget_buckets
  set active_leases = v_kept || jsonb_build_array(jsonb_build_object(
        'id', v_lease_id,
        'calls', p_calls,
        'tokens', coalesce(p_tokens, 0),
        'expires_at', v_now + make_interval(secs => p_lease_seconds)
      )),
      reserved_calls = v_reserved_calls + p_calls,
      reserved_tokens = v_reserved_tokens + coalesce(p_tokens, 0),
      call_limit = v_limit,
      updated_at = v_now
  where id = v_bucket.id
  returning * into v_bucket;

  return jsonb_build_object(
    'granted', true,
    'lease_id', v_lease_id,
    'call_limit', v_bucket.call_limit,
    'used_calls', v_bucket.used_calls,
    'reserved_calls', v_bucket.reserved_calls,
    'remaining_calls', greatest(v_bucket.call_limit - v_bucket.used_calls - v_bucket.reserved_calls, 0),
    'lease_expires_at', v_now + make_interval(secs => p_lease_seconds),
    'window_start', v_bucket.window_start,
    'window_end', v_bucket.window_end
  );
end;
$func$;

comment on function public.reserve_model_budget(text, text, timestamptz, timestamptz, integer, integer, bigint, integer) is
  'Atomically reserves model calls inside one window under a row lock. Concurrent callers cannot exceed the configured application cap.';

create or replace function public.reconcile_model_budget(
  p_lease_id uuid,
  p_actual_calls integer,
  p_actual_tokens bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := now();
  v_bucket public.budget_buckets;
  v_lease jsonb;
  v_kept jsonb;
  v_lease_calls integer;
  v_lease_tokens bigint;
begin
  if p_actual_calls < 0 or coalesce(p_actual_tokens, 0) < 0 then
    raise exception 'reconciled usage cannot be negative' using errcode = 'check_violation';
  end if;

  select * into v_bucket
  from public.budget_buckets
  where active_leases @> jsonb_build_array(jsonb_build_object('id', p_lease_id))
  for update;

  if v_bucket.id is null then
    -- Already reconciled, released, or swept. Reconciling twice is a no-op.
    return jsonb_build_object('applied', false, 'reason', 'lease_not_found');
  end if;

  select lease into v_lease
  from jsonb_array_elements(v_bucket.active_leases) as lease
  where lease ->> 'id' = p_lease_id::text
  limit 1;

  v_lease_calls := coalesce((v_lease ->> 'calls')::integer, 0);
  v_lease_tokens := coalesce((v_lease ->> 'tokens')::bigint, 0);

  select coalesce(jsonb_agg(lease) filter (where lease ->> 'id' <> p_lease_id::text), '[]'::jsonb)
  into v_kept
  from jsonb_array_elements(v_bucket.active_leases) as lease;

  -- greatest(..., 0) is what keeps a double reconcile or a swept lease from
  -- driving a counter negative.
  update public.budget_buckets
  set active_leases = v_kept,
      reserved_calls = greatest(v_bucket.reserved_calls - v_lease_calls, 0),
      reserved_tokens = greatest(v_bucket.reserved_tokens - v_lease_tokens, 0),
      used_calls = v_bucket.used_calls + p_actual_calls,
      used_tokens = v_bucket.used_tokens + coalesce(p_actual_tokens, 0),
      updated_at = v_now
  where id = v_bucket.id
  returning * into v_bucket;

  return jsonb_build_object(
    'applied', true,
    'call_limit', v_bucket.call_limit,
    'used_calls', v_bucket.used_calls,
    'used_tokens', v_bucket.used_tokens,
    'reserved_calls', v_bucket.reserved_calls,
    'reserved_tokens', v_bucket.reserved_tokens,
    'remaining_calls', greatest(v_bucket.call_limit - v_bucket.used_calls - v_bucket.reserved_calls, 0)
  );
end;
$func$;

comment on function public.reconcile_model_budget(uuid, integer, bigint) is
  'Releases one reservation and records the usage the provider actually reported. Calling it with zero usage is a release.';

-- ---------------------------------------------------------------------------
-- Function privileges: the server secret key's role only.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.reserve_operation(uuid, uuid, text, integer, text, text, integer, integer),
  public.operation_summary(public.operations),
  public.complete_operation(uuid, uuid, text, jsonb, jsonb),
  public.append_influence_decision(uuid, uuid, integer, text, text, jsonb, text[], text, uuid),
  public.reserve_model_budget(text, text, timestamptz, timestamptz, integer, integer, bigint, integer),
  public.reconcile_model_budget(uuid, integer, bigint)
from public, anon, authenticated;

grant execute on function
  public.reserve_operation(uuid, uuid, text, integer, text, text, integer, integer),
  public.operation_summary(public.operations),
  public.complete_operation(uuid, uuid, text, jsonb, jsonb),
  public.append_influence_decision(uuid, uuid, integer, text, text, jsonb, text[], text, uuid),
  public.reserve_model_budget(text, text, timestamptz, timestamptz, integer, integer, bigint, integer),
  public.reconcile_model_budget(uuid, integer, bigint)
to service_role;
