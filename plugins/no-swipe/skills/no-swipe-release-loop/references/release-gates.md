# Release and promotion gates

Read this reference only after a candidate is accepted and the user explicitly requests publication, deployment, commit, push, or promotion.

## Pre-release gate

Require all of the following on one candidate build ID:

- automated tests, syntax checks, and package verification pass;
- the required built-in and external browser stages pass;
- SQLite/outbox integrity and server ACK reconciliation pass;
- workbench visibility passes when it is part of the release claim;
- no unexplained failure or stale candidate result remains;
- the repository diff is reviewed and unrelated files are excluded;
- secrets, local credentials, run databases, exports, and candidate caches are not staged.

If persistent data, public contracts, queued uploads, or deployed services change, add and verify a safe migration/rollout plan before release. A local compatibility shim is not a substitute for that migration.

## Version and artifact rules

- Run `./scripts/set-version.mjs <x.y.z>` from the authoritative repository to update every version surface, then run `./scripts/set-version.mjs --check <x.y.z>` before build or commit. Do not hand-edit the individual manifests, pin, cloud constant, or lockfile.
- Candidate build metadata identifies a local immutable file set.
- A published semantic version identifies immutable plugin metadata and CLI artifacts.
- Never overwrite published Storage objects under an existing version.
- Build every supported release artifact and verify the generated manifest hashes.
- The plugin manifest base version, marketplace version, plugin package version, CLI package version, pinned CLI version, and baked cloud plugin version must agree.
- Keep the plugin version, CLI version, and CLI artifact hash as separate reported facts.

Use the repository release script without skip flags for the final release unless the omitted gate has already run on the exact unchanged source and the exception is documented. Do not use `--push`, upload artifacts, commit, or deploy unless the user explicitly requested that action.

## Publication is not activation

After the remote release succeeds:

1. verify the marketplace/repository publication and immutable artifacts;
2. refresh/install the published plugin locally;
3. open a clean Codex task so Skill/plugin activation is fresh;
4. run bootstrap and verify the downloaded binary version and hash;
5. run the one-item zero-interaction release smoke;
6. reconcile SQLite/outbox and server ACK;
7. report remote publication and local activation separately.

Do not reuse a local-candidate cache as proof of the published package.

## Rollback

Before promotion, identify the last accepted published version and confirm its artifacts remain available. If the published smoke fails:

- stop new live runs;
- preserve current SQLite/outbox data;
- reinstall the prior accepted immutable version;
- verify its binary hash and run a bounded smoke;
- diagnose forward from the failed release without rewriting its artifacts.

Database or backend rollback requires its own data-safety plan. Never roll back schema or delete queued data merely to make the plugin appear healthy.

## Release report

Report:

- accepted candidate build ID and source commit;
- semantic release version and artifact hashes;
- automated and live acceptance results;
- publication location/state;
- locally installed published version/path;
- release-smoke result;
- rollback version;
- commit and push state.

Use `not run` for every omitted gate and limit the release claim accordingly.
