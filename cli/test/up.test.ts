import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// CONFIG_DIR is resolved at import time, so point it at an empty temp
// directory before loading the module under test.
process.env.NO_SWIPE_AUTH_DIR = mkdtempSync(path.join(tmpdir(), "no-swipe-up-auth-"));
const { up } = await import("../src/up.ts");

test("up reports auth_login with no credentials and stays offline-safe", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "no-swipe-up-data-"));
  const result = await up(dataDir);
  expect(result.ok).toBe(true);
  expect(result.auth.connected).toBe(false);
  expect(result.next).toBe("auth_login");
  expect(result.accounts).toEqual([]);
  expect(typeof result.workbench_url).toBe("string");
  expect(result.workbench_url.startsWith("https://")).toBe(true);
  expect(typeof result.plugin_version).toBe("string");
});

test("up tolerates a missing data dir without throwing", async () => {
  const result = await up(path.join(tmpdir(), "no-swipe-up-missing", "nested"));
  expect(result.ok).toBe(true);
  expect(Array.isArray(result.accounts)).toBe(true);
});
