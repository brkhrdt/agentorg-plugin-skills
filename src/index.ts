import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, parse, sep } from "node:path";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import type { ServerPlugin, MutationChange } from "agent-organization/plugin";
import type { AgentRecord, Settings } from "agent-organization/types";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
export const skillStatesSchema = z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64), z.enum(["unavailable", "available", "installed"]));
export type SkillStates = z.infer<typeof skillStatesSchema>;
export const states = (settings: Settings) => settings.extensions?.skills as SkillStates | undefined;
import { cloneLocalSnapshot, gitWithTimeout } from "./git.ts";
import { skillsServerSettings } from "./config.ts";
import { migrateCatalog, sourceIdentity, type CatalogSkill, type SkillSource } from "./catalog.ts";
import { checkCheckoutLimits, readSkillMetadata } from "./skill-content.ts";
import { LocalSkillImporter } from "./local-import.ts";
import { localSkillImportSupported } from "./local-source.ts";

export interface Skill extends CatalogSkill {}
interface Installation { generation: string; agentId: string; skill: string; path: string; remote: string; status: "staged" | "active" | "retained"; pending: boolean; error?: string }
interface Action { generation: string; from: string; to: string; old: boolean }
interface Journal { id: string; agentId: string; revision: number; actions: Action[]; path?: string; repository?: { name: string; gitUrl: string }; localImport?: { phase: "intent" | "copying" | "copied" | "initialized"; sourcePath: string; stagingPath: string; name?: string } }
type RepositoryOrigin = "manual" | "configured";
type RepositoryStatus = "pending" | "ready" | "retired" | "error";
interface RepositoryRecordState { name: string; gitUrl: string; origin: RepositoryOrigin; status: RepositoryStatus; error?: string; attempts: number; fingerprint: string; failureClass?: "transient" | "permanent" }
interface ReconciliationStatus { generation: number; desiredRevision: number; fingerprint: string; state: "pending" | "running" | "ready" | "error"; lastSuccessfulRevision?: number; entries: Array<{ name: string; gitUrl: string; status: RepositoryStatus; error?: string; attempts: number }> }
interface Options {
  /** Test/embedded deployments only; normal CLI always uses OS home. */
  home?: string;
  /** Explicit opt-in for trusted local test fixtures. Not a socket parameter. */
  allowLocalSources?: boolean;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fail(message: string, code = "INVALID_PARAMS"): never { throw Object.assign(new Error(message), { code }); }
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const server = { kind: "server", id: "skills" } as const;
const selected = (skills?: SkillStates) => Object.entries(skills ?? {}).filter(([, state]) => state !== "unavailable");
/** Single resolver for installation, loading, collisions and reconciliation. */
export const installRoot = (cwd: string) => join(cwd, ".agents", "skills");
const exists = async (path: string) => !!await lstat(path).catch((e) => { if (e.code === "ENOENT") return null; throw e; });
async function privateDirectory(path: string) {
  path = resolve(path);
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error: any) { if (error.code !== "EEXIST") throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(`Managed directory cannot traverse a symlink/non-directory: ${current}`);
  }
  await chmod(path, 0o700);
}
async function checkoutLimit(path: string) {
  try { await checkCheckoutLimits(path); }
  catch (error: any) { fail(error.message, error.code ?? "INVALID_PARAMS"); }
}
async function metadata(path: string, name: string) {
  try { return (await readSkillMetadata(path, name)).description; }
  catch (error) { fail((error as Error).message); }
}
function source(input: unknown, allowLocal: boolean): string {
  if (typeof input !== "string" || input.length > 2048 || /[\x00-\x20]/.test(input)) fail("Invalid Git source");
  if (allowLocal && input.startsWith("/")) return resolve(input);
  let url: URL;
  try { url = new URL(input); } catch { return fail("Use an HTTPS Git URL"); }
  const authority = input.match(/^https:\/\/([^/?#]+)/i)?.[1];
  if (!authority || url.protocol !== "https:" || url.username || url.password || authority.includes(":") || url.port || url.search || url.hash ||
      !["github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname) || !/^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(url.pathname) || url.pathname.split("/").some(s => s === "." || s === ".."))
    fail("Only HTTPS repositories on github.com, gitlab.com or bitbucket.org are supported (no credentials, ports, queries or redirects)");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function createSkillsPlugin(options: Options = {}): ServerPlugin {
  return { apiVersion: 1, name: "skills", async setup(host) {
    const startupSnapshot = await host.request("organization.snapshot", {}, server) as { capabilities?: { cwd?: unknown } };
    const localImportBase = typeof startupSnapshot?.capabilities?.cwd === "string" ? resolve(startupSnapshot.capabilities.cwd) : process.cwd();
    const supportsLocalImport = await localSkillImportSupported();
    // Scope independent organizations by canonical data directory; never open core SQLite.
    const scope = hash(await realpath(host.dataDir));
    const root = join(await realpath(options.home ?? homedir()), ".agentorg", "skills", scope);
    await privateDirectory(root);
    const db = new Database(join(root, "skills.sqlite"), { create: true });
    await chmod(join(root, "skills.sqlite"), 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta(version INTEGER NOT NULL);
      INSERT INTO meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM meta);
      CREATE TABLE IF NOT EXISTS catalog(name TEXT PRIMARY KEY, url TEXT UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS installations(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_state(name TEXT NOT NULL, url TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(name,url));
      CREATE TABLE IF NOT EXISTS reconciliation(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);`);
    migrateCatalog(db);
    const rows = <T>(table: string): T[] => db.query(`SELECT data FROM ${table} ORDER BY rowid`).all().map((r: any) => JSON.parse(r.data));
    const put = (table: "installations" | "journal", id: string, value: unknown) => db.query(`INSERT OR REPLACE INTO ${table} VALUES (?,?)`).run(id, JSON.stringify(value));
    const dropJournal = (id: string) => db.query("DELETE FROM journal WHERE id=?").run(id);
    const catalog = () => rows<Skill>("catalog");
    const skill = (name: string) => catalog().find(s => s.name === name) ?? fail(`Unknown skill ${name}`);
    const knownSelection = (name: string) => catalog().some(item => item.name === name) || desiredRepositories().some(item => item.name === name) || repositoryStates().some(item => item.name === name);
    function selectionSkill(name: string): Skill {
      const item = catalog().find(skill => skill.name === name);
      if (item) return item;
      const desired = desiredRepositories().find(repository => repository.name === name);
      const state = desired ? repositoryState(name, desired.gitUrl) : repositoryStates().find(candidate => candidate.name === name);
      if (!desired && (state?.status === "retired" || state?.origin === "configured")) fail(`Skill ${name} is retired from the configured repository list`, "REPOSITORY_RETIRED");
      if (desired) {
        const conflict = state?.status === "error" && /conflict|limit/i.test(state.error ?? "");
        const currentStatus = state?.status === "retired" ? "pending" : state?.status ?? "pending";
        fail(`Configured skill ${name} is ${currentStatus}${state?.error ? `: ${state.error}` : ""}`, conflict ? "REPOSITORY_CONFLICT" : "SKILL_NOT_READY");
      }
      fail(`Unknown skill ${name}`);
    }
    const gitSource = (item: Skill): string => item.source.kind === "git" ? item.source.gitUrl : fail(`Skill ${item.name} is not Git-backed`);
    const exposedSkill = (item: Skill) => ({ ...item, origin: item.source.kind === "git" ? repositoryState(item.name, item.source.gitUrl)?.origin ?? "manual" : "manual" });
    const installations = () => rows<Installation>("installations");
    const installation = (generation: string) => installations().find(i => i.generation === generation)!;
    const report = (error: unknown, agentId?: string) => host.emit("skills.error", { message: (error as Error).message }, agentId);
    // Serialize all Git/ledger work, including asynchronous removal observers.
    let tail: Promise<unknown> = Promise.resolve();
    function exclusive<T>(work: () => Promise<T>): Promise<T> {
      const next = tail.then(work); tail = next.catch(() => {}); return next;
    }
    let publishTail: Promise<unknown> = Promise.resolve();
    function catalogPublish<T>(work: () => T | Promise<T>): Promise<T> {
      const next = publishTail.then(work); publishTail = next.catch(() => {}); return next;
    }
    const identityClaims = new Map<string, string>();
    const claimIdentity = (name: string, gitUrl: string): string | undefined => {
      const key = `${name}\0${gitUrl}`;
      if (identityClaims.has(key)) return undefined;
      const owner = randomUUID(); identityClaims.set(key, owner);
      return owner;
    };
    const releaseIdentity = (name: string, gitUrl: string, owner: string) => {
      const key = `${name}\0${gitUrl}`;
      if (identityClaims.get(key) === owner) identityClaims.delete(key);
    };
    let shuttingDown = false;
    let reconciliationWorker: Promise<void> | undefined;
    let fullReconciliationRequest: { reason: string; resetRetries: boolean; allowPermanentRetry: boolean } | undefined;
    let activePermanentRetryPermission = false;
    const targetedRetryRequests = new Set<string>();
    let observedSettingsRevision = 0;
    let sweepTimer: ReturnType<typeof setInterval> | undefined;
    const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const git = (cwd: string, ...args: string[]) => {
      const effective = host.serverSettings("skills") as { gitTimeoutMs?: number };
      return gitWithTimeout(cwd, effective.gitTimeoutMs ?? 60_000, ...args);
    };
    const effectiveConfig = () => host.serverSettings("skills") as { repositories: Array<{ name: string; gitUrl: string }>; gitTimeoutMs: number; maxCatalogEntries: number };
    const repositoryStates = () => rows<RepositoryRecordState>("repository_state");
    const repositoryState = (name: string, gitUrl: string) => repositoryStates().find(state => state.name === name && state.gitUrl === gitUrl);
    const saveRepositoryState = (state: RepositoryRecordState) => db.query("INSERT OR REPLACE INTO repository_state VALUES (?,?,?)").run(state.name, state.gitUrl, JSON.stringify(state));
    const desiredRepositories = () => effectiveConfig().repositories;
    const configuredIdentity = (name: string, gitUrl: string) => desiredRepositories().some(repository => repository.name === name && repository.gitUrl === gitUrl);
    const identityFingerprint = (repositories: Array<{ name: string; gitUrl: string }>) => hash(JSON.stringify([...repositories].sort((a, b) => a.name.localeCompare(b.name) || a.gitUrl.localeCompare(b.gitUrl))));
    const repositoryFingerprint = (name: string, gitUrl: string) => hash(JSON.stringify([name, gitUrl]));
    const reconciliation = (): ReconciliationStatus => {
      const saved = db.query("SELECT data FROM reconciliation WHERE id=1").get() as { data: string } | null;
      return saved ? JSON.parse(saved.data) : { generation: 0, desiredRevision: 0, fingerprint: "", state: "ready", entries: [] };
    };
    const saveReconciliation = (value: ReconciliationStatus) => db.query("INSERT OR REPLACE INTO reconciliation VALUES (1,?)").run(JSON.stringify(value));
    const configuredActive = (item: Skill) => {
      if (item.source.kind !== "git") return true;
      const state = repositoryState(item.name, item.source.gitUrl);
      return state?.origin === "manual" || (state?.origin === "configured" && configuredIdentity(item.name, item.source.gitUrl));
    };
    const grantable = (item: Skill) => item.source.kind === "local" || (configuredActive(item) && repositoryState(item.name, item.source.gitUrl)?.status === "ready");
    const activeCatalog = () => catalog().filter(grantable);
    // Schema-v1 catalog entries have no ownership record. Classify once against
    // the current effective configuration; all nonmatches remain manual.
    const migrateRepositoryOwnership = () => db.transaction(() => {
      const configured = desiredRepositories();
      for (const item of catalog()) if (item.source.kind === "git" && !repositoryState(item.name, item.source.gitUrl)) {
        const origin = configured.some(repository => repository.name === item.name && repository.gitUrl === gitSource(item)) ? "configured" : "manual";
        saveRepositoryState({ name: item.name, gitUrl: item.source.gitUrl, origin, status: "ready", attempts: 0, fingerprint: "" });
      }
    })();
    async function own(i: Installation, path = i.path) {
      if ((await lstat(path)).isSymbolicLink()) fail(`Skill checkout is a symlink: ${path}`);
      const markerPath = join(path, ".git", "agentorg-skills.json");
      if (!(await lstat(join(path, ".git"))).isDirectory()) fail(`Not a managed clone: ${path}`);
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      if (marker.scope !== scope || marker.generation !== i.generation || marker.agentId !== i.agentId || marker.skill !== i.skill)
        fail(`Managed checkout identity mismatch: ${path}`);
      if (await git(path, "rev-parse", "--show-toplevel") !== await realpath(path)) fail(`Not a skill repository root: ${path}`);
    }
    async function remote(i: Installation) {
      const central = skill(i.skill).path;
      const names = (await git(central, "remote")).split("\n");
      await git(central, "remote", names.includes(i.remote) ? "set-url" : "add", i.remote, i.path);
    }
    async function recover(i: Installation) {
      i.pending = true; put("installations", i.generation, i);
      try {
        await own(i); await remote(i);
        const ref = `refs/agentorg-recovery/${i.remote}/${randomUUID()}`;
        await git(skill(i.skill).path, "fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--recurse-submodules=no", "--no-write-fetch-head", i.remote,
          `refs/heads/*:${ref}/heads/*`, `HEAD:${ref}/HEAD`);
        i.pending = false; delete i.error;
        host.emit("skills.recovered", { skill: i.skill, path: i.path, ref }, i.agentId);
      } catch (error) { i.error = (error as Error).message; report(error, i.agentId); }
      put("installations", i.generation, i);
    }
    async function move(action: Action, forward: boolean) {
      const i = installation(action.generation);
      const from = forward ? action.from : action.to, to = forward ? action.to : action.from;
      if (await exists(from)) {
        await own(i, from);
        if (await exists(to)) fail(`Checkout collision: ${to}`);
        await privateDirectory(join(to, ".."));
        await rename(from, to);
      } else if (await exists(to)) await own(i, to);
      else fail(`Missing checkout during reconciliation: ${from}`);
      i.path = to;
      i.status = forward ? (action.old ? "retained" : "active") : (action.old ? "active" : "retained");
      put("installations", i.generation, i);
      await remote(i);
    }
    async function compensate(journal: Journal) {
      // Actions not yet applied stay at their original location. Never delete artifacts.
      for (const action of [...journal.actions].reverse()) {
        const atTarget = await exists(action.to), atSource = await exists(action.from);
        if (atTarget && atSource) fail(`Ambiguous interrupted move; both copies retained: ${action.from}, ${action.to}`);
        if (atTarget) await move(action, false);
        else if (action.old && !atSource) fail(`Missing retained checkout: ${action.from}`);
      }
      for (const action of journal.actions.filter(a => !a.old)) {
        const i = installation(action.generation);
        i.status = "retained"; i.pending = true;
        put("installations", i.generation, i);
      }
      dropJournal(journal.id);
    }
    async function prepare(settings: Settings, agent: Readonly<AgentRecord>, context: { caller: { kind: string; id: string }; selectionSupplied: boolean; creating: boolean; previous?: Readonly<AgentRecord> }): Promise<MutationChange> {
      const nextStates = states(settings) ?? {};
      const previousStates = context.creating ? {} : (states(context.previous?.settings ?? agent.settings) ?? {});
      for (const [name, state] of Object.entries(nextStates)) {
        if (!knownSelection(name)) fail(`Unknown skill ${name}`);
        const item = catalog().find(skill => skill.name === name);
        if (!item) {
          if (state !== "unavailable") selectionSkill(name);
          continue;
        }
        const retiredDowngrade = !configuredActive(item) && previousStates[name] === "installed" && state === "available";
        const desiredConflict = item.source.kind === "git" ? desiredRepositories().find(repository => repository.name === name && repository.gitUrl !== gitSource(item)) : undefined;
        if (item.source.kind === "git" && repositoryState(item.name, item.source.gitUrl)?.origin === "configured" && desiredConflict && state !== "unavailable" && previousStates[name] !== state && !retiredDowngrade)
          fail(`Skill ${name} conflicts with configured source ${desiredConflict.gitUrl}`, "REPOSITORY_CONFLICT");
        if (state !== "unavailable" && !grantable(item) && previousStates[name] !== state && !retiredDowngrade) {
          const record = item.source.kind === "git" ? repositoryState(item.name, item.source.gitUrl) : undefined;
          fail(`Skill ${name} is ${record?.status === "retired" || !configuredActive(item) ? "retired from the configured repository list" : "not ready"}`, record?.status === "retired" || !configuredActive(item) ? "REPOSITORY_RETIRED" : "SKILL_NOT_READY");
        }
      }
      if (context.selectionSupplied && context.caller.kind === "agent") {
        const parent = await host.request("agent.get", { agentId: context.caller.id }, server) as AgentRecord;
        for (const [name, state] of selected(nextStates)) {
          if (previousStates[name] === state || (previousStates[name] === "installed" && state === "available")) continue;
          const item = catalog().find(skill => skill.name === name)!;
          if (!grantable(item)) fail(`Skill ${name} is not active and ready for delegation`, "REPOSITORY_RETIRED");
          if (!["available", "installed"].includes(states(parent.settings)?.[name] ?? "unavailable"))
            fail(`Caller cannot delegate ${name}`, "FORBIDDEN");
        }
      }
      const cwd = settings.cwd!;
      await privateDirectory(join(cwd, ".agents"));
      await privateDirectory(installRoot(cwd));
      const journal: Journal = { id: randomUUID(), agentId: agent.id, revision: context.creating ? 1 : agent.revision + 1, actions: [] };
      put("journal", journal.id, journal);
      try {
        const active = installations().filter(i => i.agentId === agent.id && i.status === "active");
        for (const i of active) {
          if (states(settings)?.[i.skill] === "installed" && i.path === join(installRoot(cwd), i.skill)) {
            await own(i); await metadata(i.path, i.skill); continue;
          }
          await own(i);
          const to = join(agent.settings.cwd!, ".agents", "agentorg-recovery", scope, i.generation);
          journal.actions.push({ generation: i.generation, from: i.path, to, old: true });
          put("journal", journal.id, journal);
        }
        for (const [name, state] of selected(states(settings))) {
          if (state !== "installed") continue;
          const dest = join(installRoot(cwd), name);
          if (active.some(i => i.skill === name && i.path === dest && !journal.actions.some(a => a.generation === i.generation))) continue;
          if (await exists(dest)) fail(`Refusing to overwrite existing directory: ${dest}`, "COLLISION");
          const generation = randomUUID();
          const stage = join(cwd, ".agents", "agentorg-recovery", scope, generation);
          await privateDirectory(join(stage, ".."));
          const i: Installation = { generation, agentId: agent.id, skill: name, path: stage, remote: `agent-${agent.id}-${generation}`, status: "staged", pending: false };
          put("installations", generation, i);
          journal.actions.push({ generation, from: stage, to: dest, old: false });
          put("journal", journal.id, journal);
          const catalogSkill = skill(name);
          if (catalogSkill.source.kind === "local") await cloneLocalSnapshot(catalogSkill.path, stage, effectiveConfig().gitTimeoutMs);
          else await git(root, "clone", "--no-hardlinks", "--", catalogSkill.path, stage);
          await metadata(stage, name);
          await checkoutLimit(stage);
          await writeFile(join(stage, ".git", "agentorg-skills.json"), JSON.stringify({ scope, generation, agentId: agent.id, skill: name }), { mode: 0o600 });
          await remote(i);
        }
      } catch (error) {
        try { await compensate(journal); } catch (rollback) { report(rollback, agent.id); }
        throw error;
      }
      return {
        apply: () => exclusive(async () => {
          for (const action of journal.actions) {
            await move(action, true);
            if (action.old) await recover(installation(action.generation));
          }
        }),
        rollback: () => exclusive(() => compensate(journal)),
        committed: () => exclusive(async () => { dropJournal(journal.id); }),
      };
    }
    async function launchPaths(agent: Readonly<AgentRecord>) {
      if (selected(states(agent.settings)).some(([, state]) => state === "installed")) {
        await privateDirectory(join(agent.settings.cwd!, ".agents"));
        await privateDirectory(installRoot(agent.settings.cwd!));
      }
      const result: string[] = [];
      for (const [name, state] of selected(states(agent.settings))) {
        skill(name);
        if (state !== "installed") continue;
        const path = join(installRoot(agent.settings.cwd!), name);
        const i = installations().find(i => i.agentId === agent.id && i.skill === name && i.path === path && i.status === "active");
        if (!i) fail(`Installed skill ${name} is not ready; reconciliation required`, "SKILL_NOT_READY");
        await own(i); await metadata(path, name);
        result.push(join(path, "SKILL.md"));
      }
      return result;
    }
    host.registerSettings({
      namespace: "skills",
      validate(value) {
        const parsed = skillStatesSchema.parse(value);
        for (const name of Object.keys(parsed)) if (!knownSelection(name)) fail(`Unknown skill ${name}`);
        return parsed;
      },
      launchKey: value => selected(value as SkillStates).filter(([, state]) => state === "installed").map(([name]) => name).sort(),
      migrate(settings) {
        if (!Object.hasOwn(settings, "skills")) return settings;
        const legacy = skillStatesSchema.parse(settings.skills);
        const extensions = { ...(settings.extensions as Record<string, unknown> ?? {}) };
        if (Object.hasOwn(extensions, "skills") && !isDeepStrictEqual(skillStatesSchema.parse(extensions.skills), legacy))
          fail("Ambiguous legacy and namespaced skill selections; resolve both explicitly", "MIGRATION_CONFLICT");
        const { skills: _legacy, ...rest } = settings;
        return { ...rest, extensions: { ...extensions, skills: legacy } };
      },
    });
    host.registerServerSettings(skillsServerSettings(options.allowLocalSources ?? false));
    migrateRepositoryOwnership();
    host.registerCapability("skills", {
      settingsNamespace: "skills", serverSettingsNamespace: "skills",
      endpoints: { list: "skills.list", add: "skills.add", reconcile: "skills.reconcile", ...(supportsLocalImport ? { addFromPath: "skills.addFromPath" } : {}) },
      localImport: supportsLocalImport, version: 1,
    });
    async function uniqueCwd(settings: Settings, agent: Readonly<AgentRecord>, agents: Readonly<AgentRecord>[]) {
      const cwd = await realpath(settings.cwd ?? process.cwd());
      if (!(await lstat(cwd)).isDirectory()) fail("cwd must be a directory");
      for (const other of agents) {
        if (other.id === agent.id || other.removedAt) continue;
        if (await realpath(other.settings.cwd ?? process.cwd()).catch(() => null) === cwd)
          fail(`cwd already belongs to ${other.id}`, "CWD_CONFLICT");
      }
      return { ...settings, cwd };
    }
    host.beforeMutation(async context => {
      if (!["agent.create", "agent.modify"].includes(context.method)) return;
      const settings = await uniqueCwd(context.agent.settings, context.agent, context.agents);
      const selectionSupplied = context.settingsPatch?.extensions?.skills !== undefined;
      // Build grants before staging so validation failures do not leave an unowned journal.
      const updates: NonNullable<MutationChange["updates"]> = [];
      if (selectionSupplied && context.caller.kind === "client") {
        const previousStates = context.method === "agent.create" ? {} : (states((context.previous ?? context.agent).settings) ?? {});
        const newlySelected = selected(states(settings)).filter(([name, state]) => previousStates[name] !== state && !(previousStates[name] === "installed" && state === "available"));
        let parentId = context.agent.parentId;
        while (parentId && newlySelected.length) {
          const parent = context.agents.find(a => a.id === parentId)!;
          const skills = { ...states(parent.settings) };
          let changed = false;
          for (const [name] of newlySelected) {
            if (!["available", "installed"].includes(skills[name] ?? "unavailable")) { skills[name] = "available"; changed = true; }
          }
          if (changed) updates.push({ agentId: parent.id, expectedRevision: parent.revision, settings: { ...parent.settings, extensions: { ...parent.settings.extensions, skills } } });
          parentId = parent.parentId;
        }
      }
      const change = await exclusive(() => prepare(settings, context.previous ?? context.agent, { caller: context.caller, selectionSupplied, creating: context.method === "agent.create", previous: context.previous }));
      return { ...change, settings, updates };
    });
    host.prepareLaunch(async context => {
      const snapshot = await host.request("organization.snapshot", {}, server) as { agents: AgentRecord[] };
      await uniqueCwd(context.agent.settings, context.agent, snapshot.agents);
      context.env.AGENTORG_SKILL_FILES = JSON.stringify(await exclusive(() => launchPaths(context.agent)));
    });
    host.validateLaunch(async (spec, { agent }) => {
      if (selected(states(agent.settings)).some(([, state]) => state === "installed") && !spec.consumesEnv?.includes("AGENTORG_SKILL_FILES"))
        fail("Harness does not consume explicit managed skill files", "SKILL_NOT_READY");
      if (spec.env?.AGENTORG_SKILL_FILES !== JSON.stringify(await exclusive(() => launchPaths(agent))))
        fail("Explicit managed launch files were changed by another plugin", "SKILL_NOT_READY");
      if (await realpath(spec.cwd!) !== await realpath(agent.settings.cwd ?? process.cwd()))
        fail("Harness cwd must match the managed workspace", "CWD_CONFLICT");
    });
    host.onInitialize(async agents => {
        await runReconciliation("startup");
        await exclusive(async () => {
        for (const j of rows<Journal>("journal")) {
          if (j.path) {
            report(new Error(j.localImport
              ? `Interrupted local skill import (${j.localImport.phase}) retained at ${j.path}; not registered or recopied`
              : `Interrupted catalog clone retained at ${j.path}; not registered`));
            continue;
          }
          const agent = agents.find(a => a.id === j.agentId);
          try {
            if (agent && agent.revision >= j.revision) {
              for (const action of j.actions) await move(action, true);
              dropJournal(j.id);
            } else await compensate(j);
          } catch (error) { report(error, j.agentId); }
        }
        for (const i of installations()) {
          const agent = agents.find(a => a.id === i.agentId);
          if (i.pending || agent?.removedAt || i.status === "retained") await recover(i);
        }
        const identities = new Map<string, string[]>();
        for (const agent of agents.filter(a => !a.removedAt)) {
          const cwd = await realpath(agent.settings.cwd ?? process.cwd()).catch(() => null);
          if (cwd) identities.set(cwd, [...(identities.get(cwd) ?? []), agent.id]);
        }
        for (const agent of agents.filter(a => !a.removedAt)) {
          try {
            const cwd = await realpath(agent.settings.cwd ?? process.cwd());
            if ((identities.get(cwd)?.length ?? 0) > 1) fail(`Shared cwd at startup: ${cwd}`, "CWD_CONFLICT");
            // Reinstall missing managed directories only when no ledger claims a damaged checkout.
            // Missing/damaged recorded repositories require operator intervention, never replacement.
            await prepare(agent.settings, agent, { caller: server, selectionSupplied: false, creating: false });
            // Already inside the plugin queue: apply journal actions directly, not nested exclusive().
            const journal = rows<Journal>("journal").find(j => j.agentId === agent.id)!;
            for (const action of journal.actions) {
              await move(action, true);
              if (action.old) await recover(installation(action.generation));
            }
            dropJournal(journal.id);
            await launchPaths(agent);
          } catch (error) {
            report(error, agent.id);
            for (const i of installations().filter(i => i.agentId === agent.id && i.status === "active")) {
              i.pending = true; i.error = (error as Error).message;
              put("installations", i.generation, i);
            }
          }
        }
      });
    });
    async function registerCatalog(name: string, inputUrl: unknown): Promise<Skill> {
      if (typeof name !== "string" || name.length > 64 || !idPattern.test(name)) fail("Invalid skill name");
      const url = source(inputUrl, options.allowLocalSources ?? false);
      const claim = claimIdentity(name, url);
      if (!claim) fail(`Repository registration is already in progress for ${name}`, "DUPLICATE");
      try {
        const existing = catalog();
        const sameName = existing.find(s => s.name === name);
        const sameUrl = existing.find(s => s.gitUrl === url);
        if (sameName || sameUrl) fail(`Skill repository conflict for ${name}: name or Git source already registered`, "DUPLICATE");
        if (existing.length >= effectiveConfig().maxCatalogEntries) fail(`Catalog limit (${effectiveConfig().maxCatalogEntries}) reached`, "LIMIT");
        const path = join(root, hash(name) + "-" + randomUUID());
        const journalId = `catalog-${randomUUID()}`;
        put("journal", journalId, { id: journalId, agentId: "catalog", revision: 0, actions: [], path, repository: { name, gitUrl: url } });
        let description: string;
        try {
          await git(root, "-c", `protocol.file.allow=${url.startsWith("/") ? "always" : "never"}`, "clone", "--", url, path);
          description = await metadata(path, name);
          await checkoutLimit(path);
        } catch (error) {
          throw new Error(`Catalog checkout for ${name} retained at ${path}: ${(error as Error).message}`);
        }
        const record: Skill = { name, source: { kind: "git", gitUrl: url }, gitUrl: url, description, path, createdAt: new Date().toISOString() };
        try {
          await catalogPublish(() => db.transaction(() => {
            if (catalog().some(s => s.name === name || s.gitUrl === url)) fail(`Skill repository conflict for ${name}`, "DUPLICATE");
            if (catalog().length >= effectiveConfig().maxCatalogEntries) fail(`Catalog limit (${effectiveConfig().maxCatalogEntries}) reached`, "LIMIT");
            db.query("INSERT INTO catalog VALUES (?,?,?)").run(name, url, JSON.stringify(record));
            saveRepositoryState({ name, gitUrl: url, origin: "manual", status: "ready", attempts: 0, fingerprint: "" });
            dropJournal(journalId);
          })());
        } catch (error) {
          throw new Error(`Catalog registration for ${name} (${url}) failed; checkout and journal retained at ${path}: ${(error as Error).message}`);
        }
        host.emit("skills.catalog_added", exposedSkill(record));
        return exposedSkill(record);
      } finally {
        releaseIdentity(name, url, claim);
        if (desiredRepositories().some(repository => repository.name === name || repository.gitUrl === url)) scheduleReconciliation("catalog-add");
      }
    }
    const activeLocalImports = new Set<Promise<unknown>>();
    const localImporter = new LocalSkillImporter({
      centralRoot: root, stagingRoot: join(root, "local-import-staging"), maxCatalogEntries: effectiveConfig().maxCatalogEntries,
      gitTimeoutMs: () => effectiveConfig().gitTimeoutMs,
      putJournal: journal => put("journal", journal.id, journal),
      publish: async (record, identity, journalId) => {
        await catalogPublish(() => db.transaction(() => {
          const entries = catalog();
          if (entries.some(item => item.name === record.name || item.source && sourceIdentity(item.source) === identity))
            fail(`Local skill source or name already registered: ${record.name}`, "DUPLICATE");
          if (entries.length >= effectiveConfig().maxCatalogEntries) fail(`Catalog limit (${effectiveConfig().maxCatalogEntries}) reached`, "LIMIT");
          db.query("INSERT INTO catalog VALUES (?,?,?)").run(record.name, identity, JSON.stringify(record));
          dropJournal(journalId);
        })());
        if (desiredRepositories().some(repository => repository.name === record.name)) scheduleReconciliation("catalog-add");
      },
      report: error => report(error),
      emit: record => host.emit("skills.catalog_added", exposedSkill(record)),
    });
    function runLocalImport(input: unknown, pathOptions: { baseDir?: string; home?: string } = {}) {
      if (shuttingDown) fail("Skills plugin is shutting down", "SHUTTING_DOWN");
      const operation = exclusive(() => localImporter.import(input, pathOptions));
      activeLocalImports.add(operation);
      void operation.finally(() => activeLocalImports.delete(operation)).catch(() => {});
      return operation;
    }
    async function settingsView() {
      return await host.request("organization.settings.get", { namespace: "skills" }, server) as { revision: number; effective: { repositories: Array<{ name: string; gitUrl: string }> } };
    }
    function saveStatus(status: ReconciliationStatus, startsGeneration = false) {
      const current = reconciliation();
      const expectedGeneration = current.generation + (startsGeneration ? 1 : 0);
      if (status.generation !== expectedGeneration || status.desiredRevision < observedSettingsRevision || identityFingerprint(desiredRepositories()) !== status.fingerprint) return false;
      saveReconciliation(status);
      host.emit("skills.reconciliation_changed", status);
      return true;
    }
    function currentGenerationSync(generation: number, revision: number, fingerprint: string, name?: string, gitUrl?: string) {
      return !shuttingDown && reconciliation().generation === generation && observedSettingsRevision <= revision && identityFingerprint(desiredRepositories()) === fingerprint &&
        (name === undefined || gitUrl === undefined || configuredIdentity(name, gitUrl));
    }
    async function currentGeneration(generation: number, revision: number, fingerprint: string, name?: string, gitUrl?: string) {
      if (!currentGenerationSync(generation, revision, fingerprint, name, gitUrl)) return false;
      try {
        const view = await settingsView();
        observedSettingsRevision = Math.max(observedSettingsRevision, view.revision);
        return view.revision === revision && identityFingerprint(view.effective.repositories) === fingerprint && currentGenerationSync(generation, revision, fingerprint, name, gitUrl);
      } catch (error) {
        if (!shuttingDown) report(error);
        return false;
      }
    }
    function scheduleRetry(name: string, url: string, attempts: number) {
      if (attempts > 2 || shuttingDown || !configuredIdentity(name, url)) return;
      const key = `${name}\0${url}`;
      if (retryTimers.has(key)) return;
      const delay = attempts === 1 ? 1_000 : 5_000;
      const timer = setTimeout(() => {
        if (retryTimers.get(key) !== timer) return;
        retryTimers.delete(key);
        if (!shuttingDown && configuredIdentity(name, url)) void runReconciliation("retry", false, key).catch(error => report(error));
      }, delay);
      retryTimers.set(key, timer);
    }
    function transient(error: unknown) {
      const code = (error as any)?.code;
      if (["INVALID_PARAMS", "DUPLICATE", "LIMIT", "REPOSITORY_RETIRED"].includes(code)) return false;
      const message = (error as Error)?.message ?? "";
      return !/SKILL\.md|frontmatter|must match|exceeds|conflict|invalid skill name/i.test(message);
    }
    async function reconcileIdentity(repository: { name: string; gitUrl: string }, revision: number, fingerprint: string, generation: number, allowPermanentRetry = false, allowTransientRetry = false) {
      const { name, gitUrl } = repository;
      if (!currentGenerationSync(generation, revision, fingerprint, name, gitUrl)) return;
      const previous = repositoryState(name, gitUrl);
      const repoFingerprint = repositoryFingerprint(name, gitUrl);
      if (previous?.failureClass === "permanent" && !allowPermanentRetry) return;
      if (previous?.failureClass === "transient" && previous.status === "error" && !allowTransientRetry) return;
      if (previous?.fingerprint === repoFingerprint && previous.status === "error" && previous.attempts >= 3) return;
      let attempts = previous?.fingerprint === repoFingerprint ? previous.attempts : 0;
      const update = (status: RepositoryStatus, error?: string, failureClass?: "transient" | "permanent") => {
        if (!currentGenerationSync(generation, revision, fingerprint, name, gitUrl)) return false;
        saveRepositoryState({ name, gitUrl, origin: "configured", status, error, attempts, fingerprint: repoFingerprint, failureClass });
        return true;
      };
      const existing = catalog();
      const exact = existing.find(item => item.name === name && item.gitUrl === gitUrl);
      if (exact) {
        const oldState = repositoryState(name, gitUrl);
        if (oldState?.origin === "manual") return;
        try {
          await metadata(exact.path, name);
          if (!await currentGeneration(generation, revision, fingerprint, name, gitUrl)) return;
          await checkoutLimit(exact.path);
          if (!await currentGeneration(generation, revision, fingerprint, name, gitUrl)) return;
          update("ready");
        } catch (error) {
          const failureClass = transient(error) ? "transient" : "permanent";
          if (await currentGeneration(generation, revision, fingerprint, name, gitUrl) && update("error", (error as Error).message, failureClass))
            report(new Error(`Configured repository ${name} (${gitUrl}) validation failed: ${(error as Error).message}`));
        }
        return;
      }
      const conflict = existing.find(item => item.name === name || item.gitUrl === gitUrl);
      if (conflict) {
        const message = `Repository identity conflicts with registered skill ${conflict.name}`;
        if (update("error", message)) report(new Error(`Configured repository ${name} (${gitUrl}) failed: ${message}`));
        return;
      }
      if (existing.length >= effectiveConfig().maxCatalogEntries) {
        const message = `Catalog limit (${effectiveConfig().maxCatalogEntries}) reached`;
        if (update("error", message)) report(new Error(`Configured repository ${name} (${gitUrl}) failed: ${message}`));
        return;
      }
      const claim = claimIdentity(name, gitUrl);
      if (!claim) { update("pending", "Repository registration is already in progress"); return; }
      const path = join(root, hash(name) + "-" + randomUUID());
      const journalId = `catalog-${randomUUID()}`;
      put("journal", journalId, { id: journalId, agentId: "catalog", revision, actions: [], path, repository: { name, gitUrl } });
      if (!update("pending")) { releaseIdentity(name, gitUrl, claim); return; }
      try {
        const url = source(gitUrl, options.allowLocalSources ?? false);
        await git(root, "-c", `protocol.file.allow=${url.startsWith("/") ? "always" : "never"}`, "clone", "--", url, path);
        if (!await currentGeneration(generation, revision, fingerprint, name, gitUrl)) return;
        const description = await metadata(path, name);
        if (!await currentGeneration(generation, revision, fingerprint, name, gitUrl)) return;
        await checkoutLimit(path);
        if (!await currentGeneration(generation, revision, fingerprint, name, gitUrl)) return;
        const record: Skill = { name, source: { kind: "git", gitUrl }, gitUrl, description, path, createdAt: new Date().toISOString() };
        await catalogPublish(() => db.transaction(() => {
          if (!currentGenerationSync(generation, revision, fingerprint, name, gitUrl)) return;
          const now = catalog();
          const byName = now.find(item => item.name === name), byUrl = now.find(item => item.gitUrl === gitUrl);
          if (byName || byUrl) {
            if (byName?.gitUrl === gitUrl) {
              if (repositoryState(name, gitUrl)?.origin !== "manual") update("ready");
              dropJournal(journalId); return;
            }
            update("error", `Repository identity conflicts with registered skill ${byName?.name ?? byUrl?.name}`); return;
          }
          if (now.length >= effectiveConfig().maxCatalogEntries) { update("error", `Catalog limit (${effectiveConfig().maxCatalogEntries}) reached`); return; }
          db.query("INSERT INTO catalog VALUES (?,?,?)").run(name, gitUrl, JSON.stringify(record));
          update("ready");
          dropJournal(journalId);
        })());
        if (await currentGeneration(generation, revision, fingerprint, name, gitUrl) && repositoryState(name, gitUrl)?.status === "ready")
          host.emit("skills.catalog_added", exposedSkill(record));
      } catch (error) {
        if (!await currentGeneration(generation, revision, fingerprint, name, gitUrl)) return;
        attempts++;
        const message = (error as Error).message;
        const retryable = transient(error);
        if (update("error", message, retryable ? "transient" : "permanent")) {
          report(new Error(`Configured repository ${name} (${gitUrl}) failed; work retained at ${path}: ${message}`));
          if (retryable) scheduleRetry(name, gitUrl, attempts);
        }
      } finally { releaseIdentity(name, gitUrl, claim); }
    }
    function requestFullReconciliation(reason: string, resetRetries = false, allowPermanentRetry = false) {
      fullReconciliationRequest = {
        reason, resetRetries: resetRetries || (fullReconciliationRequest?.resetRetries ?? false),
        allowPermanentRetry: allowPermanentRetry || reason === "requested" || activePermanentRetryPermission || (fullReconciliationRequest?.allowPermanentRetry ?? false),
      };
    }
    async function reconcileCurrent(reason: string, resetRetries = false, retryOnly?: Set<string>, allowPermanentRetry = false) {
      let view: Awaited<ReturnType<typeof settingsView>>;
      try { view = await settingsView(); }
      catch (error) { if (!shuttingDown) throw error; return; }
      if (view.revision < observedSettingsRevision) { requestFullReconciliation("settings"); return; }
      observedSettingsRevision = view.revision;
      if (!retryOnly && (reason === "startup" || resetRetries || reason === "requested")) for (const repository of view.effective.repositories) {
        const key = `${repository.name}\0${repository.gitUrl}`, timer = retryTimers.get(key);
        if (timer) clearTimeout(timer);
        retryTimers.delete(key);
      }
      const repositories = view.effective.repositories;
      const fingerprint = identityFingerprint(repositories);
      let saved = reconciliation();
      if (reason === "startup" || resetRetries) {
        for (const repository of repositories) {
          const state = repositoryState(repository.name, repository.gitUrl);
          if (state) saveRepositoryState({ ...state, attempts: 0 });
        }
      }
      for (const state of repositoryStates()) if (state.origin === "configured" && !repositories.some(r => r.name === state.name && r.gitUrl === state.gitUrl)) {
        const timer = retryTimers.get(`${state.name}\0${state.gitUrl}`);
        if (timer) clearTimeout(timer);
        retryTimers.delete(`${state.name}\0${state.gitUrl}`);
        saveRepositoryState({ ...state, status: "retired", error: undefined, attempts: 0, failureClass: undefined });
      }
      const generation = saved.generation + 1;
      saved = { generation, desiredRevision: view.revision, fingerprint, state: "running", lastSuccessfulRevision: saved.lastSuccessfulRevision, entries: repositories.map(r => {
        const state = repositoryState(r.name, r.gitUrl), key = `${r.name}\0${r.gitUrl}`;
        return { name: r.name, gitUrl: r.gitUrl, status: retryOnly?.has(key) ? "pending" : state?.status ?? "pending", attempts: state?.attempts ?? 0, error: state?.error };
      }) };
      if (!saveStatus(saved, true)) { requestFullReconciliation("settings"); return; }
      for (const repository of repositories) {
        const identity = `${repository.name}\0${repository.gitUrl}`;
        if (shuttingDown || (retryOnly && !retryOnly.has(identity))) continue;
        const prior = repositoryState(repository.name, repository.gitUrl);
        const allowTransientRetry = reason === "startup" || resetRetries || reason === "requested" || retryOnly?.has(identity) === true || prior?.status !== "error" || prior.failureClass !== "transient";
        await reconcileIdentity(repository, view.revision, fingerprint, generation, allowPermanentRetry, allowTransientRetry);
        if (!currentGenerationSync(generation, view.revision, fingerprint)) { requestFullReconciliation("settings"); return; }
        saved.entries = repositories.map(r => {
          const item = repositoryState(r.name, r.gitUrl);
          return { name: r.name, gitUrl: r.gitUrl, status: item?.status ?? "pending", error: item?.error, attempts: item?.attempts ?? 0 };
        });
        saveStatus(saved);
      }
      let current: Awaited<ReturnType<typeof settingsView>>;
      try { current = await settingsView(); }
      catch (error) { if (shuttingDown) return; throw error; }
      observedSettingsRevision = Math.max(observedSettingsRevision, current.revision);
      if (current.revision !== view.revision || identityFingerprint(current.effective.repositories) !== fingerprint || !currentGenerationSync(generation, view.revision, fingerprint)) { requestFullReconciliation("settings"); return; }
      const finalStates = repositories.map(r => repositoryState(r.name, r.gitUrl));
      const complete = finalStates.every(state => state?.status === "ready");
      saved.state = complete ? "ready" : finalStates.some(state => state?.status === "pending") ? "pending" : "error";
      if (complete) saved.lastSuccessfulRevision = view.revision;
      saved.entries = repositories.map((r, index) => ({ name: r.name, gitUrl: r.gitUrl, status: finalStates[index]?.status ?? "pending", error: finalStates[index]?.error, attempts: finalStates[index]?.attempts ?? 0 }));
      saveStatus(saved);
      if (reason === "startup" && !complete) report(new Error("Configured repository reconciliation has pending or failed entries"));
    }
    async function runReconciliation(reason: string, resetRetries = false, retryIdentity?: string) {
      if (shuttingDown) return;
      if (retryIdentity) targetedRetryRequests.add(retryIdentity);
      else requestFullReconciliation(reason, resetRetries);
      if (!reconciliationWorker) {
        let worker: Promise<void>;
        worker = (async () => {
          while (!shuttingDown && (fullReconciliationRequest || targetedRetryRequests.size)) {
            const full = fullReconciliationRequest;
            if (full) {
              fullReconciliationRequest = undefined;
              if (full.reason === "startup" || full.resetRetries || full.reason === "requested") targetedRetryRequests.clear();
              activePermanentRetryPermission = full.allowPermanentRetry;
              try { await reconcileCurrent(full.reason, full.resetRetries, undefined, full.allowPermanentRetry); }
              finally { activePermanentRetryPermission = false; }
            } else {
              const targets = new Set(targetedRetryRequests);
              targetedRetryRequests.clear();
              await reconcileCurrent("retry", false, targets);
            }
          }
        })().finally(() => {
          if (reconciliationWorker === worker) reconciliationWorker = undefined;
          if (!shuttingDown && (fullReconciliationRequest || targetedRetryRequests.size)) void runReconciliation("coalesced").catch(error => report(error));
        });
        reconciliationWorker = worker;
      }
      await reconciliationWorker;
    }
    function scheduleReconciliation(reason = "settings", resetRetries = false) {
      if (shuttingDown) return;
      queueMicrotask(() => { if (!shuttingDown) void runReconciliation(reason, resetRetries).catch(error => report(error)); });
    }
    function clientOnly(caller: { kind: string }) { if (caller.kind !== "client") fail("Catalog endpoints are client-only", "FORBIDDEN"); }
    function publicReconciliation(wake = true) {
      const desired = desiredRepositories(), fingerprint = identityFingerprint(desired), saved = reconciliation();
      if (wake && fingerprint !== saved.fingerprint) scheduleReconciliation("status-read");
      const entries = desired.map(repository => {
        const state = repositoryState(repository.name, repository.gitUrl);
        const manualReady = state?.origin === "manual" && catalog().some(item => item.name === repository.name && item.gitUrl === repository.gitUrl);
        const current = manualReady || !!state;
        const status = state?.status === "retired" ? "pending" : state?.status;
        return { name: repository.name, gitUrl: repository.gitUrl, status: current ? status ?? "ready" : "pending", error: current ? state?.error : undefined, attempts: current ? state?.attempts ?? 0 : 0 };
      });
      return { ...saved, fingerprint, state: fingerprint !== saved.fingerprint ? "pending" : saved.state, entries };
    }
    host.registerEndpoint("skills.list", (_params, caller) => {
      clientOnly(caller);
      const retained = catalog().filter(item => item.source.kind === "git" && repositoryState(item.name, item.source.gitUrl)?.origin === "configured" && !configuredIdentity(item.name, item.source.gitUrl));
      return {
        skills: activeCatalog().map(exposedSkill), retained: retained.map(item => ({ ...exposedSkill(item), status: "retired" as const })),
        reconciliation: publicReconciliation(),
        recovery: installations().filter(i => i.pending).map(i => ({ agentId: i.agentId, skill: i.skill, path: i.path, error: i.error })),
        repositoryRecovery: rows<Journal>("journal").filter(j => j.agentId === "catalog" && j.path).map(j => ({ id: j.id, path: j.path, repository: j.repository, localImport: j.localImport, origin: (j.repository && repositoryState(j.repository.name, j.repository.gitUrl)?.origin) ?? "manual", revision: j.revision, status: "retained" as const })),
      };
    });
    host.registerEndpoint("skills.reconcile", (params, caller) => {
      clientOnly(caller);
      if (params && (typeof params !== "object" || Array.isArray(params) || Object.keys(params).length)) fail("Expected an empty object");
      const status = publicReconciliation(false);
      scheduleReconciliation("requested", true);
      return { accepted: true, reconciliation: status };
    });
    if (supportsLocalImport) host.registerEndpoint("skills.addFromPath", async (params, caller) => {
      clientOnly(caller);
      if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 1 || !Object.hasOwn(params, "path") || typeof (params as any).path !== "string")
        fail("Expected exactly {path: string}", "INVALID_PARAMS");
      try {
        const record = await runLocalImport((params as any).path, { baseDir: localImportBase, home: homedir() });
        return exposedSkill(record);
      } catch (error: any) {
        if (["INVALID_PARAMS", "INVALID_PATH", "DUPLICATE", "LIMIT", "SHUTTING_DOWN", "INTERNAL"].includes(error?.code)) throw error;
        report(new Error(`Local skill import failed: ${(error as Error).message}`));
        fail("Local skill import failed; inspect server diagnostics", "INTERNAL");
      }
    });
    host.registerEndpoint("skills.add", (params, caller) => exclusive(async () => {
      clientOnly(caller);
      if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).some(k => !["name", "gitUrl"].includes(k))) fail("Expected {name, gitUrl}");
      const { name, gitUrl } = params as any;
      try { return await registerCatalog(name, gitUrl); }
      catch (error) {
        const code = (error as any)?.code;
        if (!['INVALID_PARAMS', 'DUPLICATE', 'LIMIT'].includes(code))
          report(new Error(`Catalog add failed for ${String(name)} (${String(gitUrl)}): ${(error as Error).message}`));
        throw error;
      }
    }));
    host.registerTool({ name: "skills_list", description: "List active catalog skills and your skill states. Only available/installed active skills may be delegated; retained selections are shown separately.", inputSchema: { type: "object", additionalProperties: false }, async execute(_args, caller) {
      const agent = await host.request("agent.get", { agentId: caller.id }, caller) as AgentRecord;
      const statesForAgent = states(agent.settings) ?? {};
      const retainedNames = new Set(Object.entries(statesForAgent).filter(([, value]) => value !== "unavailable").map(([name]) => name));
      const retained = catalog().filter(item => retainedNames.has(item.name) && !configuredActive(item)).map(item => ({ ...item, status: "retired" as const, state: statesForAgent[item.name] }));
      return { skills: activeCatalog().map(item => ({ ...exposedSkill(item), state: Object.hasOwn(statesForAgent, item.name) ? statesForAgent[item.name] : "unavailable" })), retained: retained.map(exposedSkill).map(item => ({ ...item, status: "retired" as const, state: statesForAgent[item.name] })) };
    } });
    for (const name of ["child_create", "descendant_modify"]) host.transformTool(name, tool => {
      const properties = { ...tool.inputSchema.properties };
      const settings = properties.settings as { properties?: Record<string, unknown> };
      const extensions = (settings.properties?.extensions ?? { type: "object" }) as { properties?: Record<string, unknown> };
      properties.settings = { ...settings, properties: { ...settings.properties, extensions: { ...extensions, properties: { ...extensions.properties, skills: { type: "object", additionalProperties: { type: "string", enum: ["unavailable", "available", "installed"] }, description: "Complete replacement selection; omitted on modify leaves unchanged. Only your available/installed skills can be delegated." } } } } };
      return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
    });
    host.onEvent(event => {
      if (event.type === "organization.settings.changed" && (event.data as any)?.namespace === "skills") {
        const revision = (event.data as any)?.revision;
        if (Number.isSafeInteger(revision)) observedSettingsRevision = Math.max(observedSettingsRevision, revision);
        scheduleReconciliation("settings");
        return;
      }
      if (event.type === "agent.removed") return exclusive(async () => {
        for (const i of installations().filter(i => i.agentId === event.agentId)) await recover(i);
      });
    });
    sweepTimer = setInterval(() => {
      if (shuttingDown) return;
      const status = reconciliation();
      if (identityFingerprint(desiredRepositories()) !== status.fingerprint) scheduleReconciliation("sweep");
    }, 5_000);
    sweepTimer.unref?.();
    host.onShutdown(async () => {
      shuttingDown = true;
      if (sweepTimer) clearInterval(sweepTimer);
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      await Promise.allSettled([tail, publishTail, reconciliationWorker, ...activeLocalImports].filter(Boolean) as Promise<unknown>[]);
      db.close();
    });
  } };
}
export default createSkillsPlugin();
