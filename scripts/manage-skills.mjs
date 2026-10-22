#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectActiveAgents, codebuddyGlobalSkillsMismatch } from "./agent-detection.mjs";
import { assertStringArray, validateProfiles, validateExclusiveGroups, parseChoice } from "./catalog.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogPath = join(root, "pluginset.json");

function resolveNpx() {
  if (process.platform !== "win32") return { command: "npx", prefix: [] };

  const bundledCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  return existsSync(bundledCli)
    ? { command: process.execPath, prefix: [bundledCli] }
    : { command: null, prefix: [], expectedPath: bundledCli };
}

const npx = resolveNpx();

function usage() {
  console.log(`Usage: node scripts/manage-skills.mjs <command> [options]

Commands:
  doctor                         Check prerequisites and catalog validity
  plan [--profile <a,b> | --all]         Show sync changes needed for profiles
  sync [--profile <a,b> | --all] [--yes] Install selected and remove conflicting skills
  install [--profile <a,b> | --all] [--yes] Install selected skills without exclusive cleanup
  remove (--profile <a,b> | --all) [--yes] Remove selected skills without exclusive restrictions
  audit [--profile <a,b> | --all]        Report catalog and installation drift
  sources [skill ...] [options]  Confirm installed skill sources without changing them

Options:
  --profile <a,b>  Select comma-separated profiles
  --choose <group>=<name>  Override an entry group for plan/sync or profile audit (repeatable)
  --all            plan/sync: compatible defaults; install/remove/audit: every profile
  --agent <a,b>    Resolve catalog agent "detected" (otherwise infer the active agent)
  --json           Emit stable machine-readable source results
  --verify-remote  Allow source verification against a remote repository
  --yes            Execute the displayed install, remove, or sync plan
  --help            Show this help

Without --yes, install/remove/sync only preview, including cleanup-only sync.
install/remove allow same-group profiles together. plan previews sync.`);
}

function parseArgs(argv) {
  const result = {
    command: argv[0] === "--help" || argv[0] === "-h" ? "help" : argv[0],
    profiles: null,
    allProfiles: false,
    agents: null,
    names: [],
    json: false,
    verifyRemote: false,
    yes: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes") {
      result.yes = true;
    } else if (arg === "--all") {
      result.allProfiles = true;
    } else if (arg === "--choose") {
      (result.choices ??= []).push(parseChoice(argv[++index]));
    } else if (arg === "--json" && result.command === "sources") {
      result.json = true;
    } else if (arg === "--verify-remote" && result.command === "sources") {
      result.verifyRemote = true;
    } else if (arg === "--profile") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--profile requires a value");
      const profiles = value.split(",").map((item) => item.trim()).filter(Boolean);
      result.profiles = [...new Set([...(result.profiles || []), ...profiles])];
      index += 1;
    } else if (arg === "--agent") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--agent requires a value");
      result.agents = value.split(",").map((item) => item.trim()).filter(Boolean);
      if (result.agents.length === 0) throw new Error("--agent requires at least one agent");
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      result.command = "help";
    } else if (result.command === "sources" && !arg.startsWith("--")) {
      result.names.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (result.allProfiles && result.profiles) {
    throw new Error("--all cannot be combined with --profile");
  }
  if (result.command === "remove" && !result.profiles && !result.allProfiles) {
    throw new Error("remove requires --profile or --all");
  }
  if (result.choices && !(["plan", "sync"].includes(result.command) || (result.command === "audit" && result.profiles))) {
    throw new Error("--choose requires plan, sync, or audit --profile");
  }
  return result;
}

async function loadCatalog() {
  let catalog;
  try {
    catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${catalogPath}: ${error.message}`);
  }

  return validateCatalog(catalog);
}

function profileConflicts(catalog, profiles) {
  const selectedByGroup = new Map();
  for (const profile of profiles) {
    const group = catalog.profiles[profile]?.exclusiveGroup;
    if (!group) continue;
    if (!selectedByGroup.has(group)) selectedByGroup.set(group, []);
    selectedByGroup.get(group).push(profile);
  }
  return [...selectedByGroup]
    .filter(([, selected]) => selected.length > 1)
    .map(([group, selected]) => ({ group, profiles: selected }));
}

function assertCompatibleProfiles(catalog, profiles, label = "Selected profiles") {
  const conflicts = profileConflicts(catalog, profiles);
  if (conflicts.length > 0) {
    const details = conflicts.map(({ group, profiles: names }) => `${group}: ${names.join(", ")}`).join("; ");
    throw new Error(`${label} conflict in exclusive groups: ${details}`);
  }
}

function validateCatalog(catalog) {
  if (catalog.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  validateProfiles(catalog.profiles);
  assertStringArray(catalog.defaultProfiles, "defaultProfiles");
  if (!Array.isArray(catalog.skills)) throw new Error("skills must be an array");

  for (const profile of catalog.defaultProfiles) {
    if (!Object.hasOwn(catalog.profiles, profile)) throw new Error(`Unknown default profile: ${profile}`);
  }
  assertCompatibleProfiles(catalog, [...new Set(catalog.defaultProfiles)], "defaultProfiles");

  const identities = new Set();
  catalog.skills.forEach((entry, entryIndex) => {
    const label = `skills[${entryIndex}]`;
    if (!entry || typeof entry !== "object") throw new Error(`${label} must be an object`);
    if (typeof entry.package !== "string" || !entry.package.trim()) throw new Error(`${label}.package must be a string`);
    assertStringArray(entry.names, `${label}.names`);
    assertStringArray(entry.profiles, `${label}.profiles`);
    assertStringArray(entry.agents, `${label}.agents`);
    if (!['global', 'project'].includes(entry.scope)) throw new Error(`${label}.scope must be global or project`);
    if (typeof entry.required !== "boolean") throw new Error(`${label}.required must be boolean`);
    if (typeof entry.reviewed !== "boolean") throw new Error(`${label}.reviewed must be boolean`);
    if (entry.agents.includes("detected") && entry.agents.length !== 1) {
      throw new Error(`${label}.agents must use detected by itself`);
    }
    for (const profile of entry.profiles) {
      if (!Object.hasOwn(catalog.profiles, profile)) throw new Error(`${label} references unknown profile: ${profile}`);
    }
    for (const name of entry.names) {
      const identity = `${entry.scope}:${name.toLowerCase()}`;
      if (identities.has(identity)) throw new Error(`Duplicate catalog skill: ${entry.scope}:${name}`);
      identities.add(identity);
    }
  });

  skillEntryGroups(catalog);
  return catalog;
}

function skillEntryGroups(catalog) {
  const groups = validateExclusiveGroups(catalog.skills, "Skill");
  for (const [group, members] of groups) {
    if (new Set(members.map(e => e.scope)).size !== 1) throw new Error(`Skill entry group ${group} must use the same scope`);
  }
  return groups;
}

function selectSkillEntries(catalog, profiles, choices = []) {
  const groups = skillEntryGroups(catalog);
  const candidates = catalog.skills.filter(e => e.profiles.some(p => profiles.includes(p)));
  const overrides = new Map();
  for (const { group, name } of choices) {
    const entry = groups.get(group)?.find(e => e.names.some(n => n.toLowerCase() === name.toLowerCase()));
    if (!entry) throw new Error(`Unknown skill entry choice: ${group}=${name}`);
    if (!candidates.includes(entry)) throw new Error(`Skill entry choice is outside selected profiles: ${group}=${name}`);
    if (overrides.has(group) && overrides.get(group) !== entry) throw new Error(`Conflicting choices for skill entry group ${group}`);
    overrides.set(group, entry);
  }
  const selectedGroups = new Map();
  for (const [group, members] of groups) {
    const available = members.filter(e => candidates.includes(e));
    if (!available.length) continue;
    const selected = overrides.get(group) ?? (available.length === 1 ? available[0] : available.find(e => e.defaultInExclusiveGroup));
    if (!selected) throw new Error(`Default for skill entry group ${group} is outside selected profiles; use --choose`);
    selectedGroups.set(group, { entry: selected, source: overrides.has(group) ? "override" : available.length === 1 ? "single candidate" : "default" });
  }
  return { entries: candidates.filter(e => !e.exclusiveGroup || selectedGroups.get(e.exclusiveGroup)?.entry === e), groups: selectedGroups };
}

function expandSkillEntries(entries) {
  return entries.flatMap(entry => entry.names.map(name => ({ ...entry, name })));
}

function run(command, args) {
  if (!command) {
    return {
      error: new Error(`Cannot find npm's npx-cli.js beside Node.js: ${npx.expectedPath}`),
      status: null,
      stdout: "",
      stderr: "",
    };
  }
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
}

