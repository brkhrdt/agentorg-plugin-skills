# @agentorg/plugin-skills

Trusted, separately loadable AgentOrg API-v1 plugin. Requires Bun, Git and the generic API-v1 extension contract in this checkout. Pi 1.0.2+ supports explicit `--skill` with ambient discovery disabled.

```sh
cd agentorg-plugin-skills && bun install --frozen-lockfile
cd ../agentorg
# Load the separate Pi harness too if using harness: "pi" (install its deps first).
bun start --plugin ../agentorg-plugin-pi-agent/src/index.ts --plugin ../agentorg-plugin-skills/src/index.ts
# Optional containment (either plugin order works):
bun start --plugin ../agentorg-plugin-pi-agent/src/index.ts --plugin ../agentorg-plugin-unique-cwd/src/index.ts --plugin ../agentorg-plugin-skills/src/index.ts
```

The plugin has no runtime dependency on core internals; core imports are type-only. For a compiled AgentOrg binary, run `bun run build` here and load `--plugin /absolute/path/dist/skills.js`. Ship that single bundled module: it includes `yaml` and `zod`, since compiled Bun hosts do not reliably resolve external plugins' npm dependencies. Source-mode servers can load `src/index.ts` with its installed dependencies. The plugin uses generic namespaced settings, lifecycle participants, atomic multi-record writes, initialization, launch environment and capability discovery ([host contract](../agentorg/EXTENSIONS.md)). Core has no skills semantics and never exposes its database. Other harnesses must explicitly consume the JSON `AGENTORG_SKILL_FILES` launch environment and declare it in `LaunchSpec.consumesEnv`; the separate Pi adapter already does. Installed selections fail safely for unsupported harnesses. Final validation rejects overwritten managed environment or cwd. Core no longer implicitly loads Pi; see [Pi plugin setup](../agentorg-plugin-pi-agent/README.md).

## API

Socket clients only:

- `skills.add`: `{name, gitUrl}` → `{name, gitUrl, description, createdAt, path}`. Names use lowercase letters/numbers and single hyphens, at most 64 characters. Both names and canonical URL strings must be unique; duplicates are errors, not updates. The clone uses the default branch. No delete/update/revision-selection API.
- `skills.list`: `{}` → `{skills: Skill[], recovery: {agentId, skill, path, error?}[]}`. Recovery includes pending fetch/readiness failures.
- `organization.snapshot.capabilities.plugins.skills` advertises `{version: 1, settingsNamespace: "skills", serverSettingsNamespace: "skills", endpoints: {list: "skills.list", add: "skills.add"}}`. Absent/older descriptors mean unsupported.

`agent.create` / `agent.modify` accept `settings.extensions.skills`:

```json
{"alpha":"installed","beta":"available"}
```

Missing IDs are `unavailable`. New agents select nothing; children do not inherit selections. An explicit map replaces **all** states; `{}` clears them. Omission during modification preserves the existing map (and other omitted options). All IDs, even explicit `unavailable` entries, must exist in the catalog. An absent namespace means no selection. Existing records are migrated conservatively as described below.

`available` is delegable but not loaded. `installed` is loaded and delegable. `unavailable` is neither. Public-client grants add at least `available` to **every ancestor**, preserving installed states. These records and the target commit in one core SQLite transaction inside the lifecycle queue; ancestor revisions increment and modified events are emitted. Removing a selection does not revoke earlier ancestor grants or descendant selections. Installed ancestor grants do not happen implicitly.

Agent MCP tools:

- `skills_list`: catalog with the caller's effective `state` on each record.
- `child_create` and `descendant_modify`: `settings.extensions.skills` uses the same replacement semantics. Explicit selections may delegate only the caller's currently available/installed skills, checked inside the serialized mutation. Omitted modification selections are not reauthorized. Core still enforces direct-child creation / strict-descendant mutation.

Create/modify still return lifecycle operations. Await them; filesystem or validation errors fail the operation, not a second socket response. Launch failures **after** records commit leave the agent failed with its selections preserved. Without the plugin, namespaced selections cannot be newly granted; existing namespaces and legacy fields block launches/modification with the generic `EXTENSION_REQUIRED` error. Even retained empty/unavailable-only namespaces require their owner, conservatively. Stop/removal remain possible; records/files remain intact.

The TUI exposes a catalog-backed **Skills** field inside ordinary agent create/modify forms. Selections stage in the form and are sent once as a complete revision-fenced replacement; Escape discards them. Repository seeds are managed separately in `v` → `s` server settings. The old global `s` screen and JSON catalog-add prompt are removed. The client does not automatically retry a mutation.

## Organization settings

The plugin registers a public `skills` server-settings group, separate from each agent's `settings.extensions.skills` selection map. Compatible hosts advertise the group through the generic `organization.settings.*` endpoints and the plugin capability (`settingsNamespace` / `serverSettingsNamespace: "skills"`). Settings access is client-only; they are not MCP tools.

