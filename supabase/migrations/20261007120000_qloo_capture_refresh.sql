-- A fingerprint identifies a request, not an immutable upstream retrieval.
-- Keep every historical row and its ID; only replace the lookup index.
begin;
drop index public.qloo_captures_fingerprint_key;
create index qloo_captures_fingerprint_captured_idx
  on public.qloo_captures (request_fingerprint, captured_at desc, id desc);
commit;
