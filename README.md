# @agentorg/plugin-skills

Trusted, separately loadable AgentOrg API-v1 plugin. Requires Bun, Git and the generic API-v1 extension contract in this checkout. Local path import requires Linux with `/proc/self/fd`. TUI and Pi integration are not validated by the socket-to-ACP tests; container workspace identity is unsupported.

```sh
cd agentorg-plugin-skills && bun install --frozen-lockfile
cd ../agentorg
# Load the separate Pi harness too if using harness: "pi" (install its deps first).
bun start --plugin ../agentorg-plugin-pi-agent/src/index.ts --plugin ../agentorg-plugin-skills/src/index.ts
# Optional containment (either plugin order works):
bun start --plugin ../agentorg-plugin-pi-agent/src/index.ts --plugin ../agentorg-plugin-unique-cwd/src/index.ts --plugin ../agentorg-plugin-skills/src/index.ts
```

The plugin has no runtime dependency on core internals; core imports are type-only. For a compiled AgentOrg binary, run `bun run build` here and load `--plugin /absolute/path/dist/skills.js`. Ship that single bundled module: it includes `yaml` and `zod`, since compiled Bun hosts do not reliably resolve external plugins' npm dependencies. Source-mode servers can load `src/index.ts` with its installed dependencies. The plugin uses generic namespaced settings, lifecycle participants, initialization, launch environment and capability discovery ([host contract](../agentorg/EXTENSIONS.md)); core has no skills semantics and never exposes its database. Other harnesses must explicitly consume the JSON `AGENTORG_SKILL_FILES` launch environment and declare it in `LaunchSpec.consumesEnv`. The adapter may provide explicit Pi skill arguments, but Pi/TUI behavior is unverified here; no container-specific workspace identity is implemented.

## Local E2E validation

From this plugin checkout, build/check both authorized feature copies, then run the same socket-to-ACP scenario against source mode and the relocated compiled host with bundled plugins:

```sh
bun run check && bun run build
(cd ../agentorg && bun run check && bun run build)
SKILLS_E2E_MODE=source bun test tests/local-e2e.test.ts tests/bundle-parity.test.ts
ORG_BINARY=../agentorg/dist/agentorg SKILLS_E2E_MODE=bundled bun test tests/binary-loading.test.ts tests/local-e2e.test.ts
```

The E2E fixture is deterministic and makes no model or network calls. Server-path registration is supported only on Linux with `/proc/self/fd`; local Git additionally requires bounded self-contained SHA-1 history. Limits include 128 KiB root `SKILL.md`, 256 MiB payload/object storage, 20,000 entries, 4,096 refs plus HEAD, 100,000 objects/files, 1,024 packs, 4 MiB metadata, and the existing per-process Git timeout. The fixture copies the binary and bundles into a temporary runtime, then restarts those relocated artifacts.

## API

> **Negotiate the unified registration contract.** A compatible host advertises `organization.snapshot.capabilities.plugins.skills.repositoryRegistration` with `version: 1`, `history: "preserve-v1"`, and supported `sourceKinds`. Use only the client endpoint `skills.registerRepository` with the exact request `{source: string}`. The source is one HTTPS Git URL or a server-side path; no name/source-kind fields are accepted. Registration uses the validated root `SKILL.md` for both catalog name and description, and never assigns or installs a skill for an agent.