Defaults and effects:

| Setting | Default | Bounds | Effect |
| --- | --- | --- | --- |
| `repositories` | `[]` | Up to 256 `{name, gitUrl}` records | Restart |
| `gitTimeoutMs` | `60000` | Integer 1,000–60,000 ms | Immediate for subsequent Git work |
| `maxCatalogEntries` | `256` | Integer 1–256 | Immediate for new catalog admissions |

Repository records accept HTTPS URLs on GitHub, GitLab, or Bitbucket only, without credentials, explicit ports, query strings, or fragments. The list seeds the persistent catalog at server startup; it is not a live mirror. An exact existing name/URL pair is idempotent. Reusing a registered name for a different URL is a conflict and never overwrites the catalog entry. Removing a seed does not remove its catalog entry, checkout, installed files, agent selection, or recovery history. Saving repository settings performs no clone/delete; restart applies changes. Lowering `maxCatalogEntries` never evicts existing catalog entries, and the configured limit applies to new admissions through both seed import and `skills.add`.

Invalid settings fail validation before persistence or Git activity. Invalid requests use `INVALID_PARAMS`; duplicate direct catalog additions use `DUPLICATE`; admissions over the limit use `LIMIT`. Seed bootstrap failures identify the repository and preserve checkout/journal artifacts for diagnosis. Readiness/launch failures remain explicit (`SKILL_NOT_READY` / `skills.error`); inspect `skills.list`, operation errors, and event history before repair. No failure is silently retried by the client.

## Migration and compatibility

Selections remain API-visible in `settings.extensions.skills`, not in plugin-private storage. Old `settings.skills` is converted by the plugin during host initialization. State validation precedes an atomic core write of all migrated records. Equal dual representations are accepted; unequal ones abort startup with `MIGRATION_CONFLICT`, preserving both for operator repair. Representation-only migration retains revisions so interrupted filesystem journals keep their commit fences. Legacy mutation payloads are no longer accepted; upgrade clients to the namespace and generic capability descriptor.

Without this plugin, legacy fields remain byte-for-byte in records and block modification/launch; core never drops them. Plugin-owned SQLite schema, scope hashes, installation markers, filesystem locations and recovery journals are unchanged. No checkouts, untracked files or Git refs are destroyed during migration. Back up core rows, plugin storage and workspaces together. The removed pre-1.0 manager API requires coordinated plugin upgrades despite the retained API-v1 version; the new primitives are generic and additive for other v1 plugins.

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
- Downgrades/cwd changes stop the old process before moving obsolete clones out of discovery. New clones are staged before commit. A durable journal records intentions before filesystem changes; pre-commit failure compensates moves when identity/location are unambiguous. Uncertain artifacts and journals are retained with diagnostics, not deleted.
- Removal archives the core subtree and retains installed working copies in place. A nonblocking observer fetches history; failures remain pending for startup retry. Removal success does not imply successful recovery.
- Startup reconciles journals against persisted agent revisions, retries recovery, and validates selections/checkout identity. Missing or damaged recorded repositories require operator repair rather than overwriting them. Readiness failures emit `skills.error`; launches revalidate and fail instead of silently advertising missing skills. Cwd uniqueness includes all nonremoved agents, stopped/failed too, and uses real paths at mutation and launch. The optional cwd plugin additionally enforces nesting.

SQLite and Git/filesystem actions are **not one transaction**. Journals support conservative process-crash reconciliation, not a power-loss filesystem guarantee. Symlink checks and host permissions are not a sandbox against concurrent trusted shell access. Unresolved journals/collisions need operator inspection. No periodic retry/upstream update, automatic cleanup, container workspace identity, remote networking, or merge automation.

Events: `skills.catalog_added`, `skills.recovered`, `skills.error` (plus core `plugin.error` and lifecycle events). Inspect `skills.list`, agent errors and event history before repairing. Keep the plugin database, central repositories, workspace recovery areas and original removed workspaces together in backups. Never delete recovery refs or working copies merely because a core agent is archived.

## Tests

```sh
bun run check
bun test
# Optional: build ../agentorg/dist/agentorg first, then:
bun run test:binary
```

Local Git fixtures cover restart persistence, atomic ancestor grants, delegation, replacements/omissions, plugin order, canonical cwd conflicts, dirty/untracked preservation, reinstall generations, interrupted moves, collisions, failure retries and disabled-plugin launches. An end-to-end terminal test configures a trusted local seed through server settings, restarts, selects it through the ordinary agent form, calls `skills_list` over the authenticated MCP stdio bridge, then removes it and checks explicit unload plus retained recovery work. A no-model/no-network test checks explicit versus ambient loading using the installed real `pi` CLI (skipped when unavailable).
