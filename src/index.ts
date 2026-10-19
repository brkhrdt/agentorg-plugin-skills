import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, parse, sep } from "node:path";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { parse as yaml } from "yaml";
import type { ServerPlugin, MutationChange } from "agent-organization/plugin";
import type { AgentRecord, Settings } from "agent-organization/types";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
export const skillStatesSchema = z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64), z.enum(["unavailable", "available", "installed"]));
export type SkillStates = z.infer<typeof skillStatesSchema>;
export const states = (settings: Settings) => settings.extensions?.skills as SkillStates | undefined;
import { gitWithTimeout } from "./git.ts";
import { skillsServerSettings } from "./config.ts";

export interface Skill { name: string; gitUrl: string; description: string; createdAt: string; path: string }
interface Installation { generation: string; agentId: string; skill: string; path: string; remote: string; status: "staged" | "active" | "retained"; pending: boolean; error?: string }
interface Action { generation: string; from: string; to: string; old: boolean }
interface Journal { id: string; agentId: string; revision: number; actions: Action[]; path?: string }
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
  const queue = [path];
  let bytes = 0, count = 0;
  while (queue.length) {
    for (const entry of await readdir(queue.pop()!, { withFileTypes: true })) {
      const file = join(entry.parentPath, entry.name);
      if (++count > 20_000) fail("Skill checkout exceeds 20,000 entries", "LIMIT");
      if (entry.isDirectory()) queue.push(file);
      else {
        bytes += (await lstat(file)).size;
        if (bytes > 256 * 1024 * 1024) fail("Skill checkout exceeds 256 MiB", "LIMIT");
      }
    }
  }
}
async function metadata(path: string, name: string) {
  const file = join(path, "SKILL.md");
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 128 * 1024) fail("Root SKILL.md must be a regular file under 128 KiB");
  const text = await readFile(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match || !text.slice(match[0].length).trim()) fail("SKILL.md requires YAML frontmatter and instructions");
  const data = yaml(match![1], { maxAliasCount: 0 });
  if (!data || data.name !== name || typeof data.description !== "string" || !data.description.trim() || data.description.length > 1024)
    fail("SKILL.md name must match catalog name and description must contain 1–1024 characters");
  return data.description as string;
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
      CREATE TABLE IF NOT EXISTS journal(id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    if ((db.query("SELECT version FROM meta").get() as any).version !== 1) throw new Error("Unsupported skills database version");
    const rows = <T>(table: string): T[] => db.query(`SELECT data FROM ${table} ORDER BY rowid`).all().map((r: any) => JSON.parse(r.data));
    const put = (table: "installations" | "journal", id: string, value: unknown) => db.query(`INSERT OR REPLACE INTO ${table} VALUES (?,?)`).run(id, JSON.stringify(value));
    const dropJournal = (id: string) => db.query("DELETE FROM journal WHERE id=?").run(id);
    const catalog = () => rows<Skill>("catalog");
    const skill = (name: string) => catalog().find(s => s.name === name) ?? fail(`Unknown skill ${name}`);
    const installations = () => rows<Installation>("installations");
    const installation = (generation: string) => installations().find(i => i.generation === generation)!;
    const report = (error: unknown, agentId?: string) => host.emit("skills.error", { message: (error as Error).message }, agentId);
    // Serialize all Git/ledger work, including asynchronous removal observers.
    let tail: Promise<unknown> = Promise.resolve();
    function exclusive<T>(work: () => Promise<T>): Promise<T> {
      const next = tail.then(work); tail = next.catch(() => {}); return next;
    }
    const git = (cwd: string, ...args: string[]) => {
      const effective = host.serverSettings("skills") as { gitTimeoutMs?: number };
      return gitWithTimeout(cwd, effective.gitTimeoutMs ?? 60_000, ...args);
    };
    const effectiveConfig = () => host.serverSettings("skills") as { repositories: Array<{ name: string; gitUrl: string }>; gitTimeoutMs: number; maxCatalogEntries: number };
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
    async function prepare(settings: Settings, agent: Readonly<AgentRecord>, context: { caller: { kind: string; id: string }; selectionSupplied: boolean; creating: boolean }): Promise<MutationChange> {
      for (const name of Object.keys(states(settings) ?? {})) skill(name);
      if (context.selectionSupplied && context.caller.kind === "agent") {
        const parent = await host.request("agent.get", { agentId: context.caller.id }, server) as AgentRecord;
        for (const [name] of selected(states(settings))) {
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
          await git(root, "clone", "--no-hardlinks", "--", skill(name).path, stage);
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
        for (const name of Object.keys(parsed)) skill(name);
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
    host.registerCapability("skills", { settingsNamespace: "skills", serverSettingsNamespace: "skills", endpoints: { list: "skills.list", add: "skills.add" }, version: 1 });
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
        let parentId = context.agent.parentId;
        while (parentId) {
          const parent = context.agents.find(a => a.id === parentId)!;
          const skills = { ...states(parent.settings) };
          let changed = false;
          for (const [name] of selected(states(settings))) {
            if (!["available", "installed"].includes(skills[name] ?? "unavailable")) { skills[name] = "available"; changed = true; }
          }
          if (changed) updates.push({ agentId: parent.id, expectedRevision: parent.revision, settings: { ...parent.settings, extensions: { ...parent.settings.extensions, skills } } });
          parentId = parent.parentId;
        }
      }
      const change = await exclusive(() => prepare(settings, context.previous ?? context.agent, { caller: context.caller, selectionSupplied, creating: context.method === "agent.create" }));
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
    host.onInitialize(agents => exclusive(async () => {
        // Seeds are additive inputs to the persistent catalog, never a destructive mirror.
        for (const repository of effectiveConfig().repositories) {
          try { await registerCatalog(repository.name, repository.gitUrl, true); }
          catch (error) { report(new Error(`Configured repository ${repository.name} (${repository.gitUrl}) failed: ${(error as Error).message}`)); }
        }
        for (const j of rows<Journal>("journal")) {
          if (j.path) {
            report(new Error(`Interrupted catalog clone retained at ${j.path}; not registered`));
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
      }));
    async function registerCatalog(name: string, inputUrl: unknown, configuredSeed: boolean): Promise<Skill> {
      if (typeof name !== "string" || name.length > 64 || !idPattern.test(name)) fail("Invalid skill name");
      const url = source(inputUrl, options.allowLocalSources ?? false);
      const existing = catalog();
      const sameName = existing.find(s => s.name === name);
      const sameUrl = existing.find(s => s.gitUrl === url);
      if (configuredSeed && sameName?.gitUrl === url) return sameName;
      if (sameName || sameUrl) fail(`Skill repository conflict for ${name}: name or Git source already registered`, "DUPLICATE");
      const limit = effectiveConfig().maxCatalogEntries;
      if (existing.length >= limit) fail(`Catalog limit (${limit}) reached`, "LIMIT");
      const path = join(root, hash(name) + "-" + randomUUID());
      // Retain a journal and partial checkout on every failure for operator diagnosis.
      const journalId = `catalog-${randomUUID()}`;
      put("journal", journalId, { id: journalId, agentId: "catalog", revision: 0, actions: [], path });
      let description: string;
      try {
        await git(root, "-c", `protocol.file.allow=${url.startsWith("/") ? "always" : "never"}`, "clone", "--", url, path);
        description = await metadata(path, name);
        await checkoutLimit(path);
      } catch (error) {
        throw new Error(`Catalog checkout for ${name} retained at ${path}: ${(error as Error).message}`);
      }
      const record: Skill = { name, gitUrl: url, description, path, createdAt: new Date().toISOString() };
      try {
        db.transaction(() => {
          db.query("INSERT INTO catalog VALUES (?,?,?)").run(name, url, JSON.stringify(record));
          dropJournal(journalId);
        })();
      } catch (error) {
        throw new Error(`Catalog registration for ${name} (${url}) failed; checkout and journal retained at ${path}: ${(error as Error).message}`);
      }
      host.emit("skills.catalog_added", record);
      return record;
    }
    function clientOnly(caller: { kind: string }) { if (caller.kind !== "client") fail("Catalog endpoints are client-only", "FORBIDDEN"); }
    host.registerEndpoint("skills.list", (_params, caller) => { clientOnly(caller); return { skills: catalog(), recovery: installations().filter(i => i.pending).map(i => ({ agentId: i.agentId, skill: i.skill, path: i.path, error: i.error })) }; });
    host.registerEndpoint("skills.add", (params, caller) => exclusive(async () => {
      clientOnly(caller);
      if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).some(k => !["name", "gitUrl"].includes(k))) fail("Expected {name, gitUrl}");
      const { name, gitUrl } = params as any;
      try { return await registerCatalog(name, gitUrl, false); }
      catch (error) {
        const code = (error as any)?.code;
        if (!['INVALID_PARAMS', 'DUPLICATE', 'LIMIT'].includes(code))
          report(new Error(`Catalog add failed for ${String(name)} (${String(gitUrl)}): ${(error as Error).message}`));
        throw error;
      }
    }));
    host.registerTool({ name: "skills_list", description: "List catalog and your skill states. Only available/installed skills may be delegated; children default to no selections. settings.extensions.skills explicitly replaces all states.", inputSchema: { type: "object", additionalProperties: false }, async execute(_args, caller) {
      const agent = await host.request("agent.get", { agentId: caller.id }, caller) as AgentRecord;
      return { skills: catalog().map(s => ({ ...s, state: Object.hasOwn(states(agent.settings) ?? {}, s.name) ? states(agent.settings)![s.name] : "unavailable" })) };
    } });
    for (const name of ["child_create", "descendant_modify"]) host.transformTool(name, tool => {
      const properties = { ...tool.inputSchema.properties };
      const settings = properties.settings as { properties?: Record<string, unknown> };
      const extensions = (settings.properties?.extensions ?? { type: "object" }) as { properties?: Record<string, unknown> };
      properties.settings = { ...settings, properties: { ...settings.properties, extensions: { ...extensions, properties: { ...extensions.properties, skills: { type: "object", additionalProperties: { type: "string", enum: ["unavailable", "available", "installed"] }, description: "Complete replacement selection; omitted on modify leaves unchanged. Only your available/installed skills can be delegated." } } } } };
      return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
    });
    host.onEvent(event => {
      if (event.type === "agent.removed") return exclusive(async () => {
        for (const i of installations().filter(i => i.agentId === event.agentId)) await recover(i);
      });
    });
    host.onShutdown(async () => { await tail; db.close(); });
  } };
}
export default createSkillsPlugin();