- HTTPS URLs use the existing host allowlist (GitHub, GitLab, Bitbucket), without credentials, ports, query/fragment or redirects. URL-looking unsupported transports such as SSH, SCP and `file://` fail closed and are never interpreted as paths. Path support is capability-advertised and requires Linux with usable `/proc/self/fd`; absolute, relative, and `~/...` locations are resolved on the server. The name and description are derived from validated root metadata.
- Success returns the catalog record also exposed in `skills.list` and `skills.catalog_added`, including `source`, managed `path`, `createdAt`, `origin`, and explicit `history` metadata. `source.path` is the canonical original path for local sources; `source.gitUrl` identifies Git sources. The managed checkout is independent from its source. Duplicate name/source admissions fail with `DUPLICATE`; they never replace an existing record.
- For local Git roots, the importer reads Git metadata as data (it never invokes Git with the source as cwd or `--git-dir`), accepts only bounded self-contained SHA-1 ordinary worktrees, and copies only verified object data into managed storage. It retains supported branches, tags, and HEAD ancestry. Dirty, untracked, and ignored working-tree bytes are materialized in a new child commit without changing the source repository. Historical commits may retain secrets or deleted sensitive data even when absent from current files; choose a narrow trusted root. Unsupported layouts, malformed objects/refs, gitlinks, and excessive history fail rather than falling back to a shallow/snapshot-only clone. Non-Git directories are initialized as a single managed snapshot commit. The installed copy excludes `.git` entries; symlinks and special files are rejected. Copying detects observed mutations but cannot guarantee an atomic snapshot against concurrent same-user writers.
- History is explicit: `git-preserved` means the bounded branches/tags/HEAD ref set was verified; `directory-initialized` is a new one-commit directory snapshot; `legacy-git` / `legacy-snapshot` means prior provenance was not newly verified. No legacy record is upgraded to claim preserved history merely by migration.
- Intent is journaled before staging; interrupted imports and artifacts remain diagnostic data and are not automatically registered or cleaned up. Publication commits catalog state and clears the journal in a plugin SQLite transaction; Git/filesystem changes and event delivery are not part of that transaction. Local paths never trigger Git on the source, credentials, or network access. Limits include 128 KiB root metadata, 256 MiB payload/object transfer, 20,000 admitted files/tree entries, 4,096 refs plus HEAD, 100,000 objects, 1,024 packs, and 4 MiB ref/config metadata.
- Errors include `UNSUPPORTED_SOURCE` for unsupported locator/layout/history, `INCOMPLETE_HISTORY` for invalid/incomplete Git objects, `INVALID_PATH`, `DUPLICATE`, and `LIMIT`; authorization is checked first. `skills.add` (`{name, gitUrl}`) and `skills.addFromPath` (`{path}`) remain legacy socket APIs for compatibility; the TUI uses only `skills.registerRepository`. When supported, `localImportHistory: "preserve-v1"` advertises the intentional future-call history-preserving behavior change for legacy `skills.addFromPath` Git imports; callers retain the exact `{path}` request and existing `localImport`/endpoint gate.

Socket clients only:

- `skills.registerRepository`: exact `{source: string}` → metadata-derived registered catalog record. No explicit name, source kind, or revision-selection field is accepted.
- `skills.retireRepository` / `skills.restoreRepository`: exact `{name, source, expectedStatus}` operations, client-only. `source` is the catalog's exact source object and `expectedStatus` is `ready` for retirement or `retired` for restoration. The server rechecks both name/source identity and current status before updating. Only manual catalog entries are manageable; configured seeds are rejected.
- `skills.deleteRepository`: exact `{name, source, expectedStatus}`, client-only, permanently removes one manual skill. It first reserves the entry as retired to block new grants, then revision-fenced clears assignments from active agents, removes only plugin-owned installation/recovery directories with verified markers, removes the central managed checkout/history, and deletes catalog/installation/repository-state rows. The original local source path is never deleted. Active agent work, pending recovery, ambiguous journals, unowned paths, and configured seeds block deletion. On partial failure the record remains retired and can be reviewed/retried; running agents are never stopped by this endpoint.
- `skills.add`: legacy `{name, gitUrl}` registration remains available for compatibility. Names use lowercase letters/numbers and single hyphens, at most 64 characters. Both names and canonical URL strings must be unique; duplicates are errors, not updates.
- `skills.list`: `{}` → `{skills, managed, retained, reconciliation, recovery, repositoryRecovery}`. `skills` contains active/grantable catalog records; `managed` contains actual manual catalog entries with `status: ready|retired`; `retained` contains configured Git records no longer in the desired seed list. `reconciliation` reports desired Git-seed readiness; `recovery` contains pending per-agent recovery/install work; `repositoryRecovery` contains retained catalog-level journal/stage artifacts, including interrupted local imports. These fields represent different states and are not interchangeable.

