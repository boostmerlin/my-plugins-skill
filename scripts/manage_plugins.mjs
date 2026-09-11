#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalogPath = join(root, "pluginset.json");
const commandPlatforms = new Set(["default", "win32", "linux", "darwin"]);
const pluginFields = new Set([
  "name",
  "profiles",
  "checkCommand",
  "installCommand",
  "updateCommand",
  "setupCommand",
  "uninstallCommands",
  "reviewed",
]);

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be a non-empty array of strings`);
  }
}

function assertCommandSpec(spec, label) {
  if (typeof spec === "string") {
    if (!spec.trim()) throw new Error(`${label} must be a non-empty command string or platform map`);
    return;
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`${label} must be a non-empty command string or platform map`);
  }
  const entries = Object.entries(spec);
  if (entries.length === 0) throw new Error(`${label} must be a non-empty command string or platform map`);
  for (const [key, value] of entries) {
    if (!commandPlatforms.has(key)) throw new Error(`${label} has unknown platform: ${key}`);
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label}.${key} must be a non-empty string`);
  }
}

function resolveCommandSpec(spec, platform = process.platform, label = "command") {
  assertCommandSpec(spec, label);
  if (typeof spec === "string") return spec.trim();
  const command = spec[platform] ?? spec.default;
  if (!command) throw new Error(`${label} has no command for platform ${platform}`);
  return command.trim();
}

function resolveCommandList(value, platform, label) {
  const commands = Array.isArray(value) ? value : [value];
  if (commands.length === 0) throw new Error(`${label} must be a non-empty array`);
  return commands.map((command, index) =>
    resolveCommandSpec(command, platform, Array.isArray(value) ? `${label}[${index}]` : label));
}

function validatePluginCatalog(catalog, { platform = process.platform } = {}) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("catalog must be an object");
  if (catalog.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (!catalog.profiles || typeof catalog.profiles !== "object" || Array.isArray(catalog.profiles)) {
    throw new Error("profiles must be an object");
  }
  if (!Array.isArray(catalog.plugins)) throw new Error("plugins must be an array");

  const names = new Set();
  catalog.plugins.forEach((entry, index) => {
    const label = `plugins[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${label} must be an object`);
    for (const key of Object.keys(entry)) {
      if (!pluginFields.has(key)) throw new Error(`${label} has unknown field: ${key}`);
    }
    assertNonEmptyString(entry.name, `${label}.name`);
    assertStringArray(entry.profiles, `${label}.profiles`);
    if (typeof entry.reviewed !== "boolean") throw new Error(`${label}.reviewed must be boolean`);
    assertCommandSpec(entry.checkCommand, `${label}.checkCommand`);
    if (!Array.isArray(entry.uninstallCommands) || entry.uninstallCommands.length === 0) {
      throw new Error(`${label}.uninstallCommands must be a non-empty array`);
    }
    entry.uninstallCommands.forEach((command, commandIndex) => {
      assertCommandSpec(command, `${label}.uninstallCommands[${commandIndex}]`);
    });
    resolveCommandSpec(entry.checkCommand, platform, `${label}.checkCommand`);
    resolveCommandList(entry.installCommand, platform, `${label}.installCommand`);
    if (entry.updateCommand != null) resolveCommandList(entry.updateCommand, platform, `${label}.updateCommand`);
    if (entry.setupCommand != null) resolveCommandList(entry.setupCommand, platform, `${label}.setupCommand`);
    entry.uninstallCommands.forEach((command, commandIndex) => {
      resolveCommandSpec(command, platform, `${label}.uninstallCommands[${commandIndex}]`);
    });
    for (const profile of entry.profiles) {
      if (!Object.hasOwn(catalog.profiles, profile)) {
        throw new Error(`${label} references unknown profile: ${profile}`);
      }
    }
    const identity = entry.name.toLowerCase();
    if (names.has(identity)) throw new Error(`Duplicate plugin name: ${entry.name}`);
    names.add(identity);
  });
  return catalog;
}

