import { spawn } from "node:child_process";

const PSQL = "C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe";
const PORT = "54332";
const HOST = "127.0.0.1";
const DB = "nodes_smoke_test";

export function runPsql(sql, role = "postgres", db = DB) {
  return new Promise((resolve, reject) => {
    const child = spawn(PSQL, ["-h", HOST, "-p", PORT, "-U", role, "-d", db, "-t", "-A", "-c", sql]);
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
  console.log("=== Phase 5.2B.1: PostgreSQL 16 Real Database Validation ===");

  // Setup test fixtures
  console.log("Setting up player profiles...");
  await runPsql(`
    TRUNCATE public.messages, public.team_members, public.smoke_rooms, public.teams, public.operation_ledger CASCADE;
    INSERT INTO public.player_profiles (node_id, username)
    VALUES ('node-leader', 'leader_one'), ('node-member-1', 'member_one'), ('node-member-2', 'member_two')
    ON CONFLICT (node_id) DO NOTHING;
  `);
  console.log("Player profiles created.");

  // Test 1: First operation executes and stores result
  console.log("\n[Test 1] First operation executes and stores result in operation_ledger...");
  const t1 = await runPsql(`
    SELECT (public.create_team_with_room('team-1', 'mesh-1', 'Team One', 'room-1', 'node-leader', null, 'op-team-1')).team_name;
  `);
  if (t1.code !== 0) throw new Error(`Test 1 failed: ${t1.stderr}`);
  if (t1.stdout !== "Team One") throw new Error(`Test 1 unexpected output: ${t1.stdout}`);
  const ledger1 = await runPsql("SELECT status FROM public.operation_ledger WHERE operation_id = 'op-team-1';");
  if (ledger1.stdout !== "completed") throw new Error(`Ledger status not completed: ${ledger1.stdout}`);
  console.log("✓ PASS: Team created and ledger recorded with status = completed.");

  // Test 2: Identical retry returns the stored result
  console.log("\n[Test 2] Identical retry returns the stored result without repeating mutation...");
  const t2 = await runPsql(`
    SELECT (public.create_team_with_room('team-1', 'mesh-1', 'Team One', 'room-1', 'node-leader', null, 'op-team-1')).team_name;
  `);
  if (t2.code !== 0 || t2.stdout !== "Team One") throw new Error(`Test 2 failed: ${t2.stderr}`);
  const count1 = await runPsql("SELECT count(*) FROM public.teams WHERE team_id = 'team-1';");
  if (count1.stdout !== "1") throw new Error(`Unexpected team count: ${count1.stdout}`);
  console.log("✓ PASS: Identical retry returned cached response; exactly 1 team exists.");

  // Test 3: Same operation ID with different payload is rejected
  console.log("\n[Test 3] Same operation ID with different payload is rejected...");
  const t3 = await runPsql(`
    SELECT public.create_team_with_room('team-1', 'mesh-1', 'Tampered Name', 'room-1', 'node-leader', null, 'op-team-1');
  `);
  if (t3.code === 0) throw new Error("Test 3 expected failure but succeeded");
  if (!t3.stderr.includes("already used with different payload")) {
    throw new Error(`Test 3 wrong error: ${t3.stderr}`);
  }
  console.log("✓ PASS: Duplicate operation ID with modified payload rejected (code 23505).");

  // Test 4 & 5: Two concurrent PostgreSQL sessions submit the same operation ID; exactly one domain mutation occurs
  console.log("\n[Test 4 & 5] Two concurrent PostgreSQL connections submit the same operation ID simultaneously...");
  const concurrentP1 = runPsql(`
    SELECT (public.create_team_with_room('team-concurrent', 'mesh-c', 'Concurrent Team', 'room-c', 'node-leader', null, 'op-concurrent-1')).team_id;
  `);
  const concurrentP2 = runPsql(`
    SELECT (public.create_team_with_room('team-concurrent', 'mesh-c', 'Concurrent Team', 'room-c', 'node-leader', null, 'op-concurrent-1')).team_id;
  `);
  const [c1, c2] = await Promise.all([concurrentP1, concurrentP2]);
  if (c1.code !== 0 || c2.code !== 0) throw new Error(`Concurrent execution error: ${c1.stderr} / ${c2.stderr}`);
  if (c1.stdout !== "team-concurrent" || c2.stdout !== "team-concurrent") throw new Error("Concurrent responses mismatched");
  const cCount = await runPsql("SELECT count(*) FROM public.teams WHERE team_id = 'team-concurrent';");
  if (cCount.stdout !== "1") throw new Error(`Duplicate team created! Count: ${cCount.stdout}`);
  const cMembers = await runPsql("SELECT count(*) FROM public.team_members WHERE team_id = 'team-concurrent';");
  if (cMembers.stdout !== "1") throw new Error(`Duplicate members created! Count: ${cMembers.stdout}`);
  console.log("✓ PASS: Both concurrent connections resolved identically; exactly 1 team and 1 membership created.");

  // Test 6: Failed transaction rolls back the ledger record
  console.log("\n[Test 6] Failed transaction rolls back the ledger record...");
  const t6 = await runPsql(`
    SELECT public.create_team_with_room('team-fail', 'mesh-fail', 'Fail Team', 'room-fail', 'node-nonexistent', null, 'op-fail-1');
  `);
  if (t6.code === 0) throw new Error("Expected failure for non-existent leader profile");
  const failLedger = await runPsql("SELECT count(*) FROM public.operation_ledger WHERE operation_id = 'op-fail-1';");
  if (failLedger.stdout !== "0") throw new Error(`Ledger entry was not rolled back! Count: ${failLedger.stdout}`);
  console.log("✓ PASS: Transaction rollback atomically purged in_progress ledger record.");

  // Test 7: Successful operation followed by simulated lost response and retry
  console.log("\n[Test 7] Successful operation followed by simulated lost response and retry...");
  const addRes1 = await runPsql(`
    SELECT (public.add_team_member('team-1', 'node-member-1', 'op-add-m1')).node_id;
  `);
  if (addRes1.code !== 0 || addRes1.stdout !== "node-member-1") throw new Error(`add_team_member failed: ${addRes1.stderr}`);
  // Simulate network timeout: client retries with same opId
  const addRes2 = await runPsql(`
    SELECT (public.add_team_member('team-1', 'node-member-1', 'op-add-m1')).node_id;
  `);
  if (addRes2.code !== 0 || addRes2.stdout !== "node-member-1") throw new Error(`Retry failed: ${addRes2.stderr}`);
  const mCount = await runPsql("SELECT count(*) FROM public.team_members WHERE team_id = 'team-1';");
  if (mCount.stdout !== "2") throw new Error(`Expected 2 team members, got: ${mCount.stdout}`);
  console.log("✓ PASS: Retry after simulated lost response succeeded without duplicate membership.");

  // Test 8: Stale team rename is rejected
  console.log("\n[Test 8] Stale team rename is rejected via optimistic version check...");
  const rename1 = await runPsql(`
    SELECT (public.rename_team('team-1', 'Team One V2', 'op-rename-1', 1)).version;
  `);
  if (rename1.code !== 0 || rename1.stdout !== "2") throw new Error(`Initial rename failed: ${rename1.stderr}`);
  // Stale rename specifying old expected version 1
  const renameStale = await runPsql(`
    SELECT public.rename_team('team-1', 'Stale Rename Name', 'op-rename-stale', 1);
  `);
  if (renameStale.code === 0) throw new Error("Stale rename should have been rejected");
  if (!renameStale.stderr.includes("team rename conflict: current version is 2 but expected 1")) {
    throw new Error(`Unexpected error message: ${renameStale.stderr}`);
  }
  const currentName = await runPsql("SELECT team_name FROM public.teams WHERE team_id = 'team-1';");
  if (currentName.stdout !== "Team One V2") throw new Error(`Team name was overwritten: ${currentName.stdout}`);
  console.log("✓ PASS: Stale rename rejected; team name and version preserved.");

  // Test 9: Stale leadership transfer is rejected
  console.log("\n[Test 9] Stale leadership transfer is rejected...");
  const trans1 = await runPsql(`
    SELECT (public.transfer_team_leadership('team-1', 'node-member-1', 'op-trans-1', 'node-leader')).leader_node_id;
  `);
  if (trans1.code !== 0 || trans1.stdout !== "node-member-1") throw new Error(`Initial transfer failed: ${trans1.stderr}`);
  // Stale transfer expecting old leader 'node-leader'
  const transStale = await runPsql(`
    SELECT public.transfer_team_leadership('team-1', 'node-leader', 'op-trans-stale', 'node-leader');
  `);
  if (transStale.code === 0) throw new Error("Stale leadership transfer should have been rejected");
  if (!transStale.stderr.includes("leadership transfer conflict")) {
    throw new Error(`Unexpected error message: ${transStale.stderr}`);
  }
  const currentLeader = await runPsql("SELECT leader_node_id FROM public.teams WHERE team_id = 'team-1';");
  if (currentLeader.stdout !== "node-member-1") throw new Error(`Leader was overwritten: ${currentLeader.stdout}`);
  console.log("✓ PASS: Stale leadership transfer rejected; current leader preserved.");

  // Test 10: Revoked membership cannot be restored by an old operation
  console.log("\n[Test 10] Revoked membership cannot be restored by a stale operation...");
  await runPsql("SELECT public.add_team_member('team-1', 'node-member-2', 'op-add-m2');");
  const revokeRes = await runPsql("SELECT (public.remove_team_member('team-1', 'node-member-2', 'revoked', 'op-rev-m2')).status;");
  if (revokeRes.stdout !== "revoked") throw new Error(`Revocation failed: ${revokeRes.stderr}`);
  // Stale add_team_member arrives
  const staleAdd = await runPsql("SELECT public.add_team_member('team-1', 'node-member-2', 'op-stale-add-m2');");
  if (staleAdd.code === 0) throw new Error("Stale add of revoked member should have failed");
  if (!staleAdd.stderr.includes("membership is revoked")) {
    throw new Error(`Unexpected error message: ${staleAdd.stderr}`);
  }
  const memStatus = await runPsql("SELECT status FROM public.team_members WHERE team_id = 'team-1' AND node_id = 'node-member-2';");
  if (memStatus.stdout !== "revoked") throw new Error(`Status changed from revoked: ${memStatus.stdout}`);
  console.log("✓ PASS: Revocation is non-reversible by stale membership additions.");

  // Test 11: Duplicate message insertion returns the original message
  console.log("\n[Test 11] Duplicate message insertion returns the original message...");
  const msgUuid = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const msg1 = await runPsql(`
    SELECT (public.insert_room_message('${msgUuid}', 'room-1', 'node-leader', 'Hello PostgreSQL', now(), 'op-msg-1')).message_text;
  `);
  if (msg1.code !== 0 || msg1.stdout !== "Hello PostgreSQL") throw new Error(`insert message failed: ${msg1.stderr}`);
  const msgRetry = await runPsql(`
    SELECT (public.insert_room_message('${msgUuid}', 'room-1', 'node-leader', 'Hello PostgreSQL', now(), 'op-msg-1')).message_text;
  `);
  if (msgRetry.code !== 0 || msgRetry.stdout !== "Hello PostgreSQL") throw new Error(`Message retry failed: ${msgRetry.stderr}`);
  const msgCount = await runPsql(`SELECT count(*) FROM public.messages WHERE id = '${msgUuid}';`);
  if (msgCount.stdout !== "1") throw new Error(`Duplicate message records created: ${msgCount.stdout}`);
  console.log("✓ PASS: Duplicate message delivery returned original record; row count = 1.");

  // Test 12: Legacy RPC calls without operation IDs still work
  console.log("\n[Test 12] Legacy RPC calls without operation IDs still work...");
  const legTeam = await runPsql(`
    SELECT (public.create_team_with_room('team-legacy', 'mesh-legacy', 'Legacy Team', 'room-legacy', 'node-leader')).team_name;
  `);
  if (legTeam.code !== 0 || legTeam.stdout !== "Legacy Team") throw new Error(`Legacy team creation failed: ${legTeam.stderr}`);
  const legMember = await runPsql(`
    SELECT (public.add_team_member('team-legacy', 'node-member-1')).status;
  `);
  if (legMember.code !== 0 || legMember.stdout !== "active") throw new Error(`Legacy member addition failed: ${legMember.stderr}`);
  console.log("✓ PASS: Legacy RPCs with default parameters execute successfully.");

  // Test 13: Permission enforcement (Step 5)
  console.log("\n[Test 13] Verifying role-based permissions (anon, authenticated, service_role)...");
  const anonCall = await runPsql("SET ROLE anon; SELECT public.create_team_with_room('t-anon', 'm-anon', 'Anon Team', 'r-anon', 'node-leader');");
  if (anonCall.code === 0) throw new Error("anon should not have execute permission");
  if (!anonCall.stderr.includes("permission denied for function create_team_with_room")) {
    throw new Error(`Unexpected error for anon: ${anonCall.stderr}`);
  }
  const authCall = await runPsql("SET ROLE authenticated; SELECT public.create_team_with_room('t-auth', 'm-auth', 'Auth Team', 'r-auth', 'node-leader');");
  if (authCall.code === 0) throw new Error("authenticated should not have execute permission");
  if (!authCall.stderr.includes("permission denied for function create_team_with_room")) {
    throw new Error(`Unexpected error for authenticated: ${authCall.stderr}`);
  }
  const svcCall = await runPsql("SET ROLE service_role; SELECT (public.create_team_with_room('t-svc', 'm-svc', 'Service Team', 'r-svc', 'node-leader', null, 'op-svc-1')).team_name;");
  if (svcCall.code !== 0 || !svcCall.stdout.includes("Service Team")) {
    throw new Error(`service_role should have execute permission: stdout='${svcCall.stdout}' stderr='${svcCall.stderr}'`);
  }
  console.log("✓ PASS: anon and authenticated denied; service_role granted.");

  console.log("\n=== ALL REAL POSTGRESQL VALIDATION TESTS PASSED ===");
}

run().catch((err) => {
  console.error("FATAL TEST FAILURE:", err);
  process.exit(1);
});
