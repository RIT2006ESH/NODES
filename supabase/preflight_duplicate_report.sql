-- Read-only deployment preflight.
-- Run as one SQL Editor batch. The temporary table is session-local and is
-- removed when the SQL Editor session ends; no persistent records are changed.

create temp table _preflight_results (
  check_name text primary key,
  status text not null,
  failure_count bigint not null default 0,
  details text
);

create temp table _required_tables (table_name text primary key);
insert into _required_tables values
  ('player_profiles'), ('teams'), ('team_members'),
  ('smoke_rooms'), ('messages'), ('room_events');

insert into _preflight_results (check_name, status, failure_count, details)
with inventory as (
  select r.table_name, t.table_name is not null as present
  from _required_tables r
  left join information_schema.tables t
    on t.table_schema = 'public' and t.table_name = r.table_name
)
select 'schema_state',
       case
         when count(*) filter (where present) = 0 then 'FRESH_SCHEMA'
         when count(*) filter (where present) = 6 then 'EXISTING_SCHEMA'
         else 'SCHEMA_DRIFT'
       end,
       count(*) filter (where not present),
       coalesce(string_agg(
         case when present then 'existing:' else 'missing:' end || table_name,
         ', ' order by table_name
       ), '')
from inventory;

insert into _preflight_results (check_name, status, failure_count, details)
select 'required_tables',
       case when s.status = 'SCHEMA_DRIFT' then 'FAIL' else 'PASS' end,
       s.failure_count,
       s.details
from _preflight_results s
where s.check_name = 'schema_state';

