import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, parse, relative, sep } from "node:path";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import type { ServerPlugin, MutationChange } from "agent-organization/plugin";
import type { AgentRecord, Settings } from "agent-organization/types";
import { z } from "zod";
export const skillStatesSchema = z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64), z.enum(["unavailable", "available", "installed"]));
export type SkillStates = z.infer<typeof skillStatesSchema>;
export const states = (settings: Settings) => settings.extensions?.skills as SkillStates | undefined;
import { cloneManagedRepository, cloneRemoteRepository, gitWithTimeout, safeSourceGitWithTimeout } from "./git.ts";
import { canonicalSkillRepositoryUrl, skillsServerSettings } from "./config.ts";
import { notifyAfterCatalogCommit, sourceIdentity, type CatalogSkill, type SkillSource } from "./catalog.ts"
import { checkCheckoutLimits, readSkillMetadata } from "./skill-content.ts";
import { LocalSkillImporter } from "./local-import.ts";
import { captureLocalGit } from "./local-git.ts";
import { classifyRepositoryLocator } from "./source-locator.ts";

export interface Skill extends CatalogSkill {}
interface Installation { generation: string; agentId: string; skill: string; path: string; status: "staged" | "active"; fsDevice?: number; fsInode?: number }
interface Action { generation: string; from: string; to: string }
interface InstallBatch { actions: Action[] }
interface Options {
  /** Test/embedded deployments only; normal CLI always uses OS home. */
  home?: string;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const isDescendant = (base: string, candidate: string) => {
  const path = relative(resolve(base), resolve(candidate));
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !parse(path).root;
};
function fail(message: string, code = "INVALID_PARAMS"): never { throw Object.assign(new Error(message), { code }); }
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const server = { kind: "server", id: "skills" } as const;
const selected = (skills?: SkillStates) => Object.entries(skills ?? {}).filter(([, state]) => state !== "unavailable");
/** Resolve the per-agent managed installation root. */
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
export function createSkillsPlugin(options: Options = {}): ServerPlugin {
  return { apiVersion: 1, name: "skills", async setup(host) {
    host.registerServerSettings(skillsServerSettings());
    const startupSnapshot = await host.request("organization.snapshot", {}, server) as { capabilities?: { cwd?: unknown } };
    const localImportBase = typeof startupSnapshot?.capabilities?.cwd === "string" ? resolve(startupSnapshot.capabilities.cwd) : process.cwd();
    const dataRoot = await realpath(host.dataDir);
    const scope = hash(dataRoot);
    const configuredDirectory = (host.serverSettings("skills") as { directory?: string }).directory ?? "skills";
    const expandedDirectory = configuredDirectory === "~" || configuredDirectory.startsWith("~/")
      ? join(options.home ?? homedir(), configuredDirectory === "~" ? "" : configuredDirectory.slice(2))
      : configuredDirectory;
    const canonicalRoot = resolve(dataRoot, expandedDirectory);
    if (canonicalRoot === dataRoot || isDescendant(canonicalRoot, dataRoot)) fail("Skills store directory must not be the server data directory or its ancestor");
    await privateDirectory(canonicalRoot);
    const root = canonicalRoot;
    const dbPath = join(dataRoot, "skills.sqlite");
    const db = new Database(dbPath, { create: true });
    await chmod(dbPath, 0o600);
    const existingTables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
    if ((existingTables.has("catalog") || existingTables.has("installations")) && !existingTables.has("skills_contract"))
      fail("Legacy skills state is not migrated; start with a fresh AgentOrg data directory", "INCOMPATIBLE_STATE");
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS skills_contract(version INTEGER NOT NULL CHECK(version=1));
      INSERT INTO skills_contract SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM skills_contract);
      CREATE TABLE IF NOT EXISTS catalog(name TEXT PRIMARY KEY, url TEXT UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS installations(id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    const contract = db.query("SELECT version FROM skills_contract").get() as { version: number };
    if (contract.version !== 1) fail(`Unsupported fresh skills contract version ${contract.version}`, "INCOMPATIBLE_STATE");
    const rows = <T>(table: string): T[] => db.query(`SELECT data FROM ${table} ORDER BY rowid`).all().map((r: any) => JSON.parse(r.data));
    const putInstallation = (id: string, value: unknown) => db.query("INSERT OR REPLACE INTO installations VALUES (?,?)").run(id, JSON.stringify(value));
    const catalog = () => rows<Skill>("catalog");
    const previousCatalog = new Map(catalog().map(item => [resolve(item.path), item]));
    db.query("DELETE FROM catalog").run();
    // The configured store is authoritative: rebuild the catalog projection from immediate,
    // real child worktrees, preserving source provenance only for matching paths.
    for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const candidate = join(canonicalRoot, entry.name);
      try {
        if (await realpath(candidate) !== candidate) continue;
        const git = await captureLocalGit(candidate);
        if (!git) continue;
        const timeout = (host.serverSettings("skills") as { gitTimeoutMs?: number }).gitTimeoutMs ?? 60_000;
        if (await safeSourceGitWithTimeout(candidate, timeout, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "status", "--porcelain", "--untracked-files=all")) continue;
        await checkCheckoutLimits(candidate);
        const content = await readSkillMetadata(candidate);
        const head = (await safeSourceGitWithTimeout(candidate, timeout, "rev-parse", "--verify", "HEAD^{commit}")).trim();
        if (!/^[0-9a-f]{40}$/.test(head)) continue;
        const previous = previousCatalog.get(resolve(candidate));
        const source: SkillSource = previous?.source ?? { kind: "local", path: candidate };
        const identity = sourceIdentity(source);
        const existing = catalog().find(item => item.name === content.name);
        if (existing) throw new Error(`Duplicate skill name ${content.name} in store; repository ${candidate} is ambiguous`);
        const maxEntries = (host.serverSettings("skills") as { maxCatalogEntries?: number }).maxCatalogEntries ?? 256;
        if (catalog().length >= maxEntries) throw new Error(`Skills catalog limit (${maxEntries}) reached`);
        const record: Skill = { name: content.name, description: content.description, source,
          ...(source.kind === "git" ? { gitUrl: source.gitUrl } : {}), path: candidate, createdAt: previous?.createdAt ?? new Date().toISOString() };
        db.query("INSERT INTO catalog(name,url,data) VALUES (?,?,?)").run(record.name, identity, JSON.stringify(record));
      } catch (error) { host.emit("skills.error", { message: `Ignoring invalid skill store repository ${candidate}: ${(error as Error).message}` }); }
    }
    const skill = (name: string) => catalog().find(s => s.name === name) ?? fail(`Unknown skill ${name}`);
    const knownSelection = (name: string) => catalog().some(item => item.name === name);
    const exposedSkill = (item: Skill): Skill & { origin: "manual" } => ({ ...item, origin: "manual" });
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
    const activeLocalImports = new Set<Promise<unknown>>();
    const activeCatalogRegistrations = new Set<Promise<unknown>>();
    const git = (cwd: string, ...args: string[]) => {
      const effective = host.serverSettings("skills") as { gitTimeoutMs?: number };
      return gitWithTimeout(cwd, effective.gitTimeoutMs ?? 60_000, ...args);
    };
    const effectiveConfig = () => host.serverSettings("skills") as { gitTimeoutMs: number; maxCatalogEntries: number };
    const activeCatalog = () => catalog();
    async function own(i: Installation, path = i.path) {
      const rootInfo = await lstat(path);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail(`Skill checkout is not a directory: ${path}`);
      if (i.fsDevice !== undefined && (rootInfo.dev !== i.fsDevice || rootInfo.ino !== i.fsInode)) fail(`Managed checkout filesystem identity mismatch: ${path}`);
      const markerPath = join(path, ".git", "agentorg-skills.json");
      if (!(await lstat(join(path, ".git"))).isDirectory()) fail(`Not a managed clone: ${path}`);
      const marker = JSON.parse(await readFile(markerPath, "utf8"));
      if (marker.scope !== scope || marker.generation !== i.generation || marker.agentId !== i.agentId || marker.skill !== i.skill)
        fail(`Managed checkout identity mismatch: ${path}`);
      if (await git(path, "rev-parse", "--show-toplevel") !== await realpath(path)) fail(`Not a skill repository root: ${path}`);
    }
    async function move(action: Action, forward: boolean) {
      const i = installation(action.generation);
      const from = forward ? action.from : action.to, to = forward ? action.to : action.from;
      if (!await exists(from) || await exists(to)) fail(`Skill checkout publication collision: ${from} -> ${to}`, "COLLISION");
      await own(i, from);
      await privateDirectory(join(to, ".."));
      await rename(from, to);
      const info = await lstat(to);
      i.path = to; i.status = forward ? "active" : "staged";
      i.fsDevice = info.dev; i.fsInode = info.ino;
      putInstallation(i.generation, i);
    }
    async function compensate(installBatch: InstallBatch) {
      for (const action of [...installBatch.actions].reverse()) {
        const atTarget = await exists(action.to), atSource = await exists(action.from);
        if (atTarget && atSource) fail(`Ambiguous interrupted move; both copies retained: ${action.from}, ${action.to}`);
        if (atTarget) await move(action, false);
      }
    }
    async function prepare(settings: Settings, agent: Readonly<AgentRecord>, context: { caller: { kind: string; id: string }; selectionSupplied: boolean; creating: boolean; previous?: Readonly<AgentRecord> }): Promise<MutationChange> {
      const nextStates = states(settings) ?? {};
      const previousStates = context.creating ? {} : (states(context.previous?.settings ?? agent.settings) ?? {});
      for (const [name, state] of Object.entries(nextStates)) {
        if (knownSelection(name)) continue;
        const existed = Object.prototype.hasOwnProperty.call(previousStates, name);
        const previousState = previousStates[name];
        if (!existed) fail(`Unknown skill ${name}`);
        if (state === "installed") {
          const currentPath = join(installRoot(settings.cwd!), name);
          const owned = installations().find(i => i.agentId === agent.id && i.skill === name && i.path === currentPath);
          if (previousState !== "installed" || !owned || !await exists(currentPath)) fail(`Unknown skill ${name}`);
        }
        if (state === previousState || state === "unavailable" || previousState === "installed" && state === "available") continue;
        fail(`Unknown skill ${name}`);
      }
      if (context.selectionSupplied && context.caller.kind === "agent") {
        const parent = await host.request("agent.get", { agentId: context.caller.id }, server) as AgentRecord;
        for (const [name, state] of selected(nextStates)) {
          if (previousStates[name] === state || (previousStates[name] === "installed" && state === "available")) continue;
          if (!knownSelection(name)) fail(`Unknown skill ${name}`);
          if (!["available", "installed"].includes(states(parent.settings)?.[name] ?? "unavailable"))
            fail(`Caller cannot delegate ${name}`, "FORBIDDEN");
        }
      }
      const cwd = settings.cwd!;
      await privateDirectory(join(cwd, ".agents"));
      await privateDirectory(installRoot(cwd));
      const installBatch: InstallBatch = { actions: [] };
      try {
        const owned = installations().filter(i => i.agentId === agent.id);
        for (const i of owned) if (await exists(i.path)) await own(i);
        for (const [name, state] of selected(states(settings))) {
          if (state !== "installed") continue;
          const dest = join(installRoot(cwd), name);
          const existing = owned.find(i => i.skill === name && i.path === dest);
          if (existing && await exists(dest)) { await own(existing); await metadata(dest, name); continue; }
          if (await exists(dest)) fail(`Refusing to overwrite existing directory: ${dest}`, "COLLISION");
          const generation = randomUUID();
          const stage = join(installRoot(cwd), `.staging-${generation}`);
          await privateDirectory(join(stage, ".."));
          const i: Installation = { generation, agentId: agent.id, skill: name, path: stage, status: "staged" };
          putInstallation(generation, i);
          installBatch.actions.push({ generation, from: stage, to: dest });
          const catalogSkill = skill(name);
          await cloneManagedRepository(catalogSkill.path, stage, effectiveConfig().gitTimeoutMs);
          await metadata(stage, name);
          await checkoutLimit(stage);
          await writeFile(join(stage, ".git", "agentorg-skills.json"), JSON.stringify({ scope, generation, agentId: agent.id, skill: name }), { mode: 0o600 });
        }
      } catch (error) {
        try { await compensate(installBatch); } catch (rollback) { report(rollback, agent.id); }
        throw error;
      }
      return {
        apply: () => exclusive(async () => {
          for (const action of installBatch.actions) {
            await move(action, true);
          }
        }),
        rollback: () => exclusive(() => compensate(installBatch)),
        committed: async () => {},
      };
    }
    async function launchPaths(agent: Readonly<AgentRecord>) {
      if (selected(states(agent.settings)).some(([, state]) => state === "installed")) {
        await privateDirectory(join(agent.settings.cwd!, ".agents"));
        await privateDirectory(installRoot(agent.settings.cwd!));
      }
      const result: string[] = [];
      for (const [name, state] of selected(states(agent.settings))) {
        if (state !== "installed") continue;
        const path = join(installRoot(agent.settings.cwd!), name);
        const i = installations().find(i => i.agentId === agent.id && i.skill === name && i.path === path);
        if (!i) fail(`Installed skill ${name} is not ready; reconciliation required`, "SKILL_NOT_READY");
        await own(i); await metadata(path, name);
        result.push(join(path, "SKILL.md"));
      }
      return result;
    }
    host.registerSettings({
      namespace: "skills",
      validate(value) {
        return skillStatesSchema.parse(value);
      },
      launchKey: value => selected(value as SkillStates).filter(([, state]) => state === "installed").map(([name]) => name).sort(),
    });
    host.registerCapability("skills", {
      settingsNamespace: "skills", serverSettingsNamespace: "skills",
      endpoints: { list: "skills.list", registerRepository: "skills.registerRepository" },
      repositoryRegistration: { version: 2, sourceKinds: ["https", "server-path"], semantics: "committed-head-v2" },
      version: 1,
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
      // Build grants before staging so validation failures do not leave an unowned installBatch.
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
      for (const agent of agents.filter(item => !item.removedAt)) {
        const cwd = await realpath(agent.settings.cwd ?? process.cwd());
        const install = installRoot(cwd);
        // A store may contain the managed install tree when it is also the workspace or
        // an ancestor of it, but may not be placed at/inside the managed installation root.
        if (canonicalRoot === install || isDescendant(install, canonicalRoot))
          fail(`Skills store overlaps the installation root for agent ${agent.id}`, "INVALID_PATH");
        // Workspace/data-dir and workspace/skills-store overlap is intentionally allowed:
        // container policy, not application path validation, controls agent access.
      }
      await exclusive(async () => {
        for (const agent of agents.filter(item => !item.removedAt)) await launchPaths(agent);
      });
      return;
    });
    async function registerCatalog(inputUrl: string): Promise<Skill & { origin: "manual" }> {
      if (shuttingDown) fail("Skills plugin is shutting down", "SHUTTING_DOWN");
      const url = canonicalSkillRepositoryUrl(inputUrl);
      const claimName = `source-${hash(url)}`;
      const claim = claimIdentity(claimName, url);
      if (!claim) fail("Repository registration is already in progress for this source", "DUPLICATE");
      let derivedClaim: string | undefined, name: string | undefined;
      let path = join(root, `.staging-${randomUUID()}`);
      try {
        if (catalog().some(s => s.gitUrl === url)) fail("Skill repository source already registered", "DUPLICATE");
        if (catalog().length >= effectiveConfig().maxCatalogEntries) fail(`Catalog limit (${effectiveConfig().maxCatalogEntries}) reached`, "LIMIT");
        let description: string;
        try {
          await cloneRemoteRepository(url, path, effectiveConfig().gitTimeoutMs);
          const parsed = await readSkillMetadata(path);
          name = parsed.name; description = parsed.description;
          if (!idPattern.test(name) || name.length > 64) fail("Skill name in root SKILL.md is invalid");
          derivedClaim = claimIdentity(name, url);
          if (!derivedClaim) fail(`Repository registration conflicts with an in-progress skill ${name}`, "DUPLICATE");
          await checkoutLimit(path);
        } catch (error) {
          throw Object.assign(new Error(`Catalog checkout retained at ${path}: ${(error as Error).message}`), { code: (error as any)?.code ?? "SOURCE_FAILED" });
        }
        const stagedPath = path, destination = join(root, name!);
        path = destination;
        const record: Skill = { name: name!, source: { kind: "git", gitUrl: url }, gitUrl: url, description: description!, path, createdAt: new Date().toISOString() };
        await catalogPublish(async () => {
          if (catalog().some(s => s.name === name || s.source.kind === "git" && s.source.gitUrl === url)) fail(`Skill repository conflict for ${name}`, "DUPLICATE");
          if (catalog().length >= effectiveConfig().maxCatalogEntries) fail(`Catalog limit (${effectiveConfig().maxCatalogEntries}) reached`, "LIMIT");
          if (await exists(destination)) fail(`Skill destination already exists: ${destination}`, "DUPLICATE");
          await rename(stagedPath, destination);
          db.transaction(() => db.query("INSERT INTO catalog VALUES (?,?,?)").run(name!, url, JSON.stringify(record)))();
        });
        notifyAfterCatalogCommit(() => host.emit("skills.catalog_added", exposedSkill(record)),
          error => report(new Error(`Published ${name}, but catalog event failed: ${(error as Error).message}`)));
        return exposedSkill(record);
      } finally {
        releaseIdentity(claimName, url, claim);
        if (derivedClaim) releaseIdentity(name!, url, derivedClaim);
      }
    }
    function trackCatalogRegistration<T>(work: () => Promise<T>): Promise<T> {
      if (shuttingDown) return Promise.reject(Object.assign(new Error("Skills plugin is shutting down"), { code: "SHUTTING_DOWN" }));
      const operation = Promise.resolve().then(() => {
        if (shuttingDown) fail("Skills plugin is shutting down", "SHUTTING_DOWN");
        return work();
      });
      activeCatalogRegistrations.add(operation);
      void operation.finally(() => activeCatalogRegistrations.delete(operation)).catch(() => {});
      return operation;
    }
    const localImporter = new LocalSkillImporter({
      centralRoot: canonicalRoot, stagingRoot: join(root, ".staging"),
      gitTimeoutMs: () => effectiveConfig().gitTimeoutMs,
      publish: async (record, identity) => {
        const stage = record.path, destination = join(root, record.name);
        await catalogPublish(async () => {
          const entries = catalog();
          if (entries.some(item => item.name === record.name || sourceIdentity(item.source) === identity)) fail(`Local skill source or name already registered: ${record.name}`, "DUPLICATE");
          if (entries.length >= effectiveConfig().maxCatalogEntries) fail(`Catalog limit (${effectiveConfig().maxCatalogEntries}) reached`, "LIMIT");
          if (await exists(destination)) fail(`Skill destination already exists: ${destination}`, "DUPLICATE");
          await rename(stage, destination);
          record.path = destination;
          db.transaction(() => db.query("INSERT INTO catalog VALUES (?,?,?)").run(record.name, identity, JSON.stringify(record)))();
        });
      },
      report: error => report(error),
      emit: record => host.emit("skills.catalog_added", exposedSkill(record)),
    });
    function runLocalImport(input: unknown, pathOptions: { baseDir?: string; home?: string } = {}) {
      if (shuttingDown) fail("Skills plugin is shutting down", "SHUTTING_DOWN");
      const operation = localImporter.import(input, pathOptions);
      activeLocalImports.add(operation);
      void operation.finally(() => activeLocalImports.delete(operation)).catch(() => {});
      return operation;
    }
    function clientOnly(caller: { kind: string }) { if (caller.kind !== "client") fail("Catalog endpoints are client-only", "FORBIDDEN"); }
    host.registerEndpoint("skills.list", (_params, caller) => {
      clientOnly(caller);
      return { skills: activeCatalog().map(exposedSkill) };
    });




    host.registerEndpoint("skills.registerRepository", async (params, caller) => {
      clientOnly(caller);
      if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params as object).length !== 1 || typeof (params as any).source !== "string") fail("Expected exactly {source}");
      const classified = classifyRepositoryLocator((params as { source: string }).source);
      if (classified.kind === "https") {
        let url: string;
        try { url = canonicalSkillRepositoryUrl(classified.source); }
        catch (error) { fail((error as Error).message, "INVALID_PARAMS"); }
        return trackCatalogRegistration(() => registerCatalog(url));
      }
      return runLocalImport(classified.source, { baseDir: localImportBase, home: homedir() }).then(exposedSkill);
    });
    host.registerTool({ name: "skills_list", description: "List catalog skills and your skill states. Available or installed skills may be delegated.", inputSchema: { type: "object", additionalProperties: false }, async execute(_args, caller) {
      const agent = await host.request("agent.get", { agentId: caller.id }, caller) as AgentRecord;
      const statesForAgent = states(agent.settings) ?? {};
      return { skills: activeCatalog().map(item => ({ ...exposedSkill(item), state: Object.hasOwn(statesForAgent, item.name) ? statesForAgent[item.name] : "unavailable" })) };
    } });
    for (const name of ["create_subagent", "modify_subagent"]) host.transformTool(name, tool => {
      const properties = { ...tool.inputSchema.properties };
      const settings = properties.settings as { properties?: Record<string, unknown> };
      const extensions = (settings.properties?.extensions ?? { type: "object" }) as { properties?: Record<string, unknown> };
      properties.settings = { ...settings, properties: { ...settings.properties, extensions: { ...extensions, properties: { ...extensions.properties, skills: { type: "object", additionalProperties: { type: "string", enum: ["unavailable", "available", "installed"] }, description: "Complete replacement selection; omitted on modify leaves unchanged. Only your available/installed skills can be delegated." } } } } };
      return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
    });
    // Agent removal deliberately leaves its workspace checkout untouched.
    host.onShutdown(async () => {
      shuttingDown = true;
      await Promise.allSettled([tail, publishTail, ...activeLocalImports, ...activeCatalogRegistrations].filter(Boolean) as Promise<unknown>[]);
      db.close();
    });
  } };
}
export default createSkillsPlugin();
