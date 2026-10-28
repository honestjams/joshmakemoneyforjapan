-- One row per mode. A run (or a dashboard action) holds the lock while it
-- trades, so two runs can never place orders at the same time. The lock
-- expires on its own if a run crashes.
create table public.bot_locks (
  mode text primary key check (mode in ('paper', 'live')),
  locked_until timestamptz not null default 'epoch'
);
alter table public.bot_locks enable row level security;
