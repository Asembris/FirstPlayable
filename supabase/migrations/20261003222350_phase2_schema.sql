-- FirstPlayable phase 2 — the eight small tables of specification section 11.
--
-- Access model (specification section 12):
--   * Row-level security is enabled on every table and NO policy is created,
--     so `anon` and `authenticated` are denied by default even if a future
--     Supabase setting re-exposes the schema.
--   * Privileges are granted only to `service_role`, the role behind the
--     server-only secret key. Automatic table exposure is disabled on this
--     project, so the grants below are explicit rather than inherited.
--   * The secret key bypasses row-level security. That is why every repository
--     in src/server/db/ still carries an owner session id in its predicate.
--     Row-level security is defence in depth here, never the only boundary.

-- ---------------------------------------------------------------------------
-- Immutability helper for the append-only tables.
-- ---------------------------------------------------------------------------

create or replace function public.reject_content_mutation()
returns trigger
language plpgsql
set search_path = ''
as $func$
begin
  raise exception 'contents of %.% are immutable', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end;
$func$;

comment on function public.reject_content_mutation() is
  'Rejects UPDATE on the append-only phase 2 tables: immutable capture, decision, and version contents (specification section 11).';

-- ---------------------------------------------------------------------------
-- 1. sessions — anonymous ownership.
-- ---------------------------------------------------------------------------

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 hex of the opaque owner cookie secret. The raw secret is never stored.
  owner_secret_hash text not null
    constraint sessions_owner_secret_hash_shape check (owner_secret_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint sessions_expiry_after_creation check (expires_at > created_at)
);

create unique index sessions_owner_secret_hash_key on public.sessions (owner_secret_hash);
create index sessions_expires_at_idx on public.sessions (expires_at);

comment on table public.sessions is
  'Anonymous owner sessions. 60-day expiry refreshed by real owner activity. Never expose the hash or the cookie.';

-- ---------------------------------------------------------------------------
-- 2. projects — mutable current pointers and a revision counter.
-- ---------------------------------------------------------------------------

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_session_id uuid not null references public.sessions (id) on delete cascade,
  title text not null
    constraint projects_title_length check (char_length(title) between 1 and 60),
  -- Frozen brief and world, validated by the authoritative Zod contract before insert.
  brief jsonb not null,
  -- Confirmed cultural anchor and its search snapshot. Phase 3 populates this.
  anchor jsonb,
  revision integer not null default 1
    constraint projects_revision_positive check (revision >= 1),
  -- Pointers into qloo_captures. Phase 3 populates this.
  reference_capture_ids uuid[] not null default '{}'::uuid[],
  -- Current approval pointer per slot, for example {"discovery": "<decision id>"}.
  active_approvals jsonb not null default '{}'::jsonb,
  -- Clean cultural-data-blind foundation. Phase 4 populates these.
  base_scene jsonb,
  base_hash text,
  active_version_id uuid,
  workflow_state text not null default 'DRAFT'
    constraint projects_workflow_state_known check (workflow_state in (
      'DRAFT', 'ANCHOR_CONFIRMED', 'REFERENCES_READY', 'PROPOSALS_READY',
      'AWAITING_APPROVAL', 'BASE_READY', 'MODULES_READY', 'VALIDATING',
      'REVIEW_PLAYABLE', 'READY', 'REVISION_PENDING', 'FAILED'
    )),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_owner_created_idx on public.projects (owner_session_id, created_at desc);

comment on table public.projects is
  'Owner-scoped projects. Every consequential edit increments the revision counter (specification section 11).';
comment on column public.projects.base_scene is
  'Brief-only foundation. It cannot read artist names, Qloo packets, proposals, or approvals.';

-- ---------------------------------------------------------------------------
-- 3. qloo_captures — immutable normalized retrieval evidence (phase 3 writes).
-- ---------------------------------------------------------------------------

create table public.qloo_captures (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    constraint qloo_captures_kind_known check (kind in ('search', 'movies', 'videogames')),
  request_fingerprint text not null,
  normalized_query text,
  artist_entity_id text,
  domain text
    constraint qloo_captures_domain_known check (domain is null or domain in ('movie', 'videogame')),
  -- Normalized results and the exact evidence fields quoted back to the creator.
  results jsonb not null,
  quota_diagnostics jsonb,
  normalizer_version text not null,
  captured_at timestamptz not null default now(),
  cache_expires_at timestamptz not null,
  constraint qloo_captures_cache_after_capture check (cache_expires_at > captured_at)
);

