import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const workbench = "https://fai.zhuanspirit.com/creators";

// A fresh process isolates module-level paths and environment from other tests.
function probe(config: Record<string, unknown> | null, override = "") {
  const dir = mkdtempSync(path.join(tmpdir(), "no-swipe-cloud-"));
  try {
    const configPath = path.join(dir, "supabase.json");
    if (config) writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({
      workbench_url: "https://legacy.example/workbench",
    }));
    const result = Bun.spawnSync([process.execPath, "-e", `
      import { loadCloudConfig } from "./src/cloud.ts";
      import { authLogin } from "./src/auth.ts";
      import { up } from "./src/up.ts";
      const startup = await up(process.env.NO_SWIPE_DATA_DIR);
      globalThis.fetch = async () => Response.json({ code: "TEST CODE" });
      const pairing = await authLogin();
      console.log(JSON.stringify({
        configured: loadCloudConfig().workbench_url,
        startup: startup.workbench_url,
        pair: pairing.pair_url,
      }));
    `], {
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        NO_SWIPE_AUTH_DIR: dir,
        NO_SWIPE_DATA_DIR: path.join(dir, "data"),
        NO_SWIPE_SUPABASE_CONFIG: configPath,
        NO_SWIPE_WORKBENCH_URL: override,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(new TextDecoder().decode(result.stdout));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("baked workbench preserves the intranet prefix through pairing and startup", () => {
  expect(probe(null)).toEqual({
    configured: workbench,
    startup: workbench,
    pair: `${workbench}/pair?code=TEST%20CODE`,
  });
});

test("current endpoint replaces the credential URL and normalizes a trailing slash", () => {
  expect(probe({ workbench_url: `${workbench}/` })).toEqual({
    configured: workbench,
    startup: workbench,
    pair: `${workbench}/pair?code=TEST%20CODE`,
  });
});

test("explicit workbench override wins over persisted configuration", () => {
  const override = "https://preview.example/creators";
  expect(probe({ workbench_url: workbench }, `${override}/`)).toEqual({
    configured: override,
    startup: override,
    pair: `${override}/pair?code=TEST%20CODE`,
  });
});
