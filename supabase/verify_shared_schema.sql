-- Read-only post-migration verification.
-- Run as one SQL Editor batch. Every required check emits PASS or FAIL.
-- The temporary results table is removed when the SQL Editor session ends.

create temp table _verify_results (
  check_name text primary key,
  status text not null,
  failure_count bigint not null default 0,
  details text
);

insert into _verify_results
select 'required_tables',
  case when count(*) = 6 then 'PASS' else 'FAIL' end,
  abs(6 - count(*)),
  coalesce(string_agg(table_name, ', ' order by table_name), '')
from information_schema.tables
where table_schema = 'public'
  and table_name in ('player_profiles', 'teams', 'team_members',
                     'smoke_rooms', 'messages', 'room_events');

insert into _verify_results
select expected.name,
 case when count(c.oid) = 1 then 'PASS' else 'FAIL' end,
 case when count(c.oid) = 1 then 0 else 1 end,
 coalesce(string_agg(pg_get_constraintdef(c.oid), ', '), 'missing')
from (values
 ('pk_player_profiles', 'player_profiles'),
 ('pk_teams', 'teams'),
 ('pk_team_members', 'team_members'),
 ('pk_smoke_rooms', 'smoke_rooms'),
 ('pk_messages', 'messages'),
 ('pk_room_events', 'room_events')
) expected(name, relation_name)
left join pg_namespace n on n.nspname = 'public'
left join pg_class cl on cl.relnamespace = n.oid and cl.relname = expected.relation_name
left join pg_constraint c
  on c.connamespace = n.oid
 and c.conrelid = cl.oid
 and c.contype = 'p'
group by expected.name;

insert into _verify_results
select expected.name,
  case when c.oid is not null
    and c.condeferrable = expected.is_deferrable
    and c.condeferred = expected.is_deferred then 'PASS' else 'FAIL' end,
  case when c.oid is null
    or c.condeferrable <> expected.is_deferrable
    or c.condeferred <> expected.is_deferred then 1 else 0 end,
  coalesce(
    pg_get_constraintdef(c.oid) || format(
      ' [deferrable=%s, initially_deferred=%s]',
      c.condeferrable, c.condeferred
    ),
    'missing'
  )
from (values
  ('fk_teams_leader_profile', 'teams', 'teams_leader_profile_fkey', true, true),
  ('fk_members_team', 'team_members', 'team_members_team_fkey', true, true),
  ('fk_members_profile', 'team_members', 'team_members_profile_fkey', true, true),
  ('fk_rooms_team', 'smoke_rooms', 'smoke_rooms_team_fkey', true, true),
  ('fk_teams_room_mapping', 'teams', 'teams_room_mapping_fkey', true, true),
  ('fk_messages_room', 'messages', 'messages_room_fkey', false, false),
  ('fk_messages_profile', 'messages', 'messages_profile_fkey', false, false),
  ('fk_events_room', 'room_events', 'room_events_room_fkey', false, false),
  ('fk_events_profile', 'room_events', 'room_events_profile_fkey', false, false)
) expected(name, relation_name, constraint_name, is_deferrable, is_deferred)
left join pg_namespace n on n.nspname = 'public'
left join pg_class cl on cl.relnamespace = n.oid and cl.relname = expected.relation_name
left join pg_constraint c
  on c.connamespace = n.oid and c.conrelid = cl.oid
 and c.conname = expected.constraint_name and c.contype = 'f'
group by c.oid, c.condeferrable, c.condeferred,
  expected.name, expected.is_deferrable, expected.is_deferred;

insert into _verify_results
select 'fk_source_destination_columns',
  case when count(*) = 9 then 'PASS' else 'FAIL' end,
  9 - count(*),
  coalesce(string_agg(c.conname || ': ' ||
    pg_get_constraintdef(c.oid), '; ' order by c.conname), 'missing')
from pg_constraint c
join pg_namespace n on n.oid = c.connamespace and n.nspname = 'public'
where c.contype = 'f'
  and c.conname in (
    'teams_leader_profile_fkey', 'team_members_team_fkey',
    'team_members_profile_fkey', 'smoke_rooms_team_fkey',
    'teams_room_mapping_fkey', 'messages_room_fkey',
    'messages_profile_fkey', 'room_events_room_fkey',
    'room_events_profile_fkey'
  );

