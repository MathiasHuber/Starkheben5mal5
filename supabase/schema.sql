-- Starkheben 5×5: database setup for Supabase.
-- Paste this whole file into Supabase → SQL Editor → New query, put your and your partner's
-- Google email addresses in the INSERT below, then press Run. Running it again is safe.

-- Who may use the app. Only these Google accounts can read or write anything.
create table if not exists public.members (
  email text primary key
);
insert into public.members (email) values
  ('your.email@gmail.com'),
  ('your.partner@gmail.com')
on conflict do nothing;

-- One row per person: settings, working weights, schedule and any workout in progress (doc),
-- plus the name and picture from their Google account for the Crew tab.
create table if not exists public.athletes (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  doc jsonb not null,
  name text not null default '',
  avatar_url text not null default '',
  updated_at timestamptz not null default now()
);

-- One row per finished workout.
create table if not exists public.sessions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  data jsonb not null,
  primary key (user_id, id)
);

-- True when the signed-in Google account is on the member list.
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.members
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
grant execute on function public.is_member() to authenticated;

-- Row level security: members read everyone's data and write only their own.
alter table public.members enable row level security;  -- no policies: not readable from the app
alter table public.athletes enable row level security;
alter table public.sessions enable row level security;

drop policy if exists "members read athletes" on public.athletes;
drop policy if exists "members write own athlete" on public.athletes;
drop policy if exists "members update own athlete" on public.athletes;
drop policy if exists "members delete own athlete" on public.athletes;
create policy "members read athletes" on public.athletes
  for select to authenticated using (public.is_member());
create policy "members write own athlete" on public.athletes
  for insert to authenticated with check (user_id = auth.uid() and public.is_member());
create policy "members update own athlete" on public.athletes
  for update to authenticated using (user_id = auth.uid() and public.is_member())
  with check (user_id = auth.uid() and public.is_member());
create policy "members delete own athlete" on public.athletes
  for delete to authenticated using (user_id = auth.uid() and public.is_member());

drop policy if exists "members read sessions" on public.sessions;
drop policy if exists "members write own sessions" on public.sessions;
drop policy if exists "members update own sessions" on public.sessions;
drop policy if exists "members delete own sessions" on public.sessions;
create policy "members read sessions" on public.sessions
  for select to authenticated using (public.is_member());
create policy "members write own sessions" on public.sessions
  for insert to authenticated with check (user_id = auth.uid() and public.is_member());
create policy "members update own sessions" on public.sessions
  for update to authenticated using (user_id = auth.uid() and public.is_member())
  with check (user_id = auth.uid() and public.is_member());
create policy "members delete own sessions" on public.sessions
  for delete to authenticated using (user_id = auth.uid() and public.is_member());

-- Live updates between devices and between crew members.
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'athletes') then
    alter publication supabase_realtime add table public.athletes;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'sessions') then
    alter publication supabase_realtime add table public.sessions;
  end if;
end $$;
