import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ConfigValidationError,
  computeConfigHash,
  quotaConfigFromRunConfig,
  validateRunConfig,
} from "../src/config.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const readFixture = () => JSON.parse(readFileSync(
  path.resolve(TEST_DIR, "../../plugins/no-swipe/tests/fixtures/run-config.draft.example.json"),
  "utf8",
));

test("CLI config rejects homepage access in new runs", () => {
  const unsafeDraft = readFixture();
  unsafeDraft.interaction_policy.profile_sampling = { rate: 1, max_total: 50 };
  unsafeDraft.authorization.profile_visit = true;
  assert.throws(() => validateRunConfig(unsafeDraft), ConfigValidationError);
});

test("CLI keeps a legacy sealed config hash-readable but disables homepage access at runtime", () => {
  const legacyConfirmed = readFixture();
  legacyConfirmed.interaction_policy.profile_sampling = { rate: 1, max_total: 50 };
  legacyConfirmed.authorization.profile_visit = true;
  legacyConfirmed.status = "confirmed";
  legacyConfirmed.confirmed_at = "2026-08-13T08:00:00.000Z";
  legacyConfirmed.confirmed_by = "user";
  legacyConfirmed.config_hash = computeConfigHash(legacyConfirmed);

  assert.equal(validateRunConfig(legacyConfirmed, { requireConfirmed: true }), legacyConfirmed);
  assert.deepEqual(quotaConfigFromRunConfig(legacyConfirmed).profileVisit, {
    authorized: false,
    rate: 0,
    maxTotal: 0,
  });
});
