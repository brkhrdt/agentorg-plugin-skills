# Skills plugin implementation plan

## Goal

Create a trusted `@agentorg/plugin-skills` API-v1 server plugin, loaded by AgentOrg through `--plugin`, that manages an organization-wide catalog of Git-backed skills and each agent's skill state. Skills live in the server-side catalog and persistence database; agent skill selections persist with their agent records. The plugin exposes skills to public clients and agents, and augments agent creation/modification MCP tools. It is a separately loadable plugin, not a new service or harness.

Implementation is now in `src/index.ts`; see `README.md` for the shipped contract, source policy, storage scope, recovery behavior and limitations. The original design below is retained for context. The shipped implementation now uses core's generic namespaced settings, lifecycle transactions, launch environment and capability discovery. The plugin owns `settings.extensions.skills` and its migration from legacy records. The older design below is historical, not the current host contract.

## Current project integration points

- AgentOrg supports trusted API-v1 plugins, namespaced client endpoints, MCP tools, tool transformations, `beforeSettings` hooks, launch hooks, event observers, and shutdown hooks.
- Agent records/settings persist through the core SQLite store. `beforeSettings` can validate/transforms agent settings within lifecycle mutation handling, but the plugin host currently has no public persistence/transaction API for plugin-owned records.
- MCP tools are agent-capability-only. Public clients use the socket API; plugin endpoints must be namespaced (for example, `skills.add`).
- Built-in `child_create` and `descendant_modify` tools are the MCP integration targets (`child_modify` does not exist). Public `agent.create` and `agent.modify` endpoints must also support skills so socket clients can set/change them.
- Existing Pi integration explicitly passes `--no-skills` (`agentorg-plugin-pi-agent/src/pi-acp.ts` (extracted into the separate Pi harness plugin)); installing files alone will not expose skills. Add explicit loading of plugin-managed installed skills while retaining disabled ambient discovery. Verify the supported Pi loading mechanism during implementation.
- Core settings and Pi options use strict schemas. Arbitrary top-level settings are rejected, and putting plugin state in `settings.options` without adapter changes will fail Pi option validation. Plan a narrow supported settings extension rather than assuming an arbitrary field works.
- Core `agent.remove` archives a subtree and never deletes workspaces/session history. Skill recovery must respect that behavior. Event observers are nonblocking and cannot provide transactional deletion interception.
- Review source: `agentorg/README.md`, `src/plugin.ts`, `src/types.ts`, and `src/plugins/{cwd,pi,pi-acp}.ts`.

## Proposed behavior and data model

### Skill catalog

A skill has a stable organization ID/name, Git source URL, catalog metadata, and its central checkout under `~/.agentorg/skills/`. Each repository provides exactly one skill with a root `SKILL.md`; subdirectory skills and multi-skill repositories are not supported. Clone the repository's default branch without pinning a requested revision. Existing agent checkouts are not reset or automatically updated when central work changes. The catalog must be persisted in SQLite and restored at server startup. Validate skill identifiers and source URLs; do not use user-provided names directly as filesystem paths. Resolve the home directory consistently and create private directories with restrictive permissions.

The API for adding a catalog skill should accept its Git source and a stable name (final naming/metadata contract to confirm). Adding a skill clones it once into the central area, validates that it is a usable skill, records it durably, and reports errors without leaving a half-registered entry. Define update/duplicate semantics explicitly. No delete/update API is assumed until confirmed.

### Per-agent state

For every catalog skill, each agent has one of three states:

- `unavailable`: agent does not use it and cannot pass it to a child.
- `available`: not installed for this agent, but eligible to be made available to a subagent.
- `installed`: cloned into `<agent.cwd>/.agents/skills/<skill-name>` and available to the agent; it can also be passed on to descendants.

Represent these as a persisted mapping/list on the agent's settings/record, defaulting to `unavailable` when no entry exists. Keep the canonical catalog separate from agent selections. Validate references to catalog IDs and reject unknown IDs. An explicitly supplied selection replaces the complete skill set (no per-skill add/remove patch operation); omitted entries in that selection become `unavailable`. Omitting the selection field during modification leaves the current selection unchanged; an explicit empty selection clears it.

When a public client installs a skill or makes it available to an agent, make that skill at least `available` to every ancestor up to the root. Preserve ancestors' existing `installed` state; never install into ancestors automatically. This upward propagation must be serialized with the target mutation and persisted consistently across affected records. It is a client-authorized grant, not an MCP delegation bypass. Proposed default: later removal from one agent does not automatically revoke previous ancestor grants or existing descendant selections; delegation checks still apply to new MCP mutations.

### Filesystem and Git lifecycle

