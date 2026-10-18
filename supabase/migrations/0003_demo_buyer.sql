-- Demo purchases are a separate, bounded source of Stripe sandbox payment tokens.
-- A reservation is consumed before minting and never released, including uncertain
-- or failed outcomes. Rolling limits count reservation creation, not merchant work.
create table demo_purchases (
  quote_id uuid primary key references quotes,
  job_id uuid not null unique references jobs,
  client_id uuid not null references clients,
  state text not null default 'reserved'
    check (state in ('reserved', 'token_issued', 'succeeded', 'unknown', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index demo_purchases_created_idx on demo_purchases (created_at);
create index demo_purchases_client_created_idx on demo_purchases (client_id, created_at);
alter table demo_purchases enable row level security;
revoke all on table demo_purchases from public, anon, authenticated;
grant select, insert, update on table demo_purchases to service_role;

create function reserve_demo_purchase(
  p_client uuid, p_job uuid, p_per_client_limit int, p_global_limit int
) returns table (outcome text, reservation_state text) language plpgsql as $$
declare
  j jobs%rowtype;
  q quotes%rowtype;
  v videos%rowtype;
  existing_state text;
  reserved_at timestamptz;
begin
  -- Callers may tighten the demo limits but cannot raise the product's hard caps.
  if p_per_client_limit is null or p_per_client_limit not between 1 and 2
     or p_global_limit is null or p_global_limit not between 1 and 100 then
    raise exception 'BAD_REQUEST: invalid demo purchase limits';
  end if;

  -- One global transaction lock covers the read/count/insert boundary across all
  -- sessions; separate per-client locks would permit global-cap oversubscription.
  perform pg_advisory_xact_lock(hashtextextended('mediapack:demo-buyer:reservation:v1', 0));
  reserved_at := clock_timestamp();

  perform 1 from clients where id = p_client and not revoked and expires_at > reserved_at;
  if not found then raise exception 'UNAUTHORIZED'; end if;
  select * into j from jobs where id = p_job and client_id = p_client for update;
  if not found then raise exception 'UNAUTHORIZED'; end if;

  -- Merchant state remains authoritative. Never mint when a normal purchase is
  -- already paid or its outcome is being reconciled, even without a demo row.
  if j.paid_at is not null then
    return query select 'existing'::text, 'paid'::text; return;
  end if;
  perform 1 from payment_attempts where job_id = p_job and state in ('submitting', 'unknown', 'succeeded');
  if found then
    return query select 'existing'::text, 'reconciling'::text; return;
  end if;

  select state into existing_state from demo_purchases where quote_id = j.quote_id;
  if found then
    return query select 'existing'::text, existing_state; return;
  end if;

  select * into q from quotes where id = j.quote_id;
  select * into v from videos where id = j.video_id and client_id = p_client;
  if not found or q.video_id is distinct from j.video_id or v.state <> 'ready'
     or v.sha256 is null or q.source_sha256 is distinct from v.sha256 then
    raise exception 'VIDEO_NOT_READY';
  end if;
  if q.payment_mode <> 'test' or q.currency <> 'usd' or q.amount_minor <> 50 then
    raise exception 'BAD_REQUEST: demo purchase requires a USD 0.50 test quote';
  end if;
  if q.expires_at <= reserved_at then raise exception 'QUOTE_EXPIRED'; end if;

  if (select count(*) from demo_purchases
      where client_id = p_client and created_at > reserved_at - interval '24 hours') >= p_per_client_limit then
    return query select 'limited'::text, 'client_limit'::text; return;
  end if;
  if (select count(*) from demo_purchases
      where created_at > reserved_at - interval '24 hours') >= p_global_limit then
    return query select 'limited'::text, 'global_limit'::text; return;
  end if;

  insert into demo_purchases (quote_id, job_id, client_id, created_at, updated_at)
  values (j.quote_id, p_job, p_client, reserved_at, reserved_at);
  return query select 'reserved'::text, 'reserved'::text;
end $$;

create function mark_demo_purchase(p_quote uuid, p_state text) returns void language plpgsql as $$
declare previous_state text;
begin
  if p_state is null or p_state not in ('token_issued', 'succeeded', 'unknown', 'failed') then
    raise exception 'BAD_REQUEST: invalid demo purchase state';
  end if;
  select state into previous_state from demo_purchases where quote_id = p_quote for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if previous_state = p_state then return; end if;
  if previous_state in ('succeeded', 'failed')
     or (previous_state = 'unknown' and p_state = 'token_issued') then
    raise exception 'IDEMPOTENCY_CONFLICT: demo reservation cannot be reopened';
  end if;
  update demo_purchases set state = p_state, updated_at = clock_timestamp() where quote_id = p_quote;
end $$;

revoke all on function reserve_demo_purchase(uuid, uuid, int, int) from public, anon, authenticated;
revoke all on function mark_demo_purchase(uuid, text) from public, anon, authenticated;
grant execute on function reserve_demo_purchase(uuid, uuid, int, int) to service_role;
grant execute on function mark_demo_purchase(uuid, text) to service_role;
