-- FirstPlayable phase 5 — targeted revision, immutable sharing, and offline
-- export (specification sections 9, 11, and 12).
--
-- This migration creates no table. The eight tables of section 11 are still
-- the whole schema, and `public.publications` has been waiting since the
-- phase 2 migration with exactly the columns this phase writes.
--
-- What it adds, and why each piece has to be in the database:
--
--   * `operations.stage` gains `revision`: the idempotency row for one
--     deterministic revision command. A double-clicked "remove this influence"
--     must not compose two versions, and the only place that can be decided
--     once is the unique index on `operations.idempotency_key`.
--   * `projects` gains `ending_copy_overrides`: the creator's explicit
--     text-only ending wording. It lives beside the compiled modules because
--     it is an input to composition, not an edit of a version: every later
--     recomposition — including a module recompile — reads it back, so an
--     applied wording change survives a revision of a different kind.
--   * `commit_scene_version` gains `p_revision_diff`. `scene_versions` has
--     carried a `revision_diff` column since phase 2 and the table's trigger
--     refuses `UPDATE`, so the only moment a diff can be stored is the insert.
--     That means a new signature; the old one is kept, as a one-line
--     delegation, so the build deployed when this migration is applied keeps
--     committing versions until the build that goes with it is deployed. This
--     migration therefore drops no function at all.
--   * Five publication functions. A publication is a cross-table decision —
--     owner, project, version state, token uniqueness — and the public read is
--     the one query in the application with *no* owner predicate, so both
--     belong in SQL where the predicate set is visible and testable.
--
-- Every function is SECURITY INVOKER with a pinned empty search path and is
-- executable only by `service_role`, and every one that names a project
-- re-checks ownership itself. The public read deliberately takes no session:
-- it is keyed by a hashed 256-bit read token and returns no project id, no
-- owner, and no history.

-- ---------------------------------------------------------------------------
-- 1. The deterministic revision stage.
-- ---------------------------------------------------------------------------

alter table public.operations
  drop constraint operations_stage_known;

alter table public.operations
  add constraint operations_stage_known check (stage in (
    'artist_search', 'references', 'proposals', 'compile', 'base',
    'module_discovery', 'module_commitment', 'ending_copy', 'revision',
    'validate', 'smoke'
  ));

comment on column public.operations.stage is
  'One stage of one frozen input revision. `compile` is the persisted controller row; the model stages are `base`, `module_discovery`, `module_commitment`, and `ending_copy`; `revision` is one deterministic revision command.';

-- ---------------------------------------------------------------------------
-- 2. Creator ending-copy overrides.
-- ---------------------------------------------------------------------------

alter table public.projects
  -- An array of {ending_id, text, creator_edit_id}, at most three, validated
  -- by the authoritative Zod contract before it is written here.
  add column if not exists ending_copy_overrides jsonb not null default '[]'::jsonb;

alter table public.projects
  add constraint projects_ending_copy_overrides_is_array
  check (jsonb_typeof(ending_copy_overrides) = 'array');

alter table public.projects
  add constraint projects_ending_copy_overrides_bounded
  check (
    jsonb_array_length(ending_copy_overrides) <= 3
    and length(ending_copy_overrides::text) <= 8192
  );

comment on column public.projects.ending_copy_overrides is
  'Explicit creator ending wording. A text-only override of one declared ending; it can never carry a condition, an effect, or a reachability change (specification section 9).';

/*
 * Replaces the whole override list under the revision compare-and-swap.
 *
 * Whole-list replacement rather than an upsert per ending, because the list is
 * at most three small objects and a partial write would need a merge rule that
 * the creator never asked for. Advancing the revision counter is the point: an
 * applied wording change is a consequential edit, and the version commit that
 * follows it compares against the counter this call returns.
 */
