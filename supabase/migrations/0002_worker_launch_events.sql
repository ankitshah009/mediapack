-- A lease claim does not prove that the provider created a worker process.
-- Preserve the existing claim/fencing behavior and function execution privileges.
create or replace function claim_operation(p_op uuid, p_generation int, p_sandbox text, p_process text, p_lease_seconds int)
returns boolean language plpgsql as $$
declare op operations%rowtype;
begin
  select * into op from operations where id = p_op for update;
  if not found or op.generation <> p_generation or op.state in ('succeeded', 'failed') then return false; end if;
  if op.state = 'running' and op.lease_expires_at > now() then return false; end if;
  update operations set state = 'running', attempts = attempts + 1, sandbox_name = p_sandbox, process_name = p_process,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = p_op;
  perform app_event(op.video_id, op.job_id, op.id, 'worker.claimed',
    jsonb_build_object('kind', op.kind, 'sandbox', p_sandbox, 'process', p_process, 'generation', p_generation));
  return true;
end $$;
