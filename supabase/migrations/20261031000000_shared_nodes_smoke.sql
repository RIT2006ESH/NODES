-- Canonical NODES + Smoke Room schema.
-- Review preflight_duplicate_report.sql before applying.
-- This migration never renames or deletes records.
--
-- NODES and Smoke write through backend service credentials. NODES Ed25519
-- tokens are not assumed to be Supabase Auth JWTs; browser writes remain
-- denied by omission of INSERT/UPDATE/DELETE policies.

create extension if not exists pgcrypto;

create table if not exists public.player_profiles (
  node_id text primary key,
  username text not null,
  username_normalized text generated always as (lower(btrim(username))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint player_profiles_username_format
    check (
      username = btrim(username)
      and username ~ '^[A-Za-z0-9_]{3,20}$'
    )
);

alter table public.player_profiles
  add column if not exists username_normalized text
    generated always as (lower(btrim(username))) stored;

create unique index if not exists player_profiles_username_normalized_key
  on public.player_profiles (username_normalized);

create table if not exists public.teams (
  team_id text primary key,
  mesh_id text not null unique,
  team_name text not null,
  team_name_normalized text generated always as (
    lower(regexp_replace(btrim(team_name), '\s+', ' ', 'g'))
  ) stored,
  description text,
  leader_node_id text,
  room_id text not null unique,
  status text not null default 'active',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint teams_name_format
    check (
      char_length(regexp_replace(btrim(team_name), '\s+', ' ', 'g'))
        between 3 and 24
      and char_length(btrim(team_name)) > 0
    ),
  constraint teams_status_format check (status in ('active', 'archived'))
);

alter table public.teams
  add column if not exists archived_at timestamptz;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.teams'::regclass
      and conname = 'teams_name_format'
  ) then
    alter table public.teams drop constraint teams_name_format;
  end if;
  alter table public.teams add constraint teams_name_format
    check (
      char_length(regexp_replace(btrim(team_name), '\s+', ' ', 'g'))
        between 3 and 24
      and char_length(btrim(team_name)) > 0
    );
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.teams'::regclass
      and conname = 'teams_status_format'
  ) then
    alter table public.teams add constraint teams_status_format
      check (status in ('active', 'archived'));
  end if;
end
$$;

alter table public.teams
  add column if not exists team_name_normalized text
    generated always as (lower(regexp_replace(btrim(team_name), '\s+', ' ', 'g'))) stored;

create unique index if not exists teams_team_name_normalized_key
  on public.teams (team_name_normalized);

create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id text not null,
  node_id text not null,
  role text not null check (role in ('leader', 'member')),
  joined_at timestamptz not null default now(),
  status text not null default 'active',
  unique (team_id, node_id),
  constraint team_members_status_format
    check (status in ('active', 'removed', 'revoked'))
);

create table if not exists public.smoke_rooms (
  room_id text primary key,
  team_id text not null unique,
  status text not null default 'active',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  constraint smoke_rooms_status_format check (status in ('active', 'archived')),
  constraint smoke_rooms_team_room_key unique (team_id, room_id)
);

alter table public.smoke_rooms
  add column if not exists archived_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.smoke_rooms'::regclass
      and conname = 'smoke_rooms_status_format'
  ) then
    alter table public.smoke_rooms add constraint smoke_rooms_status_format
      check (status in ('active', 'archived'));
  end if;
end
$$;

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id text not null,
  node_id text not null,
  message_text text not null check (char_length(message_text) between 1 and 140),
  created_at timestamptz not null default now()
);

create index if not exists messages_room_created_key
  on public.messages (room_id, created_at);