function runSkills(args) {
  return run(npx.command, [...npx.prefix, "--yes", "skills", ...args]);
}

function commandVersion(command, args) {
  const result = run(command, args);
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || result.stderr.trim();
}

function parseListOutput(result, scope) {
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    throw new Error(`Could not list ${scope} skills: ${detail}`);
  }
  try {
    const entries = JSON.parse(result.stdout);
    if (!Array.isArray(entries)) throw new Error("output is not an array");
    return entries.map((entry) => ({ ...entry, scope }));
  } catch (error) {
    throw new Error(`Invalid JSON from npx skills list (${scope}): ${error.message}`);
  }
}

function listInstalled() {
  return [
    ...parseListOutput(runSkills(["list", "--global", "--json"]), "global"),
    ...parseListOutput(runSkills(["list", "--json"]), "project"),
  ];
}

function listInstalledScope(scope) {
  try {
    const cliArgs = scope === "global" ? ["list", "--global", "--json"] : ["list", "--json"];
    return { entries: parseListOutput(runSkills(cliArgs), scope), error: null };
  } catch (error) {
    return { entries: [], error: error.message };
  }
}

function parseSkillLock(contents, scope) {
  const lock = JSON.parse(contents.replace(/^\uFEFF/, ""));
  const rawSkills = lock?.skills && typeof lock.skills === "object" && !Array.isArray(lock.skills)
    ? lock.skills
    : {};
  const entries = new Map(
    Object.entries(rawSkills).map(([name, value]) => [name.toLowerCase(), value && typeof value === "object" ? value : {}]),
  );
  const warning = Number.isInteger(lock?.version) && lock.version !== 3
    ? `Unrecognized ${scope} lock version ${lock.version}; known fields were read compatibly`
    : null;
  return { version: lock?.version ?? null, entries, warning };
}

async function loadSkillLock(scope, directories = {}) {
  const path = scope === "global"
    ? join(directories.homeDirectory || homedir(), ".agents", ".skill-lock.json")
    : join(directories.projectDirectory || process.cwd(), "skills-lock.json");
  if (!existsSync(path)) return { path, version: null, entries: new Map(), error: null, warning: null };

  try {
    const parsed = parseSkillLock(await readFile(path, "utf8"), scope);
    return { path, ...parsed, error: null };
  } catch (error) {
    return { path, version: null, entries: new Map(), error: `Cannot read ${path}: ${error.message}`, warning: null };
  }
}

async function inspectGitProvenance(installedPath) {
  if (!installedPath) return { evidence: null, error: null };
  let target;
  try {
    target = await realpath(installedPath);
  } catch (error) {
    return { evidence: null, error: `Cannot resolve installed path ${installedPath}: ${error.message}` };
  }

  const rootResult = run("git", ["-C", target, "rev-parse", "--show-toplevel"]);
  if (rootResult.error || rootResult.status !== 0) return { evidence: null, error: null };
  const gitRoot = rootResult.stdout.trim();
  const skillPath = relative(gitRoot, join(target, "SKILL.md")).replaceAll("\\", "/");
  const trackedResult = run("git", ["-C", gitRoot, "--literal-pathspecs", "ls-files", "--error-unmatch", "--", skillPath]);
  if (trackedResult.error || trackedResult.status !== 0) return { evidence: null, error: null };
  const remoteResult = run("git", ["-C", gitRoot, "config", "--get", "remote.origin.url"]);
  if (remoteResult.error || remoteResult.status !== 0 || !remoteResult.stdout.trim()) {
    return { evidence: null, error: null };
  }

  const remote = remoteResult.stdout.trim();
  const evidence = evidenceSource("git", remote, remote, process.cwd(), {
    repositoryRoot: gitRoot,
    resolvedPath: target,
    skillPath,
  });
  return { evidence, error: null };
}