function mergeValues(current, value, label, { caseInsensitive = false } = {}) {
  if (!value || value.startsWith("--")) throw new Error(`${label} requires a value`);
  const next = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (next.length === 0) throw new Error(`${label} requires at least one value`);
  const merged = [...(current ?? []), ...next];
  const seen = new Set();
  return merged.filter((item) => {
    const identity = caseInsensitive ? item.toLowerCase() : item;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function parsePluginArgs(argv) {
  const command = argv[0] === "--help" || argv[0] === "-h" ? "help" : argv[0];
  const result = { command, profiles: null, plugins: null, all: false, yes: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes") result.yes = true;
    else if (arg === "--all") result.all = true;
    else if (arg === "--profile") {
      result.profiles = mergeValues(result.profiles, argv[index + 1], "--profile");
      index += 1;
    } else if (arg === "--plugin") {
      result.plugins = mergeValues(result.plugins, argv[index + 1], "--plugin", { caseInsensitive: true });
      index += 1;
    } else if (arg === "--help" || arg === "-h") result.command = "help";
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (result.command === "help") return result;
  if (!["plan", "install", "update", "remove"].includes(result.command)) throw new Error(`Unknown command: ${result.command}`);
  const selectorCount = Number(Boolean(result.profiles)) + Number(Boolean(result.plugins)) + Number(result.all);
  if (selectorCount === 0) throw new Error(`${result.command} requires --profile, --plugin, or --all`);
  if (selectorCount > 1) throw new Error("--profile, --plugin, and --all selectors are mutually exclusive");
  return result;
}

function selectPlugins(catalog, args) {
  if (args.all) return [...catalog.plugins];
  if (args.profiles) {
    const selectedProfiles = new Set(args.profiles);
    for (const profile of selectedProfiles) {
      if (!Object.hasOwn(catalog.profiles, profile)) throw new Error(`Unknown profile: ${profile}`);
    }
    return catalog.plugins.filter((entry) => entry.profiles.some((profile) => selectedProfiles.has(profile)));
  }
  const requested = new Set(args.plugins.map((name) => name.toLowerCase()));
  const known = new Set(catalog.plugins.map((entry) => entry.name.toLowerCase()));
  for (const name of args.plugins) {
    if (!known.has(name.toLowerCase())) throw new Error(`Unknown plugin: ${name}`);
  }
  return catalog.plugins.filter((entry) => requested.has(entry.name.toLowerCase()));
}

function resolvePluginCommands(entry, platform) {
  return {
    checkCommand: resolveCommandSpec(entry.checkCommand, platform, `${entry.name}.checkCommand`),
    installCommands: resolveCommandList(entry.installCommand, platform, `${entry.name}.installCommand`),
    setupCommands: entry.setupCommand == null
      ? []
      : resolveCommandList(entry.setupCommand, platform, `${entry.name}.setupCommand`),
    uninstallCommands: entry.uninstallCommands.map((command, index) =>
      resolveCommandSpec(command, platform, `${entry.name}.uninstallCommands[${index}]`)),
  };
}

async function inspectSelectedPlugins(catalog, args, { platform = process.platform, runCheck }) {
  const selected = selectPlugins(catalog, args);
  const inspected = [];
  for (const entry of selected) {
    const commands = resolvePluginCommands(entry, platform);
    const check = await runCheck(commands.checkCommand);
    inspected.push({ entry, commands, check, installed: check.status === 0 });
  }
  return inspected;
}

async function buildInstallPlan(catalog, args, options) {
  const inspected = await inspectSelectedPlugins(catalog, args, options);
  return inspected.map(({ entry, commands, check, installed }) => ({
    name: entry.name,
    reviewed: entry.reviewed,
    installed,
    checkCommand: commands.checkCommand,
    checkStatus: check.status,
    actions: [
      ...(!installed ? commands.installCommands.map((command) => ({ stage: "install", command })) : []),
      ...commands.setupCommands.map((command) => ({ stage: "setup", command })),
    ],
  }));
}

async function buildUpdatePlan(catalog, args, options) {
  const selected = selectPlugins(catalog, args);
  for (const entry of selected) {
    if (entry.updateCommand == null) throw new Error(`Plugin has no updateCommand: ${entry.name}`);
  }
  const inspected = await inspectSelectedPlugins(catalog, args, options);
  return inspected.map(({ entry, commands, installed, check }) => {
    if (!installed) throw new Error(`Plugin is unavailable: ${entry.name}; run install first`);
    return {
      name: entry.name, reviewed: entry.reviewed, installed,
      checkCommand: commands.checkCommand, checkStatus: check.status,
      actions: [
        ...resolveCommandList(entry.updateCommand, options.platform, `${entry.name}.updateCommand`)
          .map((command) => ({ stage: "update", command })),
        ...commands.setupCommands.map((command) => ({ stage: "setup", command })),
      ],
    };
  });
}

async function buildRemovalPlan(catalog, args, options) {
  const inspected = await inspectSelectedPlugins(catalog, args, options);
  return inspected.map(({ entry, commands, check, installed }) => ({
    name: entry.name,
    reviewed: entry.reviewed,
    installed,
    checkCommand: commands.checkCommand,
    checkStatus: check.status,
    actions: commands.uninstallCommands.map((command) => ({ stage: "uninstall", command })),
  }));
}

function formatInstallPlan(plan, { update = false } = {}) {
  const lines = [update ? "Plugin update plan:" : "Plugin installation plan:"];
  for (const item of plan) {
    lines.push(`${item.reviewed ? "[READY]" : "[BLOCKED]"} ${item.name}`);
    lines.push(`  CHECK: ${item.checkCommand}`);
    if (item.installed && !update) lines.push("  SKIP INSTALL: CLI is available");
    for (const action of item.actions) lines.push(`  ${action.stage.toUpperCase()}: ${action.command}`);
  }
  return lines.join("\n");
}

function formatRemovalPlan(plan) {
  const lines = ["Plugin removal plan:"];
  for (const item of plan) {
    lines.push(`[REMOVE] ${item.name}`);
    lines.push(`  CHECK: ${item.checkCommand} (${item.installed ? "available" : "unavailable"})`);
    for (const action of item.actions) lines.push(`  UNINSTALL: ${action.command}`);
  }
  return lines.join("\n");
}

class PluginCommandError extends Error {
  constructor(plugin, stage, command, status) {
    super(`${plugin} ${stage} failed with exit status ${status ?? "unavailable"}: ${command}`);
    this.name = "PluginCommandError";
    this.plugin = plugin;
    this.stage = stage;
    this.command = command;
    this.status = status;
  }
}

async function runActions(plan, runMutation) {
  for (const item of plan) {
    for (const action of item.actions) {
      const result = await runMutation(action.command);
      if (result.error || result.status !== 0) {
        throw new PluginCommandError(item.name, action.stage, action.command, result.status);
      }
    }
  }
}

async function applyInstallPlan(plan, { runMutation }) {
  const blocked = plan.find((item) => item.reviewed !== true);
  if (blocked) throw new Error(`Plugin is not reviewed: ${blocked.name}`);
  await runActions(plan, runMutation);
}

async function applyRemovalPlan(plan, { runMutation }) {
  await runActions(plan, runMutation);
}

function shellInvocation(command, platform = process.platform) {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `$ErrorActionPreference = 'Stop'; & { ${command} }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`,
      ],
    };
  }
  return { command: "/bin/sh", args: ["-lc", command] };
}

function spawnShell(command, { platform = process.platform, stdio = "pipe" } = {}) {
  const invocation = shellInvocation(command, platform);
  return spawnSync(invocation.command, invocation.args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
}

function runCheckCommand(command, options = {}) {
  return spawnShell(command, { ...options, stdio: "pipe" });
}

function runMutationCommand(command, options = {}) {
  return spawnShell(command, { ...options, stdio: "inherit" });
}

async function loadPluginCatalog(path = catalogPath, options = {}) {
  let catalog;
  try {
    catalog = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
  return validatePluginCatalog(catalog, options);
}

function usage() {
  return `Usage: node scripts/manage_plugins.mjs <command> <selector> [options]

Commands:
  plan     (--profile <a,b> | --plugin <a,b> | --all)
  install  (--profile <a,b> | --plugin <a,b> | --all) [--yes]
  update   (--profile <a,b> | --plugin <a,b> | --all) [--yes]
  remove   (--profile <a,b> | --plugin <a,b> | --all) [--yes]

Options:
  --profile <a,b>  Select plugins assigned to profiles
  --plugin <a,b>   Select plugins by name
  --all            Select every plugin
  --yes            Execute a displayed install, update, or removal plan
  --help            Show this help`;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const write = dependencies.write ?? console.log;
  try {
    const args = parsePluginArgs(argv);
    if (!args.command || args.command === "help") {
      write(usage());
      return 0;
    }
    const platform = dependencies.platform ?? process.platform;
    const catalog = dependencies.catalog
      ? validatePluginCatalog(dependencies.catalog, { platform })
      : await loadPluginCatalog(catalogPath, { platform });
    const runCheck = dependencies.runCheck ?? ((command) => runCheckCommand(command, { platform }));
    const runMutation = dependencies.runMutation ?? ((command) => runMutationCommand(command, { platform }));

    if (["plan", "install", "update"].includes(args.command)) {
      const update = args.command === "update";
      const plan = await (update ? buildUpdatePlan : buildInstallPlan)(catalog, args, { platform, runCheck });
      write(formatInstallPlan(plan, { update }));
      if (args.command !== "plan") {
        if (!args.yes) write("Repeat with --yes to execute this plan.");
        else await applyInstallPlan(plan, { runMutation });
      }
      return 0;
    }

    const plan = await buildRemovalPlan(catalog, args, { platform, runCheck });
    write(formatRemovalPlan(plan));
    if (!args.yes) write("Repeat with --yes to execute this plan.");
    else await applyRemovalPlan(plan, { runMutation });
    return 0;
  } catch (error) {
    (dependencies.writeError ?? console.error)(`Error: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}

export {
  assertCommandSpec,
  applyInstallPlan,
  applyRemovalPlan,
  buildInstallPlan,
  buildRemovalPlan,
  formatInstallPlan,
  formatRemovalPlan,
  loadPluginCatalog,
  main,
  parsePluginArgs,
  PluginCommandError,
  resolveCommandSpec,
  runCheckCommand,
  runMutationCommand,
  selectPlugins,
  shellInvocation,
  validatePluginCatalog,
};
