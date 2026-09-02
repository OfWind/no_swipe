import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOOP_ROOT = path.join(ROOT, "skills/no-swipe-release-loop");
const VERIFIER = path.join(LOOP_ROOT, "scripts/verify_candidate.mjs");

test("release-loop skill separates maintenance from ordinary collection and preserves authority", async () => {
  const skill = await fs.readFile(path.join(LOOP_ROOT, "SKILL.md"), "utf8");

  assert.match(skill, /use the sibling `douyin-recommendation-rpa` skill instead/i);
  assert.match(skill, /read that sibling skill completely from the exact candidate plugin root/i);
  assert.match(skill, /request only to test or diagnose[\s\S]*does not authorize a source fix/i);
  assert.match(skill, /Commit, push, upload, deploy, release, promote[\s\S]*explicit request/i);
  assert.match(skill, /Never edit `~\/\.codex\/plugins\/cache`/);
  assert.match(skill, /every new Codex task.*https:\/\/www\.douyin\.com\/user\/self/smi);
  assert.match(skill, /retry.*once.*exact nickname.*matches exactly one/smi);
  assert.match(skill, /never open another creator's homepage/i);
  assert.doesNotMatch(skill, /never open the logged-in account's own profile/i);
});

test("release-loop skill closes every iteration on a new immutable candidate", async () => {
  const skill = await fs.readFile(path.join(LOOP_ROOT, "SKILL.md"), "utf8");
  const baseline = skill.indexOf("### 1. Open a cycle record");
  const reproduce = skill.indexOf("### 2. Reproduce at the lowest failing layer");
  const install = skill.indexOf("### 4. Stage and install a local candidate");
  const live = skill.indexOf("### 5. Run progressive live acceptance");
  const replay = skill.indexOf("### 7. Fix the source and replay the failure");
  const decide = skill.indexOf("### 8. Decide candidate status");

  assert.ok(baseline >= 0 && baseline < reproduce && reproduce < install);
  assert.ok(install < live && live < replay && replay < decide);
  assert.match(skill, /Any source, Skill, reference, script, fixture, package metadata, or binary change invalidates the prior candidate result/);
  assert.match(skill, /Every shipped-file change increments the semantic version/);
  assert.match(skill, /Build metadata alone is not a version bump/);
  assert.match(skill, /Never carry a pass from an older build ID into the new cycle/);
  assert.match(skill, /1-item, 10-item, and full target gates/);
});

test("release-loop acceptance keeps browser and upload evidence independent", async () => {
  const [skill, browser, matrix] = await Promise.all([
    fs.readFile(path.join(LOOP_ROOT, "SKILL.md"), "utf8"),
    fs.readFile(path.join(LOOP_ROOT, "references/browser-protocol.md"), "utf8"),
    fs.readFile(path.join(LOOP_ROOT, "references/acceptance-matrix.md"), "utf8"),
  ]);

  assert.match(browser, /pass in one does not prove the other works/i);
  assert.match(browser, /separate browser bindings, tabs, run IDs, SQLite files, and evidence/i);
  assert.match(browser, /tool call returning success is not a verified transition/i);
  assert.match(skill, /browser hot path must not depend on remote upload completion/i);
  assert.match(skill, /local `sent` row as server acceptance without the ACK/i);
  assert.match(matrix, /transition_ok=null/);
  assert.match(matrix, /pending=0.*transition_pending=0.*dead=0/s);
});

test("release-loop keeps candidate CLI bytes and data outside the formal runtime", async () => {
  const [loop, runtime] = await Promise.all([
    fs.readFile(path.join(LOOP_ROOT, "SKILL.md"), "utf8"),
    fs.readFile(path.join(ROOT, "skills/douyin-recommendation-rpa/SKILL.md"), "utf8"),
  ]);

  assert.match(loop, /\.config\/no-swipe\/candidates\/<candidate-build-id>\/no-swipe/);
  assert.match(loop, /Never overwrite, prune, or invoke `~\/\.config\/no-swipe\/bin\/<base-version>\/no-swipe` as candidate evidence/);
  assert.match(loop, /cycle-specific test data directory/);
  assert.match(runtime, /candidate-specific binary and test data directory recorded by that cycle/);
  assert.match(runtime, /do not run bootstrap.*candidate binary.*up --data-dir/s);
});

test("release-loop references are complete and routed from the entrypoint", async () => {
  const skill = await fs.readFile(path.join(LOOP_ROOT, "SKILL.md"), "utf8");
  for (const relative of [
    "references/acceptance-matrix.md",
    "references/browser-protocol.md",
    "references/release-gates.md",
    "scripts/verify_candidate.mjs",
    "agents/openai.yaml",
  ]) {
    await fs.access(path.join(LOOP_ROOT, relative));
  }
  assert.match(skill, /Always read \[references\/acceptance-matrix\.md\]/);
  assert.match(skill, /Read \[references\/browser-protocol\.md\].*before controlling either browser/);
  assert.match(skill, /Read \[references\/release-gates\.md\].*only when the user asks to publish/);
});

test("candidate verifier normalizes only source build metadata and detects installed drift", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "no-swipe-candidate-verifier-"));
  const source = path.join(temp, "source");
  const candidate = path.join(temp, "candidate");
  const installed = path.join(temp, "installed");
  try {
    await fs.cp(ROOT, source, { recursive: true });
    await fs.cp(source, candidate, { recursive: true });
    const candidateManifestPath = path.join(candidate, ".codex-plugin/plugin.json");
    const candidateManifest = JSON.parse(await fs.readFile(candidateManifestPath, "utf8"));
    candidateManifest.version = `${candidateManifest.version.split("+", 1)[0]}+codex.verifier-test`;
    await fs.writeFile(candidateManifestPath, `${JSON.stringify(candidateManifest, null, 2)}\n`);
    await fs.cp(candidate, installed, { recursive: true });

    const success = await execFileAsync(process.execPath, [
      VERIFIER,
      "--source", source,
      "--candidate", candidate,
      "--installed", installed,
    ]);
    const accepted = JSON.parse(success.stdout);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.source_to_candidate.ok, true);
    assert.equal(accepted.candidate_to_installed.ok, true);

    await fs.appendFile(path.join(installed, "skills/no-swipe-release-loop/SKILL.md"), "\ninstalled drift\n");
    await assert.rejects(
      execFileAsync(process.execPath, [
        VERIFIER,
        "--source", source,
        "--candidate", candidate,
        "--installed", installed,
      ]),
      (error) => {
        const rejected = JSON.parse(error.stdout);
        assert.equal(rejected.ok, false);
        assert.deepEqual(rejected.candidate_to_installed.mismatched, [
          "skills/no-swipe-release-loop/SKILL.md",
        ]);
        return true;
      },
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
