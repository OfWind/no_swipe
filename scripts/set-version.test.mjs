import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertVersionState,
  createBuildStamp,
  setVersion,
  VERSION_FILES,
} from "./set-version.mjs";

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function createFixture({
  version = "0.4.12",
  lockVersion = version,
  cloudVersion = version,
  includeMarketplacePlugin = true,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "no-swipe-version-"));
  const files = Object.fromEntries(Object.entries(VERSION_FILES).map(
    ([key, relative]) => [key, path.join(root, relative)],
  ));

  await writeJson(files.marketplace, {
    name: "no-swipe-marketplace",
    version,
    preserved: true,
    plugins: includeMarketplacePlugin ? [{ name: "no-swipe", version }] : [],
  });
  await writeJson(files.pluginManifest, {
    name: "no-swipe",
    version: `${version}+codex.20260901000000`,
    preserved: true,
  });
  await writeJson(files.pluginPackage, { name: "no-swipe-plugin", version, private: true });
  await writeJson(files.pluginPackageLock, {
    name: "no-swipe-plugin",
    version: lockVersion,
    lockfileVersion: 3,
    packages: { "": { name: "no-swipe-plugin", version: lockVersion } },
  });
  await writeJson(files.cliVersion, { version });
  await writeJson(files.supabase, { contract_version: 2, plugin_version: version });
  await writeJson(files.cliPackage, { name: "no-swipe-cli", version, private: true });
  await fs.mkdir(path.dirname(files.cloud), { recursive: true });
  await fs.writeFile(files.cloud, `export const CLOUD = {\n  plugin_version: "${cloudVersion}",\n};\n`);

  return { root, files };
}

test("setVersion synchronizes every release surface and repairs lockfile drift", async () => {
  const fixture = await createFixture({ lockVersion: "0.2.6" });
  try {
    const result = setVersion("0.4.13", {
      root: fixture.root,
      buildStamp: "20260901210000",
    });

    assert.deepEqual(result, {
      ok: true,
      version: "0.4.13",
      pluginBuild: "0.4.13+codex.20260901210000",
      surfaceCount: 10,
    });
    assert.deepEqual(assertVersionState(fixture.root, "0.4.13"), result);

    const marketplace = JSON.parse(await fs.readFile(fixture.files.marketplace, "utf8"));
    const pluginManifest = JSON.parse(await fs.readFile(fixture.files.pluginManifest, "utf8"));
    const packageLock = JSON.parse(await fs.readFile(fixture.files.pluginPackageLock, "utf8"));
    assert.equal(marketplace.preserved, true);
    assert.equal(pluginManifest.preserved, true);
    assert.equal(packageLock.version, "0.4.13");
    assert.equal(packageLock.packages[""].version, "0.4.13");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("assertVersionState identifies the drifting surface", async () => {
  const fixture = await createFixture({ cloudVersion: "0.4.11" });
  try {
    assert.throws(
      () => assertVersionState(fixture.root, "0.4.12"),
      /cloud="0\.4\.11"/,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("setVersion validates every target before writing", async () => {
  const fixture = await createFixture({ includeMarketplacePlugin: false });
  try {
    const before = await fs.readFile(fixture.files.cliVersion, "utf8");
    assert.throws(
      () => setVersion("0.4.13", { root: fixture.root, buildStamp: "20260901210000" }),
      /does not contain the no-swipe plugin entry/,
    );
    assert.equal(await fs.readFile(fixture.files.cliVersion, "utf8"), before);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("setVersion refuses to restamp the current semantic version", async () => {
  const fixture = await createFixture({ version: "0.4.14" });
  try {
    assert.throws(
      () => setVersion("0.4.14", { root: fixture.root, buildStamp: "20260902150000" }),
      /already current.*increment the semantic version/i,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("createBuildStamp is stable for a supplied local date", () => {
  assert.equal(createBuildStamp(new Date(2026, 8, 1, 21, 2, 3)), "20260901210203");
});