create unique index qloo_captures_fingerprint_key on public.qloo_captures (request_fingerprint);
create index qloo_captures_cache_expires_idx on public.qloo_captures (cache_expires_at);
create index qloo_captures_artist_domain_idx on public.qloo_captures (artist_entity_id, domain);

create trigger qloo_captures_immutable
  before update on public.qloo_captures
  for each row execute function public.reject_content_mutation();

comment on table public.qloo_captures is
  'Immutable capture contents. An expired cache lookup is not deletion of evidence linked to a version.';

-- ---------------------------------------------------------------------------
-- 4. influence_decisions — append-only creator decisions (phase 3 writes).
-- ---------------------------------------------------------------------------

create table public.influence_decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  decision_kind text not null
    constraint influence_decisions_kind_known check (decision_kind in (
      'accept', 'reject', 'edit', 'replace', 'remove'
    )),
  slot text
    constraint influence_decisions_slot_known
      check (slot is null or slot in ('discovery', 'commitment')),
  proposal_snapshot jsonb not null,
  selected_evidence_ids text[] not null default '{}'::text[],
  creator_text text
    constraint influence_decisions_creator_text_length
      check (creator_text is null or char_length(creator_text) <= 700),
  predecessor_id uuid references public.influence_decisions (id) on delete set null,
  created_at timestamptz not null default now()
);

create index influence_decisions_project_created_idx
  on public.influence_decisions (project_id, created_at);
create index influence_decisions_project_slot_idx
  on public.influence_decisions (project_id, slot);

create trigger influence_decisions_immutable
  before update on public.influence_decisions
  for each row execute function public.reject_content_mutation();

comment on table public.influence_decisions is
  'Append-only decisions. The current approval is a project pointer, not a mutation of historical approved text.';

-- ---------------------------------------------------------------------------
-- 5. scene_versions — immutable validated versions (phase 4 writes).
-- ---------------------------------------------------------------------------

create table public.scene_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  parent_version_id uuid references public.scene_versions (id) on delete set null,
  input_hash text not null,
  base_hash text not null,
  -- Canonical hash per owned module, for example {"discovery": "<hex>"}.
  module_hashes jsonb not null default '{}'::jsonb,
  scene jsonb not null
    constraint scene_versions_scene_size check (length(scene::text) <= 196608),
  validation_summary jsonb not null,
  revision_diff jsonb,
  model_identifier text,
  prompt_identifier text,
  schema_identifier text,
  created_at timestamptz not null default now()
);

create index scene_versions_project_created_idx
  on public.scene_versions (project_id, created_at desc);
create index scene_versions_project_input_idx
  on public.scene_versions (project_id, input_hash);

create trigger scene_versions_immutable
  before update on public.scene_versions
  for each row execute function public.reject_content_mutation();

alter table public.projects
  add constraint projects_active_version_fk
  foreign key (active_version_id) references public.scene_versions (id) on delete set null;

comment on table public.scene_versions is
  'Immutable validated versions only. Failed candidate JSON stays a short-lived operation artifact.';

-- ---------------------------------------------------------------------------
-- 6. publications — one link names one immutable version (phase 5 writes).
-- ---------------------------------------------------------------------------