Catalog retirement is reversible and non-destructive. A retired record remains persisted with the same name/source identity, reserves both against duplicates and counts against catalog capacity; central history, existing agent selections, installations, recovery state and files remain untouched. Retired entries disappear from active grants; existing unchanged assignments continue to resolve and launch. Restore returns the same record to the active catalog. Permanent deletion is a separate, explicit operation: it cascades assignment removal and deletes only verified plugin-owned installed/recovery copies and the central managed checkout/history. It does not stop running agents or delete the original source path.
- `skills.reconcile`: client-only `{}` request that returns `{accepted: true, reconciliation: <current status>}` and schedules an asynchronous reconciliation pass for configured Git seeds. It is a retry/reconcile trigger, not a source refresh; it never recopies local source directories or updates local snapshots.
- `organization.snapshot.capabilities.plugins.skills` preserves API version 1 and existing keys, and advertises `repositoryRegistration: {version: 1, sourceKinds: ["https", "server-path"], history: "preserve-v1"}` when local path support is available (`sourceKinds: ["https"]` otherwise). It also advertises `catalogManagement: {version: 1, semantics: "reversible-retirement-v1", sourceIdentity: "name+source-v1"}` and exact `retireRepository` / `restoreRepository` endpoint names, plus `deleteRepository: "skills.deleteRepository"` when permanent managed-data cleanup is supported. Older clients may ignore the additive delete endpoint. Clients should negotiate each contract; version alone is insufficient. Legacy `skills.add` and optional `skills.addFromPath` capabilities remain for existing clients.

## Agent selections and lifecycle operations

`agent.create` and `agent.modify` accept `settings.extensions.skills` as a complete map of catalog names to `unavailable`, `available`, or `installed`:

```json
{"demo-skill":"installed"}
```

An omitted name in a supplied map is `unavailable`; the map replaces the whole selection. `{}` explicitly clears it. Omitting the skills field during modification preserves the current map. New agents, including children, inherit no selections. Names must normally exist in the catalog, even when explicitly marked `unavailable`; the exception is a configured desired Git repository name, which may be explicitly `unavailable` before its asynchronous catalog admission completes. A local skill has no such seed exception and must first be admitted to the catalog.

- `unavailable`: not loaded and cannot be delegated.
- `available`: no checkout is made and it is not included in the launch environment; an agent with this state may delegate it.
- `installed`: a separate managed clone is staged under `<cwd>/.agents/skills/<name>`, validated, and exposed to the harness through `AGENTORG_SKILL_FILES`. Each agent owns an independent checkout.

Public-client selections also grant at least `available` to every ancestor. Existing ancestor `installed` states are preserved and never downgraded to `available`. The target and any changed ancestor records commit together in the core lifecycle transaction; changed ancestors' revisions increment. Filesystem checkout staging is coordinated with the mutation but is not part of that SQLite transaction. Grants do not automatically flow down to children, and removing a selection does not revoke earlier ancestor grants or descendant selections. MCP delegation is checked against the caller's current available/installed states.

Create/modify return lifecycle operations, not final records. Await each operation and check its final `status`/`error`; filesystem or validation failures are operation failures. For example, using the socket client library:

```ts
const installed = await client.wait(await client.request("agent.modify", {
  agentId: existingAgentId,
  settings: { extensions: { skills: { "demo-skill": "installed" } } },
}));
if (installed.status !== "completed") throw new Error(installed.error?.message);

const child = await client.wait(await client.request("agent.create", {
  parentId: existingAgentId,
  settings: {
    harness: "your-harness", model: "your-model", cwd: childWorkspace,
    extensions: { skills: { "demo-skill": "installed" } },
  },
}));
if (child.status !== "completed") throw new Error(child.error?.message);
```

