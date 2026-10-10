# @agentorg/plugin-skills

Trusted, separately loadable AgentOrg API-v1 plugin. Requires Bun, Git and the additive skills host contract in this checkout. Pi 1.0.2+ supports explicit `--skill` with ambient discovery disabled.

```sh
cd agentorg-plugin-skills && bun install --frozen-lockfile
cd ../agentorg
# Load the separate Pi harness too if using harness: "pi" (install its deps first).
bun start --plugin ../agentorg-plugin-pi-agent/src/index.ts --plugin ../agentorg-plugin-skills/src/index.ts
# Optional containment (either plugin order works):
bun start --plugin ../agentorg-plugin-pi-agent/src/index.ts --plugin ./src/plugins/cwd.ts --plugin ../agentorg-plugin-skills/src/index.ts
```

The plugin has no runtime dependency on core internals; core imports are type-only. For a compiled AgentOrg binary, run `bun run build` here and load `--plugin /absolute/path/dist/skills.js`. Ship that single bundled module: it includes `yaml`, since compiled Bun hosts do not reliably resolve external plugins' npm dependencies. Source-mode servers can load `src/index.ts` with its installed dependencies. Core adds `settings.skills`, `registerSkills`, `LaunchContext.skillPaths`, atomic multi-record writes and `snapshot.capabilities.skills`. It never exposes its database to the plugin. Other harnesses must explicitly consume `LaunchContext.skillPaths` to load skills; the separate `@agentorg/plugin-pi-agent` adapter already does. Core no longer implicitly loads Pi; see [Pi plugin setup](../agentorg-plugin-pi-agent/README.md).

## API

Socket clients only:

- `skills.add`: `{name, gitUrl}` → `{name, gitUrl, description, createdAt, path}`. Names use lowercase letters/numbers and single hyphens, at most 64 characters. Both names and canonical URL strings must be unique; duplicates are errors, not updates. The clone uses the default branch. No delete/update/revision-selection API.
- `skills.list`: `{}` → `{skills: Skill[], recovery: {agentId, skill, path, error?}[]}`. Recovery includes pending fetch/readiness failures.
- `organization.snapshot` advertises `capabilities: {skills: true}` while enabled; older servers may omit this field.

`agent.create` / `agent.modify` accept `settings.skills`:

```json
{"alpha":"installed","beta":"available"}
```

Missing IDs are `unavailable`. New agents select nothing; children do not inherit selections. An explicit map replaces **all** states; `{}` clears them. Omission during modification preserves the existing map (and other omitted options). All IDs, even explicit `unavailable` entries, must exist in the catalog. Existing records need no database migration: settings are JSON and the optional field defaults semantically to an empty map.

`available` is delegable but not loaded. `installed` is loaded and delegable. `unavailable` is neither. Public-client grants add at least `available` to **every ancestor**, preserving installed states. These records and the target commit in one core SQLite transaction inside the lifecycle queue; ancestor revisions increment and modified events are emitted. Removing a selection does not revoke earlier ancestor grants or descendant selections. Installed ancestor grants do not happen implicitly.

Agent MCP tools:

- `skills_list`: catalog with the caller's effective `state` on each record.
- `child_create` and `descendant_modify`: `settings.skills` uses the same replacement semantics. Explicit selections may delegate only the caller's currently available/installed skills, checked inside the serialized mutation. Omitted modification selections are not reauthorized. Core still enforces direct-child creation / strict-descendant mutation.

Create/modify still return lifecycle operations. Await them; filesystem or validation errors fail the operation, not a second socket response. Launch failures **after** records commit leave the agent failed with its selections preserved. Without the plugin, nonempty selections cannot be newly granted, and launches with existing nonempty selections fail with `SKILLS_DISABLED`; records/files remain intact. Explicit unavailable-only maps are harmless.

The TUI discovers the snapshot capability, shows `s skills`, edits selections with a captured revision, and adds catalog entries with `+`. It never automatically retries a mutation.

## Repositories and source policy

Exactly one root `SKILL.md` is loaded per repository. It must be a regular file with YAML frontmatter, a name matching the catalog name, a nonempty description (≤1024 characters), and instructions. Nested skills are not advertised. Git submodules are not initialized. Skill files are bounded to 128 KiB; newly cloned checkouts are checked against 256 MiB and 20,000 entries, including Git metadata. Catalog limit: 256.

Production sources are HTTPS on **github.com, gitlab.com or bitbucket.org**, without embedded credentials, custom ports, queries, fragments or redirects. Other sources are rejected. Git runs without shell interpolation, system/global Git configuration, ambient URL rewrites or interactive prompts. Private authentication can use an operator-provided noninteractive `GIT_ASKPASS`; credential-helper configuration in global Git config is intentionally not read. Each Git subprocess is bounded to 60 seconds and 1 MiB diagnostic output. Clones are size-checked **after cloning**, not bandwidth/disk-quota sandboxed; use OS resource limits and trusted sources. Proxy/DNS/server environment remain operator-trusted.

Tests/embedded deployments can explicitly call `createSkillsPlugin({home, allowLocalSources: true})` for local absolute repository fixtures. These options are not accepted through the socket, and the default CLI export never enables local sources.

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

Local Git fixtures cover restart persistence, atomic ancestor grants, delegation, replacements/omissions, plugin order, canonical cwd conflicts, dirty/untracked preservation, reinstall generations, interrupted moves, collisions, failure retries and disabled-plugin launches. A no-model/no-network test checks explicit versus ambient loading using the installed real `pi` CLI (skipped when unavailable).
