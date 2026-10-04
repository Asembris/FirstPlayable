-- FirstPlayable phase 4 — bounded compilation, immutable versions, and the
-- review-before-activation compare-and-swap (specification sections 7, 8, 11).
--
-- This migration is additive. It creates no table, drops no column, and
-- rewrites no earlier function's behaviour. The eight tables of section 11 are
-- still the whole schema.
--
-- What it adds, and why each piece has to be in the database rather than in
-- application code:
--
--   * `operations.stage` gains `compile`: the persisted controller row that
--     `POST /api/operations/:id/advance` addresses. Its lease is a mutex, so
--     two concurrent advances cannot both perform a provider attempt.
--   * `projects` gains a pending-version pointer and a slot-keyed store for
--     compiled modules, so a successful compilation becomes *reviewable*
--     rather than silently current, and so a committed stage survives a closed
--     browser without a background job.
--   * `scene_versions` gains the frozen input and approval snapshots and the
--     identifiers of what produced it, and a check constraint that refuses a
--     row whose validation summary does not say `ok` and does not carry its
--     subset and witness reports. "Only validated versions are inserted" is
--     therefore a database guarantee, not a convention.
--   * Six functions take a row lock and decide inside one transaction:
--     leasing and parking a stage, writing a compilation artifact, committing
--     a version, activating one, and declining one. A compare-and-swap across
--     a read and an unprotected write cannot be made atomic in application
--     code, and row-level security cannot do it either.
--
-- Every function is SECURITY INVOKER with a pinned empty search path and is
-- executable only by `service_role`, and every one that names a project
-- re-checks ownership itself.

-- ---------------------------------------------------------------------------
-- 1. The compile controller stage.
-- ---------------------------------------------------------------------------

alter table public.operations
  drop constraint operations_stage_known;

alter table public.operations
  add constraint operations_stage_known check (stage in (
    'artist_search', 'references', 'proposals', 'compile', 'base',
    'module_discovery', 'module_commitment', 'ending_copy', 'validate', 'smoke'
  ));

comment on column public.operations.stage is
  'One stage of one frozen input revision. `compile` is the persisted controller row; the model stages are `base`, `module_discovery`, and `module_commitment`.';

-- ---------------------------------------------------------------------------
-- 2. Project-side compilation state.
-- ---------------------------------------------------------------------------

alter table public.projects
  add column if not exists pending_version_id uuid,
  -- Slot-keyed compiled modules, for example
  -- {"discovery": {"input_hash": "...", "module": { ... }}}.
  -- Small by construction: a module is at most 3 flags, 4 actions, 6 dialogue
  -- nodes, 3 gates, and 2 hooks (specification section 4).
  add column if not exists compiled_modules jsonb not null default '{}'::jsonb;

alter table public.projects
  add constraint projects_compiled_modules_is_object
  check (jsonb_typeof(compiled_modules) = 'object');

alter table public.projects
  add constraint projects_compiled_modules_bounded
  check (length(compiled_modules::text) <= 65536);

alter table public.projects
  add constraint projects_pending_version_fk
  foreign key (pending_version_id) references public.scene_versions (id) on delete set null;

create index projects_pending_version_idx on public.projects (pending_version_id);

comment on column public.projects.pending_version_id is
  'A validated version awaiting the creator''s explicit review confirmation. Deliberately separate from active_version_id: a compilation never becomes current by itself (specification section 7).';
comment on column public.projects.compiled_modules is
  'Committed module artifacts keyed by slot, each carrying the stage input hash that authorised it. An entry is reused only when that hash still matches the frozen compilation snapshot, so a changed approval recompiles its own slot and leaves the other one alone (specification section 9).';

-- ---------------------------------------------------------------------------
-- 3. Immutable scene versions: the frozen snapshots and what produced them.
-- ---------------------------------------------------------------------------

alter table public.scene_versions
  -- The frozen compilation input: revision, hashes, approval ids, identifiers.
  add column if not exists input_snapshot jsonb not null default '{}'::jsonb,
  -- The approvals as they stood at compilation, so a historical view does not
  -- silently change with today's approvals (specification section 11).
  add column if not exists approval_snapshot jsonb not null default '[]'::jsonb,
  add column if not exists validator_identifier text,
  add column if not exists compiler_identifier text,
  -- The compilation operation this version came out of.
  add column if not exists operation_id uuid;

