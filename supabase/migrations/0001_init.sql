-- MediaPack schema (CONTRACTS.md §4). Postgres owns payment, job, operation, allowance and outbox state.
-- All tables have RLS on and no policies: only the server (service role) touches them.

create extension if not exists pgcrypto;

-- ───────────────────────── identity ─────────────────────────
create table clients (
  id uuid primary key default gen_random_uuid(),
  capability_hash text not null unique,          -- peppered sha256 of the 256-bit capability
  display_name text,                             -- self-reported, not an identity
  revoked boolean not null default false,
  expires_at timestamptz not null,
  pair_code_hash text,
  pair_code_expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- ───────────────────────── media ─────────────────────────
create table videos (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients on delete cascade,
  original_filename text not null,
  object_key text not null unique,               -- immutable; never overwritten
  declared_size_bytes bigint not null,
  size_bytes bigint,                             -- verified by probe
  sha256 text,
  duration_ms int,
  width int,                                     -- display dimensions after rotation
  height int,
  rotation int,
  audio text not null default 'unknown' check (audio in ('unknown', 'present', 'absent')),
  state text not null default 'uploading'
    check (state in ('uploading', 'probing', 'ready', 'rejected', 'expired')),
  reject_code text,
  reject_message text,
  upload_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index videos_client_idx on videos (client_id, created_at desc);

-- ───────────────────────── commerce ─────────────────────────
create table quotes (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos on delete cascade,
  source_sha256 text not null,
  amount_minor int not null check (amount_minor >= 50),
  currency text not null,
  payment_mode text not null check (payment_mode in ('test', 'live')),
  limit_searches int not null,
  limit_frames int not null,
  limit_clip_ms int not null,
  limit_text_chars int not null,
  pack_ttl_seconds int not null,
  indexer_version text not null,
  terms_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create function forbid_update() returns trigger language plpgsql as $$
begin raise exception 'IMMUTABLE: % rows cannot be modified', tg_table_name; end $$;
create trigger quotes_immutable before update on quotes for each row execute function forbid_update();

create table jobs (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null unique references quotes,
  video_id uuid not null references videos on delete cascade,
  client_id uuid not null references clients on delete cascade,
  state text not null default 'awaiting_payment'
    check (state in ('awaiting_payment', 'paid', 'indexing', 'ready', 'failed', 'expired')),
  paid_at timestamptz,
  pack_expires_at timestamptz,
  payment_intent_id text unique,
  used_searches int not null default 0,
  used_frames int not null default 0,
  used_clip_ms int not null default 0,
  used_text_chars int not null default 0,
  reserved_searches int not null default 0,
  reserved_frames int not null default 0,
  reserved_clip_ms int not null default 0,
  reserved_text_chars int not null default 0,
  index_artifact_id uuid,
  row_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (used_searches >= 0 and used_frames >= 0 and used_clip_ms >= 0 and used_text_chars >= 0),
  check (reserved_searches >= 0 and reserved_frames >= 0 and reserved_clip_ms >= 0 and reserved_text_chars >= 0)
);

create table payment_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs on delete cascade,
  state text not null check (state in ('submitting', 'unknown', 'succeeded', 'failed')),
  terms_hash text not null,
  challenge_fingerprint text,
  payment_intent_id text unique,
  source text not null check (source in ('mpp', 'webhook')),
  error_class text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- At most one in-flight or successful attempt per job ⇒ concurrent purchases cannot both charge.
create unique index payment_attempts_one_live on payment_attempts (job_id)
  where state in ('submitting', 'unknown', 'succeeded');

-- ───────────────────────── work ─────────────────────────
create table operations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs on delete cascade,  -- null for probe_video (pre-purchase)
  video_id uuid not null references videos on delete cascade,
  scope_id uuid generated always as (coalesce(job_id, video_id)) stored,
  kind text not null check (kind in ('probe_video', 'index_video', 'search_video', 'extract_frames', 'extract_clip')),
  request_id uuid not null,
  input jsonb not null default '{}',
  input_hash text not null,
  state text not null default 'queued' check (state in ('queued', 'dispatched', 'running', 'succeeded', 'failed')),
  generation int not null default 1,
  attempts int not null default 0,
  lease_expires_at timestamptz,
  sandbox_name text,
  process_name text,
  reserve_searches int not null default 0,
  reserve_frames int not null default 0,
  reserve_clip_ms int not null default 0,
  reserve_text_chars int not null default 0,
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scope_id, kind, request_id)
);
create index operations_job_idx on operations (job_id, created_at);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos on delete cascade,
  job_id uuid references jobs on delete cascade,
  operation_id uuid references operations on delete set null,
  kind text not null check (kind in ('index', 'index_frame', 'frame', 'clip')),
  object_key text not null unique,
  sha256 text not null,
  bytes bigint,
  content_type text not null,
  start_ms int,
  end_ms int,
  frame_ms int,
  width int,
  height int,
  duration_ms int,
  cache_key text,                                -- digest + range/timestamps + encoding + indexer version
  indexer_version text,
  delivered boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index artifacts_cache_idx on artifacts (video_id, cache_key) where cache_key is not null;

-- Searchable temporal records derived from the index artifact. IDs are what the model must cite.
create table index_records (
  video_id uuid not null references videos on delete cascade,
  indexer_version text not null,
  record_id text not null,                       -- e.g. f_0012 (frame) / s_0007 (speech segment)
  kind text not null check (kind in ('frame', 'speech')),
  start_ms int not null,
  end_ms int not null,
  text text not null,                            -- observation or transcribed words
  visible_text text,
  artifact_id uuid references artifacts,         -- the index frame image, for frame records
  primary key (video_id, indexer_version, record_id),
  check (end_ms >= start_ms)
);

-- ───────────────────────── messaging ─────────────────────────
create table provider_events (
  provider text not null check (provider in ('stripe', 'primitive')),
  event_id text not null,
  kind text not null,
  email_id text,
  thread_id text,
  payload jsonb not null default '{}',
  state text not null default 'received' check (state in ('received', 'applied', 'ignored', 'error')),
  error text,
  received_at timestamptz not null default now(),
  applied_at timestamptz,
  primary key (provider, event_id)
);

create table outbox (
  id uuid primary key default gen_random_uuid(),
  logical_key text not null unique,              -- mp:<operation_id>:request:<generation>
  operation_id uuid references operations on delete cascade,
  target text not null check (target in ('primitive', 'blaxel')),
  action text not null,
  payload jsonb not null,
  payload_hash text not null,
  idempotency_key text not null,
  attempts int not null default 0,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now()
);
create index outbox_due_idx on outbox (next_attempt_at) where sent_at is null;

create table job_events (
  id bigserial primary key,
  video_id uuid not null references videos on delete cascade,
  job_id uuid references jobs on delete cascade,
  operation_id uuid references operations on delete set null,
  kind text not null,
  details jsonb not null default '{}',           -- display-safe facts only
  created_at timestamptz not null default now()
);
create index job_events_video_idx on job_events (video_id, id);

create table rate_counters (
  key text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (key, window_start)
);

-- ───────────────────────── transaction helpers ─────────────────────────

create function app_event(p_video uuid, p_job uuid, p_op uuid, p_kind text, p_details jsonb)
returns void language sql as $$
  insert into job_events (video_id, job_id, operation_id, kind, details) values (p_video, p_job, p_op, p_kind, coalesce(p_details, '{}'));
$$;

-- Queue a Primitive work request for an operation (same transaction as the operation change).
create function enqueue_work(p_op uuid) returns uuid language plpgsql as $$
declare
  op operations%rowtype;
  v videos%rowtype;
  q quotes%rowtype;
  env jsonb;
  oid uuid;
begin
  select * into op from operations where id = p_op;
  select * into v from videos where id = op.video_id;
  if op.job_id is not null then
    select q2.* into q from quotes q2 join jobs j on j.quote_id = q2.id where j.id = op.job_id;
  end if;
  env := jsonb_build_object(
    'schema_version', 'mediapack.v1', 'kind', 'work_request',
    'operation_id', op.id, 'job_id', op.job_id, 'video_id', op.video_id, 'action', op.kind,
    'source_sha256', v.sha256, 'terms_hash', q.terms_hash, 'generation', op.generation,
    'media_ref', jsonb_build_object('object_key', v.object_key),
    'input', op.input, 'reply_to_operation', op.id);
  insert into outbox (logical_key, operation_id, target, action, payload, payload_hash, idempotency_key)
  values (format('mp:%s:request:%s', op.id, op.generation), op.id, 'primitive', op.kind, env,
          encode(digest(env::text, 'sha256'), 'hex'), format('mp:%s:request:%s', op.id, op.generation))
  on conflict (logical_key) do nothing
  returning id into oid;
  return oid;
end $$;

-- Probe operation after upload completion (unpaid; idempotent per video).
create function enqueue_probe(p_video uuid, p_client uuid) returns uuid language plpgsql as $$
declare v videos%rowtype; opid uuid;
begin
  select * into v from videos where id = p_video and client_id = p_client for update;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  if v.state not in ('uploading', 'probing') then
    select id into opid from operations where video_id = p_video and kind = 'probe_video' order by created_at desc limit 1;
    return opid;
  end if;
  insert into operations (video_id, kind, request_id, input, input_hash)
  values (p_video, 'probe_video', p_video, '{}', 'probe')
  on conflict (scope_id, kind, request_id) do nothing
  returning id into opid;
  if opid is null then
    select id into opid from operations where scope_id = p_video and kind = 'probe_video' and request_id = p_video;
    return opid;
  end if;
  update videos set state = 'probing', updated_at = now() where id = p_video;
  perform enqueue_work(opid);
  perform app_event(p_video, null, opid, 'video.probe_queued', '{}');
  return opid;
end $$;

-- 1. Freeze terms and pre-create the pending job.
create function create_quote_and_job(p_client uuid, p_video uuid, p_terms jsonb)
returns table (quote_id uuid, job_id uuid) language plpgsql as $$
declare v videos%rowtype; qid uuid; jid uuid;
begin
  select * into v from videos where id = p_video and client_id = p_client for update;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  if v.state <> 'ready' then raise exception 'VIDEO_NOT_READY'; end if;
  if v.sha256 is distinct from p_terms->>'source_sha256' then raise exception 'VIDEO_NOT_READY'; end if;
  insert into quotes (video_id, source_sha256, amount_minor, currency, payment_mode, limit_searches, limit_frames,
                      limit_clip_ms, limit_text_chars, pack_ttl_seconds, indexer_version, terms_hash, expires_at)
  values (p_video, v.sha256, (p_terms->>'amount_minor')::int, p_terms->>'currency', p_terms->>'payment_mode',
          (p_terms->'limits'->>'searches')::int, (p_terms->'limits'->>'frames')::int,
          (p_terms->'limits'->>'clip_ms')::int, (p_terms->'limits'->>'text_chars')::int,
          (p_terms->>'pack_ttl_seconds')::int, p_terms->>'indexer_version', p_terms->>'terms_hash',
          (p_terms->>'expires_at')::timestamptz)
  returning id into qid;
  insert into jobs (quote_id, video_id, client_id) values (qid, p_video, p_client) returning id into jid;
  perform app_event(p_video, jid, null, 'quote.issued',
    jsonb_build_object('quote_id', qid, 'amount_minor', p_terms->'amount_minor', 'currency', p_terms->'currency',
                       'mode', p_terms->'payment_mode', 'expires_at', p_terms->'expires_at'));
  return query select qid, jid;
end $$;

-- 2. Payment state gate. Outcomes: paid | reconciling | expired | reserved(attempt_id).
create function reserve_payment_attempt(p_client uuid, p_job uuid, p_terms_hash text, p_fingerprint text)
returns table (outcome text, attempt_id uuid) language plpgsql as $$
declare j jobs%rowtype; q quotes%rowtype; a payment_attempts%rowtype; aid uuid;
begin
  select * into j from jobs where id = p_job and client_id = p_client for update;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  if j.paid_at is not null then return query select 'paid'::text, null::uuid; return; end if;
  select * into a from payment_attempts where job_id = p_job and state in ('submitting', 'unknown') limit 1;
  if found then return query select 'reconciling'::text, a.id; return; end if;
  select * into q from quotes where id = j.quote_id;
  if q.terms_hash <> p_terms_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  if q.expires_at < now() then return query select 'expired'::text, null::uuid; return; end if;
  insert into payment_attempts (job_id, state, terms_hash, challenge_fingerprint, source)
  values (p_job, 'submitting', p_terms_hash, p_fingerprint, 'mpp') returning id into aid;
  return query select 'reserved'::text, aid;
end $$;

-- Mark an in-flight attempt as unknown (timeout/ambiguous) or failed (definitive decline before charge).
create function settle_payment_attempt(p_attempt uuid, p_state text, p_error text, p_payment_intent text)
returns void language plpgsql as $$
begin
  if p_state not in ('unknown', 'failed') then raise exception 'BAD_STATE'; end if;
  update payment_attempts set state = p_state, error_class = p_error,
    payment_intent_id = coalesce(p_payment_intent, payment_intent_id), updated_at = now()
  where id = p_attempt and state in ('submitting', 'unknown');
end $$;

-- 3. Bind a verified PaymentIntent to its job exactly once; start indexing. Used by MPP handler and webhook.
create function apply_verified_payment(
  p_job uuid, p_attempt uuid, p_payment_intent text, p_amount int, p_currency text, p_livemode boolean
) returns table (outcome text, operation_id uuid) language plpgsql as $$
declare j jobs%rowtype; q quotes%rowtype; opid uuid;
begin
  select * into j from jobs where id = p_job for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  if j.payment_intent_id = p_payment_intent then
    select id into opid from operations where job_id = p_job and kind = 'index_video' limit 1;
    return query select 'already_applied'::text, opid; return;
  end if;
  if j.paid_at is not null then raise exception 'JOB_PAID_BY_OTHER_PAYMENT'; end if;
  select * into q from quotes where id = j.quote_id;
  if p_amount <> q.amount_minor or lower(p_currency) <> q.currency then raise exception 'PAYMENT_MISMATCH'; end if;
  if p_livemode and q.payment_mode = 'test' then raise exception 'PAYMENT_MISMATCH'; end if;

  if p_attempt is not null then
    update payment_attempts set state = 'succeeded', payment_intent_id = p_payment_intent, updated_at = now()
    where id = p_attempt;
  else
    -- Webhook recovery: close any in-flight attempt, or record the payment we learned about.
    update payment_attempts set state = 'succeeded', payment_intent_id = p_payment_intent, updated_at = now()
    where job_id = p_job and state in ('submitting', 'unknown');
    if not found then
      insert into payment_attempts (job_id, state, terms_hash, payment_intent_id, source)
      values (p_job, 'succeeded', q.terms_hash, p_payment_intent, 'webhook');
    end if;
  end if;

  update jobs set state = 'indexing', paid_at = now(), payment_intent_id = p_payment_intent,
    pack_expires_at = now() + make_interval(secs => q.pack_ttl_seconds), row_version = row_version + 1, updated_at = now()
  where id = p_job;
  -- Keep the client authorized at least as long as the pack.
  update clients set expires_at = greatest(expires_at, now() + make_interval(secs => q.pack_ttl_seconds))
  where id = j.client_id;

  insert into operations (job_id, video_id, kind, request_id, input, input_hash)
  values (p_job, j.video_id, 'index_video', p_job, '{}', 'index') returning id into opid;
  perform enqueue_work(opid);
  perform app_event(j.video_id, p_job, null, 'payment.verified',
    jsonb_build_object('payment_intent_id', p_payment_intent, 'amount_minor', p_amount, 'currency', p_currency, 'livemode', p_livemode));
  perform app_event(j.video_id, p_job, opid, 'operation.queued', jsonb_build_object('kind', 'index_video'));
  return query select 'applied'::text, opid;
end $$;

-- 4. Idempotent operation with atomic allowance reservation.
create function reserve_operation(
  p_client uuid, p_job uuid, p_kind text, p_request_id uuid, p_input jsonb, p_input_hash text,
  p_searches int, p_frames int, p_clip_ms int, p_text_chars int
) returns table (operation_id uuid, created boolean) language plpgsql as $$
declare j jobs%rowtype; q quotes%rowtype; existing operations%rowtype; opid uuid;
begin
  select * into j from jobs where id = p_job and client_id = p_client for update;
  if not found then raise exception 'UNAUTHORIZED'; end if;

  select * into existing from operations where scope_id = p_job and kind = p_kind and request_id = p_request_id;
  if found then
    if existing.input_hash <> p_input_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return query select existing.id, false; return;
  end if;

  if j.paid_at is null then raise exception 'PAYMENT_REQUIRED'; end if;
  if j.pack_expires_at < now() then raise exception 'PACK_EXPIRED'; end if;
  if j.state <> 'ready' then raise exception 'INDEX_NOT_READY'; end if;
  select * into q from quotes where id = j.quote_id;
  if j.used_searches + j.reserved_searches + p_searches > q.limit_searches
     or j.used_frames + j.reserved_frames + p_frames > q.limit_frames
     or j.used_clip_ms + j.reserved_clip_ms + p_clip_ms > q.limit_clip_ms
     or j.used_text_chars + j.reserved_text_chars + p_text_chars > q.limit_text_chars then
    raise exception 'ALLOWANCE_EXCEEDED';
  end if;

  insert into operations (job_id, video_id, kind, request_id, input, input_hash,
                          reserve_searches, reserve_frames, reserve_clip_ms, reserve_text_chars)
  values (p_job, j.video_id, p_kind, p_request_id, p_input, p_input_hash, p_searches, p_frames, p_clip_ms, p_text_chars)
  returning id into opid;
  update jobs set reserved_searches = reserved_searches + p_searches, reserved_frames = reserved_frames + p_frames,
    reserved_clip_ms = reserved_clip_ms + p_clip_ms, reserved_text_chars = reserved_text_chars + p_text_chars,
    row_version = row_version + 1, updated_at = now()
  where id = p_job;
  perform enqueue_work(opid);
  perform app_event(j.video_id, p_job, opid, 'operation.queued', jsonb_build_object('kind', p_kind, 'input', p_input));
  return query select opid, true;
end $$;

-- 5. Bounded outbox lease. Network I/O happens after this transaction commits.
create function claim_outbox_batch(p_limit int, p_lease_seconds int) returns setof outbox language plpgsql as $$
begin
  return query
  update outbox o set lease_expires_at = now() + make_interval(secs => p_lease_seconds), attempts = o.attempts + 1
  where o.id in (
    select id from outbox
    where sent_at is null and next_attempt_at <= now() and (lease_expires_at is null or lease_expires_at < now())
    order by next_attempt_at limit p_limit
    for update skip locked)
  returning o.*;
end $$;

create function mark_outbox_sent(p_id uuid, p_provider_message_id text) returns void language plpgsql as $$
declare ob outbox%rowtype;
begin
  update outbox set sent_at = now(), provider_message_id = p_provider_message_id, lease_expires_at = null, last_error = null
  where id = p_id and sent_at is null returning * into ob;
  if found and ob.operation_id is not null then
    update operations set state = 'dispatched', updated_at = now() where id = ob.operation_id and state = 'queued';
    perform app_event(o.video_id, o.job_id, o.id, 'primitive.request_sent',
      jsonb_build_object('action', ob.action, 'message_id', p_provider_message_id, 'generation', o.generation))
    from operations o where o.id = ob.operation_id;
  end if;
end $$;

create function mark_outbox_failed(p_id uuid, p_error text) returns void language sql as $$
  update outbox set lease_expires_at = null, last_error = left(p_error, 500),
    next_attempt_at = now() + make_interval(secs => least(300, 5 * power(2, attempts)::int))
  where id = p_id and sent_at is null;
$$;

-- 6. Worker launch bookkeeping (after verified work delivery). Fenced by generation.
create function claim_operation(p_op uuid, p_generation int, p_sandbox text, p_process text, p_lease_seconds int)
returns boolean language plpgsql as $$
declare op operations%rowtype;
begin
  select * into op from operations where id = p_op for update;
  if not found or op.generation <> p_generation or op.state in ('succeeded', 'failed') then return false; end if;
  if op.state = 'running' and op.lease_expires_at > now() then return false; end if;  -- already launched
  update operations set state = 'running', attempts = attempts + 1, sandbox_name = p_sandbox, process_name = p_process,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = p_op;
  perform app_event(op.video_id, op.job_id, op.id, 'worker.launched',
    jsonb_build_object('kind', op.kind, 'sandbox', p_sandbox, 'process', p_process, 'generation', p_generation));
  return true;
end $$;

-- 7. Commit a verified result exactly once. p_usage = {searches, frames, clip_ms, text_chars}.
create function complete_operation(p_op uuid, p_generation int, p_result jsonb, p_usage jsonb)
returns text language plpgsql as $$
declare op operations%rowtype; u_s int; u_f int; u_c int; u_t int;
begin
  select * into op from operations where id = p_op for update;
  if not found then raise exception 'OPERATION_NOT_FOUND'; end if;
  if op.state = 'succeeded' then return 'already_completed'; end if;
  if op.generation <> p_generation or op.state = 'failed' then return 'stale'; end if;

  u_s := coalesce((p_usage->>'searches')::int, 0); u_f := coalesce((p_usage->>'frames')::int, 0);
  u_c := coalesce((p_usage->>'clip_ms')::int, 0);  u_t := coalesce((p_usage->>'text_chars')::int, 0);
  if u_s > op.reserve_searches or u_f > op.reserve_frames or u_c > op.reserve_clip_ms or u_t > op.reserve_text_chars then
    raise exception 'USAGE_EXCEEDS_RESERVATION';
  end if;

  update operations set state = 'succeeded', result = p_result, lease_expires_at = null, updated_at = now() where id = p_op;

  if op.job_id is not null then
    update jobs set
      used_searches = used_searches + u_s, used_frames = used_frames + u_f,
      used_clip_ms = used_clip_ms + u_c, used_text_chars = used_text_chars + u_t,
      reserved_searches = reserved_searches - op.reserve_searches, reserved_frames = reserved_frames - op.reserve_frames,
      reserved_clip_ms = reserved_clip_ms - op.reserve_clip_ms, reserved_text_chars = reserved_text_chars - op.reserve_text_chars,
      state = case when op.kind = 'index_video' then 'ready' else state end,
      index_artifact_id = case when op.kind = 'index_video' then (p_result->>'index_artifact_id')::uuid else index_artifact_id end,
      row_version = row_version + 1, updated_at = now()
    where id = op.job_id;
  end if;

  if op.kind = 'probe_video' then
    if coalesce((p_result->>'accepted')::boolean, false) then
      update videos set state = 'ready', size_bytes = (p_result->>'size_bytes')::bigint, sha256 = p_result->>'sha256',
        duration_ms = (p_result->>'duration_ms')::int, width = (p_result->>'width')::int, height = (p_result->>'height')::int,
        rotation = (p_result->>'rotation')::int, audio = p_result->>'audio', updated_at = now()
      where id = op.video_id;
    else
      update videos set state = 'rejected', reject_code = p_result->>'reject_code', reject_message = p_result->>'reject_message',
        updated_at = now() where id = op.video_id;
    end if;
  end if;

  perform app_event(op.video_id, op.job_id, op.id, 'operation.succeeded',
    jsonb_build_object('kind', op.kind, 'usage', p_usage));
  return 'completed';
end $$;

-- 8. One bounded retry with the same reservation; release only on terminal failure.
create function fail_or_retry_operation(p_op uuid, p_generation int, p_code text, p_message text, p_retryable boolean)
returns text language plpgsql as $$
declare op operations%rowtype;
begin
  select * into op from operations where id = p_op for update;
  if not found then raise exception 'OPERATION_NOT_FOUND'; end if;
  if op.state in ('succeeded', 'failed') or op.generation <> p_generation then return 'stale'; end if;

  if p_retryable and op.attempts < 2 then
    update operations set generation = generation + 1, state = 'queued', lease_expires_at = null,
      error_code = p_code, error_message = left(p_message, 500), updated_at = now() where id = p_op;
    perform enqueue_work(p_op);
    perform app_event(op.video_id, op.job_id, op.id, 'operation.retrying', jsonb_build_object('kind', op.kind, 'error_code', p_code));
    return 'retrying';
  end if;

  update operations set state = 'failed', lease_expires_at = null, error_code = p_code,
    error_message = left(p_message, 500), updated_at = now() where id = p_op;
  if op.job_id is not null then
    update jobs set
      reserved_searches = reserved_searches - op.reserve_searches, reserved_frames = reserved_frames - op.reserve_frames,
      reserved_clip_ms = reserved_clip_ms - op.reserve_clip_ms, reserved_text_chars = reserved_text_chars - op.reserve_text_chars,
      state = case when op.kind = 'index_video' then 'failed' else state end, updated_at = now()
    where id = op.job_id;
  end if;
  if op.kind = 'probe_video' then
    update videos set state = 'rejected', reject_code = p_code, reject_message = left(p_message, 500), updated_at = now()
    where id = op.video_id;
  end if;
  perform app_event(op.video_id, op.job_id, op.id, 'operation.failed', jsonb_build_object('kind', op.kind, 'error_code', p_code));
  return 'failed';
end $$;

-- Operations whose worker lease expired without a result: re-dispatch once via the retry path.
create function reap_stale_operations(p_limit int) returns int language plpgsql as $$
declare r record; n int := 0;
begin
  for r in select id, generation from operations
           where state = 'running' and lease_expires_at < now() order by lease_expires_at limit p_limit
  loop
    perform fail_or_retry_operation(r.id, r.generation, 'WORKER_FAILED', 'lease expired without result', true);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ───────────────────────── lockdown ─────────────────────────
do $$ declare t text; begin
  foreach t in array array['clients','videos','quotes','jobs','payment_attempts','operations','artifacts',
                           'index_records','provider_events','outbox','job_events','rate_counters']
  loop execute format('alter table %I enable row level security', t); end loop;
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f'
  loop execute format('revoke execute on function %s from public', f.sig); end loop;
end $$;