function remoteListContainsSkill(output, name) {
  const clean = stripAnsi(output).replaceAll("\r", "\n");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)\\s*[|│]\\s+${escaped}\\s*(?:\\n|$)`, "i").test(clean);
}

function verifyRemoteSource(source, name) {
  const normalized = normalizeSource(source);
  if (!normalized || normalized.type === "local") return null;
  const result = runSkills(["add", source, "--list"]);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || stripAnsi(result.stderr).trim() || `exit ${result.status}`;
    return {
      kind: "remote",
      source: normalized.display,
      sourceUrl: null,
      normalized: normalized.display,
      normalizedId: normalized.id,
      type: normalized.type,
      verified: false,
      skill: name,
      error: `Remote verification failed for ${source}: ${detail}`,
    };
  }
  const verified = remoteListContainsSkill(output, name);
  return {
    kind: "remote",
    source: normalized.display,
    sourceUrl: null,
    normalized: normalized.display,
    normalizedId: normalized.id,
    type: normalized.type,
    verified,
    skill: name,
    error: verified ? null : `Remote source ${source} does not expose skill ${name}`,
  };
}

async function collectSourceResults(args) {
  const diagnostics = [];
  const requestedNames = new Set(args.names.map((name) => name.toLowerCase()));
  const installedByScope = {
    global: listInstalledScope("global"),
    project: listInstalledScope("project"),
  };
  const locks = {
    global: await loadSkillLock("global"),
    project: await loadSkillLock("project"),
  };
  const entries = [];

  for (const scope of ["global", "project"]) {
    const installed = installedByScope[scope];
    const lock = locks[scope];
    if (installed.error) diagnostics.push({ level: "error", scope, message: installed.error });
    if (lock.error) diagnostics.push({ level: "error", scope, message: lock.error });
    if (lock.warning) diagnostics.push({ level: "warning", scope, message: lock.warning });

    entries.push(...installed.entries);
    if (installed.error) {
      for (const [name] of lock.entries) {
        entries.push({ name, path: null, scope, source: null, sourceUrl: null, sourceType: null });
      }
    }
  }

  const uniqueEntries = new Map();
  for (const entry of entries) {
    if (!entry?.name || isExcludedInstalledPath(entry.path)) continue;
    if (requestedNames.size > 0 && !requestedNames.has(String(entry.name).toLowerCase())) continue;
    const identity = `${entry.scope}:${String(entry.name).toLowerCase()}`;
    if (!uniqueEntries.has(identity)) uniqueEntries.set(identity, entry);
  }

  if (requestedNames.size > 0) {
    const found = new Set([...uniqueEntries.values()].map((entry) => String(entry.name).toLowerCase()));
    for (const requested of requestedNames) {
      if (!found.has(requested)) {
        diagnostics.push({ level: "error", scope: null, message: `Installed skill not found: ${requested}` });
      }
    }
  }

  const results = [];
  const ordered = [...uniqueEntries.values()].sort(
    (left, right) => left.scope.localeCompare(right.scope) || String(left.name).localeCompare(String(right.name)),
  );
  for (const entry of ordered) {
    const lock = locks[entry.scope];
    const lockEntry = lock.entries.get(String(entry.name).toLowerCase()) || null;
    const git = await inspectGitProvenance(entry.path);
    let result = assessProvenance(entry, lockEntry, git.evidence);
    if (git.error) result.errors.push(git.error);

    if (args.verifyRemote && ["CANDIDATE", "UNKNOWN"].includes(result.status) && result.source) {
      const remoteEvidence = verifyRemoteSource(result.source, result.name);
      result = assessProvenance(entry, lockEntry, git.evidence, remoteEvidence);
      if (git.error) result.errors.push(git.error);
    }
    results.push(result);
  }

  return { schemaVersion: 1, results, diagnostics };
}

function printSourceReport(report) {
  if (report.results.length === 0) console.log("No matching non-system skills found.");
  for (const result of report.results) {
    const source = result.source ? ` -> ${result.source}` : "";
    console.log(`[${result.status}] ${result.scope}:${result.name}${source}`);
    for (const item of result.evidence) {
      const detail = item.skillPath ? `; skillPath=${item.skillPath}` : "";
      console.log(`  evidence: ${item.kind}=${item.normalized || "unavailable"}${detail}`);
    }
    for (const conflict of result.conflicts) console.log(`  conflict: ${conflict}`);
    for (const error of result.errors) console.log(`  error: ${error}`);
  }
  for (const diagnostic of report.diagnostics) {
    const scope = diagnostic.scope ? `${diagnostic.scope}: ` : "";
    console.log(`[${diagnostic.level.toUpperCase()}] ${scope}${diagnostic.message}`);
  }
}

async function sourcesCommand(args) {
  const report = await collectSourceResults(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printSourceReport(report);

  const unresolved = report.results.some((result) => ["CANDIDATE", "UNKNOWN"].includes(result.status));
  const errors = report.diagnostics.some((item) => item.level === "error") || report.results.some((item) => item.errors.length > 0);
  if (unresolved || errors) process.exitCode = 1;
  return report;
}

function normalizeAgent(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isLocalSource(value) {
  if (typeof value !== "string") return false;
  return (
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value === "." ||
    value === ".." ||
    /^[a-zA-Z]:[/\\]/.test(value)
  );
}

function stripAnsi(value) {
  return String(value)
    .replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function normalizeSource(value, baseDirectory = process.cwd()) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  if (isLocalSource(raw)) {
    return {
      id: `local:${resolve(baseDirectory, raw).replaceAll("\\", "/").toLowerCase()}`,
      display: raw,
      type: "local",
    };
  }

  let match = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!match) match = raw.match(/^(?:https?:\/\/|ssh:\/\/git@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!match) match = raw.match(/^([^/:\s]+)\/([^/\s]+)$/);
  if (match) {
    const owner = match[1];
    const repository = match[2].replace(/\.git$/i, "").replace(/\/$/, "");
    const display = `${owner}/${repository}`;
    return { id: `github:${display.toLowerCase()}`, display, type: "github" };
  }

  try {
    const url = new URL(raw);
    const pathname = url.pathname.replace(/\.git\/?$/i, "").replace(/\/$/, "");
    const display = `${url.protocol}//${url.host}${pathname}`;
    return { id: `url:${display.toLowerCase()}`, display, type: "git" };
  } catch {
    return { id: `source:${raw.toLowerCase()}`, display: raw, type: "unknown" };
  }
}