Ensure the workspace exists and is not shared with another active/nonremoved agent. Registration alone changes neither agent selection, revision, nor generation. Launch failures after the record mutation commits leave selections preserved; inspect the operation error and `skills.list` before repair.

Agent MCP tools:

- `skills_list`: catalog with the caller's effective `state` on each record.
- `create_subagent` and `modify_subagent`: `settings.extensions.skills` uses the same replacement semantics. Explicit selections may delegate only the caller's currently available/installed skills, checked inside the serialized mutation. Omitted modification selections are not reauthorized. Core still enforces direct-child creation / strict-descendant mutation.

Create/modify still return lifecycle operations. Await them; filesystem or validation errors fail the operation, not a second socket response. Launch failures **after** records commit leave the agent failed with its selections preserved. Without the plugin, namespaced selections cannot be newly granted; existing namespaces and legacy fields block launches/modification with the generic `EXTENSION_REQUIRED` error. Even retained empty/unavailable-only namespaces require their owner, conservatively. Stop/removal remain possible; records/files remain intact.

The repository contains TUI and Pi integration code, but those integrations are **unverified in this validation**. The completed end-to-end validation covers only socket operations through a deterministic ACP consumer in source and bundled-host modes. No claim is made here about interactive TUI behavior, a real Pi invocation, or container-specific workspaces.

## Organization settings

The plugin registers a public `skills` server-settings group, separate from each agent's `settings.extensions.skills` selection map. Compatible hosts advertise the group through the generic `organization.settings.*` endpoints and the plugin capability (`settingsNamespace` / `serverSettingsNamespace: "skills"`). Settings access is client-only; they are not MCP tools.

Defaults and effects:

| Setting | Default | Bounds | Effect |
| --- | --- | --- | --- |
| `repositories` | `[]` | Up to 256 `{name, gitUrl}` records | Immediate configuration; asynchronous reconciliation |
| `gitTimeoutMs` | `60000` | Integer 1,000–60,000 ms | Immediate for subsequent Git work |
| `maxCatalogEntries` | `256` | Integer 1–256 | Immediate for new catalog admissions |

Repository settings accept HTTPS URLs on `github.com`, `gitlab.com`, or `bitbucket.org` only, without credentials, explicit ports, query strings, fragments, or redirects. The unified `skills.registerRepository` endpoint accepts an allowlisted HTTPS URL or, when capability-advertised, a server-side path. Legacy `skills.add` and repository settings preserve their existing Git-seed semantics; `skills.addFromPath` remains for compatibility.

Repository settings are desired state and take effect immediately. Saving schedules asynchronous reconciliation; it does not block on a clone and does not install a skill into any agent. `skills.list.reconciliation` reports that process. `skills.reconcile: {}` explicitly requests another reconciliation/retry pass for configured Git seeds. Neither operation refreshes an existing manual Git checkout or a local registration from its source. Local registrations are independent copies, not mirrors; supported Git history is preserved but never automatically synchronized. An exact existing name/URL seed is idempotent; reusing a registered name for another Git URL conflicts and never overwrites the existing catalog record. If a configured seed conflicts by name with an existing manual/local record, the existing manual/local record wins and reconciliation reports the conflict. Removing a seed does not remove its catalog checkout, agent files, selection, or recovery history; a no-longer-configured seed may appear under `retained`. Local manual records remain catalog entries regardless of seed-list edits. Lowering `maxCatalogEntries` never evicts existing entries; the limit applies to new seed, Git API, and local-path admissions.

