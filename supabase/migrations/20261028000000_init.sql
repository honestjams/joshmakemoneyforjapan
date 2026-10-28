-- Trading bot schema. Only the server (service-role key) reads or writes these
-- tables: RLS is on with no policies, so the public anon key can't touch them.

create table public.bot_state (
  mode text primary key check (mode in ('paper', 'live')),
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.positions (
  id uuid primary key,
  mode text not null check (mode in ('paper', 'live')),
  product_id text not null,
  size numeric not null,
  entry_price numeric not null,
  stop_price numeric not null,
  take_profit_price numeric not null,
  entry_fee numeric not null,
  opened_at timestamptz not null,
  stop_order_id text,
  win_probability numeric not null,
  expected_value_pct numeric not null,
  agents text[] not null,
  jev_probability numeric,
  exploration boolean not null default false
);
create index positions_mode_idx on public.positions (mode, opened_at);

create table public.trades (
  id bigint generated always as identity primary key,
  mode text not null check (mode in ('paper', 'live')),
  position_id uuid not null,
  product_id text not null,
  size numeric not null,
  entry_price numeric not null,
  exit_price numeric not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null,
  fees numeric not null,
  pnl numeric not null,
  exit_reason text not null,
  win_probability numeric not null,
  expected_value_pct numeric not null,
  agents text[] not null,
  jev_probability numeric,
  exploration boolean not null default false
);
create index trades_mode_closed_idx on public.trades (mode, closed_at desc);

-- Written by Claude during a "knowledge update" chat; the bot reads the newest row.
create table public.knowledge_briefs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  market_bias numeric not null check (market_bias between -1 and 1),
  product_bias jsonb not null default '{}'::jsonb,
  pause_trading boolean not null default false,
  risk_events jsonb not null default '[]'::jsonb,
  summary text not null,
  sources jsonb not null default '[]'::jsonb
);

create table public.runs (
  id bigint generated always as identity primary key,
  at timestamptz not null,
  mode text not null,
  equity numeric not null,
  cash numeric not null,
  actions jsonb not null,
  error text
);
create index runs_at_idx on public.runs (at desc);

alter table public.bot_state enable row level security;
alter table public.positions enable row level security;
alter table public.trades enable row level security;
alter table public.knowledge_briefs enable row level security;
alter table public.runs enable row level security;