insert into _verify_results
select 'fk_delete_actions',
  case when count(c.oid) = 9
        and count(*) filter (where c.confdeltype = expected.delete_action) = 9
    then 'PASS' else 'FAIL' end,
  9 - count(*) filter (where c.oid is not null
                        and c.confdeltype = expected.delete_action),
  coalesce(string_agg(expected.constraint_name || ': ' ||
    coalesce(c.confdeltype::text, 'missing'), ', ' order by expected.constraint_name), 'missing')
from (values
  ('teams', 'teams_leader_profile_fkey', 'r'),
  ('team_members', 'team_members_team_fkey', 'c'),
  ('team_members', 'team_members_profile_fkey', 'r'),
  ('smoke_rooms', 'smoke_rooms_team_fkey', 'r'),
  ('teams', 'teams_room_mapping_fkey', 'r'),
  ('messages', 'messages_room_fkey', 'r'),
  ('messages', 'messages_profile_fkey', 'r'),
  ('room_events', 'room_events_room_fkey', 'r'),
  ('room_events', 'room_events_profile_fkey', 'r')
) expected(relation_name, constraint_name, delete_action)
left join pg_namespace n on n.nspname = 'public'
left join pg_class cl on cl.relnamespace = n.oid
  and cl.relname = expected.relation_name
left join pg_constraint c
  on c.connamespace = n.oid
 and c.conrelid = cl.oid
 and c.conname = expected.constraint_name
 and c.contype = 'f';

insert into _verify_results
select expected.name,
  case when x.indexdef is not null then 'PASS' else 'FAIL' end,
  case when x.indexdef is null then 1 else 0 end,
  coalesce(x.indexdef, 'missing')
from (values
  ('unique_username_index', 'player_profiles_username_normalized_key'),
  ('unique_team_name_index', 'teams_team_name_normalized_key'),
  ('active_leader_index', 'team_members_one_active_leader_key')
) expected(name, index_name)
left join pg_indexes x
  on x.schemaname = 'public' and x.indexname = expected.index_name
  and (
    (expected.name = 'unique_username_index' and x.indexdef like '%(username_normalized)%')
    or (expected.name = 'unique_team_name_index' and x.indexdef like '%(team_name_normalized)%')
    or (expected.name = 'active_leader_index'
        and x.indexdef like '%(team_id)%'
        and x.indexdef like '%role = ''leader''%'
        and x.indexdef like '%status = ''active''%')
  );

insert into _verify_results
select expected.name,
  case when count(c.oid) = 1 then 'PASS' else 'FAIL' end,
  case when count(c.oid) = 1 then 0 else 1 end,
  coalesce(string_agg(c.conname || ': ' || pg_get_constraintdef(c.oid), '; '), 'missing')
from (values
  ('unique_teams_mesh', 'teams'),
  ('unique_teams_room', 'teams'),
  ('unique_membership', 'team_members'),
  ('unique_rooms_team', 'smoke_rooms'),
  ('unique_rooms_team_room', 'smoke_rooms')
) expected(name, relation_name)
left join pg_namespace n on n.nspname = 'public'
left join pg_class cl on cl.relnamespace = n.oid and cl.relname = expected.relation_name
left join pg_constraint c
  on c.connamespace = n.oid and c.conrelid = cl.oid and c.contype = 'u'
 and (
   (expected.name = 'unique_teams_mesh' and pg_get_constraintdef(c.oid) like '%(mesh_id)%')
   or (expected.name = 'unique_teams_room' and pg_get_constraintdef(c.oid) like '%(room_id)%')
   or (expected.name = 'unique_membership' and pg_get_constraintdef(c.oid) like '%(team_id, node_id)%')
   or (expected.name = 'unique_rooms_team' and pg_get_constraintdef(c.oid) like '%(team_id)%')
   or (expected.name = 'unique_rooms_team_room' and pg_get_constraintdef(c.oid) like '%(team_id, room_id)%')
 )
