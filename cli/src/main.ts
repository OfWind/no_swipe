#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { authLogin, authLogout, authStatus, pollPairing } from "./auth.ts";
import { exportCsv, finishSession, insertObservation, startSession, statusSession } from "./collector.ts";
import { runConfig } from "./config_cmd.ts";
import { runStep } from "./step.ts";
import { syncOutbox } from "./sync.ts";

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readJsonArg(args: string[]) {
  const file = option(args, "--json-file");
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const raw = option(args, "--json");
  if (raw) return JSON.parse(raw);
  if (!process.stdin.isTTY) return JSON.parse(readFileSync(0, "utf8") || "{}");
  return {};
}

function print(value: unknown) {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

async function main(args: string[]) {
  const [command, sub, ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    print("no-swipe auth|config|start|record|status|finish|export|sync|step");
    return 0;
  }
  if (command === "config") {
    print(await runConfig([sub, ...rest]));
    return 0;
  }
  if (command === "auth" && sub === "login") {
    const started = await authLogin();
    print({ status: "pending", code: started.code, pair_url: started.pair_url });
    if (args.includes("--no-wait")) return 0;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      const result = await pollPairing(started.code, started.device_secret);
      if (result.status === "approved") {
        print(result);
        return 0;
      }
      await Bun.sleep(2000);
    }
    throw new Error("pairing timed out");
  }
  if (command === "auth" && sub === "status") {
    print(await authStatus());
    return 0;
  }
  if (command === "auth" && sub === "logout") {
    print(authLogout());
    return 0;
  }
  const db = option(args, "--db") || ".no-swipe/runs/current/douyin_rpa_session.sqlite";
  if (command === "start") {
    print(startSession(
      db,
      Number(option(args, "--target") || 1000),
      args.includes("--relevant") ? "relevant" : "observed",
      args.includes("--new"),
    ));
    return 0;
  }
  if (command === "record") {
    print(insertObservation(db, readJsonArg(args)));
    return 0;
  }
  if (command === "status") {
    print(statusSession(db));
    return 0;
  }
  if (command === "finish") {
    print(finishSession(db));
    return 0;
  }
  if (command === "export") {
    print(exportCsv(db, option(args, "--csv") || "observations.csv", option(args, "--target-csv") || "target.csv"));
    return 0;
  }
  if (command === "sync") {
    print(await syncOutbox(db, { force: !args.includes("--no-force") }));
    return 0;
  }
  if (command === "step") {
    const payload = readJsonArg(args);
    print(runStep({
      dbPath: db,
      runConfig: payload.runConfig || payload.run_config,
      page: payload.page || payload,
      evidence: payload.evidence ?? null,
      record_id: payload.record_id,
      action_results: payload.action_results,
    }));
    return 0;
  }
  throw new Error(`unsupported command: ${command} ${sub ?? ""}`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.name || "Error", message: error.message })}\n`);
  process.exitCode = 1;
});
