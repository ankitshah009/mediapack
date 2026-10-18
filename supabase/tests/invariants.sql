-- Invariant tests for 0001_init.sql. Run against a scratch database (see scripts/test-db.sh).
\set ON_ERROR_STOP 1
\set QUIET 1

create or replace function assert(cond boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'ASSERT FAILED: %', msg; end if; raise notice 'ok  %', msg; end $$;

create or replace function expect_error(sql text, code text, msg text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'ASSERT FAILED: % (no error raised, wanted %)', msg, code;
exception when others then
  if sqlerrm not like code || '%' then raise exception 'ASSERT FAILED: % (got %, wanted %)', msg, sqlerrm, code; end if;
  raise notice 'ok  %', msg;
end $$;

insert into clients (id, capability_hash, expires_at) values
  ('11111111-1111-1111-1111-111111111111', 'h1', now() + interval '48 hours'),
  ('22222222-2222-2222-2222-222222222222', 'h2', now() + interval '48 hours');
insert into videos (id, client_id, original_filename, object_key, declared_size_bytes, upload_expires_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'a.mp4', 'c1/v1/source.mp4', 1000, now() + interval '1 hour');

-- probe: idempotent, ownership-checked
select assert(enqueue_probe('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111') =
              enqueue_probe('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111'), 'repeat completion returns same probe');
select expect_error($$select enqueue_probe('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222')$$,
                    'UNAUTHORIZED', 'other client cannot complete my upload');
select assert((select count(*) from outbox where action = 'probe_video') = 1, 'one probe work request queued');

-- quote before ready is refused
select expect_error($$select * from create_quote_and_job('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
  '{"source_sha256":"x"}')$$, 'VIDEO_NOT_READY', 'unready video cannot be quoted');

-- probe result accepted
select assert(complete_operation((select id from operations where kind='probe_video'), 1,
  '{"accepted":true,"sha256":"abc","size_bytes":1000,"duration_ms":53120,"width":1280,"height":800,"rotation":0,"audio":"absent"}', '{}') = 'completed', 'probe completes');
select assert((select state from videos) = 'ready', 'video ready after probe');

create temp table t as select * from create_quote_and_job('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001',
  '{"source_sha256":"abc","amount_minor":50,"currency":"usd","payment_mode":"test","limits":{"searches":3,"frames":8,"clip_ms":15000,"text_chars":8000},
    "pack_ttl_seconds":86400,"indexer_version":"video-index-v1","terms_hash":"T1","expires_at":"2099-01-01T00:00:00Z"}');
select expect_error($$update quotes set amount_minor = 99$$, 'IMMUTABLE', 'quotes are immutable');

-- payment gate
select assert((select outcome from reserve_payment_attempt('11111111-1111-1111-1111-111111111111',(select job_id from t),'T1','fp')) = 'reserved', 'first attempt reserved');
select assert((select outcome from reserve_payment_attempt('11111111-1111-1111-1111-111111111111',(select job_id from t),'T1','fp')) = 'reconciling', 'concurrent attempt → reconciling, no second charge');
select expect_error($$select * from reserve_payment_attempt('22222222-2222-2222-2222-222222222222',(select job_id from t),'T1','fp')$$, 'UNAUTHORIZED', 'other client cannot buy my job');
select expect_error($$insert into payment_attempts (job_id,state,terms_hash,source) select job_id,'submitting','T1','mpp' from t$$, 'duplicate key', 'unique index forbids two live attempts');

-- crash recovery: attempt stuck "unknown", webhook applies the payment
select settle_payment_attempt((select id from payment_attempts), 'unknown', 'timeout', null);
select expect_error($$select * from apply_verified_payment((select job_id from t), null, 'pi_1', 50, 'usd', true)$$, 'PAYMENT_MISMATCH', 'live payment rejected for test quote');
select expect_error($$select * from apply_verified_payment((select job_id from t), null, 'pi_1', 49, 'usd', false)$$, 'PAYMENT_MISMATCH', 'wrong amount rejected');
select assert((select outcome from apply_verified_payment((select job_id from t), null, 'pi_1', 50, 'usd', false)) = 'applied', 'webhook applies verified payment');
select assert((select outcome from apply_verified_payment((select job_id from t), null, 'pi_1', 50, 'usd', false)) = 'already_applied', 'duplicate webhook harmless');
select expect_error($$select * from apply_verified_payment((select job_id from t), null, 'pi_2', 50, 'usd', false)$$, 'JOB_PAID_BY_OTHER_PAYMENT', 'second PaymentIntent cannot re-pay');
select assert((select count(*) from operations where kind='index_video') = 1, 'exactly one index operation');
select assert((select count(*) from outbox where action='index_video') = 1, 'exactly one index outbox message');
select assert((select state from payment_attempts) = 'succeeded', 'stuck attempt resolved to succeeded');
select assert((select outcome from reserve_payment_attempt('11111111-1111-1111-1111-111111111111',(select job_id from t),'T1','fp')) = 'paid', 'paid job never re-challenges');

-- search before index ready is refused
select expect_error($$select * from reserve_operation('11111111-1111-1111-1111-111111111111',(select job_id from t),'search_video',
  gen_random_uuid(),'{}','h',1,0,0,500)$$, 'INDEX_NOT_READY', 'search waits for index');

-- worker: claim, stale generation, completion
select assert(claim_operation((select id from operations where kind='index_video'), 1, 'sbx', 'proc', 600), 'index claimed');
select assert(not claim_operation((select id from operations where kind='index_video'), 1, 'sbx', 'proc2', 600), 'double launch refused');
select assert(complete_operation((select id from operations where kind='index_video'), 2, '{}', '{}') = 'stale', 'wrong generation cannot win');
select assert(complete_operation((select id from operations where kind='index_video'), 1, '{"index_artifact_id":null}', '{}') = 'completed', 'index completes');
select assert((select state from jobs) = 'ready', 'job ready');

-- allowance + idempotency
create temp table s1 as select * from reserve_operation('11111111-1111-1111-1111-111111111111',(select job_id from t),'search_video',
  '00000000-0000-0000-0000-0000000000a1','{"q":"x"}','hx',1,0,0,2000);
select assert((select created from s1), 'search reserved');
select assert((select operation_id from reserve_operation('11111111-1111-1111-1111-111111111111',(select job_id from t),'search_video',
  '00000000-0000-0000-0000-0000000000a1','{"q":"x"}','hx',1,0,0,2000)) = (select operation_id from s1), 'identical retry returns same operation');
select expect_error($$select * from reserve_operation('11111111-1111-1111-1111-111111111111',(select job_id from t),'search_video',
  '00000000-0000-0000-0000-0000000000a1','{"q":"y"}','hy',1,0,0,2000)$$, 'IDEMPOTENCY_CONFLICT', 'same request id, different input → conflict');
select expect_error($$select * from reserve_operation('11111111-1111-1111-1111-111111111111',(select job_id from t),'extract_frames',
  gen_random_uuid(),'{}','hf',0,9,0,0)$$, 'ALLOWANCE_EXCEEDED', '9 frames > 8 allowance');
select expect_error($$select * from reserve_operation('11111111-1111-1111-1111-111111111111',(select job_id from t),'extract_clip',
  gen_random_uuid(),'{}','hc',0,0,16000,0)$$, 'ALLOWANCE_EXCEEDED', '16s clip > 15s allowance');
select assert(claim_operation((select operation_id from s1), 1, 'sbx', 'p', 60), 'search claimed');
select expect_error($$select complete_operation((select operation_id from s1), 1, '{}', '{"searches":1,"text_chars":2001}')$$,
  'USAGE_EXCEEDS_RESERVATION', 'worker cannot overspend its reservation');
select assert(complete_operation((select operation_id from s1), 1, '{"matches":[]}', '{"searches":1,"text_chars":700}') = 'completed', 'search completes');
select assert(complete_operation((select operation_id from s1), 1, '{"matches":[]}', '{"searches":1,"text_chars":700}') = 'already_completed', 'duplicate result harmless');
select assert((select used_searches = 1 and used_text_chars = 700 and reserved_searches = 0 and reserved_text_chars = 0 from jobs), 'ledger: used 1 search / 700 chars, reservations released');

-- failure: one retry then terminal, reservation released
create temp table c1 as select * from reserve_operation('11111111-1111-1111-1111-111111111111',(select job_id from t),'extract_clip',
  gen_random_uuid(),'{}','hc2',0,0,12000,0);
select claim_operation((select operation_id from c1), 1, 's', 'p', 60);
select assert(fail_or_retry_operation((select operation_id from c1), 1, 'WORKER_FAILED', 'x', true) = 'retrying', 'first failure retries');
select assert((select count(*) from outbox where operation_id = (select operation_id from c1)) = 2, 'retry queued a new generation message');
select claim_operation((select operation_id from c1), 2, 's', 'p', 60);
select assert(fail_or_retry_operation((select operation_id from c1), 2, 'WORKER_FAILED', 'x', true) = 'failed', 'second failure terminal');
select assert((select reserved_clip_ms from jobs) = 0, 'clip reservation released on terminal failure');

-- outbox claim is exclusive
select assert((select count(*) from claim_outbox_batch(100, 30)) >= 1, 'outbox batch claimed');
select assert((select count(*) from claim_outbox_batch(100, 30)) = 0, 'leased messages not double-claimed');

\echo ALL INVARIANTS PASSED