Invalid settings fail validation before persistence or Git activity. Invalid requests use `INVALID_PARAMS`; duplicate direct admissions use `DUPLICATE`; admissions over the limit use `LIMIT`. Seed preparation/readiness is asynchronous and may fail after desired settings persist; inspect reconciliation entries and `repositoryRecovery`. Agent checkout/recovery problems appear separately in `recovery` and may emit `skills.error`. Explicit reconciliation retries configured seed work; it is not a refresh. No client mutation is automatically retried.

## Migration and compatibility

Selections remain API-visible in `settings.extensions.skills`, not in plugin-private storage. Old `settings.skills` is converted by the plugin during host initialization. State validation precedes an atomic core write of all migrated records. Equal dual representations are accepted; unequal ones abort startup with `MIGRATION_CONFLICT`, preserving both for operator repair. Representation-only migration retains revisions so interrupted filesystem journals keep their commit fences. Legacy mutation payloads are no longer accepted; upgrade clients to the namespace and generic capability descriptor.

Without this plugin, legacy fields remain byte-for-byte in records and block modification/launch; core never drops them. The plugin catalog ledger uses schema version 5 with explicit source, history, and reversible catalog status; startup upgrades v1–v4 catalog JSON transactionally and idempotently, preserves legacy Git URL fields and journal payloads, labels unverified legacy history, defaults legacy entries to active, and fails closed on malformed records or newer schemas. This metadata-only upgrade does not probe or mutate source/checkout paths. Plugin-owned scope hashes, installation markers, filesystem locations and recovery journals remain unchanged. No checkouts, untracked files or Git refs are destroyed during migration. Back up core rows, plugin storage and workspaces together. The removed pre-1.0 manager API requires coordinated plugin upgrades despite the retained API-v1 version; the new primitives are generic and additive for other v1 plugins.

## Repositories and source policy

Exactly one root `SKILL.md` is loaded per repository. It must be a regular file with YAML frontmatter, a name matching the catalog name, a nonempty description (≤1024 characters), and instructions. Nested skills are not advertised. Git submodules are not initialized. Skill files are bounded to 128 KiB; newly cloned checkouts are checked against 256 MiB and 20,000 entries, including Git metadata. Catalog limit: 256.

For Git-backed inputs through `skills.add` and repository settings, production sources are HTTPS on **github.com, gitlab.com or bitbucket.org**, without embedded credentials, custom ports, queries, fragments or redirects; other Git sources are rejected. This policy is part of the unified `skills.registerRepository` contract; URL-like SSH, SCP, `file://`, and other schemes are rejected rather than falling back to a server path. Git runs without shell interpolation, system/global Git configuration, ambient URL rewrites or interactive prompts. Private authentication can use an operator-provided noninteractive `GIT_ASKPASS`; credential-helper configuration in global Git config is intentionally not read. Each Git subprocess is bounded to 60 seconds and 1 MiB diagnostic output. Clones are size-checked **after cloning**, not bandwidth/disk-quota sandboxed; use OS resource limits and trusted sources. Proxy/DNS/server environment remain operator-trusted.

Tests/embedded deployments can explicitly call `createSkillsPlugin({home, allowLocalSources: true})` to accept local absolute Git fixtures through `skills.add` or repository settings, including seeds edited through the generic settings UI/API in that trusted host. This factory option is not a socket parameter. The default CLI exposes server-path registration only when the `repositoryRegistration.sourceKinds` capability includes `server-path`.

## Storage, preservation and recovery

