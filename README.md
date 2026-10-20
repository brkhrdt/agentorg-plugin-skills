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

The E2E fixture is deterministic and makes no model or network calls. Local imports are supported only on Linux with `/proc/self/fd`; limits are 128 KiB for root `SKILL.md`, 256 MiB payload, and 20,000 admitted entries. The fixture copies the binary and bundles into a temporary runtime, then restarts those relocated artifacts.

## API

> **Local import support is capability-negotiated.** Use `skills.addFromPath` only when `organization.snapshot.capabilities.plugins.skills.localImport === true` and its `endpoints.addFromPath` is `skills.addFromPath`; plugin version alone does not imply support. Registration in the organization catalog does not assign or install a skill for any agent.

- `skills.addFromPath` is a client-only socket endpoint with the exact request `{path: string}`; extra/missing fields are rejected. `path` may be an absolute or relative directory, its root `SKILL.md`, or `~/...`; relative paths use the core server cwd captured at plugin startup and `~` uses the server OS user's home, independent of plugin storage settings. Spaces are valid; paths are never passed through a shell. The name and description are derived from validated root metadata.
- Success returns the same registered record exposed in `skills.list` and `skills.catalog_added`, with this shape (timestamps and paths are runtime values):

```json
{"name":"demo-skill","description":"Example description","source":{"kind":"local","path":"/original/canonical/source"},"path":"/home/user/.agentorg/skills/<scope>/local-import-staging/<uuid>","createdAt":"<ISO timestamp>","origin":"manual"}
```

  There is no top-level `gitUrl`. `source.path` identifies the canonical original source directory; top-level `path` is the durable independent central checkout used by the catalog. Registration does not assign or install the skill. Duplicate name or canonical source imports fail with `DUPLICATE`; they do not refresh, replace, or resynchronize an existing snapshot.
- Supported only on Linux with usable `/proc/self/fd`. On unsupported hosts the descriptor advertises `localImport: false` and omits `endpoints.addFromPath`; calls then fail as an unknown method. The root must contain a valid regular `SKILL.md`. The copy excludes only entries named exactly `.git` at any depth; ignored/untracked content, `.agents`, caches and dependency trees are copied. A top-level directory symlink alias is canonicalized, but a symlinked root `SKILL.md`, interior symlinks and special files are rejected. File bytes are retained; files with any source execute bit are normalized to mode `0700`, other files to `0600`, and directories to `0700`. Limits: root `SKILL.md` 128 KiB, total payload 256 MiB and 20,000 admitted entries (excluding `.git`).
- A local import is a fresh one-commit Git snapshot with no source history, remote, alternate or synchronization link. The source may be deleted or changed after import without changing the catalog copy. Same-user processes with filesystem access are trusted; copying detects observed mutations but cannot promise an atomic snapshot against concurrent writers. Source/destination/central-root overlap is rejected; the staging parent must be process-owned and not group/world writable.
- Intent is journaled before staging; import phases are retained for diagnosis. An interrupted import is not automatically resumed, registered, recopied or cleaned up. Its UUID-named stage is durable diagnostic data, not disposable temporary storage. Publication commits the catalog record and removes the intent in the plugin SQLite transaction, but filesystem/Git changes are not part of that transaction; event delivery after commit is not exactly-once. Local import never uses Git credentials or network access. Production defaults do not enable local paths through `skills.add` or repository settings.
- Errors: authorization is checked first (`FORBIDDEN`); malformed shape or skill metadata (`INVALID_PARAMS`); invalid, unreadable or unsafe paths (`INVALID_PATH`); duplicate name/source (`DUPLICATE`); file/catalog bounds (`LIMIT`); plugin shutdown (`SHUTTING_DOWN`); unexpected failures (`INTERNAL`).

Socket clients only:

- `skills.add`: `{name, gitUrl}` → `{name, gitUrl, description, createdAt, path}`. Names use lowercase letters/numbers and single hyphens, at most 64 characters. Both names and canonical URL strings must be unique; duplicates are errors, not updates. The clone uses the default branch. No delete/update/revision-selection API.
- `skills.list`: `{}` → `{skills, retained, reconciliation, recovery, repositoryRecovery}`. `skills` contains active catalog records; `retained` contains configured Git records no longer in the desired seed list. `reconciliation` reports desired Git-seed readiness; `recovery` contains pending per-agent recovery/install work; `repositoryRecovery` contains retained catalog-level journal/stage artifacts, including interrupted local imports. These fields represent different states and are not interchangeable.
- `skills.reconcile`: client-only `{}` request that returns `{accepted: true, reconciliation: <current status>}` and schedules an asynchronous reconciliation pass for configured Git seeds. It is a retry/reconcile trigger, not a source refresh; it never recopies local source directories or updates local snapshots.
- `organization.snapshot.capabilities.plugins.skills` preserves API version 1 and the existing keys, advertising `{version: 1, settingsNamespace: "skills", serverSettingsNamespace: "skills", localImport: true, endpoints: {list: "skills.list", add: "skills.add", reconcile: "skills.reconcile", addFromPath: "skills.addFromPath"}}` when local copying is supported. Negotiate both `localImport === true` and the exact `endpoints.addFromPath` value; version alone is insufficient. On unsupported platforms `localImport` is false and the local endpoint is absent.

