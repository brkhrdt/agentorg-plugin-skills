# AgentOrg Skills

> **Fresh-start contract:** This simplified implementation does not migrate prior plugin databases, catalogs, selections, or installation ledgers. Start with a new AgentOrg data directory; existing workspaces and plugin-home metadata are not imported or removed.

The skills plugin exposes a catalog of root-`SKILL.md` Git repositories and installs independent mutable clones in agent workspaces at `<agent.cwd>/.agents/skills/<name>`. Workspaces may overlap or reach the server `dataDir` (including `.org`), skills store, SQLite metadata, catalog repositories, and installed-checkout metadata; host agents can access those paths through ordinary filesystem tools. The plugin does not automatically add the store or `dataDir` to container mount/volume grants. Pi receives installed files through the explicit `AGENTORG_SKILL_FILES` launch environment; ambient skill discovery is disabled by the Pi adapter. Podman receives only the workspace grants configured for that agent. Host path validation is not containment. When filesystem isolation is required, the trusted container plugin's mount/grant enforcement is the boundary.

## Store

`skills.directory` is the server-side directory containing immediate child skill repositories. Its default is `skills`, resolved as `<server dataDir>/skills`; an absolute path or `~/...` can be configured. Changes require a server restart. The directory is not itself a monorepo: children are validated as repository roots, and nested repositories are not discovered. Each child must be a committed Git worktree with a root `SKILL.md`. Keep the worktree clean for admission. Plain directories, paths within an ancestor repository, bare repositories, linked worktrees, and unsupported Git layouts are rejected. The plugin does not initialize Git or create commits on the operator's behalf.

The local registration API accepts a server-side repository root (or root `SKILL.md`) and requires a clean committed Git worktree; plain directories and dirty/untracked worktrees are rejected. Registration clones the selected branch into the store; other branches and tags are not fetched. Git history naturally present on the selected branch remains ordinary Git history. HTTPS registration is limited to GitHub, GitLab, and Bitbucket. Registration does not assign a skill to any agent. Operators maintain repositories and deliberately promote changes; there is no plugin-managed sync, backup, recovery, version/update, or upstream reconciliation process. Existing agent checkouts are never synchronized when the store changes.

The default store is `<dataDir>/skills`; agent workspaces may equal, contain, or be contained by the `dataDir` and store. The plugin retains topology and integrity checks unrelated to agent reads: a store at or inside an agent workspace's `<cwd>/.agents/skills` installation root is rejected; the store may not equal or contain `dataDir`; and managed installations, symlinks, Git checkouts, and sources remain validated. These checks do not sandbox a host-executed agent or prevent it from reading/modifying server files. Removed agents do not participate in workspace overlap checks.

Changing the store path does not copy or migrate repositories. Existing selections are retained as historical settings, but a missing catalog entry cannot be newly assigned or promoted to `installed` until it is present in the current store. Historical selections can be disabled or cleared; existing verified agent-owned installed checkouts remain independent and are not replaced or copied from the store. The plugin has no recovery journal, generation archive, or legacy metadata migration; a fresh data directory starts with an empty catalog which is populated by store discovery.

## Agent selections

`settings.extensions.skills` is a complete map of skill names to `unavailable`, `available`, or `installed`. `available` permits delegation without loading the skill into that agent. `installed` creates/uses that agent's independent checkout and explicitly loads it. Agent edits and commits stay in that checkout and are not synchronized by AgentOrg. Deselecting a skill stops loading it but leaves its checkout in place. Agent removal and cwd changes do not move or delete user work. Installed skill loading remains explicit; the plugin neither requires nor automatically mounts/grants the store or dataDir. Container operators control any mount policy.

## Development and checks

Development and runtime require Node.js 22.14 or newer. The plugin uses built-in `node:sqlite`, available in Node 22.14 but experimental in this release line (Node 24+ no longer emits the experimental warning). Tests run under Vitest; builds use esbuild.

A live Pi demonstration (requires Pi CLI, provider OAuth/API credentials, and the configured `PI_PROVIDER`/`PI_MODEL`) is available as `node --experimental-strip-types scripts/live-pi-skill-demo.ts`. It creates a fresh temporary organization dataDir, commits a local skill repository, registers it, installs it into a real Pi-backed agent, and verifies the model follows the skill instruction.

From this feature copy, using npm:

```sh
npm install
npm run check
npm test
npm run build
```

The tests include local Git fixtures and do not require network access for primary coverage. The real Pi harness requires a configured Pi provider account for a model-mediated skill-use demonstration. No claim of a live model run should be inferred from unit tests.
