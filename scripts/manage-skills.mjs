#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogPath = join(root, "skillset.json");

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
  plan [--profile <a,b> | --all]         Show installations needed for profiles
  init [--profile <a,b> | --all] [--yes] Install missing reviewed skills
  audit [--profile <a,b> | --all]        Report catalog and installation drift
  sources [skill ...] [options]  Confirm installed skill sources without changing them

Options:
  --profile <a,b>  Select comma-separated profiles
  --all            Select every configured profile
  --agent <a,b>    Resolve catalog agent "detected" (otherwise infer the active agent)
  --json           Emit stable machine-readable source results
  --verify-remote  Allow source verification against a remote repository
  --yes            Confirm a previously reviewed init plan
  --help            Show this help`);
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
    } else if (arg === "--json" && result.command === "sources") {
      result.json = true;
    } else if (arg === "--verify-remote" && result.command === "sources") {
      result.verifyRemote = true;
    } else if (arg === "--profile") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--profile requires a value");
      result.profiles = value.split(",").map((item) => item.trim()).filter(Boolean);
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
  return result;
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be a non-empty array of strings`);
  }
}

async function loadCatalog() {
  let catalog;
  try {
    catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${catalogPath}: ${error.message}`);
  }

  if (catalog.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (!catalog.profiles || typeof catalog.profiles !== "object" || Array.isArray(catalog.profiles)) {
    throw new Error("profiles must be an object");
  }
  assertStringArray(catalog.defaultProfiles, "defaultProfiles");
  if (!Array.isArray(catalog.skills)) throw new Error("skills must be an array");

  for (const profile of catalog.defaultProfiles) {
    if (!catalog.profiles[profile]) throw new Error(`Unknown default profile: ${profile}`);
  }

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
      if (!catalog.profiles[profile]) throw new Error(`${label} references unknown profile: ${profile}`);
    }
    for (const name of entry.names) {
      const identity = `${entry.scope}:${name.toLowerCase()}`;
      if (identities.has(identity)) throw new Error(`Duplicate catalog skill: ${entry.scope}:${name}`);
      identities.add(identity);
    }
  });

  return catalog;
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
  const remoteResult = run("git", ["-C", gitRoot, "config", "--get", "remote.origin.url"]);
  if (remoteResult.error || remoteResult.status !== 0 || !remoteResult.stdout.trim()) {
    return { evidence: null, error: null };
  }

  const remote = remoteResult.stdout.trim();
  const evidence = evidenceSource("git", remote, remote, process.cwd(), {
    repositoryRoot: gitRoot,
    resolvedPath: target,
    skillPath: relative(gitRoot, join(target, "SKILL.md")).replaceAll("\\", "/"),
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

function detectActiveAgents(override) {
  if (override) return override;

  const configured = process.env.MY_SKILLS_AGENT?.split(",").map((item) => item.trim()).filter(Boolean);
  if (configured?.length) return configured;

  const detected = [];
  if (
    process.env.CODEX_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_CI ||
    process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE
  ) {
    detected.push("codex");
  }
  if (process.env.CLAUDECODE === "1") detected.push("claude-code");

  if (detected.length === 1) return detected;
  if (detected.length > 1) {
    throw new Error(`Active agent is ambiguous (${detected.join(", ")}); pass --agent <id>`);
  }
  throw new Error("Could not detect the active agent; pass --agent <id> or set MY_SKILLS_AGENT");
}

function resolveAgents(skill, detectedAgents) {
  return skill.agents[0] === "detected" ? detectedAgents : skill.agents;
}

function selectProfiles(catalog, requested, allProfiles = false) {
  const profiles = allProfiles ? Object.keys(catalog.profiles) : (requested || catalog.defaultProfiles);
  if (profiles.length === 0) throw new Error("At least one profile is required");
  for (const profile of profiles) {
    if (!catalog.profiles[profile]) throw new Error(`Unknown profile: ${profile}`);
  }
  return profiles;
}

function expandCatalog(catalog, profiles) {
  const selected = new Set(profiles);
  return catalog.skills.flatMap((entry) => {
    if (!entry.profiles.some((profile) => selected.has(profile))) return [];
    return entry.names.map((name) => ({ ...entry, name }));
  });
}

function assessSkill(skill, installed, detectedAgents) {
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

function buildPlan(catalog, profiles, installed, detectedAgents) {
  return expandCatalog(catalog, profiles).map((skill) => {
    if (isLocalSource(skill.package)) {
      return { skill, action: "skip", reason: `local source is not portable: ${skill.package}` };
    }
    if (!skill.reviewed) return { skill, action: "blocked", reason: "source is not reviewed" };
    const assessment = assessSkill(skill, installed, detectedAgents);
    return assessment ? { skill, ...assessment } : { skill, action: "ok", reason: "already installed" };
  });
}

function printPlan(profiles, plan) {
  console.log(`Profiles: ${profiles.join(", ")}`);
  if (plan.length === 0) {
    console.log("Catalog selection is empty.");
    return;
  }
  for (const item of plan) {
    const scope = item.skill.scope === "global" ? "global" : "project";
    console.log(`[${item.action.toUpperCase()}] ${item.skill.name} (${scope}) - ${item.reason}`);
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
        console.log(`[OK] Active agent: ${detectActiveAgents(args.agents).join(", ")}`);
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

async function planCommand(args) {
  const catalog = await loadCatalog();
  const profiles = selectProfiles(catalog, args.profiles, args.allProfiles);
  const selected = expandCatalog(catalog, profiles);
  const needsDetection = selected.some(
    (skill) => !isLocalSource(skill.package) && skill.agents[0] === "detected",
  );
  const detectedAgents = needsDetection ? detectActiveAgents(args.agents) : [];
  if (needsDetection) console.log(`Active agent: ${detectedAgents.join(", ")}`);
  const plan = buildPlan(catalog, profiles, listInstalled(), detectedAgents);
  printPlan(profiles, plan);
  return { profiles, plan, detectedAgents };
}

async function confirmInit() {
  if (!process.stdin.isTTY) {
    throw new Error("Cannot prompt in a non-interactive session; review the plan and rerun with --yes");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question("Install the planned skills? [y/N] ");
  prompt.close();
  return /^(y|yes)$/i.test(answer.trim());
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

async function initCommand(args) {
  const { profiles, plan, detectedAgents } = await planCommand(args);
  const actions = plan.filter((item) => item.action === "install");
  const blocked = plan.filter((item) => item.action === "blocked");
  const skipped = plan.filter((item) => item.action === "skip");
  if (blocked.length > 0) throw new Error("Initialization blocked by unreviewed catalog entries");
  if (actions.length === 0) {
    if (skipped.length > 0) console.log(`Skipped local skills: ${skipped.map((item) => item.skill.name).join(", ")}`);
    console.log("Nothing to install.");
    return;
  }

  if (!args.yes && !(await confirmInit())) {
    console.log("Initialization cancelled.");
    return;
  }

  const batches = buildInstallBatches(actions, detectedAgents);
  console.log(`Installation batches: ${batches.length} for ${actions.length} skills`);
  const failures = [];
  for (const batch of batches) {
    console.log(`Installing ${batch.names.join(", ")} from ${batch.package}...`);
    const result = runSkills(installArgs(batch));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) {
      failures.push(...batch.names);
      if (batch.required) {
        throw new Error(`Required skills failed: ${batch.names.join(", ")}`);
      }
    }
  }

  console.log(`Initialization complete for profiles: ${profiles.join(", ")}`);
  if (skipped.length > 0) console.log(`Skipped local skills: ${skipped.map((item) => item.skill.name).join(", ")}`);
  if (failures.length > 0) {
    console.log(`Optional failures: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

async function auditCommand(args) {
  const catalog = await loadCatalog();
  const profiles = selectProfiles(catalog, args.profiles, args.allProfiles || !args.profiles);
  const expected = expandCatalog(catalog, profiles);
  const needsDetection = expected.some(
    (skill) => !isLocalSource(skill.package) && skill.agents[0] === "detected",
  );
  const detectedAgents = needsDetection ? detectActiveAgents(args.agents) : [];
  if (needsDetection) console.log(`Active agent: ${detectedAgents.join(", ")}`);
  const installed = listInstalled();
  const drift = [];

  for (const skill of expected) {
    if (isLocalSource(skill.package)) {
      console.log(`[LOCAL] ${skill.scope}:${skill.name} - restore skipped: ${skill.package}`);
    } else if (!skill.reviewed) drift.push(`[BLOCKED] ${skill.scope}:${skill.name} - source is not reviewed`);
    else {
      const assessment = assessSkill(skill, installed, detectedAgents);
      if (assessment) drift.push(`[MISSING] ${skill.scope}:${skill.name} - ${assessment.reason}`);
    }
  }

  const expectedIds = new Set(expected.map((skill) => `${skill.scope}:${skill.name.toLowerCase()}`));
  for (const entry of installed) {
    const identity = `${entry.scope}:${String(entry.name).toLowerCase()}`;
    if (!expectedIds.has(identity)) {
      const source = entry.source ? ` from ${entry.source}` : " with unknown source";
      drift.push(`[UNMANAGED] ${entry.scope}:${entry.name}${source}`);
    }
  }

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
    else if (args.command === "plan") await planCommand(args);
    else if (args.command === "init") await initCommand(args);
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
  assessProvenance,
  buildInstallBatches,
  buildPlan,
  installArgs,
  inspectGitProvenance,
  isExcludedInstalledPath,
  isLocalSource,
  loadSkillLock,
  normalizeSource,
  parseArgs,
  parseSkillLock,
  remoteListContainsSkill,
  selectProfiles,
};
