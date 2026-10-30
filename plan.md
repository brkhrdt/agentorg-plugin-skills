# Skills store contract

This fresh-start implementation follows the accepted simplification plan in the feature workspace. It does not migrate prior plugin databases or installation ledgers.

- Discover immediate-child Git worktrees with committed root `SKILL.md` files under `skills.directory` (default `<dataDir>/skills`).
- Register HTTPS Git sources or server-side Git roots with `skills.registerRepository`; reject plain directories, dirty roots, and unsupported layouts.
- Keep each agent installation as an independent mutable clone under `<cwd>/.agents/skills/<name>`. No plugin synchronization, refresh, update/revert, backup, recovery, or version-management workflow exists.
- Deselecting, moving, or removing an agent leaves its checkout untouched. Pi receives explicit skill paths through `AGENTORG_SKILL_FILES`; the store and server data directory are never mounted into agents.
- Start with a new AgentOrg data directory. Existing catalog metadata and workspace ownership ledgers are not migrated; user workspaces are not cleaned up.