function isExcludedInstalledPath(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.includes("/.codex/skills/.system/") ||
    normalized.endsWith("/.codex/skills/.system") ||
    normalized.includes("/.codex/plugins/cache/") ||
    normalized.endsWith("/.codex/plugins/cache")
  );
}

function evidenceSource(kind, rawSource, rawUrl, baseDirectory, extra = {}) {
  const normalizedSource = normalizeSource(rawSource, baseDirectory);
  const normalizedUrl = normalizeSource(rawUrl, baseDirectory);
  return {
    kind,
    source: rawSource || null,
    sourceUrl: rawUrl || null,
    normalized: normalizedSource?.display || normalizedUrl?.display || null,
    normalizedId: normalizedSource?.id || normalizedUrl?.id || null,
    type: normalizedSource?.type || normalizedUrl?.type || null,
    internallyConsistent: !normalizedSource || !normalizedUrl || normalizedSource.id === normalizedUrl.id,
    ...extra,
  };
}

function assessProvenance(entry, lockEntry, gitEvidence = null, remoteEvidence = null, baseDirectory = process.cwd()) {
  const evidence = [];
  const conflicts = [];
  const errors = [];
  const cliEvidence = evidenceSource("cli", entry.source, entry.sourceUrl, baseDirectory, {
    sourceType: entry.sourceType || null,
  });
  if (cliEvidence.normalizedId) evidence.push(cliEvidence);
  if (!cliEvidence.internallyConsistent) conflicts.push("CLI source and sourceUrl disagree");

  let lockEvidence = null;
  if (lockEntry) {
    lockEvidence = evidenceSource("lock", lockEntry.source, lockEntry.sourceUrl, baseDirectory, {
      sourceType: lockEntry.sourceType || null,
      skillPath: lockEntry.skillPath || null,
      skillFolderHash: lockEntry.skillFolderHash || null,
    });
    if (lockEvidence.normalizedId) evidence.push(lockEvidence);
    if (!lockEvidence.internallyConsistent) conflicts.push("Lock source and sourceUrl disagree");
  }
  if (gitEvidence?.normalizedId) evidence.push(gitEvidence);
  if (remoteEvidence) {
    evidence.push(remoteEvidence);
    if (remoteEvidence.error) errors.push(remoteEvidence.error);
  }

  const sourceEvidence = evidence.filter((item) => item.normalizedId && item.kind !== "remote");
  const uniqueIds = new Set(sourceEvidence.map((item) => item.normalizedId));
  if (uniqueIds.size > 1) {
    conflicts.push(`Source evidence disagrees: ${[...uniqueIds].join(", ")}`);
  }

  const localEvidence = sourceEvidence.find((item) => item.type === "local");
  let status = "UNKNOWN";
  let chosen = cliEvidence.normalizedId ? cliEvidence : lockEvidence?.normalizedId ? lockEvidence : gitEvidence;

  if (localEvidence) {
    status = uniqueIds.size === 1 && conflicts.length === 0 ? "LOCAL" : "CANDIDATE";
    chosen = localEvidence;
  } else if (conflicts.length > 0) {
    status = "CANDIDATE";
  } else if (
    cliEvidence.normalizedId &&
    lockEvidence?.normalizedId &&
    cliEvidence.normalizedId === lockEvidence.normalizedId
  ) {
    status = "CONFIRMED";
  } else if (
    chosen?.normalizedId &&
    ((gitEvidence?.normalizedId === chosen.normalizedId) || remoteEvidence?.verified === true)
  ) {
    status = "VERIFIED";
  } else if (chosen?.normalizedId) {
    status = "CANDIDATE";
  }

  return {
    name: String(entry.name),
    scope: entry.scope,
    status,
    source: chosen?.normalized || null,
    sourceType: chosen?.type || entry.sourceType || lockEntry?.sourceType || null,
    installedPath: entry.path || null,
    skillPath: lockEntry?.skillPath || gitEvidence?.skillPath || null,
    evidence: evidence.map(({ normalizedId, internallyConsistent, ...item }) => item),
    conflicts,
    errors,
  };
}


function resolveAgents(skill, detectedAgents) {
  return skill.agents[0] === "detected" ? detectedAgents : skill.agents;
}

function selectProfiles(catalog, requested, allProfiles = false, { allowConflicts = false } = {}) {
  const configured = Object.keys(catalog.profiles);
  const selected = allProfiles && !allowConflicts
    ? configured.filter((name) => {
        const profile = catalog.profiles[name];
        return !profile.exclusiveGroup || profile.defaultInExclusiveGroup === true;
      })
    : allProfiles
      ? configured
      : (requested || catalog.defaultProfiles);
  const profiles = [...new Set(selected)];
  if (profiles.length === 0) throw new Error("At least one profile is required");
  for (const profile of profiles) {
    if (!Object.hasOwn(catalog.profiles, profile)) throw new Error(`Unknown profile: ${profile}`);
  }
  if (!allowConflicts) assertCompatibleProfiles(catalog, profiles);
  return profiles;
}

function expandCatalog(catalog, profiles) {
  const selected = new Set(profiles);
  return catalog.skills.flatMap((entry) => {
    if (!entry.profiles.some((profile) => selected.has(profile))) return [];
    return entry.names.map((name) => ({ ...entry, name }));
  });
}

function installedForAgents(installed, skill, targetAgents) {
  const targets = new Set(targetAgents.map(normalizeAgent));
  return installed.some((entry) =>
    entry.scope === skill.scope &&
    String(entry.name).toLowerCase() === skill.name.toLowerCase() &&
    (entry.agents || []).some((agent) => targets.has(normalizeAgent(agent))),
  );
}

