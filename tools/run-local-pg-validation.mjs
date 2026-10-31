import { spawn, spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";

const PG_BIN = "C:\\Program Files\\PostgreSQL\\16\\bin";
const PG_CTL = `"${PG_BIN}\\pg_ctl.exe"`;
const PSQL = `"${PG_BIN}\\psql.exe"`;
const INITDB = `"${PG_BIN}\\initdb.exe"`;
const DATA_DIR = "C:\\Temp\\pg_test_db";
const LOG_FILE = "C:\\Temp\\pg_test.log";
const PORT = "54332";

function psql(sql, db = "postgres") {
  const cmd = `${PSQL} -h 127.0.0.1 -p ${PORT} -U postgres -d ${db} -t -A -c "${sql.replace(/"/g, '\\"')}"`;
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function psqlFile(file, db = "postgres") {
  const cmd = `${PSQL} -h 127.0.0.1 -p ${PORT} -U postgres -d ${db} -f "${file}"`;
  return execSync(cmd, { encoding: "utf8" }).trim();
}

async function main() {
  console.log("=== Starting Isolated PostgreSQL Validation on Port 54332 ===");

  if (!existsSync(`${DATA_DIR}\\PG_VERSION`)) {
    console.log("Initializing database directory...");
    execSync(`${INITDB} -D "${DATA_DIR}" -U postgres -A trust`, { encoding: "utf8" });
  }

  console.log("Starting PostgreSQL server on port 54332...");
  // Use start /b or execSync with pg_ctl
  try {
    execSync(`${PG_CTL} -D "${DATA_DIR}" -o "-p ${PORT}" -l "${LOG_FILE}" start`, {
      encoding: "utf8",
      timeout: 10000,
    });
  } catch (e) {
    console.log("pg_ctl start returned:", e.message);
  }

  try {
    console.log("Waiting for PostgreSQL to be ready...");
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = psql("SELECT 1;");
        if (res === "1") {
          ready = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!ready) throw new Error("PostgreSQL server failed to accept connections.");
    console.log("PostgreSQL server is ready!");

    console.log("Creating test roles (anon, authenticated, service_role)...");
    for (const role of ["anon", "authenticated", "service_role"]) {
      try {
        psql(`CREATE ROLE ${role} NOLOGIN;`);
      } catch (e) {
        // ignore if already exists
      }
    }

    console.log("Creating database nodes_smoke_test...");
    try { psql("DROP DATABASE IF EXISTS nodes_smoke_test;"); } catch {}
    psql("CREATE DATABASE nodes_smoke_test;");

    console.log("Applying Migration 1 (20261031000000_shared_nodes_smoke.sql)...");
    psqlFile("C:\\Users\\Asus\\Downloads\\NODES-main\\supabase\\migrations\\20261031000000_shared_nodes_smoke.sql", "nodes_smoke_test");

    console.log("Applying Migration 2 (20261031010000_remote_idempotency_ledger.sql)...");
    psqlFile("C:\\Users\\Asus\\Downloads\\NODES-main\\supabase\\migrations\\20261031010000_remote_idempotency_ledger.sql", "nodes_smoke_test");

    // Supabase service_role has table permissions and bypassrls by default
    psql("ALTER ROLE service_role BYPASSRLS;", "nodes_smoke_test");
    psql("GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;", "nodes_smoke_test");
    psql("GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;", "nodes_smoke_test");

    console.log("\n--- Running test-postgres-idempotency.mjs ---");
    const test1 = spawnSync("node", ["C:\\Users\\Asus\\Downloads\\NODES-main\\tools\\test-postgres-idempotency.mjs"], {
      stdio: "inherit",
      encoding: "utf8",
    });
    if (test1.status !== 0) throw new Error("test-postgres-idempotency.mjs FAILED");

    console.log("\n--- Running test-rollback.mjs ---");
    const test2 = spawnSync("node", ["C:\\Users\\Asus\\Downloads\\NODES-main\\tools\\test-rollback.mjs"], {
      stdio: "inherit",
      encoding: "utf8",
    });
    if (test2.status !== 0) throw new Error("test-rollback.mjs FAILED");

    console.log("\n=== ALL POSTGRESQL VALIDATIONS SUCCEEDED ===");
  } finally {
    console.log("Stopping PostgreSQL server on port 54332...");
    try {
      execSync(`${PG_CTL} -D "${DATA_DIR}" stop`, { encoding: "utf8" });
    } catch (e) {
      console.error("Stop error:", e.message);
    }
  }
}

main().catch((err) => {
  console.error("Validation failed:", err);
  process.exit(1);
});