- Central catalog checkouts are kept under `~/.agentorg/skills/` and act as the local source from which agent installations are cloned, avoiding repeated GitHub/network clones.
- Installing a skill creates a clone at `.agents/skills/<skill-name>` in the agent cwd. Do not overwrite an existing unrelated directory; detect and report collisions.
- Centralize install-root resolution behind one helper with `.agents/skills` as the default. A future config file can override it; do not add configuration parsing now. Loading, installation, collision checks, and recovery must all use the same resolver.
- Prohibit shared cwd among nonremoved agents, including stopped/failed agents. Compare canonical real paths, not input strings, at create/modify and launch/recovery. Compose with the optional cwd plugin and its relative-path/containment rules. Container-specific workspace identity is future work.
- Register each installed agent checkout as a named remote in the corresponding central checkout, as requested, so later work can be recovered centrally.
- Preserve agent work rather than automatically integrating it. Fetch committed history into durable per-agent recovery refs in the central repository; do not auto-commit, merge, rebase, reset, or prune recovery refs. Another agent/operator can merge changes later. Retain the original repository and dirty/untracked files; Git fetch alone does not preserve them. Preserve each recovery generation when a checkout is reused or reinstalled.
- On agent removal, retain skill working copies and recovery remotes, consistent with core workspace archival. Attempt central fetch and persist failed recovery work for retry; report failures without deleting source data. Observers may perform this non-destructive recovery after removal, but must not be treated as a transactional removal hook.
- On downgrade or cwd change, move obsolete managed installations to a plugin-owned recovery area outside the skill discovery/install root. Never delete them automatically. Keep recovery remotes pointing to retained repositories. Stage changes and compensate on mutation failure; retain uncertain artifacts for reconciliation rather than destructively rolling back user work.
- Validation/installation failures fail create/modify before committing new settings wherever supported. Interrupted filesystem operations need a durable journal and idempotent startup reconciliation; do not claim SQLite and Git/filesystem actions share a transaction.
- Handle startup/recovery idempotently: reconcile persisted `installed` settings with target directories without clobbering local modifications. Missing repositories, collisions, and failed recovery must be visible; never silently mark an unsuccessful installation as ready.
- Proposed disabled-plugin behavior: preserve records and files, but reject launches with nonempty plugin-managed selections until the plugin is enabled. Keep ambient Pi discovery disabled so retained files do not silently bypass state.

## API surface (proposal)

Use namespaced public socket endpoints, documented in AgentOrg's client API specification:

- `skills.add`: add/clone a skill into the organization catalog and persist it. Proposed input: `{ name, gitUrl }`; response returns the canonical skill record.
- `skills.list`: list catalog entries and metadata. Optional client-side filters can be considered later.

Public API agent mutations:

- `agent.create`: accept a complete skill-state selection (or an explicit installed/available representation) as part of agent settings, then install requested `installed` skills into the new agent's cwd.
- `agent.modify`: if the skill selection is supplied, accept a complete replacement; if omitted, retain the existing selection. Validate that the caller can modify the target and coordinate filesystem changes with the core lifecycle queue/persistence behavior. Public-client grants propagate availability to all ancestors without downgrading their installed skills.
- Snapshots/get/create/modify responses should return the persisted skill states so clients can display them. Document defaults and compatibility for agents created before the plugin is loaded.

MCP tools:

- Add an agent-facing `skills_list` tool returning the catalog and the caller's effective states (and clear guidance on what can be passed to children).
- Transform `child_create` to accept a complete skill selection for the new child; allow only skills the caller is allowed to delegate (at minimum, parent `available` and `installed` skills). Install the selected installed skills in the child's cwd.
- Transform `descendant_modify` to accept an optional complete replacement skill selection, applying the same validation/delegation rules to any strict descendant. An omitted selection leaves it unchanged. Do not treat inherited unchanged selections as fresh grants requiring reauthorization.

Tool names and precise fields are provisional; maintain consistent semantics between MCP create/modify and public `agent.create`/`agent.modify`. A client must not be able to make an agent use a skill absent from the catalog or bypass parent delegation constraints through MCP.

## Persistence and plugin architecture

Keep the implementation as a loadable API-v1 plugin. The current host has no generic DB API, transaction hook, or supported atomic multi-agent mutation API; being trusted in-process code does not supply those contracts.

Recommended initial architecture (implementation proposal, not yet an approved storage contract):

