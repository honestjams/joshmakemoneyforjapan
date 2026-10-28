-- Runs the bot every 5 minutes by calling the Vercel endpoint.
--
-- Why Supabase and not Vercel Cron: on Vercel's free (Hobby) plan cron jobs
-- can only run once a day. pg_cron on Supabase's free plan can run every minute.
--
-- Applied to the trading-bot project on 28 Oct 2026 (migration "scheduler").
-- The secret lives in Supabase Vault, not in the job; create it once with the
-- vault.create_secret line below, using the same value as CRON_SECRET in Vercel.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- select vault.create_secret('<SAME VALUE AS CRON_SECRET IN VERCEL>', 'trading_bot_cron_secret');

select cron.schedule(
  'trading-bot-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://joshmakemoneyforjapan.vercel.app/api/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'trading_bot_cron_secret'), '')
    ),
    timeout_milliseconds := 55000
  );
  $$
);

-- Keep two weeks of run logs.
select cron.schedule(
  'trading-bot-prune-runs',
  '17 3 * * *',
  $$ delete from public.runs where at < now() - interval '14 days' $$
);

-- To pause the bot:   select cron.unschedule('trading-bot-tick');
-- To see recent calls: select * from net._http_response order by created desc limit 10;
