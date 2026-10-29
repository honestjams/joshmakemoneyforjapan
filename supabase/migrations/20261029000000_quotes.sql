-- Research data: CoinJar bid/ask alongside the Binance reference price in AUD,
-- saved every run, for testing whether CoinJar lags global prices.
create table public.quotes (
  id bigint generated always as identity primary key,
  at timestamptz not null,
  product_id text not null,
  bid numeric not null,
  ask numeric not null,
  last numeric not null,
  reference_aud numeric
);
create index quotes_product_at_idx on public.quotes (product_id, at);
alter table public.quotes enable row level security;

-- Keep 90 days.
select cron.schedule('trading-bot-prune-quotes', '23 3 * * *', $$ delete from public.quotes where at < now() - interval '90 days' $$);