create or replace function public.set_project_ending_copy_overrides(
  p_project_id uuid,
  p_owner_session_id uuid,
  p_expected_revision integer,
  p_overrides jsonb
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
  if jsonb_typeof(p_overrides) <> 'array' then
    raise exception 'ending copy overrides must be an array'
      using errcode = 'check_violation';
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

  update public.projects
  set ending_copy_overrides = p_overrides,
      revision = v_project.revision + 1,
      updated_at = v_now
  where id = v_project.id;

  return jsonb_build_object('outcome', 'updated', 'revision', v_project.revision + 1);
end;
$func$;

comment on function public.set_project_ending_copy_overrides(uuid, uuid, integer, jsonb) is
  'Replaces the creator ending-wording overrides under the revision compare-and-swap, advancing the revision counter.';

-- ---------------------------------------------------------------------------
-- 3. Committing a version with its deterministic revision diff.
-- ---------------------------------------------------------------------------

/*
 * Committing a version with its diff, added as a new signature.
 *
 * `scene_versions.revision_diff` has existed since the phase 2 migration and
 * `scene_versions_immutable` refuses every `UPDATE`, so a diff can only be
 * written by the insert that creates the row. Adding the parameter therefore
 * means a new signature, and the body below is the phase 4 body with one column
 * added: the compare-and-swap triple, the pending-not-active pointer, and the
 * preserved module artifacts are unchanged.
 *
 * The nineteen-argument form is deliberately **not** dropped, and this is an
 * operational decision rather than tidiness. A migration is applied to the live
 * database while the previously deployed build is still serving: dropping the
 * signature that build calls would break every compilation in the window
 * between applying this file and deploying the code that goes with it. So the
 * old signature stays, rewritten below as a one-line delegation to this one with
 * no diff — which is exactly what it did before — and nothing in this repository
 * calls it any more. There is no duplicated body to drift, and no moment at
 * which committing a version fails.
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
  p_validator_identifier text,
  p_revision_diff jsonb
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
    scene, validation_summary, revision_diff, model_identifier,
    prompt_identifier, schema_identifier, input_snapshot, approval_snapshot,
    validator_identifier, compiler_identifier, operation_id
  )
  values (
    p_project_id, p_parent_version_id, p_input_hash, p_base_hash,
    coalesce(p_module_hashes, '{}'::jsonb), p_scene, p_validation_summary,
    p_revision_diff, p_model_identifier, p_prompt_identifier,
    p_schema_identifier, coalesce(p_input_snapshot, '{}'::jsonb),
    coalesce(p_approval_snapshot, '[]'::jsonb),
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

comment on function public.commit_scene_version(uuid, uuid, integer, text, jsonb, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, text, text, text, jsonb) is
  'Inserts one validated immutable version, with its deterministic revision diff, and makes it the pending review, under a compare-and-swap on revision, base hash, and approval pointers. A stale result inserts nothing.';

/*
 * The superseded nineteen-argument signature, kept callable for one deployment.
 *
 * It delegates, so the compare-and-swap, the validation guard, and the
 * pending-not-active pointer are the ones above and cannot drift from them. It
 * stores no revision diff, which is precisely what it did before this phase.
 * Nothing in this repository calls it; it exists so that the build deployed
 * when this migration is applied keeps working until the build that goes with
 * this migration replaces it.
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
language sql
security invoker
set search_path = ''
as $compat$
  select public.commit_scene_version(
    p_project_id, p_owner_session_id, p_expected_revision, p_expected_base_hash,
    p_expected_approvals, p_operation_id, p_parent_version_id, p_input_hash,
    p_base_hash, p_module_hashes, p_scene, p_validation_summary,
    p_input_snapshot, p_approval_snapshot, p_model_identifier,
    p_prompt_identifier, p_schema_identifier, p_compiler_identifier,
    p_validator_identifier, null::jsonb
  );
$compat$;

comment on function public.commit_scene_version(uuid, uuid, integer, text, jsonb, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, text, text, text) is
  'Superseded signature, kept callable for one deployment window. Delegates to the form that also stores a revision diff, and stores none itself.';

/*
 * The version read, replaced so a summary carries its stored revision diff.
 *
 * Same signature, same ownership predicate, same "the scene travels only when
 * one version is named" rule. The only change is one more key, which is what
 * lets the studio show "what changed" for a historical version without reading
 * that version's whole scene.
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
        'revision_diff', v.revision_diff,
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
  'Owner-checked version read. Returns summaries for a project, each with its stored revision diff, or one named version including its scene.';

-- ---------------------------------------------------------------------------
-- 4. Publication: one link names one immutable version.
-- ---------------------------------------------------------------------------

/*
 * Publishes one validated immutable version behind a hashed read token.
 *
 * Four refusals, each of them a cross-table fact application code cannot check
 * without a race:
 *
 *   * the project is not this owner's — answered as `not_found`, exactly as a
 *     nonexistent project is;
 *   * the version is not that project's — `not_found` again, so a version id
 *     from somewhere else reveals nothing;
 *   * the version is the one awaiting review — `not_reviewed`. A creator
 *     publishes a scene they confirmed, not one they have not looked at;
 *   * the revision moved — `revision_conflict`.
 *
 * The token itself never reaches this function: the caller generates 256 bits,
 * hashes them, and keeps the only copy of the plaintext for its one response.
 */
create or replace function public.publish_scene_version(
  p_project_id uuid,
  p_owner_session_id uuid,
  p_expected_revision integer,
  p_version_id uuid,
  p_read_token_hash text,
  p_public_snapshot jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_project public.projects;
  v_version public.scene_versions;
  v_publication public.publications;
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

  select * into v_version
  from public.scene_versions
  where id = p_version_id and project_id = p_project_id;

  if v_version.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_project.pending_version_id is not distinct from p_version_id then
    return jsonb_build_object('outcome', 'not_reviewed');
  end if;

  insert into public.publications (
    owner_session_id, project_id, scene_version_id, read_token_hash,
    public_snapshot
  )
  values (
    p_owner_session_id, p_project_id, p_version_id, p_read_token_hash,
    p_public_snapshot
  )
  returning * into v_publication;

  return jsonb_build_object(
    'outcome', 'published',
    'publication', jsonb_build_object(
      'id', v_publication.id,
      'scene_version_id', v_publication.scene_version_id,
      'created_at', v_publication.created_at,
      'revoked_at', v_publication.revoked_at
    )
  );
end;
$func$;

comment on function public.publish_scene_version(uuid, uuid, integer, uuid, text, jsonb) is
  'Creates one immutable publication naming one validated, reviewed version. The read token is supplied already hashed; the plaintext never reaches the database.';

/*
 * Owner-only revocation.
 *
 * It sets `revoked_at` and deletes nothing: the private source version, its
 * evidence, and the published snapshot all survive, which is what section 11's
 * retention rule requires. Revoking twice is idempotent rather than an error.
 */
create or replace function public.revoke_publication(
  p_publication_id uuid,
  p_owner_session_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_now timestamptz := now();
  v_publication public.publications;
begin
  select * into v_publication
  from public.publications
  where id = p_publication_id and owner_session_id = p_owner_session_id
  for update;

  if v_publication.id is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_publication.revoked_at is not null then
    return jsonb_build_object(
      'outcome', 'already_revoked',
      'publication', jsonb_build_object(
        'id', v_publication.id,
        'scene_version_id', v_publication.scene_version_id,
        'created_at', v_publication.created_at,
        'revoked_at', v_publication.revoked_at
      )
    );
  end if;

  update public.publications
  set revoked_at = v_now
  where id = v_publication.id;

  return jsonb_build_object(
    'outcome', 'revoked',
    'publication', jsonb_build_object(
      'id', v_publication.id,
      'scene_version_id', v_publication.scene_version_id,
      'created_at', v_publication.created_at,
      'revoked_at', v_now
    )
  );
end;
$func$;

comment on function public.revoke_publication(uuid, uuid) is
  'Owner-only revocation. Sets revoked_at; deletes no snapshot and no source version.';

/*
 * The public read. The one query in this application with no owner predicate.
 *
 * It is keyed by the SHA-256 hash of a 256-bit read token, and it returns the
 * whitelisted snapshot and the publication date — not the project id, not the
 * owner session, not the version's input snapshot, not its approval snapshot,
 * and not any sibling publication. A revoked or unknown token produces the
 * same `unavailable` outcome, so a viewer cannot distinguish "never existed"
 * from "withdrawn".
 */
create or replace function public.read_publication_by_token(
  p_read_token_hash text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $func$
declare
  v_publication public.publications;
begin
  select * into v_publication
  from public.publications
  where read_token_hash = p_read_token_hash;

  if v_publication.id is null or v_publication.revoked_at is not null then
    return jsonb_build_object('outcome', 'unavailable');
  end if;

  return jsonb_build_object(
    'outcome', 'read',
    'published_at', v_publication.created_at,
    'public_snapshot', v_publication.public_snapshot
  );
end;
$func$;

comment on function public.read_publication_by_token(text) is
  'Whitelisted read-only snapshot for one hashed read token. Returns no project, no owner, and no history. Unknown and revoked tokens are indistinguishable.';

/* The owner's own list of links for one project, newest first. */
create or replace function public.read_publications_for_owner(
  p_project_id uuid,
  p_owner_session_id uuid,
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
      p.created_at,
      jsonb_build_object(
        'id', p.id,
        'scene_version_id', p.scene_version_id,
        'created_at', p.created_at,
        'revoked_at', p.revoked_at,
        -- The snapshot's own disclosure flag, so the list can say whether a
        -- link carries the source chain. The snapshot itself does not travel.
        'provenance_included', coalesce(
          (p.public_snapshot -> 'provenance_included') = 'true'::jsonb,
          false
        )
      ) as row_json
    from public.publications as p
    where p.project_id = p_project_id
      and p.owner_session_id = p_owner_session_id
    order by p.created_at desc
    limit p_limit
  ) as selected;

  return jsonb_build_object('outcome', 'read', 'publications', v_rows);
end;
$func$;

comment on function public.read_publications_for_owner(uuid, uuid, integer) is
  'Owner-checked list of one project''s publications. Carries no read token and no snapshot body.';

-- ---------------------------------------------------------------------------
-- 5. Function privileges: the server secret key's role only.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.set_project_ending_copy_overrides(uuid, uuid, integer, jsonb),
  public.commit_scene_version(uuid, uuid, integer, text, jsonb, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, text, text, text, jsonb),
  public.commit_scene_version(uuid, uuid, integer, text, jsonb, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, text, text, text),
  public.publish_scene_version(uuid, uuid, integer, uuid, text, jsonb),
  public.revoke_publication(uuid, uuid),
  public.read_publication_by_token(text),
  public.read_publications_for_owner(uuid, uuid, integer),
  public.read_scene_versions(uuid, uuid, uuid, integer)
from public, anon, authenticated;

grant execute on function
  public.set_project_ending_copy_overrides(uuid, uuid, integer, jsonb),
  public.commit_scene_version(uuid, uuid, integer, text, jsonb, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, text, text, text, jsonb),
  public.commit_scene_version(uuid, uuid, integer, text, jsonb, uuid, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, text, text, text, text),
  public.publish_scene_version(uuid, uuid, integer, uuid, text, jsonb),
  public.revoke_publication(uuid, uuid),
  public.read_publication_by_token(text),
  public.read_publications_for_owner(uuid, uuid, integer),
  public.read_scene_versions(uuid, uuid, uuid, integer)
to service_role;
