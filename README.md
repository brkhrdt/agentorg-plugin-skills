# AgentOrg Skills

> **Fresh-start contract:** This simplified implementation does not migrate prior plugin databases, catalogs, selections, or installation ledgers. Start with a new AgentOrg data directory; existing workspaces and plugin-home metadata are not imported or removed.

The skills plugin exposes a catalog of root-`SKILL.md` Git repositories and installs independent mutable clones in agent workspaces at `<agent.cwd>/.agents/skills/<name>`. The store is server-side and is never mounted into an agent. Pi receives installed files through the explicit `AGENTORG_SKILL_FILES` launch environment; ambient skill discovery is disabled by the Pi adapter. Podman receives only the agent workspace grants configured for that agent.

## Store

`skills.directory` is the server-side directory containing immediate child skill repositories. Its default is `skills`, resolved as `<server dataDir>/skills`; an absolute path or `~/...` can be configured. Changes require a server restart. The directory is not itself a monorepo: children are validated as repository roots, and nested repositories are not discovered. Each child must be a committed Git worktree with a root `SKILL.md`. Keep the worktree clean for admission. Plain directories, paths within an ancestor repository, bare repositories, linked worktrees, and unsupported Git layouts are rejected. The plugin does not initialize Git or create commits on the operator's behalf.

The local registration API accepts a server-side repository root (or root `SKILL.md`) and requires a clean committed Git worktree; plain directories and dirty/untracked worktrees are rejected. Registration clones the selected branch into the store; other branches and tags are not fetched. Git history naturally present on the selected branch remains ordinary Git history. HTTPS registration is limited to GitHub, GitLab, and Bitbucket. Registration does not assign a skill to any agent. Operators maintain repositories and deliberately promote changes; there is no plugin-managed sync, backup, recovery, version/update, or upstream reconciliation process. Existing agent checkouts are never synchronized when the store changes.

Changing the store path does not copy or migrate repositories. The plugin has no recovery journal, generation archive, or legacy metadata migration; a fresh data directory starts with an empty catalog which is populated by store discovery.

## Agent selections

`settings.extensions.skills` is a complete map of skill names to `unavailable`, `available`, or `installed`. `available` permits delegation without loading the skill into that agent. `installed` creates/uses that agent's independent checkout and explicitly loads it. Agent edits and commits stay in that checkout and are not synchronized by AgentOrg. Deselecting a skill stops loading it but leaves its checkout in place. Agent removal and cwd changes do not move or delete user work. The store and dataDir must not be mounted as a solution to skill visibility.

## Development and checks

A live Pi demonstration (requires Pi CLI, provider OAuth/API credentials, and the configured `PI_PROVIDER`/`PI_MODEL`) is available as `bun scripts/live-pi-skill-demo.ts`. It creates a fresh temporary organization dataDir, commits a local skill repository, registers it, installs it into a real Pi-backed agent, and verifies the model follows the skill instruction.

From this feature copy:

```sh
bun install
bun run check
bun test
bun run build
```

The tests include local Git fixtures and do not require network access for primary coverage. The real Pi harness requires a configured Pi provider account for a model-mediated skill-use demonstration. No claim of a live model run should be inferred from unit tests.