create table public.publications (
  id uuid primary key default gen_random_uuid(),
  owner_session_id uuid not null references public.sessions (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  scene_version_id uuid not null references public.scene_versions (id) on delete restrict,
  -- SHA-256 hex of a separately generated read token with at least 128 bits of entropy.
  read_token_hash text not null
    constraint publications_read_token_hash_shape check (read_token_hash ~ '^[0-9a-f]{64}$'),
  public_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index publications_read_token_hash_key on public.publications (read_token_hash);
create index publications_project_idx on public.publications (project_id, created_at desc);

create trigger publications_content_immutable
  before update on public.publications
  for each row
  when (
    new.project_id is distinct from old.project_id
    or new.owner_session_id is distinct from old.owner_session_id
    or new.scene_version_id is distinct from old.scene_version_id
    or new.read_token_hash is distinct from old.read_token_hash
    or new.public_snapshot is distinct from old.public_snapshot
    or new.created_at is distinct from old.created_at
  )
  execute function public.reject_content_mutation();

comment on table public.publications is
  'One link equals one version. Revocation sets revoked_at and does not delete the private source version.';

-- ---------------------------------------------------------------------------
-- 7. operations — resumable stage checkpoints, not a job queue.
-- ---------------------------------------------------------------------------

create table public.operations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  owner_session_id uuid not null references public.sessions (id) on delete cascade,
  stage text not null
    constraint operations_stage_known check (stage in (
      'artist_search', 'references', 'proposals', 'base', 'module_discovery',
      'module_commitment', 'ending_copy', 'validate', 'smoke'
    )),
  status text not null
    constraint operations_status_known check (status in (
      'reserved', 'running', 'succeeded', 'failed', 'expired'
    )),
  input_revision integer not null
    constraint operations_input_revision_positive check (input_revision >= 1),
  input_hash text not null,
  attempts integer not null default 0
    constraint operations_attempts_nonnegative check (attempts >= 0),
  max_attempts integer not null default 2
    constraint operations_max_attempts_bounded check (max_attempts between 1 and 4),
  -- One idempotency key identifies one stage of one frozen input revision.
  idempotency_key text not null
    constraint operations_idempotency_key_length
      check (char_length(idempotency_key) between 8 and 200),
  lease_expires_at timestamptz,
  result jsonb
    constraint operations_result_bounded check (result is null or length(result::text) <= 16384),
  error jsonb
    constraint operations_error_bounded check (error is null or length(error::text) <= 4096),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operations_attempts_within_ceiling check (attempts <= max_attempts)
);

create unique index operations_idempotency_key_key on public.operations (idempotency_key);
create index operations_project_created_idx on public.operations (project_id, created_at desc);
create index operations_lease_idx on public.operations (status, lease_expires_at);

comment on table public.operations is
  'Resumable checkpoints with a database lease and an idempotency key. Not a general job queue or a tracing warehouse.';
comment on column public.operations.lease_expires_at is
  'A held lease prevents duplicate work. An expired lease may be recovered, still inside max_attempts.';

-- ---------------------------------------------------------------------------
-- 8. budget_buckets — atomic safety counters.
-- ---------------------------------------------------------------------------

create table public.budget_buckets (
  id uuid primary key default gen_random_uuid(),
  scope text not null
    constraint budget_buckets_scope_length check (char_length(scope) between 1 and 64),
  bucket_key text not null
    constraint budget_buckets_key_length check (char_length(bucket_key) between 1 and 200),
  window_start timestamptz not null,
  window_end timestamptz not null,
  call_limit integer not null
    constraint budget_buckets_limit_nonnegative check (call_limit >= 0),
  reserved_calls integer not null default 0
    constraint budget_buckets_reserved_calls_nonnegative check (reserved_calls >= 0),
  used_calls integer not null default 0
    constraint budget_buckets_used_calls_nonnegative check (used_calls >= 0),
  reserved_tokens bigint not null default 0
    constraint budget_buckets_reserved_tokens_nonnegative check (reserved_tokens >= 0),
  used_tokens bigint not null default 0
    constraint budget_buckets_used_tokens_nonnegative check (used_tokens >= 0),
  -- Active request leases, each
  -- {"id": uuid, "calls": int, "tokens": int, "expires_at": timestamptz}.
  -- An abandoned request's reservation is swept back out when its lease expires.
  active_leases jsonb not null default '[]'::jsonb
    constraint budget_buckets_leases_are_an_array check (jsonb_typeof(active_leases) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budget_buckets_window_ordered check (window_end > window_start)
);

create unique index budget_buckets_window_key
  on public.budget_buckets (scope, bucket_key, window_start);
create index budget_buckets_window_end_idx on public.budget_buckets (window_end);
create index budget_buckets_leases_idx on public.budget_buckets using gin (active_leases);

comment on table public.budget_buckets is
  'Atomic safety counters with cleanup for expired windows and leases. The configured limit is an application cap, not a provider quota.';

-- ---------------------------------------------------------------------------
-- Deny-by-default access posture.
-- ---------------------------------------------------------------------------

alter table public.sessions enable row level security;
alter table public.projects enable row level security;
alter table public.qloo_captures enable row level security;
alter table public.influence_decisions enable row level security;
alter table public.scene_versions enable row level security;
alter table public.publications enable row level security;
alter table public.operations enable row level security;
alter table public.budget_buckets enable row level security;

-- Browser and public roles get nothing: no policy exists and no grant remains.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke execute on function public.reject_content_mutation() from public;

-- The server secret key's role gets exactly the table access the repositories need.
grant usage on schema public to service_role;
grant select, insert, update, delete on
  public.sessions,
  public.projects,
  public.qloo_captures,
  public.influence_decisions,
  public.scene_versions,
  public.publications,
  public.operations,
  public.budget_buckets
to service_role;