- OS-user home: `~/.agentorg/skills/<sha256(canonical organization dataDir)>/skills.sqlite` and hashed/UUID central checkout paths. Separate organizations do **not** share a catalog. Moving the data directory changes its scope; migrate storage deliberately.
- Active installs: `<cwd>/.agents/skills/<name>` (validated IDs only). One resolver owns this default; no configuration parser yet.
- Staged/retained work: `<cwd>/.agents/agentorg-recovery/<scope>/<generation>`, outside discovery. Cwd changes retain old work in the **old** workspace. All managed directories reject symlink traversal and use private permissions.
- Every agent clone has a private identity marker in `.git/agentorg-skills.json` and a named `agent-<agentId>-<generation>` remote in its central repository. Never overwrite unrelated destinations or silently reset/reclone a damaged recorded checkout.
- Every recovery fetch uses fresh `refs/agentorg-recovery/<remote>/<UUID>/…` refs for branches and HEAD. No auto-commit/merge/rebase/reset/prune. Dirty and untracked files remain in the original retained repository; fetch preserves committed history only.
- Downgrades/cwd changes stop the old process before moving obsolete clones out of discovery; they do not delete those clones. New clones are staged before commit. A durable journal records intentions before filesystem changes; pre-commit failure compensates moves when identity/location are unambiguous. Uncertain artifacts and journals are retained with diagnostics, not deleted.
- Removal archives the core subtree and retains installed working copies in place. A nonblocking observer fetches history; failures remain pending for startup retry. Removal success does not imply successful recovery.
- Startup reconciles journals against persisted agent revisions, may retry pending recovery fetches, and validates selections/checkout identity. This retry fetches history only. It does not recreate or overwrite a missing/damaged checkout already claimed by a recorded installation, repair user files, delete uncertain artifacts, or refresh a local snapshot. If a persisted `installed` selection has no installation-ledger record, startup reconciliation may stage a new managed clone from the central catalog snapshot; an unrelated occupied destination is never overwritten. Recorded-checkout damage requires operator inspection and repair. Readiness failures emit `skills.error`; launches revalidate and fail instead of silently advertising missing skills. Cwd uniqueness includes all nonremoved agents, stopped/failed too, and uses real paths at mutation and launch. The optional cwd plugin additionally enforces nesting.

Core SQLite lifecycle mutations, plugin SQLite catalog publication, and Git/filesystem changes are **not one transaction**. Agent install/cwd/downgrade work uses durable journals and staged moves; pre-commit compensation is conservative and uncertain artifacts are preserved. Local imports journal intent/copy/initialized phases; interrupted imports are diagnostic-only retained artifacts and are never automatically retried, repaired, registered, or cleaned up. Successful local publication atomically records provenance and clears its journal in the plugin database transaction, but this does not include the filesystem copy or guarantee exactly-once post-commit event delivery. A crash can therefore leave a journal/stage, a committed record without its event, or an operation whose filesystem work requires inspection. Journals support conservative process-crash recovery, not a power-loss filesystem guarantee. Symlink checks and host permissions are not a sandbox against concurrent trusted shell access. No destructive automatic downgrade, checkout repair, or cleanup is performed. There is no periodic upstream refresh, container workspace identity, remote networking for local imports, or merge automation.

Events: `skills.catalog_added`, `skills.recovered`, `skills.error` (plus core `plugin.error` and lifecycle events). Inspect the distinct `skills.list` recovery/reconciliation fields, operation errors and event history before repairing. Back up the complete organization database, the plugin's `~/.agentorg/skills/` directory (SQLite, central Git repositories and retained UUID staging artifacts), agent workspaces/recovery directories and archived removed workspaces together. Never delete recovery refs, UUID staging artifacts or working copies merely because a core agent is archived.

## Validation scope

See [Local E2E validation](#local-e2e-validation) for the source-mode and compiled-host commands. Regression coverage also includes catalog schema-v5 migration, local copy/snapshot bounds and safety, durable import/restart behavior, client API authorization/errors, reversible retirement/restore and explicit managed-data deletion, lifecycle assignment/delegation/recovery, settings/bootstrap/live reconciliation, and source/bundle contract parity. Run the plugin's full `bun test` suite when its optional sibling TUI, Pi and cwd-plugin test dependencies are available; missing sibling modules block those suites and must not be reported as passed.

The verified integration boundary here is a deterministic, no-model/no-network socket-to-ACP consumer in source mode and with the relocated compiled host/bundled plugin. TUI interaction, real Pi skill loading and container workspace identity are outside this validation; do not infer support or correctness from this E2E result.