do $$
begin
  if (select status from _preflight_results where check_name = 'schema_state') = 'FRESH_SCHEMA' then
    return;
  end if;

  if (select status from _preflight_results where check_name = 'schema_state') = 'SCHEMA_DRIFT' then
    insert into _preflight_results
      values
      ('schema_drift_action', 'FAIL', 1,
       'Stop: inspect existing and missing tables before deployment');
    return;
  end if;

  execute $sql$
    insert into _preflight_results
    select 'duplicate_usernames',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*),
           coalesce(string_agg(username_normalized, ', ' order by username_normalized), '')
    from (
      select lower(btrim(username)) username_normalized
      from public.player_profiles
      group by lower(btrim(username))
      having count(*) > 1
    ) duplicates
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'invalid_usernames',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*),
           coalesce(string_agg(node_id, ', ' order by node_id), '')
    from public.player_profiles
    where username is null
       or username <> btrim(username)
       or char_length(btrim(username)) not between 3 and 20
       or username !~ '^[A-Za-z0-9_]{3,20}$'
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'duplicate_team_names',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*),
           coalesce(string_agg(team_name_normalized, ', ' order by team_name_normalized), '')
    from (
      select lower(regexp_replace(btrim(team_name), '\s+', ' ', 'g'))
             team_name_normalized
      from public.teams
      group by lower(regexp_replace(btrim(team_name), '\s+', ' ', 'g'))
      having count(*) > 1
    ) duplicates
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'invalid_team_names',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*),
           coalesce(string_agg(team_id, ', ' order by team_id), '')
    from public.teams
    where team_name is null
       or char_length(regexp_replace(btrim(team_name), '\s+', ' ', 'g'))
            not between 3 and 24
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'duplicate_room_ids',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*),
           coalesce(string_agg(room_id, ', ' order by room_id), '')
    from (
      select room_id from public.teams
      group by room_id having count(*) > 1
      union all
      select room_id from public.smoke_rooms
      group by room_id having count(*) > 1
    ) duplicates
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'duplicate_memberships',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*),
           coalesce(string_agg(team_id || ':' || node_id, ', ' order by team_id, node_id), '')
    from (
      select team_id, node_id
      from public.team_members
      group by team_id, node_id
      having count(*) > 1
    ) duplicates
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'multiple_active_leaders',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*),
           coalesce(string_agg(team_id, ', ' order by team_id), '')
    from (
      select team_id
      from public.team_members
      where role = 'leader' and status = 'active'
      group by team_id
      having count(*) > 1
    ) duplicates
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'teams_without_active_leader',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*),
           coalesce(string_agg(team_id, ', ' order by team_id), '')
    from (
      select t.team_id
      from public.teams t
      left join public.team_members m
        on m.team_id = t.team_id
       and m.role = 'leader'
       and m.status = 'active'
      where t.status = 'active'
      group by t.team_id
      having count(m.node_id) = 0
    ) missing
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'leader_mismatch',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*),
           coalesce(string_agg(team_id, ', ' order by team_id), '')
    from (
      select t.team_id
      from public.teams t
      left join public.team_members m
        on m.team_id = t.team_id
       and m.role = 'leader'
       and m.status = 'active'
      where t.status = 'active'
      group by t.team_id, t.leader_node_id
      having count(m.node_id) <> 1
          or min(m.node_id) is distinct from t.leader_node_id
    ) mismatches
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'missing_player_profiles',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*),
           coalesce(string_agg(node_id, ', ' order by node_id), '')
    from (
      select distinct m.node_id
      from public.team_members m
      left join public.player_profiles p on p.node_id = m.node_id
      where p.node_id is null
      union
      select distinct t.leader_node_id
      from public.teams t
      left join public.player_profiles p on p.node_id = t.leader_node_id
      where t.leader_node_id is not null and p.node_id is null
    ) missing
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'team_room_mismatch',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*),
           coalesce(string_agg(t.team_id, ', ' order by t.team_id), '')
    from public.teams t
    left join public.smoke_rooms r
      on r.team_id = t.team_id and r.room_id = t.room_id
    where r.team_id is null
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'members_missing_teams',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*), coalesce(string_agg(m.team_id, ', ' order by m.team_id), '')
    from public.team_members m
    left join public.teams t on t.team_id = m.team_id
    where t.team_id is null
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'members_missing_profiles',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*), coalesce(string_agg(m.node_id, ', ' order by m.node_id), '')
    from public.team_members m
    left join public.player_profiles p on p.node_id = m.node_id
    where p.node_id is null
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'rooms_missing_teams',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*), coalesce(string_agg(r.team_id, ', ' order by r.team_id), '')
    from public.smoke_rooms r
    left join public.teams t on t.team_id = r.team_id
    where t.team_id is null
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'messages_missing_rooms',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*), coalesce(string_agg(m.room_id, ', ' order by m.room_id), '')
    from public.messages m
    left join public.smoke_rooms r on r.room_id = m.room_id
    where r.room_id is null
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'messages_missing_profiles',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*), coalesce(string_agg(m.node_id, ', ' order by m.node_id), '')
    from public.messages m
    left join public.player_profiles p on p.node_id = m.node_id
    where p.node_id is null
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'events_missing_rooms',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*), coalesce(string_agg(e.room_id, ', ' order by e.room_id), '')
    from public.room_events e
    left join public.smoke_rooms r on r.room_id = e.room_id
    where r.room_id is null
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'events_missing_profiles',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*), coalesce(string_agg(e.node_id, ', ' order by e.node_id), '')
    from public.room_events e
    left join public.player_profiles p on p.node_id = e.node_id
    where e.node_id is not null and p.node_id is null
  $sql$;

  execute $sql$
    insert into _preflight_results
    select 'archived_mapping_mismatch',
           case when count(*) = 0 then 'PASS' else 'FAIL' end,
           count(*), coalesce(string_agg(t.team_id, ', ' order by t.team_id), '')
    from public.teams t
    join public.smoke_rooms r on r.team_id = t.team_id
    where t.status = 'archived'
      and (r.status <> 'archived' or r.room_id <> t.room_id)
  $sql$;
end
$$;

select check_name, status, failure_count, details
from _preflight_results
order by check_name;

select case
  when count(*) filter (where status = 'FAIL') = 0 then 'PASS'
  else 'FAIL'
end as overall_status
from _preflight_results;