function installedSourceConflict(skill, installed, targetAgents) {
  const targets = targetAgents && new Set(targetAgents.map(normalizeAgent));
  const repositoryId = (source) => {
    const normalized = normalizeSource(source);
    // Installation URLs may select a GitHub subdirectory; ownership is repository-wide.
    return normalized?.type === "github" ? normalized.id.split("/").slice(0, 2).join("/") : normalized?.id;
  };
  for (const entry of installed) {
    if (entry.scope !== skill.scope || String(entry.name).toLowerCase() !== skill.name.toLowerCase()) continue;
    if (targets && !(entry.agents || []).some(agent => targets.has(normalizeAgent(agent)))) continue;
    if (isExcludedInstalledPath(entry.path)) return `installed path is protected: ${entry.path}`;
    if (entry.sourceType === "local") return "installed skill has a local source";
    for (const source of [entry.source, entry.sourceUrl]) {
      const normalized = normalizeSource(source);
      if (!normalized) continue;
      if (normalized.type === "local") return `installed skill has a local source: ${source}`;
      if (repositoryId(source) !== repositoryId(skill.package)) {
        return `installed source ${source} conflicts with catalog source ${skill.package}`;
      }
    }
  }
  return null;
}

function displacedProfiles(catalog, profiles) {
  const selected = new Set(profiles);
  const groups = new Set(profiles.map((name) => catalog.profiles[name]?.exclusiveGroup).filter(Boolean));
  return new Set(
    Object.entries(catalog.profiles)
      .filter(([name, profile]) => profile.exclusiveGroup && groups.has(profile.exclusiveGroup) && !selected.has(name))
      .map(([name]) => name),
  );
}

function buildProfileCleanupPlan(catalog, profiles, installed, targetAgents, selectedEntries) {
  if (targetAgents.length === 0) return [];
  const displaced = displacedProfiles(catalog, profiles);
  if (displaced.size === 0) return [];

  return catalog.skills.flatMap((entry) => {
    const conflicting = entry.profiles.filter((profile) => displaced.has(profile));
    if (conflicting.length === 0) return [];
    const protectedProfiles = entry.profiles.filter((profile) => !displaced.has(profile));
    const groups = new Set(conflicting.map(p => catalog.profiles[p].exclusiveGroup));
    const replacements = selectedEntries.filter(e => e.profiles.some(p => profiles.includes(p) && groups.has(catalog.profiles[p].exclusiveGroup)));
    // An empty replacement profile intentionally removes its old managed set.
    const replacementAgents = new Set((replacements.length ? replacements.flatMap(e => resolveAgents(e, targetAgents)) : targetAgents).map(normalizeAgent));
    const peerAgents = new Set(resolveAgents(entry, targetAgents).map(normalizeAgent));
    const candidateAgents = targetAgents.filter(a => replacementAgents.has(normalizeAgent(a)) && peerAgents.has(normalizeAgent(a)));
    return entry.names.flatMap((name) => {
      const skill = { ...entry, name };
      const agents = candidateAgents.filter(agent => installedForAgents(installed, skill, [agent]));
      if (!agents.length) return [];
      if (protectedProfiles.length > 0) {
        return [{ skill, action: "keep", reason: `also managed by protected profiles: ${protectedProfiles.join(", ")}` }];
      }
      if (isLocalSource(entry.package)) {
        return [{ skill, action: "skip", reason: `local source cleanup is disabled: ${entry.package}` }];
      }
      const conflict = installedSourceConflict(skill, installed, agents);
      if (conflict) return [{ skill, agents, action: "blocked", reason: conflict }];
      const localOnlyAgents = agents.filter(agent => [...groups].some(group => {
        const alternatives = replacements.filter(replacement =>
          replacement.profiles.some(profile => profiles.includes(profile) && catalog.profiles[profile].exclusiveGroup === group)
          && resolveAgents(replacement, targetAgents).some(target => normalizeAgent(target) === normalizeAgent(agent)));
        return alternatives.length > 0 && alternatives.every(replacement => isLocalSource(replacement.package));
      }));
      if (localOnlyAgents.length) {
        return [{ skill, agents, action: "blocked", reason: `replacement has only local sources for ${localOnlyAgents.join(", ")}` }];
      }
      return [{ skill, agents, action: "remove", reason: `managed only by displaced profiles: ${conflicting.join(", ")}` }];
    });
  });
}

function buildCleanupPlan(catalog, profiles, installed, targetAgents, selection = selectSkillEntries(catalog, profiles)) {
  const result = new Map(buildProfileCleanupPlan(catalog, profiles, installed, targetAgents, selection.entries).map(item => [`${item.skill.scope}:${item.skill.name.toLowerCase()}`, item]));
  for (const [group, { entry: selected }] of selection.groups) {
    const selectedAgents = new Set(resolveAgents(selected, targetAgents).map(normalizeAgent));
    for (const entry of catalog.skills.filter(e => e.exclusiveGroup === group && e !== selected)) {
      const peerAgents = new Set(resolveAgents(entry, targetAgents).map(normalizeAgent));
      const agents = targetAgents.filter(a => selectedAgents.has(normalizeAgent(a)) && peerAgents.has(normalizeAgent(a)));
      for (const skill of expandSkillEntries([entry])) {
        const key = `${skill.scope}:${skill.name.toLowerCase()}`;
        // Entry-level conflicts supersede profile cleanup, including its target set.
        result.delete(key);
        if (!installedForAgents(installed, skill, agents)) continue;
        const local = isLocalSource(entry.package);
        const conflict = local ? null : installedSourceConflict(skill, installed, agents);
        result.set(key, { skill, agents, action: local ? "skip" : conflict ? "blocked" : "remove", reason: conflict || `entry group ${group}: selected ${selected.names.join(", ")}${local ? "; local source cleanup is disabled" : ""}` });
      }
    }
  }
  return [...result.values()];
}

