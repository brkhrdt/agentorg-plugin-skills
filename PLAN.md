# Plan and baseline

Baselines inspected before edits: `agentorg` `5c32223e55e0dd230b3999a9232b5277aec4f5f2`; `agentorg-plugin-skills` `21fac1aa44805b8184950a9affadfd968e9af4fc`. Both task branches were clean. Canonical `./git` is untouched.

## Trace and scope
The skills plugin owns the explicit restriction in `agentorg-plugin-skills/src/index.ts` `host.onInitialize`: it rejects workspace/data-root overlap and store/workspace overlap. Its separate installation-root exclusion and local-source/store safety guards are not the requested restriction and remain. Core organization code has no agent-workspace-vs-data-dir rejection in the traced locations; `organization.ts` export destination checks (`dataDir`, socket, symlink-safe canonical destination) are export safety policy, not agent workspace access policy, and remain unchanged. The plugin consumes core `host.dataDir` to locate its store and records explicit skill paths for launch. Initialization and launch need regression coverage.

## Intended change and risk
Remove only the dataRoot/workspace and canonicalRoot/workspace overlap rejection in plugin initialization. Workspace equal to or within data dir, and skills store/metadata reachable from that workspace, should no longer fail solely due to overlap. Preserve installation-root, symlink, export, socket, and local-source checks. This intentionally means an agent workspace can expose server-side data/skills to its harness; containment is the container's responsibility, not these path checks.

## Validation/review sequence
Add focused regression tests for equal/inside-data-dir cases and retained boundaries; run focused suites and project checks. Commit implementation, obtain independent review from a direct child, fix any findings in separate commits, then obtain independent re-review. Report SHAs, tests, and limitations.
