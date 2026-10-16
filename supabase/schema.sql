-- Starkheben 5×5: database setup for Supabase.
-- Paste this whole file into Supabase → SQL Editor → New query and press Run. Running it again is safe.
--
-- Accounts are a username and a password (stored as a bcrypt hash). Signing in returns a random
-- token that the app keeps on the device. The app reaches the data only through the crew_* functions
-- below: everyone signed in reads everyone's data, and each person writes only their own.

create extension if not exists pgcrypto with schema extensions;

-- Leftovers from the Google sign-in draft, if that script was run (those tables never held data).
drop table if exists public.sessions, public.athletes, public.members cascade;
drop function if exists public.is_member();

create table if not exists public.crew_accounts (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9_.-]{3,20}$'),
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.crew_tokens (
  token text primary key,
  account_id uuid not null references public.crew_accounts (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Settings, working weights, schedule and any workout in progress.
create table if not exists public.crew_athletes (
  account_id uuid primary key references public.crew_accounts (id) on delete cascade,
  doc jsonb not null,
  updated_at timestamptz not null default now()
);

-- One row per finished workout.
create table if not exists public.crew_sessions (
  account_id uuid not null references public.crew_accounts (id) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  data jsonb not null,
  primary key (account_id, id)
);

-- No direct table access from the app: only the functions below.
alter table public.crew_accounts enable row level security;
alter table public.crew_tokens enable row level security;
alter table public.crew_athletes enable row level security;
alter table public.crew_sessions enable row level security;
revoke all on public.crew_accounts, public.crew_tokens, public.crew_athletes, public.crew_sessions from anon, authenticated;

-- The account a token belongs to (internal).
create or replace function public.crew_account(p_token text) returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare a uuid;
begin
  select account_id into a from crew_tokens where token = p_token;
  if a is null then raise exception 'invalid_token'; end if;
  return a;
end $$;
revoke execute on function public.crew_account(text) from public, anon, authenticated;

create or replace function public.crew_new_token(p_account uuid) returns text
language sql volatile security definer set search_path = public, extensions
as $$
  insert into crew_tokens (token, account_id) values (encode(gen_random_bytes(24), 'hex'), p_account) returning token;
$$;
revoke execute on function public.crew_new_token(uuid) from public, anon, authenticated;

create or replace function public.crew_register(p_username text, p_password text) returns json
language plpgsql security definer set search_path = public, extensions
as $$
declare
  u text := lower(trim(coalesce(p_username, '')));
  a uuid;
begin
  if u !~ '^[a-z0-9_.-]{3,20}$' then raise exception 'invalid_username'; end if;
  if length(coalesce(p_password, '')) < 4 then raise exception 'password_too_short'; end if;
  if (select count(*) from crew_accounts) >= 20 then raise exception 'crew_full'; end if;
  insert into crew_accounts (username, password_hash) values (u, crypt(p_password, gen_salt('bf')))
    on conflict (username) do nothing
    returning id into a;
  if a is null then raise exception 'username_taken'; end if;
  return json_build_object('token', crew_new_token(a), 'id', a, 'username', u);
end $$;

create or replace function public.crew_login(p_username text, p_password text) returns json
language plpgsql security definer set search_path = public, extensions
as $$
declare r crew_accounts;
begin
  select * into r from crew_accounts where username = lower(trim(coalesce(p_username, '')));
  if r.id is null or r.password_hash <> crypt(coalesce(p_password, ''), r.password_hash) then
    raise exception 'invalid_login';
  end if;
  return json_build_object('token', crew_new_token(r.id), 'id', r.id, 'username', r.username);
end $$;

create or replace function public.crew_logout(p_token text) returns void
language sql security definer set search_path = public
as $$ delete from crew_tokens where token = p_token; $$;

-- Everyone's settings and weights, plus the ids of everyone's workouts (bodies via crew_get_sessions).
create or replace function public.crew_state(p_token text) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := crew_account(p_token);
begin
  return json_build_object(
    'me', (select json_build_object('id', id, 'username', username) from crew_accounts where id = me),
    'athletes', coalesce((
      select json_agg(json_build_object('id', a.id, 'username', a.username, 'doc', t.doc) order by a.created_at)
      from crew_accounts a left join crew_athletes t on t.account_id = a.id), '[]'::json),
    'sessions', coalesce((
      select json_agg(json_build_object('account', account_id, 'ids', ids))
      from (select account_id, json_agg(id order by id) as ids from crew_sessions group by account_id) s), '[]'::json)
  );
end $$;

create or replace function public.crew_get_sessions(p_token text, p_account uuid, p_ids text[]) returns json
language plpgsql stable security definer set search_path = public
as $$
begin
  perform crew_account(p_token);
  return coalesce((select json_agg(data) from crew_sessions where account_id = p_account and id = any (p_ids)), '[]'::json);
end $$;

create or replace function public.crew_save_doc(p_token text, p_doc jsonb) returns void
language plpgsql security definer set search_path = public
as $$
declare me uuid := crew_account(p_token);
begin
  if jsonb_typeof(p_doc) <> 'object' or pg_column_size(p_doc) > 262144 then raise exception 'invalid_doc'; end if;
  insert into crew_athletes (account_id, doc, updated_at) values (me, p_doc, now())
    on conflict (account_id) do update set doc = excluded.doc, updated_at = now();
end $$;

create or replace function public.crew_save_session(p_token text, p_session jsonb) returns void
language plpgsql security definer set search_path = public
as $$
declare me uuid := crew_account(p_token);
begin
  if jsonb_typeof(p_session) <> 'object' or pg_column_size(p_session) > 262144 then raise exception 'invalid_session'; end if;
  insert into crew_sessions (account_id, id, data) values (me, p_session ->> 'id', p_session)
    on conflict (account_id, id) do update set data = excluded.data;
end $$;

create or replace function public.crew_delete_session(p_token text, p_id text) returns void
language plpgsql security definer set search_path = public
as $$
declare me uuid := crew_account(p_token);
begin
  delete from crew_sessions where account_id = me and id = p_id;
end $$;

grant execute on function
  public.crew_register(text, text), public.crew_login(text, text), public.crew_logout(text),
  public.crew_state(text), public.crew_get_sessions(text, uuid, text[]),
  public.crew_save_doc(text, jsonb), public.crew_save_session(text, jsonb), public.crew_delete_session(text, text)
to anon, authenticated;

-- Tell Supabase's API to pick up the new functions right away.
notify pgrst, 'reload schema';
