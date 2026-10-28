-- Switch from intraday bracket trades (take-profit/stop, signal "agents",
-- paper exploration) to strategy-based trend trades.
--
-- Resets the paper account: its only content was one simulated exploration
-- trade from the retired intraday strategy. Live data is untouched (there is none).

delete from public.positions where mode = 'paper';
delete from public.trades where mode = 'paper';
delete from public.bot_state where mode = 'paper';

alter table public.positions
  drop column take_profit_price,
  drop column agents,
  drop column exploration,
  add column strategy text not null;

alter table public.trades
  drop column agents,
  drop column exploration,
  add column strategy text not null;