## Agent selections and lifecycle operations

`agent.create` and `agent.modify` accept `settings.extensions.skills` as a complete map of catalog names to `unavailable`, `available`, or `installed`:

```json
{"demo-skill":"installed"}
```

An omitted name in a supplied map is `unavailable`; the map replaces the whole selection. `{}` explicitly clears it. Omitting the skills field during modification preserves the current map. New agents, including children, inherit no selections. Names must already exist in the catalog, even when explicitly marked `unavailable`.

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
- `child_create` and `descendant_modify`: `settings.extensions.skills` uses the same replacement semantics. Explicit selections may delegate only the caller's currently available/installed skills, checked inside the serialized mutation. Omitted modification selections are not reauthorized. Core still enforces direct-child creation / strict-descendant mutation.

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

Repository settings accept HTTPS URLs on `github.com`, `gitlab.com`, or `bitbucket.org` only, without credentials, explicit ports, query strings, fragments, or redirects. The production `skills.add` endpoint and repository settings reject local paths; only an explicit trusted embedded test factory option can allow local Git fixtures there. `skills.addFromPath` is the separate production local-import API and creates a manual catalog record independent of configured Git seeds.

Repository settings are desired state and take effect immediately. Saving schedules asynchronous reconciliation; it does not block on a clone and does not install a skill into any agent. `skills.list.reconciliation` reports that process. `skills.reconcile: {}` explicitly requests another reconciliation/retry pass for configured Git seeds. Neither operation refreshes an existing manual Git checkout or a local snapshot from its source. Local imports are snapshots, not mirrors. An exact existing name/URL seed is idempotent; reusing a registered name for another Git URL conflicts and never overwrites the existing catalog record. If a configured seed conflicts by name with an existing manual/local record, the existing manual/local record wins and reconciliation reports the conflict. Removing a seed does not remove its catalog checkout, agent files, selection, or recovery history; a no-longer-configured seed may appear under `retained`. Local manual records remain catalog entries regardless of seed-list edits. Lowering `maxCatalogEntries` never evicts existing entries; the limit applies to new seed, Git API, and local-path admissions.

Invalid settings fail validation before persistence or Git activity. Invalid requests use `INVALID_PARAMS`; duplicate direct admissions use `DUPLICATE`; admissions over the limit use `LIMIT`. Seed preparation/readiness is asynchronous and may fail after desired settings persist; inspect reconciliation entries and `repositoryRecovery`. Agent checkout/recovery problems appear separately in `recovery` and may emit `skills.error`. Explicit reconciliation retries configured seed work; it is not a refresh. No client mutation is automatically retried.

## Migration and compatibility

Selections remain API-visible in `settings.extensions.skills`, not in plugin-private storage. Old `settings.skills` is converted by the plugin during host initialization. State validation precedes an atomic core write of all migrated records. Equal dual representations are accepted; unequal ones abort startup with `MIGRATION_CONFLICT`, preserving both for operator repair. Representation-only migration retains revisions so interrupted filesystem journals keep their commit fences. Legacy mutation payloads are no longer accepted; upgrade clients to the namespace and generic capability descriptor.

Without this plugin, legacy fields remain byte-for-byte in records and block modification/launch; core never drops them. The plugin catalog ledger uses schema version 3 with explicit source provenance; startup upgrades v1/v2 catalog JSON transactionally and idempotently, preserves legacy Git URL fields and journal payloads, and fails closed on malformed records or newer schemas. This metadata-only upgrade does not probe or mutate source/checkout paths. Plugin-owned scope hashes, installation markers, filesystem locations and recovery journals remain unchanged. No checkouts, untracked files or Git refs are destroyed during migration. Back up core rows, plugin storage and workspaces together. The removed pre-1.0 manager API requires coordinated plugin upgrades despite the retained API-v1 version; the new primitives are generic and additive for other v1 plugins.

## Repositories and source policy

Exactly one root `SKILL.md` is loaded per repository. It must be a regular file with YAML frontmatter, a name matching the catalog name, a nonempty description (≤1024 characters), and instructions. Nested skills are not advertised. Git submodules are not initialized. Skill files are bounded to 128 KiB; newly cloned checkouts are checked against 256 MiB and 20,000 entries, including Git metadata. Catalog limit: 256.

Production sources are HTTPS on **github.com, gitlab.com or bitbucket.org**, without embedded credentials, custom ports, queries, fragments or redirects. Other sources are rejected. Git runs without shell interpolation, system/global Git configuration, ambient URL rewrites or interactive prompts. Private authentication can use an operator-provided noninteractive `GIT_ASKPASS`; credential-helper configuration in global Git config is intentionally not read. Each Git subprocess is bounded to 60 seconds and 1 MiB diagnostic output. Clones are size-checked **after cloning**, not bandwidth/disk-quota sandboxed; use OS resource limits and trusted sources. Proxy/DNS/server environment remain operator-trusted.

