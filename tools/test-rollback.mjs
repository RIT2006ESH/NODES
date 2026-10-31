import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PSQL = "C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe";
const PORT = "54332";
const HOST = "127.0.0.1";
const DB = "nodes_rollback_test";

function runPsql(sql, db = DB) {
  return new Promise((resolve, reject) => {
    const child = spawn(PSQL, ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-t", "-A", "-c", sql]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", reject);
  });
}

function runPsqlFile(filePath, db = DB) {
  return new Promise((resolve, reject) => {
    const child = spawn(PSQL, ["-h", HOST, "-p", PORT, "-U", "postgres", "-d", db, "-f", filePath]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", reject);
  });
}

async function run() {
  console.log("=== Phase 5.2B.1: Rollback Validation on Real PostgreSQL ===");

  // 1. Recreate disposable database
  console.log("Recreating disposable database nodes_rollback_test...");
  await runPsql("DROP DATABASE IF EXISTS nodes_rollback_test;", "postgres");
  const createDb = await runPsql("CREATE DATABASE nodes_rollback_test;", "postgres");
  if (createDb.code !== 0) throw new Error(`Create DB failed: ${createDb.stderr}`);

  // 2. Apply migration 1
  console.log("Applying Migration 1 (20261031000000_shared_nodes_smoke.sql)...");
  const m1 = await runPsqlFile("C:\\Users\\Asus\\Downloads\\NODES-main\\supabase\\migrations\\20261031000000_shared_nodes_smoke.sql");
  if (m1.code !== 0) throw new Error(`Migration 1 failed: ${m1.stderr}`);

  // 3. Apply migration 2
  console.log("Applying Migration 2 (20261031010000_remote_idempotency_ledger.sql)...");
  const m2 = await runPsqlFile("C:\\Users\\Asus\\Downloads\\NODES-main\\supabase\\migrations\\20261031010000_remote_idempotency_ledger.sql");
  if (m2.code !== 0) throw new Error(`Migration 2 failed: ${m2.stderr}`);

  // Verify migration 2 artifacts exist
  const tableCheckBefore = await runPsql("SELECT count(*) FROM information_schema.tables WHERE table_name = 'operation_ledger';");
  if (tableCheckBefore.stdout !== "1") throw new Error("operation_ledger table not found after migration 2");
  const colCheckBefore = await runPsql("SELECT count(*) FROM information_schema.columns WHERE table_name = 'teams' AND column_name = 'version';");
  if (colCheckBefore.stdout !== "1") throw new Error("teams.version column not found after migration 2");

  // 4. Extract and execute rollback script
  console.log("Executing rollback script...");
  const rollbackSql = `
    drop function if exists public.insert_room_message(uuid,text,text,text,timestamptz,text);
    drop function if exists public.rename_team(text,text,text,integer);
    drop function if exists public.archive_team(text,text);
    drop function if exists public.set_team_member_member(text,text,text);
    drop function if exists public.remove_team_member(text,text,text,text);
    drop function if exists public.transfer_team_leadership(text,text,text,text);
    drop function if exists public.add_team_member(text,text,text);
    drop function if exists public.create_team_with_room(text,text,text,text,text,text,text);
    drop function if exists public.complete_idempotent_op(text,jsonb);
    drop function if exists public.begin_idempotent_op(text,text,jsonb);
    drop function if exists public.compute_payload_hash(jsonb);

    -- Re-create original function signatures from 20261031000000_shared_nodes_smoke.sql
    create or replace function public.create_team_with_room(
      p_team_id text, p_mesh_id text, p_team_name text, p_room_id text,
      p_leader_node_id text, p_description text default null
    )
    returns public.teams
    language plpgsql security definer set search_path = public
    as $$
    declare result public.teams;
    begin
      if p_team_id is null or p_mesh_id is null or p_room_id is null or p_leader_node_id is null then
        raise exception 'team, mesh, room, and leader identifiers are required' using errcode = '22023';
      end if;
      perform 1 from public.player_profiles where node_id = p_leader_node_id for update;
      if not found then raise exception 'leader profile does not exist' using errcode = '23503'; end if;
      select * into result from public.teams where team_id = p_team_id for update;
      if found then
        if result.mesh_id <> p_mesh_id or result.room_id <> p_room_id then
          raise exception 'stable team, mesh, or room identity mismatch' using errcode = '23514';
        end if;
        return result;
      end if;
      insert into public.teams (team_id, mesh_id, team_name, description, leader_node_id, room_id, status)
      values (p_team_id, p_mesh_id, public.validate_team_name_input(p_team_name), p_description, p_leader_node_id, p_room_id, 'active')
      returning * into result;
      insert into public.smoke_rooms (room_id, team_id, status) values (p_room_id, p_team_id, 'active');
      insert into public.team_members (team_id, node_id, role, status) values (p_team_id, p_leader_node_id, 'leader', 'active');
      return result;
    end;
    $$;

    create or replace function public.add_team_member(p_team_id text, p_node_id text)
    returns public.team_members
    language plpgsql security definer set search_path = public
    as $$
    declare result public.team_members;
    begin
      perform 1 from public.teams where team_id = p_team_id and status = 'active' for update;
      if not found then raise exception 'active team does not exist' using errcode = '23503'; end if;
      perform 1 from public.player_profiles where node_id = p_node_id for update;
      if not found then raise exception 'member profile does not exist' using errcode = '23503'; end if;
      insert into public.team_members (team_id, node_id, role, status)
      values (p_team_id, p_node_id, 'member', 'active')
      on conflict (team_id, node_id) do update
        set status = 'active', role = case when public.team_members.role = 'leader' then 'leader' else 'member' end
      returning * into result;
      return result;
    end;
    $$;

    create or replace function public.transfer_team_leadership(p_team_id text, p_new_leader_node_id text)
    returns public.teams
    language plpgsql security definer set search_path = public
    as $$
    declare result public.teams;
    begin
      select * into result from public.teams where team_id = p_team_id and status = 'active' for update;
      if not found then raise exception 'active team does not exist' using errcode = '23503'; end if;
      perform 1 from public.team_members where team_id = p_team_id and node_id = p_new_leader_node_id and status = 'active' for update;
      if not found then raise exception 'new leader must be an active member' using errcode = '23503'; end if;
      update public.team_members set role = 'member' where team_id = p_team_id and role = 'leader' and status = 'active';
      update public.team_members set role = 'leader' where team_id = p_team_id and node_id = p_new_leader_node_id;
      update public.teams set leader_node_id = p_new_leader_node_id, updated_at = now() where team_id = p_team_id returning * into result;
      return result;
    end;
    $$;

    create or replace function public.remove_team_member(p_team_id text, p_node_id text, p_status text default 'removed')
    returns public.team_members
    language plpgsql security definer set search_path = public
    as $$
    declare result public.team_members;
    begin
      if p_status not in ('removed', 'revoked') then raise exception 'invalid member removal status' using errcode = '22023'; end if;
      perform 1 from public.teams where team_id = p_team_id for update;
      if not found then raise exception 'team does not exist' using errcode = '23503'; end if;
      select * into result from public.team_members where team_id = p_team_id and node_id = p_node_id for update;
      if not found then raise exception 'membership does not exist' using errcode = '23503'; end if;
      if result.role = 'leader' and result.status = 'active' then raise exception 'transfer leadership before removing the leader' using errcode = '23514'; end if;
      update public.team_members set status = p_status where team_id = p_team_id and node_id = p_node_id returning * into result;
      return result;
    end;
    $$;

    create or replace function public.set_team_member_member(p_team_id text, p_node_id text)
    returns public.team_members
    language plpgsql security definer set search_path = public
    as $$
    declare result public.team_members;
    begin
      perform 1 from public.teams where team_id = p_team_id for update;
      if not found then raise exception 'team does not exist' using errcode = '23503'; end if;
      select * into result from public.team_members where team_id = p_team_id and node_id = p_node_id for update;
      if not found then raise exception 'membership does not exist' using errcode = '23503'; end if;
      if result.status = 'active' and result.role = 'leader' then raise exception 'transfer leadership before demoting the leader' using errcode = '23514'; end if;
      update public.team_members set role = 'member' where team_id = p_team_id and node_id = p_node_id returning * into result;
      return result;
    end;
    $$;

    create or replace function public.rename_team(p_team_id text, p_team_name text)
    returns public.teams
    language plpgsql security definer set search_path = public
    as $$
    declare result public.teams;
    begin
      perform 1 from public.teams where team_id = p_team_id for update;
      if not found then raise exception 'team does not exist' using errcode = '23503'; end if;
      update public.teams set team_name = public.validate_team_name_input(p_team_name), updated_at = now() where team_id = p_team_id returning * into result;
      return result;
    end;
    $$;

    create or replace function public.archive_team(p_team_id text)
    returns public.teams
    language plpgsql security definer set search_path = public
    as $$
    declare result public.teams;
    begin
      select * into result from public.teams where team_id = p_team_id for update;
      if not found then raise exception 'team does not exist' using errcode = '23503'; end if;
      update public.teams set status = 'archived', archived_at = coalesce(archived_at, now()), updated_at = now() where team_id = p_team_id returning * into result;
      update public.smoke_rooms set status = 'archived', archived_at = coalesce(archived_at, now()) where team_id = p_team_id;
      update public.team_members set status = case when status = 'active' then 'removed' else status end where team_id = p_team_id;
      return result;
    end;
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

    alter table public.teams drop column if exists version;
    drop table if exists public.operation_ledger cascade;
  `;
  const rbRes = await runPsql(rollbackSql);
  if (rbRes.code !== 0) throw new Error(`Rollback execution failed: ${rbRes.stderr}`);

  // 5. Verify rollback result
  console.log("Verifying post-rollback schema...");
  const tableCheckAfter = await runPsql("SELECT count(*) FROM information_schema.tables WHERE table_name = 'operation_ledger';");
  if (tableCheckAfter.stdout !== "0") throw new Error("operation_ledger still exists after rollback");
  const colCheckAfter = await runPsql("SELECT count(*) FROM information_schema.columns WHERE table_name = 'teams' AND column_name = 'version';");
  if (colCheckAfter.stdout !== "0") throw new Error("teams.version column still exists after rollback");

  // Verify original schema works
  await runPsql("INSERT INTO public.player_profiles (node_id, username) VALUES ('node-rb', 'rb_user');");
  const testOriginal = await runPsql("SELECT (public.create_team_with_room('team-rb', 'mesh-rb', 'Rollback Team', 'room-rb', 'node-rb')).team_name;");
  if (testOriginal.code !== 0 || testOriginal.stdout !== "Rollback Team") {
    throw new Error(`Original create_team_with_room failed after rollback: ${testOriginal.stderr}`);
  }

  console.log("✓ PASS: Rollback cleanly removed proposed changes and preserved original schema.");
}

run().catch((err) => {
  console.error("FATAL ROLLBACK FAILURE:", err);
  process.exit(1);
});