function assessSkill(skill, installed, detectedAgents) {
  const conflict = installedSourceConflict(skill, installed);
  if (conflict) return { action: "blocked", reason: conflict };
  const matches = installed.filter(
    (entry) => entry.scope === skill.scope && String(entry.name).toLowerCase() === skill.name.toLowerCase(),
  );
  if (matches.length === 0) return { action: "install", reason: "not installed" };
  const installedAgents = new Set(matches.flatMap((entry) => entry.agents || []).map(normalizeAgent));
  const missingAgents = resolveAgents(skill, detectedAgents).filter(
    (agent) => !installedAgents.has(normalizeAgent(agent)),
  );
  if (missingAgents.length > 0) return { action: "install", reason: `missing agent links: ${missingAgents.join(", ")}` };
  return null;
}

function buildPlan(catalog, profiles, installed, detectedAgents, { choices = [], allowConflicts = false, selection } = {}) {
  const skills = allowConflicts ? expandCatalog(catalog, profiles) : expandSkillEntries((selection ?? selectSkillEntries(catalog, profiles, choices)).entries);
  return skills.map((skill) => {
    if (isLocalSource(skill.package)) {
      return { skill, action: "skip", reason: `local source is not portable: ${skill.package}` };
    }
    if (!skill.reviewed) return { skill, action: "blocked", reason: "source is not reviewed" };
    const assessment = assessSkill(skill, installed, detectedAgents);
    return assessment ? { skill, ...assessment } : { skill, action: "ok", reason: "already installed" };
  });
}

function printPlan(profiles, plan, cleanupPlan = [], cleanupAgents = []) {
  console.log(`Profiles: ${profiles.join(", ")}`);
  if (cleanupAgents.length > 0) console.log(`Cleanup agents: ${cleanupAgents.join(", ")}`);
  if (plan.length === 0 && cleanupPlan.length === 0) console.log("Catalog selection is empty.");
  for (const item of [...plan, ...cleanupPlan]) {
    console.log(`[${item.action.toUpperCase()}] ${item.skill.name} (${item.skill.scope}) - ${item.reason}`);
  }
}

async function doctor(args) {
  const checks = [
    ["Node.js", process.version],
    ["Git", commandVersion("git", ["--version"])],
    ["npx", commandVersion(npx.command, [...npx.prefix, "--version"])],
    ["Skills CLI", commandVersion(npx.command, [...npx.prefix, "--yes", "skills", "--version"])],
  ];

  let failed = false;
  for (const [name, value] of checks) {
    if (value) console.log(`[OK] ${name}: ${value}`);
    else {
      console.log(`[ERROR] ${name}: unavailable`);
      failed = true;
    }
  }
  try {
    const catalog = await loadCatalog();
    console.log(`[OK] Catalog: schema v${catalog.schemaVersion}, ${catalog.skills.length} source entries`);
    if (catalog.skills.some((entry) => entry.agents[0] === "detected")) {
      try {
        const agents = detectActiveAgents(args.agents);
        console.log(`[OK] Active agent: ${agents.join(", ")}`);
        if (agents.includes("codebuddy")) {
          const mismatch = codebuddyGlobalSkillsMismatch();
          if (mismatch) {
            console.log(`[WARN] CodeBuddy global scope: Skills CLI writes ${mismatch.cliDir},`
              + ` this runtime scans ${mismatch.runtimeDir}`);
          }
        }
      } catch (error) {
        console.log(`[WARN] Active agent: ${error.message}`);
      }
    }
  } catch (error) {
    console.log(`[ERROR] Catalog: ${error.message}`);
    failed = true;
  }
  if (failed) process.exitCode = 1;
}

async function planCommand(args, dependencies = {}) {
  const catalog = dependencies.catalog ? validateCatalog(dependencies.catalog) : await loadCatalog();
  const syncing = ["plan", "sync"].includes(args.command);
  const profiles = selectProfiles(catalog, args.profiles, args.allProfiles, { allowConflicts: !syncing });
  const selection = syncing ? selectSkillEntries(catalog, profiles, args.choices) : null;
  const selected = selection ? expandSkillEntries(selection.entries) : expandCatalog(catalog, profiles);
  const selectsExclusiveProfile = syncing && profiles.some((profile) => catalog.profiles[profile].exclusiveGroup);
  const hasEntrySelection = Boolean(selection?.groups.size);
  const needsDetection = selectsExclusiveProfile || hasEntrySelection || selected.some(
    (skill) => !isLocalSource(skill.package) && skill.agents[0] === "detected",
  );
  const detectedAgents = needsDetection ? (dependencies.detectActiveAgents || detectActiveAgents)(args.agents) : [];
  if (needsDetection) console.log(`Active agent: ${detectedAgents.join(", ")}`);
  const installed = (dependencies.listInstalled || listInstalled)();
  const cleanupAgents = selectsExclusiveProfile || hasEntrySelection ? detectedAgents : [];
  const plan = args.command === "remove"
    ? buildExplicitRemovalPlan(selected, installed, detectedAgents)
    : buildPlan(catalog, profiles, installed, detectedAgents, { selection, allowConflicts: !syncing });
  const cleanupPlan = syncing ? buildCleanupPlan(catalog, profiles, installed, cleanupAgents, selection) : [];
  console.log(`Skill ${args.command === "plan" ? "sync" : args.command} plan:`);
  for (const [group, { entry, source }] of selection?.groups ?? []) console.log(`Entry group ${group}: ${entry.names.join(", ")} (${source})`);
  printPlan(profiles, plan, cleanupPlan, cleanupAgents);
  return { catalog, profiles, plan, cleanupPlan, detectedAgents, cleanupAgents, hasEntrySelection };
}

function buildExplicitRemovalPlan(selected, installed, detectedAgents) {
  return selected.map((skill) => {
    const membership = `profiles: ${skill.profiles.join(", ")}`;
    if (isLocalSource(skill.package)) return { skill, action: "skip", reason: `local source removal is disabled; ${membership}` };
    const agents = resolveAgents(skill, detectedAgents).filter((agent) => installedForAgents(installed, skill, [agent]));
    const conflict = installedSourceConflict(skill, installed, agents);
    return {
      skill, agents, action: conflict ? "blocked" : agents.length ? "remove" : "skip",
      reason: `${conflict || (agents.length ? `explicit removal from ${agents.join(", ")}` : "not installed for selected agents")}; ${membership}`,
    };
  });
}