group by expected.name;

insert into _verify_results
select expected.name,
  case when t.oid is not null and t.relrowsecurity then 'PASS' else 'FAIL' end,
  case when t.oid is null or not t.relrowsecurity then 1 else 0 end,
  coalesce(n.nspname || '.' || t.relname, 'missing')
from (values
  ('rls_player_profiles', 'player_profiles'),
  ('rls_teams', 'teams'),
  ('rls_team_members', 'team_members'),
  ('rls_smoke_rooms', 'smoke_rooms'),
  ('rls_messages', 'messages'),
  ('rls_room_events', 'room_events')
) expected(name, relation_name)
left join pg_namespace n on n.nspname = 'public'
left join pg_class t on t.relnamespace = n.oid and t.relname = expected.relation_name;

insert into _verify_results
select expected.name,
  case when p.policyname is not null then 'PASS' else 'FAIL' end,
  case when p.policyname is null then 1 else 0 end,
  coalesce(p.policyname || ': ' || p.cmd, 'missing')
from (values
  ('policy_profile_read', 'player_profiles_self_read'),
  ('policy_team_read', 'teams_member_read'),
  ('policy_members_read', 'team_members_self_read'),
  ('policy_room_read', 'smoke_rooms_member_read'),
  ('policy_messages_read', 'messages_member_read'),
  ('policy_messages_insert', 'messages_member_insert')
) expected(name, policy_name)
left join pg_policies p
  on p.schemaname = 'public' and p.policyname = expected.policy_name;

insert into _verify_results
select 'unexpected_permissive_policies',
  case when count(*) = 0 then 'PASS' else 'FAIL' end,
  count(*),
  coalesce(string_agg(tablename || '.' || policyname, ', ' order by tablename, policyname), '')
from pg_policies
where schemaname = 'public'
  and tablename in ('player_profiles', 'teams', 'team_members',
                    'smoke_rooms', 'messages', 'room_events')
  and policyname not in (
    'player_profiles_self_read', 'teams_member_read',
    'team_members_self_read', 'smoke_rooms_member_read',
    'messages_member_read', 'messages_member_insert'
  );

insert into _verify_results
select 'team_room_mapping',
  case when count(*) = 0 then 'PASS' else 'FAIL' end,
  count(*),
  coalesce(string_agg(t.team_id, ', ' order by t.team_id), '')
from public.teams t
left join public.smoke_rooms r
  on r.team_id = t.team_id and r.room_id = t.room_id
where r.team_id is null;

insert into _verify_results
select 'archived_room_mapping',
  case when count(*) = 0 then 'PASS' else 'FAIL' end,
  count(*),
  coalesce(string_agg(t.team_id, ', ' order by t.team_id), '')
from public.teams t
join public.smoke_rooms r on r.team_id = t.team_id
where (t.status = 'archived' and r.status <> 'archived')
   or (t.status = 'active' and r.status <> 'active');

insert into _verify_results
select 'leader_member_consistency',
  case when count(*) = 0 then 'PASS' else 'FAIL' end,
  count(*),
  coalesce(string_agg(team_id, ', ' order by team_id), '')
from (
  select t.team_id
  from public.teams t
  left join public.team_members m
    on m.team_id = t.team_id and m.role = 'leader' and m.status = 'active'
  where t.status = 'active'
  group by t.team_id, t.leader_node_id
  having count(m.node_id) <> 1 or min(m.node_id) is distinct from t.leader_node_id
) invalid;

insert into _verify_results
select 'transaction_functions',
  case when count(*) = 7 then 'PASS' else 'FAIL' end,
  7 - count(*),
  coalesce(string_agg(routine_name, ', ' order by routine_name), 'missing')
from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('create_team_with_room', 'add_team_member',
    'transfer_team_leadership', 'remove_team_member',
    'set_team_member_member', 'archive_team', 'rename_team');

select check_name, status, failure_count, details
from _verify_results
order by check_name;

select case when count(*) filter (where status = 'FAIL') = 0
  then 'PASS' else 'FAIL' end as overall_status
from _verify_results;