Tests/embedded deployments can explicitly call `createSkillsPlugin({home, allowLocalSources: true})` for local absolute repository fixtures, including repository seeds edited through the generic server-settings UI/API in that trusted test host. The opt-in is a plugin-factory option (not a socket parameter); the default CLI export rejects local sources.

## Storage, preservation and recovery

- OS-user home: `~/.agentorg/skills/<sha256(canonical organization dataDir)>/skills.sqlite` and hashed/UUID central checkout paths. Separate organizations do **not** share a catalog. Moving the data directory changes its scope; migrate storage deliberately.
- Active installs: `<cwd>/.agents/skills/<name>` (validated IDs only). One resolver owns this default; no configuration parser yet.
- Staged/retained work: `<cwd>/.agents/agentorg-recovery/<scope>/<generation>`, outside discovery. Cwd changes retain old work in the **old** workspace. All managed directories reject symlink traversal and use private permissions.
- Every agent clone has a private identity marker in `.git/agentorg-skills.json` and a named `agent-<agentId>-<generation>` remote in its central repository. Never overwrite unrelated destinations or silently reset/reclone a damaged recorded checkout.
- Every recovery fetch uses fresh `refs/agentorg-recovery/<remote>/<UUID>/…` refs for branches and HEAD. No auto-commit/merge/rebase/reset/prune. Dirty and untracked files remain in the original retained repository; fetch preserves committed history only.
- Downgrades/cwd changes stop the old process before moving obsolete clones out of discovery; they do not delete those clones. New clones are staged before commit. A durable journal records intentions before filesystem changes; pre-commit failure compensates moves when identity/location are unambiguous. Uncertain artifacts and journals are retained with diagnostics, not deleted.
- Removal archives the core subtree and retains installed working copies in place. A nonblocking observer fetches history; failures remain pending for startup retry. Removal success does not imply successful recovery.
- Startup reconciles journals against persisted agent revisions, may retry pending recovery fetches, and validates selections/checkout identity. This retry fetches history only; startup does not recreate or overwrite a missing/damaged checkout, repair user files, delete uncertain artifacts, or refresh a local snapshot. Such cases require operator inspection and repair. Readiness failures emit `skills.error`; launches revalidate and fail instead of silently advertising missing skills. Cwd uniqueness includes all nonremoved agents, stopped/failed too, and uses real paths at mutation and launch. The optional cwd plugin additionally enforces nesting.

Core SQLite lifecycle mutations, plugin SQLite catalog publication, and Git/filesystem changes are **not one transaction**. Agent install/cwd/downgrade work uses durable journals and staged moves; pre-commit compensation is conservative and uncertain artifacts are preserved. Local imports journal intent/copy/initialized phases; interrupted imports are diagnostic-only retained artifacts and are never automatically retried, repaired, registered, or cleaned up. Successful local publication atomically records provenance and clears its journal in the plugin database transaction, but this does not include the filesystem copy or guarantee exactly-once post-commit event delivery. A crash can therefore leave a journal/stage, a committed record without its event, or an operation whose filesystem work requires inspection. Journals support conservative process-crash recovery, not a power-loss filesystem guarantee. Symlink checks and host permissions are not a sandbox against concurrent trusted shell access. No destructive automatic downgrade, checkout repair, or cleanup is performed. There is no periodic upstream refresh, container workspace identity, remote networking for local imports, or merge automation.

Events: `skills.catalog_added`, `skills.recovered`, `skills.error` (plus core `plugin.error` and lifecycle events). Inspect the distinct `skills.list` recovery/reconciliation fields, operation errors and event history before repairing. Back up the complete organization database, the plugin's `~/.agentorg/skills/` directory (SQLite, central Git repositories and retained UUID staging artifacts), agent workspaces/recovery directories and archived removed workspaces together. Never delete recovery refs, UUID staging artifacts or working copies merely because a core agent is archived.

## Validation scope

See [Local E2E validation](#local-e2e-validation) for the source-mode and compiled-host commands. Regression coverage also includes catalog schema-v3 migration, local copy/snapshot bounds and safety, durable import/restart behavior, client API authorization/errors, lifecycle assignment/delegation/recovery, settings/bootstrap/live reconciliation, and source/bundle contract parity. Run the plugin's full `bun test` suite when its optional sibling TUI, Pi and cwd-plugin test dependencies are available; missing sibling modules block those suites and must not be reported as passed.

The verified integration boundary here is a deterministic, no-model/no-network socket-to-ACP consumer in source mode and with the relocated compiled host/bundled plugin. TUI interaction, real Pi skill loading and container workspace identity are outside this validation; do not infer support or correctness from this E2E result.