function buildInstallBatches(actions, detectedAgents) {
  const batches = new Map();
  for (const item of actions) {
    const skill = item.skill;
    const agents = resolveAgents(skill, detectedAgents);
    const agentKey = agents.map(normalizeAgent).sort().join(",");
    const key = JSON.stringify([skill.package, skill.scope, agentKey, skill.required]);
    if (!batches.has(key)) {
      batches.set(key, {
        package: skill.package,
        names: [],
        scope: skill.scope,
        agents,
        required: skill.required,
      });
    }
    batches.get(key).names.push(skill.name);
  }
  return [...batches.values()];
}

function installArgs(batch) {
  const args = ["add", batch.package, "--skill", ...batch.names, "--agent", ...batch.agents, "--yes"];
  if (batch.scope === "global") args.push("--global");
  return args;
}

function buildRemovalBatches(removals, agents) {
  const batches = new Map();
  for (const item of removals) {
    const scope = item.skill.scope;
    const targets = item.agents ?? agents;
    const key = `${scope}:${targets.map(normalizeAgent).sort().join(",")}`;
    if (!batches.has(key)) batches.set(key, { names: [], scope, agents: targets });
    const batch = batches.get(key);
    if (!batch.names.some((name) => name.toLowerCase() === item.skill.name.toLowerCase())) batch.names.push(item.skill.name);
  }
  return [...batches.values()];
}

function removeArgs(batch) {
  const args = ["remove", ...batch.names, "--agent", ...batch.agents, "--yes"];
  if (batch.scope === "global") args.push("--global");
  return args;
}

async function applySyncPlan(syncPlan, args, dependencies = {}) {
  const executeSkills = dependencies.runSkills || runSkills;
  const readInstalled = dependencies.listInstalled || listInstalled;
  const { profiles, plan, cleanupPlan, detectedAgents, cleanupAgents } = syncPlan;
  const actions = plan.filter((item) => item.action === "install");
  const blocked = [...plan, ...cleanupPlan].filter((item) => item.action === "blocked");
  const skipped = plan.filter((item) => item.action === "skip");
  const removals = cleanupPlan.filter((item) => item.action === "remove");
  if (!args.yes) {
    console.log("Repeat with --yes to execute this plan.");
    return { failed: false, cancelled: false, preview: true, residual: [] };
  }
  if (blocked.length > 0) throw new Error(`Operation blocked: ${blocked.map(item => `${item.skill.name}: ${item.reason}`).join("; ")}`);
  if ((syncPlan.hasEntrySelection || removals.length > 0) && skipped.some(item => item.skill.exclusiveGroup || item.skill.required)) throw new Error("Sync blocked: selected required skill or entry alternative is a local source and cannot be established");
  if (actions.length === 0 && removals.length === 0) {
    if (skipped.length > 0) console.log(`Skipped local skills: ${skipped.map((item) => item.skill.name).join(", ")}`);
    console.log("Nothing to install or remove.");
    return { failed: false, cancelled: false, residual: [] };
  }

  const batches = buildInstallBatches(actions, detectedAgents);
  if (actions.length > 0) console.log(`Installation batches: ${batches.length} for ${actions.length} skills`);
  const failures = [];
  for (const batch of batches) {
    console.log(`Installing ${batch.names.join(", ")} from ${batch.package}...`);
    const result = executeSkills(installArgs(batch));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) {
      failures.push(...batch.names);
      if (batch.required) {
        if (removals.length > 0) console.log("Cleanup skipped because installation failed.");
        throw new Error(`Required skills failed: ${batch.names.join(", ")}`);
      }
    }
  }

  if (skipped.length > 0) console.log(`Skipped local skills: ${skipped.map((item) => item.skill.name).join(", ")}`);
  if (failures.length > 0) {
    console.log(`Optional failures: ${failures.join(", ")}`);
    if (removals.length > 0) console.log("Cleanup skipped because installation failed.");
    return { failed: true, cancelled: false, residual: removals, installFailures: failures };
  }

  if (syncPlan.hasEntrySelection || removals.length > 0) {
    const installedAfterInstall = readInstalled();
    const missing = plan.filter(item => item.action !== "skip" && assessSkill(item.skill, installedAfterInstall, detectedAgents));
    if (missing.length) {
      console.log(`Cleanup skipped: replacement verification failed for ${missing.map(item => item.skill.name).join(", ")}`);
      return { failed: true, cancelled: false, residual: removals, verificationFailures: missing.map(item => item.skill.name) };
    }
  }
  const commandFailures = [];
  for (const batch of buildRemovalBatches(removals, cleanupAgents)) {
    console.log(`Removing ${batch.names.join(", ")} from ${batch.agents.join(", ")}...`);
    const result = executeSkills(removeArgs(batch));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) commandFailures.push(...batch.names);
  }

  const installedAfterCleanup = removals.length > 0 ? readInstalled() : [];
  const residual = removals.filter((item) => installedForAgents(installedAfterCleanup, item.skill, item.agents ?? cleanupAgents));
  const removedCount = removals.length - residual.length;
  if (removals.length > 0) console.log(`Removed conflicting skills: ${removedCount}/${removals.length}`);
  console.log(`${args.command === "install" ? "Install" : "Sync"} ${commandFailures.length || residual.length ? "failed" : "complete"} for profiles: ${profiles.join(", ")}`);
  if (commandFailures.length > 0 || residual.length > 0) {
    if (commandFailures.length > 0) console.log(`Removal command failures: ${[...new Set(commandFailures)].join(", ")}`);
    if (residual.length > 0) console.log(`Removal verification failed: ${residual.map((item) => item.skill.name).join(", ")}`);
  }
  return {
    failed: commandFailures.length > 0 || residual.length > 0,
    cancelled: false,
    residual,
    commandFailures,
  };
}

