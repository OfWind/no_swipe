import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COLLECTOR_PATH = fileURLToPath(new URL("./douyin_rpa_collector.py", import.meta.url));

function defaultPython() {
  return process.env.PYTHON || process.env.PYTHON3 || "python3";
}

function spawnCollector(args, { python = defaultPython(), input = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [COLLECTOR_PATH, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`collector timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(errorOutput || output || `collector exited ${code}`));
        return;
      }
      if (!output) {
        reject(new Error(errorOutput || "collector returned empty output"));
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error(`collector returned invalid JSON: ${output}`));
      }
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function createCollectorClient({ dbPath, python = defaultPython() } = {}) {
  if (!dbPath || typeof dbPath !== "string") throw new Error("dbPath 必须是非空路径");

  function run(args, options = {}) {
    return spawnCollector(["--db", dbPath, ...args], { python, ...options });
  }

  return {
    dbPath,
    start({ target, allVideos = false, forceNew = false } = {}) {
      const args = ["start", "--target", String(target ?? 100)];
      if (allVideos) args.push("--all-videos");
      if (forceNew) args.push("--new");
      return run(args);
    },
    async record(observation) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "no-swipe-record-"));
      const payloadPath = path.join(directory, "observation.json");
      try {
        await fs.writeFile(payloadPath, JSON.stringify(observation), "utf8");
        return await run(["record", "--json-file", payloadPath]);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
    status() {
      return run(["status"]);
    },
    sync({ force = false } = {}) {
      const args = ["sync"];
      if (force) args.push("--force");
      return run(args);
    },
    runnerState({ runId, configHash } = {}) {
      const args = ["runner-state"];
      if (runId) args.push("--run-id", runId);
      if (configHash) args.push("--config-hash", configHash);
      return run(args);
    },
    ack(payload) {
      return run(["mcp-ack"], { input: `${JSON.stringify(payload)}\n` });
    },
  };
}
