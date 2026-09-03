begin;

do $$
declare
  v_job record;
begin
  for v_job in
    select jobid
    from cron.job
    where jobname = 'inbound-sync-superset-5m'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'inbound-sync-superset-30m',
  '*/30 * * * *',
  $$
    select net.http_post(
      url := 'https://qiafoaoslnbmtsbnmqou.supabase.co/functions/v1/sync-superset',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'inbound_sync_secret'
          order by created_at desc limit 1
        )
      ),
      body := jsonb_build_object('scheduled_at', now())
    );
  $$
);

commit;