async function applyExplicitRemovalPlan(operationPlan, args, dependencies = {}) {
  const removals = operationPlan.plan.filter((item) => item.action === "remove");
  if (!args.yes) {
    console.log("Repeat with --yes to execute this plan.");
    return { failed: false, preview: true };
  }
  const blocked = operationPlan.plan.filter(item => item.action === "blocked");
  if (blocked.length) throw new Error(`Removal blocked: ${blocked.map(item => `${item.skill.name}: ${item.reason}`).join("; ")}`);
  const executeSkills = dependencies.runSkills || runSkills;
  const readInstalled = dependencies.listInstalled || listInstalled;
  const batches = buildRemovalBatches(removals, operationPlan.detectedAgents);
  const completed = [];
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    try {
      const result = executeSkills(removeArgs(batch));
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error || result.status !== 0) throw new Error(`Removal command failed: ${batch.names.join(", ")}`);
      const installed = readInstalled();
      const residual = batch.names.filter((name) => installedForAgents(installed, { name, scope: batch.scope }, batch.agents));
      if (residual.length) throw new Error(`Removal verification failed: ${residual.join(", ")}`);
      completed.push(`${batch.scope}:${batch.names.join(", ")} [${batch.agents.join(", ")}]`);
    } catch (error) {
      console.error(error.message);
      console.error(`Completed: ${completed.join("; ") || "none"}`);
      console.error(`Pending: ${batches.slice(index).map((b) => `${b.scope}:${b.names.join(", ")} [${b.agents.join(", ")}]`).join("; ")}`);
      return { failed: true, completed };
    }
  }
  console.log(`Removal complete for profiles: ${operationPlan.profiles.join(", ")}`);
  return { failed: false, completed };
}

async function executeSkillOperation(args, dependencies = {}) {
  if (args.command === "remove" && !args.profiles && !args.allProfiles) throw new Error("remove requires --profile or --all");
  const operationPlan = await planCommand(args, dependencies);
  if (args.command === "plan") return { failed: false, preview: true };
  return args.command === "remove"
    ? applyExplicitRemovalPlan(operationPlan, args, dependencies)
    : applySyncPlan(operationPlan, args, dependencies);
}

function buildAuditFindings(catalog, profiles, installed, detectedAgents, { profileAudit = false, choices = [], selection: resolvedSelection } = {}) {
  const selection = profileAudit ? resolvedSelection ?? selectSkillEntries(catalog, profiles, choices) : null;
  const expected = selection ? expandSkillEntries(selection.entries) : expandCatalog(catalog, profiles);
  const local = [];
  const drift = [];

  for (const skill of expected) {
    if (isLocalSource(skill.package)) {
      local.push(`[LOCAL] ${skill.scope}:${skill.name} - restore skipped: ${skill.package}`);
    } else if (!skill.reviewed) drift.push(`[BLOCKED] ${skill.scope}:${skill.name} - source is not reviewed`);
    else {
      const assessment = assessSkill(skill, installed, detectedAgents);
      if (assessment) drift.push(`[${assessment.action === "blocked" ? "BLOCKED" : "MISSING"}] ${skill.scope}:${skill.name} - ${assessment.reason}`);
    }
  }

  if (profileAudit) {
    const cleanupPlan = buildCleanupPlan(catalog, profiles, installed, detectedAgents, selection);
    for (const item of cleanupPlan.filter((entry) => ["remove", "skip", "blocked"].includes(entry.action))) {
      drift.push(`[CONFLICT] ${item.skill.scope}:${item.skill.name} - ${item.reason}`);
    }
  }

  const managed = profileAudit ? expandCatalog(catalog, Object.keys(catalog.profiles)) : expected;
  const managedIds = new Set(managed.map((skill) => `${skill.scope}:${skill.name.toLowerCase()}`));
  for (const entry of installed) {
    const identity = `${entry.scope}:${String(entry.name).toLowerCase()}`;
    if (!managedIds.has(identity)) {
      const source = entry.source ? ` from ${entry.source}` : " with unknown source";
      drift.push(`[UNMANAGED] ${entry.scope}:${entry.name}${source}`);
    }
  }

  return { expected, local, drift };
}

async function auditCommand(args) {
  const catalog = await loadCatalog();
  const profileAudit = Boolean(args.profiles);
  const profiles = selectProfiles(catalog, args.profiles, args.allProfiles || !args.profiles, { allowConflicts: !profileAudit });
  const selection = profileAudit ? selectSkillEntries(catalog, profiles, args.choices) : null;
  const expected = selection ? expandSkillEntries(selection.entries) : expandCatalog(catalog, profiles);
  const selectsExclusiveProfile = profileAudit && profiles.some((profile) => catalog.profiles[profile].exclusiveGroup);
  const needsDetection = selectsExclusiveProfile || Boolean(selection?.groups.size) || expected.some(
    (skill) => !isLocalSource(skill.package) && skill.agents[0] === "detected",
  );
  const detectedAgents = needsDetection ? detectActiveAgents(args.agents) : [];
  if (needsDetection) console.log(`Active agent: ${detectedAgents.join(", ")}`);
  const { local, drift } = buildAuditFindings(catalog, profiles, listInstalled(), detectedAgents, { profileAudit, selection });
  local.forEach((line) => console.log(line));

  console.log(`Profiles audited: ${profiles.join(", ")}`);
  if (drift.length === 0) console.log("No drift found.");
  else {
    drift.forEach((line) => console.log(line));
    process.exitCode = 1;
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (!args.command || args.command === "help") {
      usage();
      return;
    }
    if (args.command === "doctor") await doctor(args);
    else if (["plan", "sync", "install", "remove"].includes(args.command)) {
      const result = await executeSkillOperation(args);
      if (result.failed) process.exitCode = 1;
    }
    else if (args.command === "audit") await auditCommand(args);
    else if (args.command === "sources") await sourcesCommand(args);
    else throw new Error(`Unknown command: ${args.command}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}

export {
  executeSkillOperation,
  assessProvenance,
  applySyncPlan,
  buildAuditFindings,
  buildCleanupPlan,
  buildInstallBatches,
  buildPlan,
  buildRemovalBatches,
  installArgs,
  inspectGitProvenance,
  isExcludedInstalledPath,
  isLocalSource,
  loadSkillLock,
  normalizeSource,
  parseArgs,
  parseSkillLock,
  remoteListContainsSkill,
  removeArgs,
  selectProfiles,
  validateCatalog,
};
