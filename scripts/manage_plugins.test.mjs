import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyInstallPlan,
  applyRemovalPlan,
  buildInstallPlan,
  buildRemovalPlan,
  formatInstallPlan,
  formatRemovalPlan,
  main,
  parsePluginArgs,
  resolveCommandSpec,
  runCheckCommand,
  selectPlugins,
  shellInvocation,
  validatePluginCatalog,
} from "./manage_plugins.mjs";

test("uses PowerShell on Windows and sh elsewhere", () => {
  assert.deepEqual(shellInvocation("echo ready", "win32"), {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference = 'Stop'; & { echo ready }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
    ],
  });
  assert.deepEqual(shellInvocation("echo ready", "linux"), {
    command: "/bin/sh",
    args: ["-lc", "echo ready"],
  });
});

test("PowerShell runner preserves a native command exit status", { skip: process.platform !== "win32" }, () => {
  const result = runCheckCommand("cmd.exe /d /c exit 9", { platform: "win32" });
  assert.equal(result.status, 9, result.stderr);
});

test("PowerShell runner reports PowerShell command failures", { skip: process.platform !== "win32" }, () => {
  const result = runCheckCommand("throw 'expected failure'", { platform: "win32" });
  assert.equal(result.status, 1);
});

test("install without yes prints a plan but performs no mutation", async () => {
  const output = [];
  const mutations = [];
  const exitCode = await main(["install", "--plugin", "gitnexus"], {
    catalog: catalog(),
    platform: "linux",
    runCheck: () => ({ status: 1, stdout: "", stderr: "" }),
    runMutation: (command) => { mutations.push(command); return { status: 0 }; },
    write: (line) => output.push(line),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(mutations, []);
  assert.match(output.join("\n"), /Repeat with --yes to execute/);
});

test("install with yes applies the generated plan", async () => {
  const mutations = [];
  const exitCode = await main(["install", "--plugin", "gitnexus", "--yes"], {
    catalog: catalog(),
    platform: "linux",
    runCheck: () => ({ status: 1, stdout: "", stderr: "" }),
    runMutation: (command) => { mutations.push(command); return { status: 0 }; },
    write: () => {},
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(mutations, [
    "npm install -g gitnexus@latest",
    "gitnexus setup -c codex",
  ]);
});

test("remove with yes runs interactive uninstall commands in order", async () => {
  const mutations = [];
  const exitCode = await main(["remove", "--plugin", "gitnexus", "--yes"], {
    catalog: catalog([plugin({
      reviewed: false,
      uninstallCommands: ["gitnexus uninstall --force", "npm uninstall -g gitnexus"],
    })]),
    platform: "linux",
    runCheck: () => ({ status: 1, stdout: "", stderr: "" }),
    runMutation: (command) => { mutations.push(command); return { status: 0 }; },
    write: () => {},
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(mutations, ["gitnexus uninstall --force", "npm uninstall -g gitnexus"]);
});

test("remove without yes prints a plan but performs no mutation", async () => {
  const output = [];
  const mutations = [];
  const exitCode = await main(["remove", "--plugin", "gitnexus"], {
    catalog: catalog(),
    platform: "linux",
    runCheck: () => ({ status: 0, stdout: "1.6.7", stderr: "" }),
    runMutation: (command) => { mutations.push(command); return { status: 0 }; },
    write: (line) => output.push(line),
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(mutations, []);
  assert.match(output.join("\n"), /Repeat with --yes to execute/);
});

test("malformed catalogs fail before running checks or mutations", async () => {
  const checks = [];
  const mutations = [];
  const exitCode = await main(["install", "--all", "--yes"], {
    catalog: catalog([plugin({ checkCommand: " " })]),
    platform: "linux",
    runCheck: (command) => { checks.push(command); return { status: 0 }; },
    runMutation: (command) => { mutations.push(command); return { status: 0 }; },
    write: () => {},
    writeError: () => {},
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(checks, []);
  assert.deepEqual(mutations, []);
});

test("catalog validation rejects inherited profile names before checks or mutations", async () => {
  const checks = [];
  const mutations = [];
  const errors = [];
  const exitCode = await main(["install", "--all", "--yes"], {
    catalog: catalog([plugin({ profiles: ["toString"] })]),
    platform: "linux",
    runCheck: (command) => { checks.push(command); return { status: 0 }; },
    runMutation: (command) => { mutations.push(command); return { status: 0 }; },
    write: () => {},
    writeError: (line) => errors.push(line),
  });
  assert.equal(exitCode, 1);
  assert.match(errors.join("\n"), /references unknown profile: toString/);
  assert.deepEqual(checks, []);
  assert.deepEqual(mutations, []);
});

test("profile selection rejects inherited names before checks or mutations", async () => {
  const checks = [];
  const mutations = [];
  const errors = [];
  const exitCode = await main(["install", "--profile", "toString", "--yes"], {
    catalog: catalog(),
    platform: "linux",
    runCheck: (command) => { checks.push(command); return { status: 0 }; },
    runMutation: (command) => { mutations.push(command); return { status: 0 }; },
    write: () => {},
    writeError: (line) => errors.push(line),
  });
  assert.equal(exitCode, 1);
  assert.match(errors.join("\n"), /Unknown profile: toString/);
  assert.deepEqual(checks, []);
  assert.deepEqual(mutations, []);
});

test("CLI help succeeds without reading or changing the catalog", () => {
  const scriptPath = fileURLToPath(new URL("./manage_plugins.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /manage_plugins\.mjs/);
  assert.match(result.stdout, /--plugin/);
});

test("installation blocks every mutation when any selected plugin is unreviewed", async () => {
  const calls = [];
  const plan = [
    { name: "safe", reviewed: true, actions: [{ stage: "setup", command: "safe setup" }] },
    { name: "unsafe", reviewed: false, actions: [{ stage: "install", command: "unsafe install" }] },
  ];
  await assert.rejects(
    applyInstallPlan(plan, { runMutation: (command) => calls.push(command) }),
    /Plugin is not reviewed: unsafe/,
  );
  assert.deepEqual(calls, []);
});

test("installation runs commands sequentially", async () => {
  const calls = [];
  const plan = [{
    name: "gitnexus",
    reviewed: true,
    actions: [
      { stage: "install", command: "install gitnexus" },
      { stage: "setup", command: "setup gitnexus" },
    ],
  }];
  await applyInstallPlan(plan, {
    runMutation: async (command) => { calls.push(command); return { status: 0 }; },
  });
  assert.deepEqual(calls, ["install gitnexus", "setup gitnexus"]);
});

test("a failed install prevents setup and later plugins", async () => {
  const calls = [];
  const plan = [
    {
      name: "one",
      reviewed: true,
      actions: [
        { stage: "install", command: "install one" },
        { stage: "setup", command: "setup one" },
      ],
    },
    { name: "two", reviewed: true, actions: [{ stage: "setup", command: "setup two" }] },
  ];
  await assert.rejects(
    applyInstallPlan(plan, {
      runMutation: async (command) => {
        calls.push(command);
        return { status: command === "install one" ? 9 : 0 };
      },
    }),
    /one install failed with exit status 9/,
  );
  assert.deepEqual(calls, ["install one"]);
});

test("a failed setup prevents every later plugin", async () => {
  const calls = [];
  const plan = [
    {
      name: "one",
      reviewed: true,
      actions: [
        { stage: "install", command: "install one" },
        { stage: "setup", command: "setup one" },
      ],
    },
    { name: "two", reviewed: true, actions: [{ stage: "install", command: "install two" }] },
  ];
  await assert.rejects(
    applyInstallPlan(plan, {
      runMutation: async (command) => {
        calls.push(command);
        return { status: command === "setup one" ? 7 : 0 };
      },
    }),
    /one setup failed with exit status 7/,
  );
  assert.deepEqual(calls, ["install one", "setup one"]);
});

test("removal ignores reviewed state and stops after failure", async () => {
  const calls = [];
  const plan = [{
    name: "gitnexus",
    reviewed: false,
    actions: [
      { stage: "uninstall", command: "cleanup integration" },
      { stage: "uninstall", command: "remove npm package" },
    ],
  }];
  await assert.rejects(
    applyRemovalPlan(plan, {
      runMutation: async (command) => {
        calls.push(command);
        return { status: 1 };
      },
    }),
    /gitnexus uninstall failed with exit status 1/,
  );
  assert.deepEqual(calls, ["cleanup integration"]);
});

test("plans install then setup when the CLI check fails", async () => {
  const args = parsePluginArgs(["plan", "--plugin", "gitnexus"]);
  const plan = await buildInstallPlan(catalog(), args, {
    platform: "win32",
    runCheck: () => ({ status: 1, stdout: "", stderr: "not found" }),
  });
  assert.deepEqual(plan[0].actions, [
    { stage: "install", command: "npm install -g gitnexus@latest" },
    { stage: "setup", command: "gitnexus setup -c codex" },
  ]);
});

test("skips installation but still plans setup when the CLI exists", async () => {
  const args = parsePluginArgs(["plan", "--plugin", "gitnexus"]);
  const plan = await buildInstallPlan(catalog(), args, {
    platform: "linux",
    runCheck: () => ({ status: 0, stdout: "1.6.7", stderr: "" }),
  });
  assert.equal(plan[0].installed, true);
  assert.deepEqual(plan[0].actions, [{ stage: "setup", command: "gitnexus setup -c codex" }]);
});

test("removal plans every uninstall command even when the check fails", async () => {
  const input = catalog([plugin({ uninstallCommands: ["gitnexus uninstall --force", "npm uninstall -g gitnexus"] })]);
  const args = parsePluginArgs(["remove", "--plugin", "gitnexus"]);
  const plan = await buildRemovalPlan(input, args, {
    platform: "linux",
    runCheck: () => ({ status: 1, stdout: "", stderr: "not found" }),
  });
  assert.deepEqual(plan[0].actions, [
    { stage: "uninstall", command: "gitnexus uninstall --force" },
    { stage: "uninstall", command: "npm uninstall -g gitnexus" },
  ]);
});

test("formats exact commands and trust state", async () => {
  const input = catalog([plugin({ reviewed: false })]);
  const args = parsePluginArgs(["plan", "--plugin", "gitnexus"]);
  const plan = await buildInstallPlan(input, args, {
    platform: "linux",
    runCheck: () => ({ status: 1, stdout: "", stderr: "" }),
  });
  assert.match(formatInstallPlan(plan), /\[BLOCKED\] gitnexus/);
  assert.match(formatInstallPlan(plan), /INSTALL: npm install -g gitnexus@latest/);
  assert.match(formatInstallPlan(plan), /SETUP: gitnexus setup -c codex/);
});

test("formats removal availability and every uninstall command", async () => {
  const args = parsePluginArgs(["remove", "--plugin", "gitnexus"]);
  const unavailable = await buildRemovalPlan(catalog([plugin({
    uninstallCommands: ["gitnexus uninstall --force", "npm uninstall -g gitnexus"],
  })]), args, {
    platform: "linux",
    runCheck: () => ({ status: 1, stdout: "", stderr: "not found" }),
  });
  assert.equal(formatRemovalPlan(unavailable), [
    "Plugin removal plan:",
    "[REMOVE] gitnexus",
    "  CHECK: gitnexus --version (unavailable)",
    "  UNINSTALL: gitnexus uninstall --force",
    "  UNINSTALL: npm uninstall -g gitnexus",
  ].join("\n"));

  const available = await buildRemovalPlan(catalog(), args, {
    platform: "linux",
    runCheck: () => ({ status: 0, stdout: "1.6.7", stderr: "" }),
  });
  assert.match(formatRemovalPlan(available), /CHECK: gitnexus --version \(available\)/);
});

test("mixed command arrays resolve per platform and skip all installs when available", async () => {
  const input = catalog([plugin({
    installCommand: [{ default: "install-posix", win32: "install-win" }, "download-runtime"],
    setupCommand: ["setup-first", { default: "setup-last" }],
  })]);
  for (const platform of ["win32", "linux", "darwin"]) {
    validatePluginCatalog(input, { platform });
    for (const installed of [false, true]) {
      const plan = await buildInstallPlan(input, parsePluginArgs(["install", "--all"]), {
        platform, runCheck: () => ({ status: installed ? 0 : 1 }),
      });
      const expected = [
        ...(!installed ? [platform === "win32" ? "install-win" : "install-posix", "download-runtime"] : []),
        "setup-first", "setup-last",
      ];
      assert.deepEqual(plan[0].actions.map((action) => action.command), expected);
      const calls = [];
      await applyInstallPlan(plan, { runMutation: async (command) => { calls.push(command); return { status: 0 }; } });
      assert.deepEqual(calls, expected);
    }
  }
});

test("invalid command arrays fail before any checks or mutations", async () => {
  for (const field of ["installCommand", "setupCommand"]) {
    for (const value of [[], ["valid", ""], [["nested"]], [null], [{ linux: "linux-only" }]]) {
      const calls = [];
      const result = await main(["install", "--all", "--yes"], {
        catalog: catalog([plugin({ [field]: value })]), platform: "win32",
        runCheck: () => calls.push("check"), runMutation: () => calls.push("mutation"),
        write: () => {}, writeError: () => {},
      });
      assert.equal(result, 1);
      assert.deepEqual(calls, []);
    }
  }
});

test("failure in either command array stops remaining commands and later plugins", async () => {
  const input = catalog([
    plugin({ installCommand: ["install-1", "install-2", "install-3"], setupCommand: ["setup-1", "setup-2", "setup-3"] }),
    plugin({ name: "later" }),
  ]);
  const plan = await buildInstallPlan(input, parsePluginArgs(["install", "--all"]), {
    platform: "linux", runCheck: () => ({ status: 1 }),
  });
  for (const failure of ["install-2", "setup-2"]) {
    const calls = [];
    await assert.rejects(applyInstallPlan(plan, { runMutation: async (command) => {
      calls.push(command);
      return { status: command === failure ? 9 : 0 };
    } }));
    const commands = plan[0].actions.map((action) => action.command);
    assert.deepEqual(calls, commands.slice(0, commands.indexOf(failure) + 1));
  }
});

test("update previews and executes mixed commands before setup", async () => {
  for (const platform of ["linux", "win32"]) {
    for (const yes of [false, true]) {
      const calls = [], output = [];
      const result = await main(["update", "--all", ...(yes ? ["--yes"] : [])], {
        catalog: catalog([plugin({ updateCommand: [{ default: "upgrade", win32: "upgrade.cmd" }, "finish-update"], setupCommand: ["setup-1", "setup-2"] })]),
        platform, runCheck: () => ({ status: 0 }),
        runMutation: async (command) => { calls.push(command); return { status: 0 }; },
        write: (line) => output.push(line),
      });
      assert.equal(result, 0);
      assert.deepEqual(calls, yes ? [platform === "win32" ? "upgrade.cmd" : "upgrade", "finish-update", "setup-1", "setup-2"] : []);
      assert.match(output.join("\n"), /Plugin update plan:/);
      assert.match(output.join("\n"), /UPDATE: finish-update/);
      assert.doesNotMatch(output.join("\n"), /SKIP INSTALL/);
    }
  }
});

test("update blocks unsupported, unavailable, unreviewed and malformed selections before mutations", async () => {
  for (const overrides of [{ updateCommand: undefined }, { updateCommand: [] }, { updateCommand: [["nested"]] }, { updateCommand: "upgrade", reviewed: false }]) {
    const calls = [];
    const result = await main(["update", "--all", "--yes"], {
      catalog: catalog([plugin({ updateCommand: "first" }), plugin({ name: "second", ...overrides })]),
      runCheck: () => ({ status: 0 }), runMutation: (command) => calls.push(command),
      write: () => {}, writeError: () => {},
    });
    assert.equal(result, 1);
    assert.deepEqual(calls, []);
  }
  const calls = [];
  assert.equal(await main(["update", "--all", "--yes"], {
    catalog: catalog([plugin({ updateCommand: "upgrade" })]), runCheck: () => ({ status: 1 }),
    runMutation: (command) => calls.push(command), write: () => {}, writeError: () => {},
  }), 1);
  assert.deepEqual(calls, []);
  assert.throws(() => parsePluginArgs(["update"]), /requires/);
  assert.throws(() => parsePluginArgs(["update", "--all", "--plugin", "x"]), /mutually exclusive/);
});

test("update failure stops remaining updates, setup and later plugins", async () => {
  for (const failure of ["upgrade-2", "setup-1"]) {
    const calls = [], errors = [];
    const result = await main(["update", "--all", "--yes"], {
      catalog: catalog([plugin({ updateCommand: ["upgrade-1", "upgrade-2", "upgrade-3"], setupCommand: ["setup-1", "setup-2"] }), plugin({ name: "later", updateCommand: "later-update" })]),
      runCheck: () => ({ status: 0 }),
      runMutation: async (command) => { calls.push(command); return { status: command === failure ? 9 : 0 }; },
      write: () => {}, writeError: (message) => errors.push(message),
    });
    assert.equal(result, 1);
    assert.deepEqual(calls, failure === "upgrade-2" ? ["upgrade-1", "upgrade-2"] : ["upgrade-1", "upgrade-2", "upgrade-3", "setup-1"]);
    assert.match(errors.join("\n"), /exit status 9/);
  }
});

test("null optional commands behave like omitted fields", async () => {
  for (const value of [undefined, null]) {
    const input = catalog([plugin({ setupCommand: value, updateCommand: value })]);
    validatePluginCatalog(input);
    const calls = [], errors = [];
    const dependencies = {
      catalog: input, runCheck: () => ({ status: 1 }),
      runMutation: async (command) => { calls.push(command); return { status: 0 }; },
      write: () => {}, writeError: (message) => errors.push(message),
    };
    assert.equal(await main(["install", "--all", "--yes"], dependencies), 0);
    assert.deepEqual(calls, [input.plugins[0].installCommand]);
    calls.length = 0;
    assert.equal(await main(["update", "--all", "--yes"], dependencies), 1);
    assert.match(errors.join("\n"), /has no updateCommand/);
    assert.deepEqual(calls, []);
    input.plugins[0].updateCommand = "upgrade";
    dependencies.runCheck = () => ({ status: 0 });
    assert.equal(await main(["update", "--all", "--yes"], dependencies), 0);
    assert.deepEqual(calls, ["upgrade"]);
  }
});

test("null required commands and null array elements remain invalid", () => {
  for (const field of ["checkCommand", "installCommand", "uninstallCommands"]) {
    assert.throws(() => validatePluginCatalog(catalog([plugin({ [field]: null })])));
  }
  for (const field of ["setupCommand", "updateCommand"]) {
    assert.throws(() => validatePluginCatalog(catalog([plugin({ [field]: [null] })])));
  }
});

function plugin(overrides = {}) {
  return {
    name: "gitnexus",
    profiles: ["coding1"],
    checkCommand: "gitnexus --version",
    installCommand: "npm install -g gitnexus@latest",
    setupCommand: "gitnexus setup -c codex",
    uninstallCommands: ["gitnexus uninstall --force"],
    reviewed: true,
    ...overrides,
  };
}

function catalog(plugins = [plugin()]) {
  return {
    schemaVersion: 1,
    defaultProfiles: ["core"],
    profiles: { core: {}, coding1: {} },
    skills: [],
    plugins,
  };
}

test("resolves the current platform before the default command", () => {
  const spec = { default: "npm install example", win32: "npm.cmd install example" };
  assert.equal(resolveCommandSpec(spec, "win32", "installCommand"), "npm.cmd install example");
  assert.equal(resolveCommandSpec(spec, "linux", "installCommand"), "npm install example");
});

test("rejects a command without a current-platform or default value", () => {
  assert.throws(
    () => resolveCommandSpec({ darwin: "brew install example" }, "win32", "installCommand"),
    /installCommand has no command for platform win32/,
  );
});

test("accepts a valid plugin catalog", () => {
  assert.equal(validatePluginCatalog(catalog(), { platform: "win32" }).plugins.length, 1);
});

test("rejects duplicate plugin names case-insensitively", () => {
  assert.throws(
    () => validatePluginCatalog(catalog([plugin(), plugin({ name: "GitNexus" })])),
    /Duplicate plugin name: GitNexus/,
  );
});

test("rejects unknown profiles and unknown plugin fields", () => {
  assert.throws(
    () => validatePluginCatalog(catalog([plugin({ profiles: ["missing"] })])),
    /references unknown profile: missing/,
  );
  assert.throws(
    () => validatePluginCatalog(catalog([plugin({ arbitraryCommand: "echo unsafe" })])),
    /unknown field: arbitraryCommand/,
  );
});

test("rejects empty command values and invalid uninstall arrays", () => {
  assert.throws(
    () => validatePluginCatalog(catalog([plugin({ checkCommand: " " })])),
    /checkCommand must be a non-empty command string or platform map/,
  );
  assert.throws(
    () => validatePluginCatalog(catalog([plugin({ uninstallCommands: [] })])),
    /uninstallCommands must be a non-empty array/,
  );
});

test("parses and deduplicates comma-separated plugin selectors", () => {
  assert.deepEqual(parsePluginArgs(["plan", "--plugin", "gitnexus,GitNexus"]), {
    command: "plan",
    profiles: null,
    plugins: ["gitnexus"],
    all: false,
    yes: false,
  });
});

test("requires exactly one selector", () => {
  assert.throws(() => parsePluginArgs(["install"]), /requires --profile, --plugin, or --all/);
  assert.throws(
    () => parsePluginArgs(["install", "--profile", "coding1", "--all"]),
    /selectors are mutually exclusive/,
  );
});

test("selects plugin names case-insensitively in catalog order", () => {
  const input = catalog([
    plugin({ name: "gitnexus" }),
    plugin({ name: "codegraph" }),
  ]);
  const args = parsePluginArgs(["plan", "--plugin", "CODEGRAPH,gitnexus"]);
  assert.deepEqual(selectPlugins(input, args).map((entry) => entry.name), ["gitnexus", "codegraph"]);
});

test("selects every plugin attached to any selected profile", () => {
  const input = catalog([
    plugin({ name: "one", profiles: ["coding1"] }),
    plugin({ name: "two", profiles: ["core"] }),
  ]);
  const args = parsePluginArgs(["plan", "--profile", "coding1"]);
  assert.deepEqual(selectPlugins(input, args).map((entry) => entry.name), ["one"]);
});

test("rejects unknown profiles and plugins", () => {
  assert.throws(
    () => selectPlugins(catalog(), parsePluginArgs(["plan", "--profile", "missing"])),
    /Unknown profile: missing/,
  );
  assert.throws(
    () => selectPlugins(catalog(), parsePluginArgs(["plan", "--plugin", "missing"])),
    /Unknown plugin: missing/,
  );
});

test("current catalog defines the approved plugins without project index commands", async () => {
  const current = JSON.parse(await readFile(new URL("../pluginset.json", import.meta.url), "utf8"));
  validatePluginCatalog(current, { platform: "win32" });
  assert.deepEqual(current.plugins.map((entry) => entry.name), [
    "gitnexus",
    "codegraph",
    "codebase-memory-mcp",
  ]);
  assert.deepEqual(current.plugins.map((entry) => entry.profiles), [
    ["coding1"],
    ["coding2"],
    ["coding2"],
  ]);
  assert.equal(Object.hasOwn(current.profiles, "codegraph"), false);
  assert.equal(Object.hasOwn(current.profiles, "codebase-memory"), false);
  assert.deepEqual(
    selectPlugins(current, parsePluginArgs(["plan", "--profile", "coding2"])).map((entry) => entry.name),
    ["codegraph", "codebase-memory-mcp"],
  );
  const serialized = JSON.stringify(current.plugins);
  for (const forbidden of ["gitnexus analyze", "gitnexus clean", "codegraph init", "codegraph uninit"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("codebase-memory removal preserves its interactive prompt before npm removal", async () => {
  const current = JSON.parse(await readFile(new URL("../pluginset.json", import.meta.url), "utf8"));
  for (const [platform, expectedNpmCommand] of [
    ["linux", "npm uninstall -g codebase-memory-mcp"],
    ["darwin", "npm uninstall -g codebase-memory-mcp"],
    ["win32", "npm.cmd uninstall -g codebase-memory-mcp"],
  ]) {
    const plan = await buildRemovalPlan(
      current,
      parsePluginArgs(["remove", "--plugin", "codebase-memory-mcp"]),
      { platform, runCheck: () => ({ status: 0, stdout: "", stderr: "" }) },
    );
    assert.deepEqual(plan[0].actions, [
      { stage: "uninstall", command: "codebase-memory-mcp uninstall" },
      { stage: "uninstall", command: expectedNpmCommand },
    ]);
  }
});

test("documentation routes plugin operations through the separate manager", async () => {
  const paths = [
    new URL("../README.md", import.meta.url),
    new URL("../SKILL.md", import.meta.url),
    new URL("../references/configuration.md", import.meta.url),
    new URL("../references/operations.md", import.meta.url),
  ];
  const documents = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  for (const [index, document] of documents.entries()) {
    assert.match(document, /manage_plugins\.mjs/, paths[index].pathname);
    assert.match(document, /plugins/, paths[index].pathname);
  }
  assert.match(documents[2], /checkCommand/);
  assert.match(documents[2], /uninstallCommands/);
  assert.match(documents[3], /does not manage project indexes|不管理项目索引/i);
});