alter table public.scene_versions
  add constraint scene_versions_approval_snapshot_is_array
  check (jsonb_typeof(approval_snapshot) = 'array');

-- Only a validated version is a version. A row whose summary does not say it
-- passed, or does not carry its subset and witness reports, is rejected here
-- rather than trusted to have been checked upstream.
alter table public.scene_versions
  add constraint scene_versions_validation_passed
  check (
    (validation_summary ->> 'ok')::boolean is true
    and validation_summary ? 'subsets'
    and validation_summary ? 'witnesses'
  );

comment on constraint scene_versions_validation_passed on public.scene_versions is
  'Refuses an unvalidated candidate. Failed candidate JSON lives only in a bounded operation artifact (specification section 11).';

-- ---------------------------------------------------------------------------
-- 4. Leasing and parking one stage.
-- ---------------------------------------------------------------------------

/*
 * The controller row's mutex.
 *
 * Deliberately separate from `reserve_operation`, and deliberately restricted
 * to the `compile` stage: `reserve_operation` spends an attempt every time it
 * hands out a lease, which is exactly right for a stage that may make a
 * provider call and exactly wrong for a controller row that is leased once per
 * advance request. Nothing here increments `attempts`, and nothing here
 * authorises a provider call: the model stages still go through
 * `reserve_operation` and still get two attempts each and no more.
 */