create table if not exists public.room_events (
  event_id text primary key,
  room_id text not null,
  event_type text not null,
  node_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Named, deferrable relationships permit one transaction to create or change
-- a team, room, and membership without exposing an invalid committed state.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.teams'::regclass and conname = 'teams_leader_profile_fkey') then
    alter table public.teams
      add constraint teams_leader_profile_fkey
      foreign key (leader_node_id) references public.player_profiles(node_id)
      on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.team_members'::regclass and conname = 'team_members_team_fkey') then
    alter table public.team_members
      add constraint team_members_team_fkey
      foreign key (team_id) references public.teams(team_id)
      on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.team_members'::regclass and conname = 'team_members_profile_fkey') then
    alter table public.team_members
      add constraint team_members_profile_fkey
      foreign key (node_id) references public.player_profiles(node_id)
      on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.smoke_rooms'::regclass and conname = 'smoke_rooms_team_fkey') then
    alter table public.smoke_rooms
      add constraint smoke_rooms_team_fkey
      foreign key (team_id) references public.teams(team_id)
      on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.teams'::regclass and conname = 'teams_room_mapping_fkey') then
    alter table public.teams
      add constraint teams_room_mapping_fkey
      foreign key (team_id, room_id)
      references public.smoke_rooms(team_id, room_id)
      on delete restrict
      deferrable initially deferred;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.messages'::regclass and conname = 'messages_room_fkey') then
    alter table public.messages
      add constraint messages_room_fkey
      foreign key (room_id) references public.smoke_rooms(room_id)
      on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.messages'::regclass and conname = 'messages_profile_fkey') then
    alter table public.messages
      add constraint messages_profile_fkey
      foreign key (node_id) references public.player_profiles(node_id)
      on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.room_events'::regclass and conname = 'room_events_room_fkey') then
    alter table public.room_events
      add constraint room_events_room_fkey
      foreign key (room_id) references public.smoke_rooms(room_id)
      on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.room_events'::regclass and conname = 'room_events_profile_fkey') then
    alter table public.room_events
      add constraint room_events_profile_fkey
      foreign key (node_id) references public.player_profiles(node_id)
      on delete restrict;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.team_members'::regclass
      and conname = 'team_members_status_format'
  ) then
    alter table public.team_members add constraint team_members_status_format
      check (status in ('active', 'removed', 'revoked'));
  end if;
end
$$;

do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.teams'::regclass and conname = 'teams_leader_profile_fkey') then
    alter table public.teams alter constraint teams_leader_profile_fkey deferrable initially deferred;
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.team_members'::regclass and conname = 'team_members_team_fkey') then
    alter table public.team_members alter constraint team_members_team_fkey deferrable initially deferred;
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.team_members'::regclass and conname = 'team_members_profile_fkey') then
    alter table public.team_members alter constraint team_members_profile_fkey deferrable initially deferred;
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.smoke_rooms'::regclass and conname = 'smoke_rooms_team_fkey') then
    alter table public.smoke_rooms alter constraint smoke_rooms_team_fkey deferrable initially deferred;
  end if;
end
$$;

create unique index if not exists team_members_one_active_leader_key
  on public.team_members (team_id)
  where role = 'leader' and status = 'active';

create or replace function public.validate_active_team_integrity()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  affected_team text;
  leader_count integer;
  expected_leader text;
  team_leader text;
begin
  for affected_team in
    select distinct team_id
    from (
      select new.team_id as team_id where tg_op <> 'DELETE'
      union all
      select old.team_id as team_id where tg_op <> 'INSERT'
    ) affected
    where team_id is not null
  loop
    if not exists (
      select 1 from public.teams
      where team_id = affected_team and status = 'active'
    ) then
      continue;
    end if;

    select count(*)::integer, min(node_id)
      into leader_count, expected_leader
    from public.team_members
    where team_id = affected_team
      and role = 'leader'
      and status = 'active';

    select leader_node_id
      into team_leader
    from public.teams
    where team_id = affected_team
      and status = 'active';

    if team_leader is null or leader_count <> 1 or team_leader <> expected_leader then
      raise exception 'active team % must have exactly one matching active leader', affected_team
        using errcode = '23514';
    end if;
  end loop;
  return null;
end
$$;

drop trigger if exists team_members_leadership_integrity on public.team_members;
create constraint trigger team_members_leadership_integrity
after insert or update or delete on public.team_members
deferrable initially deferred
for each row execute function public.validate_active_team_integrity();

drop trigger if exists teams_leadership_integrity on public.teams;
create constraint trigger teams_leadership_integrity
after insert or update of leader_node_id, status on public.teams
deferrable initially deferred
for each row execute function public.validate_active_team_integrity();

