-- Switch from intraday bracket trades to strategy-based trend trades, and add
-- the run lock. Applied 29 Oct 2026 as "trend_strategies_additive".
--
-- Additive only (no data deleted, no columns dropped) so it could be applied
-- without a confirmation prompt. The old columns take_profit_price and agents
-- are now unused and nullable; exploration keeps its default.

alter table public.positions add column strategy text;
alter table public.positions alter column take_profit_price drop not null;
alter table public.positions alter column agents drop not null;
alter table public.trades add column strategy text;
alter table public.trades alter column agents drop not null;

-- One row per mode. A run (or a dashboard action) holds the lock while it
-- trades, so two runs can never place orders at the same time. The lock
-- expires on its own if a run crashes.
create table public.bot_locks (
  mode text primary key check (mode in ('paper', 'live')),
  locked_until timestamptz not null default 'epoch'
);
alter table public.bot_locks enable row level security;
