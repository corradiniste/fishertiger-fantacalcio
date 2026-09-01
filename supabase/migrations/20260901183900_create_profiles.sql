-- Saved league profiles for the local advisor API (direct Postgres; no Auth).
-- RLS enabled with no anon/authenticated policies → public Data API denied.
-- Direct postgres / service_role connections bypass RLS.

create table public.profiles (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