create or replace function public.validate_team_name_input(p_team_name text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  normalized text := regexp_replace(btrim(coalesce(p_team_name, '')), '\s+', ' ', 'g');
begin
  if char_length(normalized) not between 3 and 24 then
    raise exception 'team name must be 3 to 24 normalized characters'
      using errcode = '22023';
  end if;
  return normalized;
end
$$;

create or replace function public.create_team_with_room(
  p_team_id text, p_mesh_id text, p_team_name text, p_room_id text,
  p_leader_node_id text, p_description text default null
)
returns public.teams
language plpgsql security definer set search_path = public
as $$
declare result public.teams;
begin
  if p_team_id is null or p_mesh_id is null or p_room_id is null
     or p_leader_node_id is null then
    raise exception 'team, mesh, room, and leader identifiers are required'
      using errcode = '22023';
  end if;
  perform 1 from public.player_profiles
    where node_id = p_leader_node_id for update;
  if not found then
    raise exception 'leader profile does not exist' using errcode = '23503';
  end if;
  select * into result from public.teams where team_id = p_team_id for update;
  if found then
    if result.mesh_id <> p_mesh_id or result.room_id <> p_room_id then
      raise exception 'stable team, mesh, or room identity mismatch'
        using errcode = '23514';
    end if;
    return result;
  end if;
  insert into public.teams (
    team_id, mesh_id, team_name, description, leader_node_id, room_id, status
  ) values (
    p_team_id, p_mesh_id, public.validate_team_name_input(p_team_name),
    p_description, p_leader_node_id, p_room_id, 'active'
  ) returning * into result;
  insert into public.smoke_rooms (room_id, team_id, status)
    values (p_room_id, p_team_id, 'active');
  insert into public.team_members (team_id, node_id, role, status)
    values (p_team_id, p_leader_node_id, 'leader', 'active');
  return result;
end
$$;

create or replace function public.add_team_member(p_team_id text, p_node_id text)
returns public.team_members
language plpgsql security definer set search_path = public
as $$
declare result public.team_members;
begin
  perform 1 from public.teams
    where team_id = p_team_id and status = 'active' for update;
  if not found then raise exception 'active team does not exist' using errcode = '23503'; end if;
  perform 1 from public.player_profiles where node_id = p_node_id for update;
  if not found then raise exception 'member profile does not exist' using errcode = '23503'; end if;
  insert into public.team_members (team_id, node_id, role, status)
    values (p_team_id, p_node_id, 'member', 'active')
  on conflict (team_id, node_id) do update
    set status = 'active',
        role = case when public.team_members.role = 'leader'
                    then 'leader' else 'member' end
  returning * into result;
  return result;
end
$$;

create or replace function public.transfer_team_leadership(
  p_team_id text, p_new_leader_node_id text
)
returns public.teams
language plpgsql security definer set search_path = public
as $$
declare result public.teams;
begin
  select * into result from public.teams
    where team_id = p_team_id and status = 'active' for update;
  if not found then raise exception 'active team does not exist' using errcode = '23503'; end if;
  perform 1 from public.team_members
    where team_id = p_team_id and node_id = p_new_leader_node_id
      and status = 'active' for update;
  if not found then raise exception 'new leader must be an active member' using errcode = '23503'; end if;
  update public.team_members set role = 'member'
    where team_id = p_team_id and role = 'leader' and status = 'active';
  update public.team_members set role = 'leader'
    where team_id = p_team_id and node_id = p_new_leader_node_id;
  update public.teams set leader_node_id = p_new_leader_node_id, updated_at = now()
    where team_id = p_team_id returning * into result;
  return result;
end
$$;

create or replace function public.remove_team_member(
  p_team_id text, p_node_id text, p_status text default 'removed'
)
returns public.team_members
language plpgsql security definer set search_path = public
as $$
declare result public.team_members;
begin
  if p_status not in ('removed', 'revoked') then
    raise exception 'invalid member removal status' using errcode = '22023';
  end if;
  perform 1 from public.teams where team_id = p_team_id for update;
  if not found then raise exception 'team does not exist' using errcode = '23503'; end if;
  select * into result from public.team_members
    where team_id = p_team_id and node_id = p_node_id for update;
  if not found then raise exception 'membership does not exist' using errcode = '23503'; end if;
  if result.role = 'leader' and result.status = 'active' then
    raise exception 'transfer leadership before removing the leader' using errcode = '23514';
  end if;
  update public.team_members set status = p_status
    where team_id = p_team_id and node_id = p_node_id returning * into result;
  return result;
end
$$;

create or replace function public.set_team_member_member(
  p_team_id text, p_node_id text
)
returns public.team_members
language plpgsql security definer set search_path = public
as $$
declare result public.team_members;
begin
  perform 1 from public.teams where team_id = p_team_id for update;
  if not found then raise exception 'team does not exist' using errcode = '23503'; end if;
  select * into result from public.team_members
    where team_id = p_team_id and node_id = p_node_id for update;
  if not found then raise exception 'membership does not exist' using errcode = '23503'; end if;
  if result.status = 'active' and result.role = 'leader' then
    raise exception 'transfer leadership before demoting the leader' using errcode = '23514';
  end if;
  update public.team_members set role = 'member'
    where team_id = p_team_id and node_id = p_node_id
    returning * into result;
  return result;
end
$$;

create or replace function public.archive_team(p_team_id text)
returns public.teams
language plpgsql security definer set search_path = public
as $$
declare result public.teams;
begin
  select * into result from public.teams where team_id = p_team_id for update;
  if not found then raise exception 'team does not exist' using errcode = '23503'; end if;
  update public.teams
    set status = 'archived', archived_at = coalesce(archived_at, now()), updated_at = now()
    where team_id = p_team_id returning * into result;
  update public.smoke_rooms
    set status = 'archived', archived_at = coalesce(archived_at, now())
    where team_id = p_team_id;
  update public.team_members
    set status = case when status = 'active' then 'removed' else status end
    where team_id = p_team_id;
  return result;
end
$$;

create or replace function public.rename_team(p_team_id text, p_team_name text)
returns public.teams
language plpgsql security definer set search_path = public
as $$
declare result public.teams;
begin
  perform 1 from public.teams where team_id = p_team_id for update;
  if not found then raise exception 'team does not exist' using errcode = '23503'; end if;
  update public.teams
    set team_name = public.validate_team_name_input(p_team_name), updated_at = now()
    where team_id = p_team_id returning * into result;
  return result;
end
$$;

revoke all on function public.create_team_with_room(text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.add_team_member(text,text) from public, anon, authenticated;
revoke all on function public.transfer_team_leadership(text,text) from public, anon, authenticated;
revoke all on function public.remove_team_member(text,text,text) from public, anon, authenticated;
revoke all on function public.set_team_member_member(text,text) from public, anon, authenticated;
revoke all on function public.archive_team(text) from public, anon, authenticated;
revoke all on function public.rename_team(text,text) from public, anon, authenticated;
grant execute on function public.create_team_with_room(text,text,text,text,text,text) to service_role;
grant execute on function public.add_team_member(text,text) to service_role;
grant execute on function public.transfer_team_leadership(text,text) to service_role;
grant execute on function public.remove_team_member(text,text,text) to service_role;
grant execute on function public.set_team_member_member(text,text) to service_role;
grant execute on function public.archive_team(text) to service_role;
grant execute on function public.rename_team(text,text) to service_role;

alter table public.player_profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.smoke_rooms enable row level security;
alter table public.messages enable row level security;
alter table public.room_events enable row level security;

drop policy if exists player_profiles_self_read on public.player_profiles;
create policy player_profiles_self_read on public.player_profiles
  for select to authenticated using (
    node_id = current_setting('request.jwt.claim.sub', true)
  );

drop policy if exists teams_member_read on public.teams;
create policy teams_member_read on public.teams
  for select to authenticated using (exists (
    select 1 from public.team_members m
    where m.team_id = teams.team_id
      and m.node_id = current_setting('request.jwt.claim.sub', true)
      and m.status = 'active'
  ));

drop policy if exists team_members_self_read on public.team_members;
create policy team_members_self_read on public.team_members
  for select to authenticated using (
    node_id = current_setting('request.jwt.claim.sub', true)
  );

drop policy if exists smoke_rooms_member_read on public.smoke_rooms;
create policy smoke_rooms_member_read on public.smoke_rooms
  for select to authenticated using (exists (
    select 1 from public.team_members m
    where m.team_id = smoke_rooms.team_id
      and m.node_id = current_setting('request.jwt.claim.sub', true)
      and m.status = 'active'
  ));

drop policy if exists messages_member_read on public.messages;
create policy messages_member_read on public.messages
  for select to authenticated using (exists (
    select 1
    from public.team_members m
    join public.teams t on t.team_id = m.team_id
    where t.room_id = messages.room_id
      and m.node_id = current_setting('request.jwt.claim.sub', true)
      and m.status = 'active'
  ));

drop policy if exists messages_member_insert on public.messages;
create policy messages_member_insert on public.messages
  for insert to authenticated with check (
    node_id = current_setting('request.jwt.claim.sub', true)
    and exists (
      select 1
      from public.team_members m
      join public.teams t on t.team_id = m.team_id
      where t.room_id = messages.room_id
        and m.node_id = current_setting('request.jwt.claim.sub', true)
        and m.status = 'active'
    )
  );