1. Use a dedicated plugin SQLite database under `~/.agentorg/` for the catalog, filesystem/recovery journal, and pending fetch retries. Avoid building a general plugin DB framework just for this feature.
2. Add a narrow supported per-agent skill-state field to core settings/records, persisted with the agent. Prefer a dedicated field over Pi's strict `settings.options`; define schemas, response visibility, migrations, and disabled-plugin validation explicitly.
3. Add the minimum lifecycle support needed to persist client-triggered ancestor availability with the target mutation and coordinate staged filesystem changes. The existing `beforeSettings` hook alone does not guarantee atomic updates to ancestors or post-failure compensation. Do not call queued `agent.modify` operations from inside a hook already holding the lifecycle queue.
4. Add explicit Pi skill loading through an adapter-supported input that the plugin can supply at launch; do not enable broad discovery of unrelated skills.

If upstream instead chooses a supported plugin-persistence API, catalog tables may live in `organization.sqlite`. Never independently open the core database from the plugin. SQLite transactions, schema migrations, and lifecycle consistency must remain safe. A separately loadable plugin may still require these narrow additive core integration changes; list them explicitly before implementation.

## Implementation sequence

1. Finalize the remaining API/schema decisions and narrow core integration contract. Confirm root `SKILL.md` validation, default-branch cloning, preservation-only Git recovery, and the proposed defaults below.
2. Add/confirm supported skill-state persistence, atomic ancestor grants, lifecycle compensation, disabled-plugin behavior, and explicit Pi loading. Specify migration/recovery behavior and keep public-client behavior backward-compatible.
3. Implement catalog validation, central clone initialization, persistence, listing, duplicate handling, and `skills.add`/`skills.list` endpoints.
4. Implement skill-state schema/defaults and validation for public create/modify; make installation/removal operations safe, idempotent, and failure-aware.
5. Add `skills_list`, transform `child_create`/`descendant_modify`, and enforce delegation, unchanged-on-omission, complete-replacement, and client-triggered ancestor-availability semantics.
6. Implement central/agent checkout remote registration, durable recovery refs, retained working copies, and removal-time fetch/retry, without automatic commits or merges. Test dirty trees, missing remotes, network failures, and partial failures.
7. Update the client API spec and plugin README with schemas, authorization, filesystem layout, limitations, and operations.
8. Test plugin integration and core API behavior: persistence/restart, old records, public API mutations, ancestor grants, MCP delegation, omitted versus empty selections, cwd uniqueness/symlink aliases, cwd-plugin composition, actual Pi skill loading, disabled-plugin behavior, clone/install, removal recovery, validation/security (path traversal, URL/name validation), and crash/failure compensation. Add a fake/local Git remote fixture so tests do not require network access.

## Confirmed product decisions

- This is a trusted loadable AgentOrg server plugin.
- One root `SKILL.md` per repository; no subdirectory selection and no revision pinning. Use the default branch.
- Preserve agent work for a merging agent/operator; do not automatically integrate changes.
- Omitted modification selections are unchanged; explicit selections replace the complete set.
- Public-client grants make skills at least available to all ancestors.
- Shared agent cwd is prohibited; containers are a future plugin concern.
- Default install root is `.agents/skills`; structure path resolution for a future config file, but do not implement configuration now.
- Choose conservative failure/recovery behavior, prioritizing preservation over cleanup.

## Proposed defaults and remaining decisions

Unless changed before implementation:

1. Expose `skills.add` and `skills.list` only initially. Use a caller-chosen unique name/ID and `{ name, gitUrl }`; derive descriptive metadata from root `SKILL.md`. Reject duplicate names instead of silently updating. Decide whether the same Git URL may have multiple catalog names.
2. Use a map such as `{ "skill-id": "installed" }`. New agents default to no selected skills; there is no implicit downward inheritance. A parent can delegate its installed skill as either available or installed.
3. Ancestor grants are additive; they do not automatically disappear when a descendant drops a skill. Existing children keep selections when a parent loses availability; only new MCP grants are checked against the caller's current delegable set.
4. Public clients can grant skills to roots and descendants. Catalog management is client-only initially; agents receive `skills_list` and delegation through existing tools.
5. No periodic upstream fetching or automatic propagation into existing checkouts. A merging agent/operator may work in central repositories, but plugin-managed recovery refs must not be overwritten. Future upstream-update behavior needs an explicit API/policy.
6. Use the server OS user's home consistently, with private directories and actionable permission errors. Confirm whether multiple independent organizations under the same OS user share this catalog intentionally; otherwise catalog/checkouts and remote names need organization scoping.
7. Define allowed Git URL/protocol types, noninteractive private-repository authentication, bounded clone/fetch timeouts, and size/count limits. Production source policy should reject unsafe transports and unexpected local/private-network access; local fixtures remain available for tests.
8. Finalize the supported per-agent field name and narrow core changes for persistence, ancestor grants, lifecycle compensation, and Pi loading. These are integration prerequisites, not justification for silently accessing core internals.
