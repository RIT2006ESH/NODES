-- Migration: 20261031010000_remote_idempotency_ledger.sql
-- Description: Server-side operation ledger and idempotent RPC wrappers for remote synchronization.
--
-- DO NOT APPLY AUTOMATICALLY. This migration is proposed for Phase 5.2B review.
--
-- Rollback Strategy:
--   See the rollback script section at the bottom of this file.

-- 1. Create Operation Ledger Table
create table if not exists public.operation_ledger (
  operation_id text primary key,
  operation_type text not null,
  payload_hash text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'failed')),
  response_payload jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_operation_ledger_type_created
  on public.operation_ledger(operation_type, created_at);

-- Restrictive RLS on operation_ledger
alter table public.operation_ledger enable row level security;
revoke all on public.operation_ledger from public, anon, authenticated;
grant select, insert, update on public.operation_ledger to service_role;

-- 2. Add optimistic version column to teams for out-of-order protection
alter table public.teams
  add column if not exists version integer not null default 1;

-- 3. Cryptographic hash helper for stable payload hashing
create or replace function public.compute_payload_hash(p_payload jsonb)
returns text
language plpgsql
immutable
set search_path = public, extensions
as $$
begin
  return encode(digest(coalesce(p_payload::text, ''), 'sha256'), 'hex');
end;
$$;