create or replace function public.lease_compile_operation(
  p_operation_id uuid,
  p_owner_session_id uuid,
  p_lease_seconds integer
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
  if p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'lease seconds out of range' using errcode = 'check_violation';
  end if;

  select * into v_operation
  from public.operations
  where id = p_operation_id and owner_session_id = p_owner_session_id
  for update;

  if v_operation.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_operation.stage <> 'compile' then
    -- A model stage is never leased this way; it would bypass its attempt ceiling.
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_operation.status in ('succeeded', 'failed') then
    return jsonb_build_object(
      'outcome', 'settled',
      'operation', public.operation_summary(v_operation)
    );
  end if;

  if v_operation.lease_expires_at is not null and v_operation.lease_expires_at > v_now then
    -- Another advance request holds it. The caller waits; it does not proceed.
    return jsonb_build_object(
      'outcome', 'lease_held',
      'operation', public.operation_summary(v_operation)
    );
  end if;

  update public.operations
  set status = 'running',
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      updated_at = v_now
  where id = v_operation.id
  returning * into v_operation;

  return jsonb_build_object(
    'outcome', 'leased',
    'operation', public.operation_summary(v_operation)
  );
end;
$func$;

comment on function public.lease_compile_operation(uuid, uuid, integer) is
  'Leases the persisted compilation controller row for one advance request. Spends no attempt and authorises no provider call.';

/*
 * Releases a stage's lease without settling it, recording a bounded artifact.
 *
 * This is what makes "one advance performs at most one provider attempt" and
 * "each stage gets one repair" the same mechanism. A stage whose candidate was
 * rejected is parked: its status stays `reserved`, its lease is expired, and
 * its rejected candidate and findings are stored. The next advance calls
 * `reserve_operation` with the same idempotency key, which sees an expired
 * lease, increments `attempts` to 2, and hands out the repair attempt. A third
 * advance sees `attempts >= max_attempts` and gets `attempts_exhausted`.
 */
create or replace function public.park_operation(
  p_operation_id uuid,
  p_owner_session_id uuid,
  p_result jsonb
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
  set status = 'reserved',
      result = coalesce(p_result, v_operation.result),
      lease_expires_at = v_now,
      updated_at = v_now
  where id = v_operation.id
  returning * into v_operation;

  return jsonb_build_object(
    'outcome', 'parked',
    'operation', public.operation_summary(v_operation)
  );
end;
$func$;

comment on function public.park_operation(uuid, uuid, jsonb) is
  'Releases a stage lease without settling it, so the next advance can take the one permitted repair attempt inside the same max_attempts ceiling.';

-- ---------------------------------------------------------------------------
-- 5. Writing a compilation artifact under a revision compare-and-swap.
-- ---------------------------------------------------------------------------

/*
 * Writes the clean base, a compiled module, and the workflow state.
 *
 * A null argument leaves that field as it is, so one function serves the base
 * stage, each module stage, and a workflow transition without three near-copies.
 *
 * It deliberately does **not** advance the project revision. The revision
 * counts consequential *creator* edits; the foundation and the modules are
 * derived from a revision, and the whole compare-and-swap discipline depends
 * on the revision staying still while a compilation runs. An approval change
 * goes through `append_influence_decision`, which does advance it, and that is
 * what makes an in-flight compilation stale.
 */
create or replace function public.set_project_compilation_state(
  p_project_id uuid,
  p_owner_session_id uuid,
  p_expected_revision integer,
  p_base_scene jsonb,
  p_base_hash text,
  p_compiled_modules jsonb,
  p_workflow_state text
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

  update public.projects
  set base_scene = coalesce(p_base_scene, v_project.base_scene),
      base_hash = coalesce(p_base_hash, v_project.base_hash),
      compiled_modules = coalesce(p_compiled_modules, v_project.compiled_modules),
      workflow_state = coalesce(p_workflow_state, v_project.workflow_state),
      updated_at = v_now
  where id = v_project.id
  returning * into v_project;

  return jsonb_build_object(
    'outcome', 'updated',
    'revision', v_project.revision,
    'base_hash', v_project.base_hash,
    'workflow_state', v_project.workflow_state
  );
end;
$func$;

comment on function public.set_project_compilation_state(uuid, uuid, integer, jsonb, text, jsonb, text) is
  'Writes the clean base, the compiled modules, and the workflow state under a revision compare-and-swap. Never advances the revision itself.';

-- ---------------------------------------------------------------------------
-- 6. Committing one validated immutable version.
-- ---------------------------------------------------------------------------

/*
 * Inserts a validated version and makes it the project's pending review.
 *
 * The compare-and-swap is the whole point. A compilation froze a revision, a
 * brief hash, a base hash, and a set of approval pointers; if any of them has
 * moved by the time the result arrives, this returns `stale_input` and inserts
 * nothing. The result then remains an operation artifact and cannot become
 * current (specification section 7, "Approval semantics").
 *
 * `p_expected_approvals` is compared as a whole jsonb object, so adding,
 * removing, replacing, or re-approving a slot all count as a change.
 *
 * The brief hash is deliberately not a parameter. It is a SHA-256 over this
 * application's canonical JSON, which this function cannot recompute, and the
 * `brief` column has no update path at all: it is written once at project
 * creation. The compilation compares it in application code against the row it
 * read, and the revision compare-and-swap here is what catches a moved project.
 */
create or replace function public.commit_scene_version(
  p_project_id uuid,
  p_owner_session_id uuid,
  p_expected_revision integer,
  p_expected_base_hash text,
  p_expected_approvals jsonb,
  p_operation_id uuid,
  p_parent_version_id uuid,
  p_input_hash text,
  p_base_hash text,
  p_module_hashes jsonb,
  p_scene jsonb,
  p_validation_summary jsonb,
  p_input_snapshot jsonb,
  p_approval_snapshot jsonb,
  p_model_identifier text,
  p_prompt_identifier text,
  p_schema_identifier text,
  p_compiler_identifier text,
  p_validator_identifier text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := now();
  v_project public.projects;
  v_version public.scene_versions;
begin
  select * into v_project
  from public.projects
  where id = p_project_id and owner_session_id = p_owner_session_id
  for update;

  if v_project.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_project.revision <> p_expected_revision
     or coalesce(v_project.base_hash, '') <> coalesce(p_expected_base_hash, '')
     or v_project.active_approvals <> p_expected_approvals then
    return jsonb_build_object(
      'outcome', 'stale_input',
      'current_revision', v_project.revision
    );
  end if;

  insert into public.scene_versions (
    project_id, parent_version_id, input_hash, base_hash, module_hashes,
    scene, validation_summary, model_identifier, prompt_identifier,
    schema_identifier, input_snapshot, approval_snapshot,
    validator_identifier, compiler_identifier, operation_id
  )
  values (
    p_project_id, p_parent_version_id, p_input_hash, p_base_hash,
    coalesce(p_module_hashes, '{}'::jsonb), p_scene, p_validation_summary,
    p_model_identifier, p_prompt_identifier, p_schema_identifier,
    coalesce(p_input_snapshot, '{}'::jsonb), coalesce(p_approval_snapshot, '[]'::jsonb),
    p_validator_identifier, p_compiler_identifier, p_operation_id
  )
  returning * into v_version;

  -- Reviewable, not current. `active_version_id` is untouched, which is what
  -- keeps the last good version playable while a new one awaits review.
  -- The compiled module artifacts stay: an approval that did not change keeps
  -- its module, so a later compilation recompiles only the slot that moved.
  update public.projects
  set pending_version_id = v_version.id,
      workflow_state = 'REVIEW_PLAYABLE',
      updated_at = v_now
  where id = v_project.id;

  return jsonb_build_object(
    'outcome', 'committed',
    'version_id', v_version.id,
    'created_at', v_version.created_at,
    'revision', v_project.revision
  );
end;
$func$;

comment on function public.commit_scene_version(uuid, uuid, integer, text, jsonb, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, text, text, text) is
  'Inserts one validated immutable version and makes it the pending review, under a compare-and-swap on revision, base hash, and approval pointers. A stale result inserts nothing.';

-- ---------------------------------------------------------------------------
-- 7. Explicit activation and explicit decline.
-- ---------------------------------------------------------------------------

/*
 * The creator's explicit confirmation that the compiled interaction reflects
 * the approved idea.
 *
 * It compares the project's current revision, base hash, and approval
 * pointers against the ones the version was compiled from — read from the
 * version row itself, not supplied by the browser — so a stale version cannot
 * be activated even if its id is still known.
 *
 * Activation does not advance the revision. A second activation of the same
 * version is therefore idempotent rather than a conflict, which is the honest
 * answer to a double-clicked confirm button.
 */
create or replace function public.activate_scene_version(
  p_project_id uuid,
  p_owner_session_id uuid,
  p_expected_revision integer,
  p_version_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := now();
  v_project public.projects;
  v_version public.scene_versions;
  v_frozen_approvals jsonb;
begin
  select * into v_project
  from public.projects
  where id = p_project_id and owner_session_id = p_owner_session_id
  for update;

  if v_project.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select * into v_version
  from public.scene_versions
  where id = p_version_id and project_id = p_project_id;

  if v_version.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_project.active_version_id = p_version_id then
    return jsonb_build_object(
      'outcome', 'already_active',
      'active_version_id', v_project.active_version_id,
      'pending_version_id', v_project.pending_version_id,
      'workflow_state', v_project.workflow_state
    );
  end if;

  if v_project.revision <> p_expected_revision then
    return jsonb_build_object(
      'outcome', 'revision_conflict',
      'current_revision', v_project.revision
    );
  end if;

  -- Only the version that is actually awaiting review may be activated. An
  -- earlier version cannot be reactivated through this route.
  if v_project.pending_version_id is distinct from p_version_id then
    return jsonb_build_object('outcome', 'not_pending');
  end if;

  -- The compare-and-swap, read from the version row itself rather than from
  -- the request: the revision it was compiled against, the foundation it was
  -- built on, and the exact approval pointers that authorised it.
  select coalesce(
           jsonb_object_agg(approval ->> 'slot', approval ->> 'approval_id'),
           '{}'::jsonb
         )
  into v_frozen_approvals
  from jsonb_array_elements(v_version.approval_snapshot) as approval;

  if (v_version.input_snapshot ->> 'project_revision') is distinct from v_project.revision::text
     or coalesce(v_version.base_hash, '') <> coalesce(v_project.base_hash, '')
     or v_frozen_approvals <> v_project.active_approvals then
    return jsonb_build_object(
      'outcome', 'stale_input',
      'current_revision', v_project.revision
    );
  end if;

  update public.projects
  set active_version_id = p_version_id,
      pending_version_id = null,
      workflow_state = 'READY',
      updated_at = v_now
  where id = v_project.id
  returning * into v_project;

  return jsonb_build_object(
    'outcome', 'activated',
    'active_version_id', v_project.active_version_id,
    'pending_version_id', v_project.pending_version_id,
    'workflow_state', v_project.workflow_state
  );
end;
$func$;

comment on function public.activate_scene_version(uuid, uuid, integer, uuid) is
  'The creator''s explicit activation, under a compare-and-swap against the snapshot stored on the version itself. A stale version can never become current.';

/*
 * Declining a reviewed version.
 *
 * The version row stays exactly where it is — it is immutable and remains a
 * labelled historical version — and the previously active version stays
 * active, which is the specification's "declining preserves the previous
 * version".
 */
create or replace function public.decline_scene_version(
  p_project_id uuid,
  p_owner_session_id uuid,
  p_expected_revision integer,
  p_version_id uuid
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

  if v_project.pending_version_id is distinct from p_version_id then
    return jsonb_build_object('outcome', 'not_pending');
  end if;

  update public.projects
  set pending_version_id = null,
      workflow_state = case
        when v_project.active_version_id is null then 'AWAITING_APPROVAL'
        else 'READY'
      end,
      updated_at = v_now
  where id = v_project.id
  returning * into v_project;

  return jsonb_build_object(
    'outcome', 'declined',
    'active_version_id', v_project.active_version_id,
    'pending_version_id', v_project.pending_version_id,
    'workflow_state', v_project.workflow_state
  );
end;
$func$;

comment on function public.decline_scene_version(uuid, uuid, integer, uuid) is
  'Clears the pending review and preserves the previously active version. The declined version row is untouched and stays a labelled historical version.';

-- ---------------------------------------------------------------------------
-- 8. Owner-checked version reads.
-- ---------------------------------------------------------------------------

/*
 * Reads this owner's versions for one project.
 *
 * An RPC rather than a plain select, because `scene_versions` carries no owner
 * column: the ownership predicate has to come from the join, and putting it
 * here means no repository can forget it. The scene itself is returned only
 * when one version is named, so the project list stays small.
 */
create or replace function public.read_scene_versions(
  p_project_id uuid,
  p_owner_session_id uuid,
  p_version_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_owns boolean;
  v_rows jsonb;
begin
  if p_limit < 1 or p_limit > 50 then
    raise exception 'limit out of range' using errcode = 'check_violation';
  end if;

  select true into v_owns
  from public.projects
  where id = p_project_id and owner_session_id = p_owner_session_id;

  if v_owns is not true then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select coalesce(jsonb_agg(row_json order by created_at desc), '[]'::jsonb)
  into v_rows
  from (
    select
      v.created_at,
      jsonb_build_object(
        'id', v.id,
        'project_id', v.project_id,
        'parent_version_id', v.parent_version_id,
        'input_hash', v.input_hash,
        'base_hash', v.base_hash,
        'module_hashes', v.module_hashes,
        'validation_summary', v.validation_summary,
        'input_snapshot', v.input_snapshot,
        'approval_snapshot', v.approval_snapshot,
        'model_identifier', v.model_identifier,
        'prompt_identifier', v.prompt_identifier,
        'schema_identifier', v.schema_identifier,
        'compiler_identifier', v.compiler_identifier,
        'validator_identifier', v.validator_identifier,
        'operation_id', v.operation_id,
        'created_at', v.created_at,
        -- The whole scene travels only when one version is named.
        'scene', case when p_version_id is null then null else v.scene end
      ) as row_json
    from public.scene_versions as v
    where v.project_id = p_project_id
      and (p_version_id is null or v.id = p_version_id)
    order by v.created_at desc
    limit p_limit
  ) as selected;

  return jsonb_build_object('outcome', 'read', 'versions', v_rows);
end;
$func$;

comment on function public.read_scene_versions(uuid, uuid, uuid, integer) is
  'Owner-checked version read. Returns summaries for a project, or one named version including its scene.';

-- ---------------------------------------------------------------------------
-- Function privileges: the server secret key's role only.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.lease_compile_operation(uuid, uuid, integer),
  public.park_operation(uuid, uuid, jsonb),
  public.set_project_compilation_state(uuid, uuid, integer, jsonb, text, jsonb, text),
  public.commit_scene_version(uuid, uuid, integer, text, jsonb, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, text, text, text),
  public.activate_scene_version(uuid, uuid, integer, uuid),
  public.decline_scene_version(uuid, uuid, integer, uuid),
  public.read_scene_versions(uuid, uuid, uuid, integer)
from public, anon, authenticated;

grant execute on function
  public.lease_compile_operation(uuid, uuid, integer),
  public.park_operation(uuid, uuid, jsonb),
  public.set_project_compilation_state(uuid, uuid, integer, jsonb, text, jsonb, text),
  public.commit_scene_version(uuid, uuid, integer, text, jsonb, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, text, text, text),
  public.activate_scene_version(uuid, uuid, integer, uuid),
  public.decline_scene_version(uuid, uuid, integer, uuid),
  public.read_scene_versions(uuid, uuid, uuid, integer)
to service_role;
