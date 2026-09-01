-- Generated auction/simulation JSON and binary source files for the local advisor API.
-- RLS enabled with no anon/authenticated policies → public Data API denied.
-- Direct postgres connections bypass RLS.

create table public.datasets (
  path text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.datasets enable row level security;

create table public.blobs (
  path text primary key,
  content bytea not null,
  content_type text not null default 'application/octet-stream',
  byte_size integer not null check (byte_size >= 0),
  updated_at timestamptz not null default now()
);

alter table public.blobs enable row level security;