-- 4. Idempotency Lifecycle Helpers
create or replace function public.begin_idempotent_op(
  p_op_id text,
  p_op_type text,
  p_payload jsonb,
  out p_is_completed boolean,
  out p_cached_response jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text;
  v_rec record;
begin
  if p_op_id is null then
    p_is_completed := false;
    p_cached_response := null;
    return;
  end if;

  v_hash := public.compute_payload_hash(p_payload);

  -- Insert 'in_progress' record or keep existing
  insert into public.operation_ledger (
    operation_id, operation_type, payload_hash, status, created_at
  ) values (
    p_op_id, p_op_type, v_hash, 'in_progress', now()
  ) on conflict (operation_id) do nothing;

  -- Lock row for update to sequence concurrent identical requests
  select * into v_rec
  from public.operation_ledger
  where operation_id = p_op_id
  for update;

  if v_rec.payload_hash <> v_hash then
    raise exception 'operation ID % already used with different payload', p_op_id
      using errcode = '23505';
  end if;

  if v_rec.status = 'completed' then
    p_is_completed := true;
    p_cached_response := v_rec.response_payload;
    return;
  end if;

  p_is_completed := false;
  p_cached_response := null;
end;
$$;

create or replace function public.complete_idempotent_op(
  p_op_id text,
  p_response jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_op_id is not null then
    update public.operation_ledger
    set status = 'completed',
        response_payload = p_response,
        completed_at = now()
    where operation_id = p_op_id;
  end if;
end;
$$;

-- 5. Updated RPC: create_team_with_room
drop function if exists public.create_team_with_room(text,text,text,text,text,text);
create or replace function public.create_team_with_room(
  p_team_id text, p_mesh_id text, p_team_name text, p_room_id text,
  p_leader_node_id text, p_description text default null,
  p_op_id text default null
)
returns public.teams
language plpgsql security definer set search_path = public
as $$
declare
  v_is_done boolean;
  v_cached jsonb;
  result public.teams;
begin
  select p_is_completed, p_cached_response into v_is_done, v_cached
  from public.begin_idempotent_op(
    p_op_id,
    'create_team_with_room',
    jsonb_build_object('team_id', p_team_id, 'mesh_id', p_mesh_id, 'team_name', p_team_name, 'room_id', p_room_id, 'leader_node_id', p_leader_node_id)
  );

  if v_is_done then
    return jsonb_populate_record(null::public.teams, v_cached);
  end if;

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
    perform public.complete_idempotent_op(p_op_id, to_jsonb(result));
    return result;
  end if;
  insert into public.teams (
    team_id, mesh_id, team_name, description, leader_node_id, room_id, status, version
  ) values (
    p_team_id, p_mesh_id, public.validate_team_name_input(p_team_name),
    p_description, p_leader_node_id, p_room_id, 'active', 1
  ) returning * into result;
  insert into public.smoke_rooms (room_id, team_id, status)
    values (p_room_id, p_team_id, 'active');
  insert into public.team_members (team_id, node_id, role, status)
    values (p_team_id, p_leader_node_id, 'leader', 'active');

  perform public.complete_idempotent_op(p_op_id, to_jsonb(result));
  return result;
end;
$$;

-- 6. Updated RPC: add_team_member (with Stale Revocation Protection)
drop function if exists public.add_team_member(text,text);
create or replace function public.add_team_member(
  p_team_id text, p_node_id text,
  p_op_id text default null
)
returns public.team_members
language plpgsql security definer set search_path = public
as $$
declare
  v_is_done boolean;
  v_cached jsonb;
  v_existing public.team_members;
  result public.team_members;
begin
  select p_is_completed, p_cached_response into v_is_done, v_cached
  from public.begin_idempotent_op(
    p_op_id,
    'add_team_member',
    jsonb_build_object('team_id', p_team_id, 'node_id', p_node_id)
  );

  if v_is_done then
    return jsonb_populate_record(null::public.team_members, v_cached);
  end if;

  perform 1 from public.teams
    where team_id = p_team_id and status = 'active' for update;
  if not found then raise exception 'active team does not exist' using errcode = '23503'; end if;
  perform 1 from public.player_profiles where node_id = p_node_id for update;
  if not found then raise exception 'member profile does not exist' using errcode = '23503'; end if;

  -- Protect against stale sync un-revoking a banned member
  select * into v_existing from public.team_members
    where team_id = p_team_id and node_id = p_node_id for update;
  if found and v_existing.status = 'revoked' then
    raise exception 'cannot add member % to team %: membership is revoked', p_node_id, p_team_id
      using errcode = '23514';
  end if;

  insert into public.team_members (team_id, node_id, role, status)
    values (p_team_id, p_node_id, 'member', 'active')
  on conflict (team_id, node_id) do update
    set status = 'active',
        role = case when public.team_members.role = 'leader'
                    then 'leader' else 'member' end
  returning * into result;

  perform public.complete_idempotent_op(p_op_id, to_jsonb(result));
  return result;
end;
$$;

-- 7. Updated RPC: transfer_team_leadership (with Expected Leader & Version Protection)
drop function if exists public.transfer_team_leadership(text,text);
create or replace function public.transfer_team_leadership(
  p_team_id text, p_new_leader_node_id text,
  p_op_id text default null,
  p_expected_current_leader_node_id text default null
)
returns public.teams
language plpgsql security definer set search_path = public
as $$
declare
  v_is_done boolean;
  v_cached jsonb;
  result public.teams;
begin
  select p_is_completed, p_cached_response into v_is_done, v_cached
  from public.begin_idempotent_op(
    p_op_id,
    'transfer_team_leadership',
    jsonb_build_object('team_id', p_team_id, 'new_leader_node_id', p_new_leader_node_id, 'expected_leader', p_expected_current_leader_node_id)
  );

  if v_is_done then
    return jsonb_populate_record(null::public.teams, v_cached);
  end if;

  select * into result from public.teams
    where team_id = p_team_id and status = 'active' for update;
  if not found then raise exception 'active team does not exist' using errcode = '23503'; end if;

  if p_expected_current_leader_node_id is not null and result.leader_node_id <> p_expected_current_leader_node_id then
    raise exception 'leadership transfer conflict: current leader is % but expected %', result.leader_node_id, p_expected_current_leader_node_id
      using errcode = '23514';
  end if;

  perform 1 from public.team_members
    where team_id = p_team_id and node_id = p_new_leader_node_id
      and status = 'active' for update;
  if not found then raise exception 'new leader must be an active member' using errcode = '23503'; end if;

  update public.team_members set role = 'member'
    where team_id = p_team_id and role = 'leader' and status = 'active';
  update public.team_members set role = 'leader'
    where team_id = p_team_id and node_id = p_new_leader_node_id;
  update public.teams
    set leader_node_id = p_new_leader_node_id,
        version = version + 1,
        updated_at = now()
    where team_id = p_team_id returning * into result;

  perform public.complete_idempotent_op(p_op_id, to_jsonb(result));
  return result;
end;
$$;

-- 8. Updated RPC: remove_team_member
drop function if exists public.remove_team_member(text,text,text);
create or replace function public.remove_team_member(
  p_team_id text, p_node_id text, p_status text default 'removed',
  p_op_id text default null
)
returns public.team_members
language plpgsql security definer set search_path = public
as $$
declare
  v_is_done boolean;
  v_cached jsonb;
  result public.team_members;
begin
  select p_is_completed, p_cached_response into v_is_done, v_cached
  from public.begin_idempotent_op(
    p_op_id,
    'remove_team_member',
    jsonb_build_object('team_id', p_team_id, 'node_id', p_node_id, 'status', p_status)
  );

  if v_is_done then
    return jsonb_populate_record(null::public.team_members, v_cached);
  end if;

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

  perform public.complete_idempotent_op(p_op_id, to_jsonb(result));
  return result;
end;
$$;

-- 9. Updated RPC: set_team_member_member
drop function if exists public.set_team_member_member(text,text);
create or replace function public.set_team_member_member(
  p_team_id text, p_node_id text,
  p_op_id text default null
)
returns public.team_members
language plpgsql security definer set search_path = public
as $$
declare
  v_is_done boolean;
  v_cached jsonb;
  result public.team_members;
begin
  select p_is_completed, p_cached_response into v_is_done, v_cached
  from public.begin_idempotent_op(
    p_op_id,
    'set_team_member_member',
    jsonb_build_object('team_id', p_team_id, 'node_id', p_node_id)
  );

  if v_is_done then
    return jsonb_populate_record(null::public.team_members, v_cached);
  end if;

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

  perform public.complete_idempotent_op(p_op_id, to_jsonb(result));
  return result;
end;
$$;

-- 10. Updated RPC: rename_team (with Version Conflict Protection)
drop function if exists public.rename_team(text,text);
create or replace function public.rename_team(
  p_team_id text, p_team_name text,
  p_op_id text default null,
  p_expected_version integer default null
)
returns public.teams
language plpgsql security definer set search_path = public
as $$
declare
  v_is_done boolean;
  v_cached jsonb;
  result public.teams;
begin
  select p_is_completed, p_cached_response into v_is_done, v_cached
  from public.begin_idempotent_op(
    p_op_id,
    'rename_team',
    jsonb_build_object('team_id', p_team_id, 'team_name', p_team_name, 'expected_version', p_expected_version)
  );

  if v_is_done then
    return jsonb_populate_record(null::public.teams, v_cached);
  end if;

  select * into result from public.teams where team_id = p_team_id for update;
  if not found then raise exception 'team does not exist' using errcode = '23503'; end if;

  if p_expected_version is not null and result.version <> p_expected_version then
    raise exception 'team rename conflict: current version is % but expected %', result.version, p_expected_version
      using errcode = '23514';
  end if;

  update public.teams
    set team_name = public.validate_team_name_input(p_team_name),
        version = version + 1,
        updated_at = now()
    where team_id = p_team_id returning * into result;

  perform public.complete_idempotent_op(p_op_id, to_jsonb(result));
  return result;
end;
$$;

-- 11. Updated RPC: archive_team
drop function if exists public.archive_team(text);
create or replace function public.archive_team(
  p_team_id text,
  p_op_id text default null
)
returns public.teams
language plpgsql security definer set search_path = public
as $$
declare
  v_is_done boolean;
  v_cached jsonb;
  result public.teams;
begin
  select p_is_completed, p_cached_response into v_is_done, v_cached
  from public.begin_idempotent_op(
    p_op_id,
    'archive_team',
    jsonb_build_object('team_id', p_team_id)
  );

  if v_is_done then
    return jsonb_populate_record(null::public.teams, v_cached);
  end if;

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

  perform public.complete_idempotent_op(p_op_id, to_jsonb(result));
  return result;
end;
$$;

-- 12. New Idempotent Message Insertion RPC
create or replace function public.insert_room_message(
  p_message_id uuid,
  p_room_id text,
  p_node_id text,
  p_message_text text,
  p_created_at timestamptz default now(),
  p_op_id text default null
)
returns public.messages
language plpgsql security definer set search_path = public
as $$
declare
  v_is_done boolean;
  v_cached jsonb;
  v_existing public.messages;
  result public.messages;
begin
  select p_is_completed, p_cached_response into v_is_done, v_cached
  from public.begin_idempotent_op(
    p_op_id,
    'insert_room_message',
    jsonb_build_object('message_id', p_message_id, 'room_id', p_room_id, 'node_id', p_node_id, 'text', p_message_text)
  );

  if v_is_done then
    return jsonb_populate_record(null::public.messages, v_cached);
  end if;

  -- Check if message already exists with this ID
  select * into v_existing from public.messages where id = p_message_id for update;
  if found then
    if v_existing.room_id <> p_room_id or v_existing.node_id <> p_node_id then
      raise exception 'message ID % already exists with different room or author', p_message_id
        using errcode = '23514';
    end if;
    perform public.complete_idempotent_op(p_op_id, to_jsonb(v_existing));
    return v_existing;
  end if;

  insert into public.messages (id, room_id, node_id, message_text, created_at)
  values (p_message_id, p_room_id, p_node_id, p_message_text, coalesce(p_created_at, now()))
  returning * into result;

  perform public.complete_idempotent_op(p_op_id, to_jsonb(result));
  return result;
end;
$$;

-- 13. Backend-only execution permissions
revoke all on function public.compute_payload_hash(jsonb) from public, anon, authenticated;
revoke all on function public.begin_idempotent_op(text,text,jsonb) from public, anon, authenticated;
revoke all on function public.complete_idempotent_op(text,jsonb) from public, anon, authenticated;
revoke all on function public.create_team_with_room(text,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.add_team_member(text,text,text) from public, anon, authenticated;
revoke all on function public.transfer_team_leadership(text,text,text,text) from public, anon, authenticated;
revoke all on function public.remove_team_member(text,text,text,text) from public, anon, authenticated;
revoke all on function public.set_team_member_member(text,text,text) from public, anon, authenticated;
revoke all on function public.archive_team(text,text) from public, anon, authenticated;
revoke all on function public.rename_team(text,text,text,integer) from public, anon, authenticated;
revoke all on function public.insert_room_message(uuid,text,text,text,timestamptz,text) from public, anon, authenticated;

grant execute on function public.compute_payload_hash(jsonb) to service_role;
grant execute on function public.begin_idempotent_op(text,text,jsonb) to service_role;
grant execute on function public.complete_idempotent_op(text,jsonb) to service_role;
grant execute on function public.create_team_with_room(text,text,text,text,text,text,text) to service_role;
grant execute on function public.add_team_member(text,text,text) to service_role;
grant execute on function public.transfer_team_leadership(text,text,text,text) to service_role;
grant execute on function public.remove_team_member(text,text,text,text) to service_role;
grant execute on function public.set_team_member_member(text,text,text) to service_role;
grant execute on function public.archive_team(text,text) to service_role;
grant execute on function public.rename_team(text,text,text,integer) to service_role;
grant execute on function public.insert_room_message(uuid,text,text,text,timestamptz,text) to service_role;

-- ============================================================================
-- ROLLBACK SCRIPT (Execute only if rolling back this migration):
-- ============================================================================
--
-- drop function if exists public.insert_room_message(uuid,text,text,text,timestamptz,text);
-- drop function if exists public.rename_team(text,text,text,integer);
-- drop function if exists public.archive_team(text,text);
-- drop function if exists public.set_team_member_member(text,text,text);
-- drop function if exists public.remove_team_member(text,text,text,text);
-- drop function if exists public.transfer_team_leadership(text,text,text,text);
-- drop function if exists public.add_team_member(text,text,text);
-- drop function if exists public.create_team_with_room(text,text,text,text,text,text,text);
-- drop function if exists public.complete_idempotent_op(text,jsonb);
-- drop function if exists public.begin_idempotent_op(text,text,jsonb);
-- drop function if exists public.compute_payload_hash(jsonb);
--
-- -- Re-create original function signatures from 20261031000000_shared_nodes_smoke.sql
-- -- (See 20261031000000_shared_nodes_smoke.sql lines 324-494)
--
-- alter table public.teams drop column if exists version;
-- drop table if exists public.operation_ledger cascade;

