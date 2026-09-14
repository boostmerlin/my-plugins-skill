import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { codebuddyGlobalSkillsMismatch, detectActiveAgents, detectInstalledAgents } from "./agent-detection.mjs";
import { join } from "node:path";
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

function exclusiveCatalog() {
  return {
    schemaVersion: 1,
    profiles: {
      a: { exclusiveGroup: "graphs", defaultInExclusiveGroup: true },
      b: { exclusiveGroup: "graphs" },
      c: { exclusiveGroup: "graphs" },
      core: {},
    },
    plugins: ["a", "b", "c"].map((name) => ({
      name, profiles: [name], reviewed: true,
      checkCommand: `check ${name}`, installCommand: `install ${name}`,
      setupCommand: `setup ${name}`, updateCommand: `update ${name}`,
      uninstallCommands: [`remove ${name}`],
    })),
  };
}

test("install and update allow exclusive plugins together without peer checks or cleanup", async () => {
  for (const command of ["install", "update"]) {
    for (const selector of [["--all"], ["--profile", "a,b,c"], ["--plugin", "a,b,c"]]) {
      for (const yes of [false, true]) {
        const calls = [];
        assert.equal(await main([command, ...selector, ...(yes ? ["--yes"] : [])], {
          catalog: exclusiveCatalog(),
          runCheck: (check) => { calls.push(check); return { status: command === "update" ? 0 : 1 }; },
          runMutation: (mutation) => { calls.push(mutation); return { status: 0 }; },
          write: () => {}, writeError: (error) => assert.fail(error),
        }), 0);
        assert.deepEqual(calls, ["check a", "check b", "check c", ...(yes ? [
          `${command} a`, "setup a", `${command} b`, "setup b", `${command} c`, "setup c",
        ] : [])]);
      }
    }
  }
  const checks = [];
  const plan = await buildInstallPlan(exclusiveCatalog(), parsePluginArgs(["install", "--plugin", "a"]), {
    runCheck: (command) => { checks.push(command); return { status: 0 }; },
  });
  assert.deepEqual(checks, ["check a"]);
  assert.deepEqual(plan.flatMap((item) => item.actions.map((a) => a.command)), ["setup a"]);
});

test("plugin cleanup-only sync requires yes and leaves unrelated profiles alone", async () => {
  const input = exclusiveCatalog();
  input.plugins[0].setupCommand = null;
  input.plugins.push({ ...input.plugins[0], name: "unrelated", profiles: ["core"], checkCommand: "check unrelated" });
  const installed = new Set(["a", "b", "unrelated", "deleted-from-catalog"]), calls = [];
  const dependencies = {
    catalog: input,
    runCheck: (command) => ({ status: installed.has(command.split(" ")[1]) ? 0 : 1 }),
    runMutation: (command) => { calls.push(command); installed.delete(command.split(" ")[1]); return { status: 0 }; },
    write: () => {}, writeError: (error) => assert.fail(error),
  };
  assert.equal(await main(["sync", "--profile", "a"], dependencies), 0);
  assert.deepEqual(calls, []);
  assert.equal(await main(["sync", "--profile", "a", "--yes"], dependencies), 0);
  assert.deepEqual(calls, ["remove b"]);
  assert.deepEqual([...installed], ["a", "unrelated", "deleted-from-catalog"]);
});

test("exclusive plugins reject conflicting selections before checks and allow batch removal", async () => {
  for (const command of ["plan", "sync"]) {
    for (const selector of ["--profile", "--plugin"]) {
      let checks = 0;
      const errors = [];
      assert.equal(await main([command, selector, "a,b", "--yes"], {
        catalog: exclusiveCatalog(), runCheck: () => { checks++; return { status: 0 }; },
        runMutation: () => assert.fail("must not mutate"), write: () => {}, writeError: (error) => errors.push(error),
      }), 1);
      assert.equal(checks, 0);
      assert.match(errors.join("\n"), /exclusive/i);
    }
  }
  assert.deepEqual(selectPlugins(exclusiveCatalog(), parsePluginArgs(["plan", "--all"])).map((p) => p.name), ["a"]);
  assert.equal(selectPlugins(exclusiveCatalog(), parsePluginArgs(["remove", "--all"])).length, 3);
  assert.equal(selectPlugins(exclusiveCatalog(), parsePluginArgs(["remove", "--profile", "a,b"])).length, 2);
});

test("exclusive group validation requires multiple members and exactly one default", () => {
  for (const mutate of [
    (c) => { delete c.profiles.a.defaultInExclusiveGroup; },
    (c) => { c.profiles.b.defaultInExclusiveGroup = true; },
    (c) => { c.profiles.b.exclusiveGroup = "alone"; },
    (c) => { c.profiles.core.defaultInExclusiveGroup = true; },
    (c) => { c.profiles.a.exclusiveGroup = " "; },
  ]) {
    const input = exclusiveCatalog(); mutate(input);
    assert.throws(() => validatePluginCatalog(input), /exclusive/i);
  }
});

test("exclusive switch previews cleanup and verifies new installation before removing old plugins", async () => {
  for (const execute of [false, true]) {
    const installed = new Set(["b", "c"]);
    const events = [], output = [];
    assert.equal(await main(["sync", "--plugin", "a", ...(execute ? ["--yes"] : [])], {
      catalog: exclusiveCatalog(),
      runCheck: (command) => { events.push(command); return { status: installed.has(command.split(" ")[1]) ? 0 : 1 }; },
      runMutation: (command) => {
        events.push(command);
        const [action, name] = command.split(" ");
        if (action === "install") installed.add(name);
        if (action === "remove") installed.delete(name);
        return { status: 0 };
      },
      write: (line) => output.push(line), writeError: (error) => assert.fail(error),
    }), 0);
    assert.match(output.join("\n"), /remove b/);
    assert.match(output.join("\n"), /shared CLI/);
    assert.deepEqual(events, execute
      ? ["check a", "check b", "check c", "install a", "setup a", "check a", "remove b", "check b", "remove c", "check c"]
      : ["check a", "check b", "check c"]);
  }
});

test("exclusive switch stops on failed install, setup, verification or cleanup with progress", async () => {
  for (const failure of ["install a", "setup a", "verify a", "remove b", "verify b"]) {
    const installed = new Set(["b", "c"]), mutations = [], errors = [];
    const code = await main(["sync", "--plugin", "a", "--yes"], {
      catalog: exclusiveCatalog(),
      runCheck: (command) => ({ status: installed.has(command.split(" ")[1]) ? 0 : 1 }),
      runMutation: (command) => {
        mutations.push(command);
        if (command === failure) return { status: 1 };
        if (command === "install a" && failure !== "verify a") installed.add("a");
        if (command === "remove b" && failure !== "verify b") installed.delete("b");
        return { status: 0 };
      }, write: () => {}, writeError: (error) => errors.push(error),
    });
    assert.equal(code, 1, failure);
    assert.ok(!mutations.includes("remove c"), failure);
    if (["install a", "setup a", "verify a"].includes(failure)) assert.ok(!mutations.includes("remove b"));
    assert.match(errors.join("\n"), /Completed:/);
    assert.match(errors.join("\n"), /Pending:/);
  }
});

test("exclusive cleanup preserves shared and unrelated plugins", async () => {
  const input = exclusiveCatalog();
  input.plugins.push(
    { ...input.plugins[1], name: "shared", profiles: ["a", "b"], checkCommand: "check shared" },
    { ...input.plugins[1], name: "ordinary", profiles: ["core", "b"], checkCommand: "check ordinary" },
    { ...input.plugins[1], name: "other-shared", profiles: ["b", "c"], checkCommand: "check other-shared" },
  );
  const checks = [];
  const plan = await buildInstallPlan(input, parsePluginArgs(["plan", "--plugin", "a"]), {
    runCheck: (command) => { checks.push(command); return { status: 0 }; },
  });
  assert.deepEqual(checks, ["check a", "check b", "check c"]);
  assert.deepEqual(plan.filter((item) => item.cleanup).map((item) => item.name), ["b", "c"]);
  assert.deepEqual(selectPlugins(input, parsePluginArgs(["plan", "--plugin", "a,shared"])).map((p) => p.name), ["a", "shared"]);
});

test("exclusive cleanup resolves every mapping before any check", async () => {
  const input = exclusiveCatalog();
  Object.assign(input.plugins[1], { agents: ["codex"], agentMap: { cursor: "cursor" } });
  await assert.rejects(buildInstallPlan(input, parsePluginArgs(["plan", "--plugin", "a"]), {
    runCheck: () => assert.fail("mapping error must precede checks"),
  }), /missing agentMap/);
});

test("exclusive sync of an installed target cleans up conflicts after verification", async () => {
  for (const operation of ["sync"]) {
    const installed = new Set(["a", "b"]), events = [];
    assert.equal(await main([operation, "--plugin", "a", "--yes"], {
      catalog: exclusiveCatalog(),
      runCheck: (command) => { events.push(command); return { status: installed.has(command.split(" ")[1]) ? 0 : 1 }; },
      runMutation: (command) => { events.push(command); if (command === "remove b") installed.delete("b"); return { status: 0 }; },
      write: () => {}, writeError: (error) => assert.fail(error),
    }), 0);
    assert.deepEqual(events, ["check a", "check b", "check c", ...(operation === "update" ? ["update a"] : []), "setup a", "check a", "remove b", "check b"]);
  }
});

test("exclusive cleanup waits for every selected plugin to succeed", async () => {
  const input = exclusiveCatalog();
  input.plugins.push({ ...input.plugins[0], name: "extra", profiles: ["core"], installCommand: "install extra", setupCommand: "setup extra" });
  const mutations = [];
  assert.equal(await main(["sync", "--profile", "a,core", "--yes"], {
    catalog: input, runCheck: (command) => ({ status: command === "check b" ? 0 : 1 }),
    runMutation: (command) => { mutations.push(command); return { status: command === "setup extra" ? 1 : 0 }; },
    write: () => {}, writeError: () => {},
  }), 1);
  assert.deepEqual(mutations, ["install a", "setup a", "install extra", "setup extra"]);
});

test("shared-only selection does not implicitly choose an exclusive profile for cleanup", async () => {
  const input = exclusiveCatalog();
  input.plugins.push({ ...input.plugins[0], name: "shared", profiles: ["a", "b"], checkCommand: "check shared" });
  const checks = [];
  const plan = await buildInstallPlan(input, parsePluginArgs(["plan", "--plugin", "shared"]), {
    runCheck: (command) => { checks.push(command); return { status: 0 }; },
  });
  assert.deepEqual(checks, ["check shared"]);
  assert.deepEqual(plan.map((item) => item.name), ["shared"]);
});

test("exclusive verification execution errors never count as successful removal", async () => {
  for (const failAt of ["target", "cleanup"]) {
    for (const failure of ["throw", "null"]) {
      const mutations = [], errors = [];
      const code = await main(["sync", "--plugin", "a", "--yes"], {
        catalog: exclusiveCatalog(),
        runCheck: (command) => {
          if ((failAt === "target" && command === "check a" && mutations.includes("setup a")) ||
              (failAt === "cleanup" && command === "check b" && mutations.includes("remove b"))) {
            if (failure === "throw") throw new Error("check process failed");
            return { status: null, error: new Error("spawn failed") };
          }
          return { status: command === "check a" && !mutations.includes("install a") ? 1 : 0 };
        },
        runMutation: (command) => { mutations.push(command); return { status: 0 }; },
        write: () => {}, writeError: (error) => errors.push(error),
      });
      assert.equal(code, 1);
      assert.ok(!mutations.includes("remove c"));
      if (failAt === "target") assert.ok(!mutations.includes("remove b"));
      assert.match(errors.join("\n"), /Completed:.*setup a/s);
      assert.match(errors.join("\n"), /Pending:/);
    }
  }
});

test("exclusive switches across groups verify all new plugins before any cleanup", async () => {
  const input = exclusiveCatalog();
  input.profiles.x = { exclusiveGroup: "other", defaultInExclusiveGroup: true };
  input.profiles.y = { exclusiveGroup: "other" };
  for (const name of ["x", "y"]) input.plugins.push({
    ...input.plugins[0], name, profiles: [name], checkCommand: `check ${name}`,
    installCommand: `install ${name}`, setupCommand: `setup ${name}`, uninstallCommands: [`remove ${name}`],
  });
  const installed = new Set(["b", "y"]), events = [];
  assert.equal(await main(["sync", "--all", "--yes"], {
    catalog: input,
    runCheck: (command) => { events.push(command); return { status: installed.has(command.split(" ")[1]) ? 0 : 1 }; },
    runMutation: (command) => {
      events.push(command); const [action, name] = command.split(" ");
      if (action === "install") installed.add(name);
      if (action === "remove") installed.delete(name);
      return { status: 0 };
    }, write: () => {}, writeError: (error) => assert.fail(error),
  }), 0);
  assert.deepEqual(events.slice(5), ["install a", "setup a", "install x", "setup x", "check a", "check x", "remove b", "check b", "remove y", "check y"]);
  assert.deepEqual([...installed], ["a", "x"]);
});

test("batch removal executes every conflicting plugin even without review", async () => {
  const input = exclusiveCatalog();
  input.plugins.forEach((p) => { p.reviewed = false; });
  const mutations = [];
  assert.equal(await main(["remove", "--all", "--yes"], {
    catalog: input, runCheck: () => ({ status: 0 }),
    runMutation: (command) => { mutations.push(command); return { status: 0 }; },
    write: () => {}, writeError: (error) => assert.fail(error),
  }), 0);
  assert.deepEqual(mutations, ["remove a", "remove b", "remove c"]);
});

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

test("shared detector preserves override, environment and runtime precedence", () => {
  assert.deepEqual(detectActiveAgents(["cursor"], { MY_SKILLS_AGENT: "codex" }), ["cursor"]);
  assert.deepEqual(detectActiveAgents(undefined, { MY_SKILLS_AGENT: "codex, claude-code", CLAUDECODE: "1" }), ["codex", "claude-code"]);
  for (const key of ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]) {
    assert.deepEqual(detectActiveAgents(undefined, { [key]: "1" }), ["codex"]);
  }
  assert.deepEqual(detectActiveAgents(undefined, { CLAUDECODE: "1" }), ["claude-code"]);
  assert.throws(() => detectActiveAgents(undefined, {}), /Could not detect/);
  assert.throws(() => detectActiveAgents(undefined, { CODEX_THREAD_ID: "1", CLAUDECODE: "1" }), /ambiguous/);
});

test("WorkBuddy and CodeBuddy markers resolve to the codebuddy agent", () => {
  const workbuddy = {
    WORKBUDDY_APP_NAME: "WorkBuddy",
    WORKBUDDY_PRODUCT_NAME: "WorkBuddy",
    WORKBUDDY_CONFIG_DIR: "C:\\Users\\someone\\.workbuddy",
    WORKBUDDY_USER_DATA_DIR: "C:\\Users\\someone\\.workbuddy\\app",
    WORKBUDDY_IS_PACKAGED: "1",
    CODEBUDDY_CONFIG_DIR: "C:\\Users\\someone\\.workbuddy",
    CODEBUDDY_HOST: "workbuddy-desktop",
    CODEBUDDY_SESSION_ID: "session",
    CLIENT_INFO_PLATFORM: "WorkBuddy",
    CLIENT_INFO_IDE_TYPE: "WorkBuddy",
    CLIENT_INFO_PRODUCT_NAME: "WorkBuddy",
    CLAUDE_SESSION_ID: "shim-session",
    CLAUDE_PROJECT_DIR: "/project",
  };
  // Every marker belongs to the one runtime, so overlapping evidence is not ambiguity.
  assert.deepEqual(detectActiveAgents(undefined, workbuddy), ["codebuddy"]);
  for (const key of ["WORKBUDDY_APP_NAME", "WORKBUDDY_PRODUCT_NAME", "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_USER_DATA_DIR", "WORKBUDDY_IS_PACKAGED", "CODEBUDDY_CONFIG_DIR", "CODEBUDDY_SESSION_ID"]) {
    assert.deepEqual(detectActiveAgents(undefined, { [key]: "1" }), ["codebuddy"], key);
  }
  assert.deepEqual(detectActiveAgents(undefined, { CODEBUDDY_HOST: "workbuddy-desktop" }), ["codebuddy"]);
  for (const key of ["CLIENT_INFO_PLATFORM", "CLIENT_INFO_IDE_TYPE", "CLIENT_INFO_PRODUCT_NAME"]) {
    assert.deepEqual(detectActiveAgents(undefined, { [key]: "WorkBuddy" }), ["codebuddy"], key);
  }
  // WorkBuddy injects Claude Code compatibility variables; they are not activity evidence.
  const shim = { CLAUDE_SESSION_ID: "shim-session", CLAUDE_PROJECT_DIR: "/project" };
  assert.throws(() => detectActiveAgents(undefined, shim), /Could not detect/);
  // Overrides keep precedence and a genuinely different runtime is still ambiguous.
  assert.deepEqual(detectActiveAgents(["codex"], workbuddy), ["codex"]);
  assert.deepEqual(detectActiveAgents(undefined, { ...workbuddy, MY_SKILLS_AGENT: "codex" }), ["codex"]);
  assert.throws(() => detectActiveAgents(undefined, { CODEX_THREAD_ID: "1", CODEBUDDY_SESSION_ID: "1" }), /ambiguous/);
});

test("codebuddy global skills mismatch is reported only when the directories differ", () => {
  const home = join("fake-home", "someone");
  const cliHome = join(home, ".codebuddy");
  assert.equal(codebuddyGlobalSkillsMismatch({}, home), null);
  assert.equal(codebuddyGlobalSkillsMismatch({ CODEBUDDY_CONFIG_DIR: cliHome }, home), null);
  assert.equal(codebuddyGlobalSkillsMismatch({ CODEBUDDY_CONFIG_DIR: ` ${cliHome} ` }, home), null);
  assert.deepEqual(
    codebuddyGlobalSkillsMismatch({ CODEBUDDY_CONFIG_DIR: join(home, ".workbuddy") }, home),
    { runtimeDir: join(home, ".workbuddy", "skills"), cliDir: join(cliHome, "skills") },
  );
});

test("agent options merge and only resolve detected targets", async () => {
  const args = parsePluginArgs(["plan", "--all", "--agent", "codex,claude-code", "--agent", "codex"]);
  assert.deepEqual(args.agents, ["codex", "claude-code"]);
  const input = catalog([plugin({ agents: ["cursor"], agentMap: { cursor: "cursor" }, setupCommand: "setup {agent}" })]);
  const plan = await buildInstallPlan(input, args, { env: {}, runCheck: () => ({ status: 0 }) });
  assert.deepEqual(plan[0].agents, ["cursor"]);
  assert.deepEqual(plan[0].actions, [{ stage: "setup", command: "setup cursor", agent: "cursor" }]);
  for (const value of ["detected", "codex;echo", "a b"]) assert.throws(() => parsePluginArgs(["plan", "--all", "--agent", value]));
});

test("multi-agent execution resolves platform first, preserves command order and deduplicates mapped targets", async () => {
  for (const operation of ["install", "update", "remove"]) {
    for (const yes of [false, true]) {
      const calls = [], output = [];
      const input = catalog([plugin({
        agents: ["detected"], agentMap: { codex: "codex", "claude-code": "claude", alias: "codex" },
        installCommand: "install-once", updateCommand: "update-once",
        setupCommand: [{ default: "setup-posix {agent}", win32: "setup-win {agent}" }, "second {agent}", "shared-setup"],
        uninstallCommands: ["remove {agent}", "remove-cli"],
      })]);
      const result = await main([operation, "--all", "--agent", "codex,claude-code,alias,codex", ...(yes ? ["--yes"] : [])], {
        catalog: input, platform: "win32", env: {}, runCheck: () => ({ status: operation === "install" ? 1 : 0 }),
        runMutation: async (command) => { calls.push(command); return { status: 0 }; }, write: (line) => output.push(line),
      });
      assert.equal(result, 0);
      const expected = operation === "remove" ? ["remove codex", "remove claude", "remove-cli"]
        : [operation === "install" ? "install-once" : "update-once", "setup-win codex", "setup-win claude", "second codex", "second claude", "shared-setup"];
      assert.deepEqual(calls, yes ? expected : []);
      assert.match(output.join("\n"), /AGENTS: codex, claude-code, alias/);
      assert.match(output.join("\n"), /agent: claude-code/);
      if (operation === "remove") assert.match(output.join("\n"), /Full uninstall.*other agents/);
    }
  }
});

test("all agent validation happens before the first selected plugin check", async () => {
  const invalid = [
    { agents: ["detected", "codex"] }, { agents: [] }, { agents: null },
    { agents: ["bad;name"] }, { agents: ["codex"], agentMap: {} },
    { agents: ["codex"], agentMap: [] }, { agents: ["codex"], agentMap: null },
    { agents: ["codex"], agentMap: { codex: "bad;value" } },
    { agents: ["codex"], agentMap: { codex: "" } },
    { agents: ["codex"], agentMap: { other: "other" } },
    { setupCommand: "setup {agent}" }, { checkCommand: "check {agent}" },
    { agents: ["detected"], agentMap: { codex: "codex" } },
  ];
  for (const overrides of invalid) {
    const calls = [];
    assert.equal(await main(["install", "--all", "--yes"], {
      catalog: catalog([plugin(), plugin({ name: "invalid", ...overrides })]), env: {},
      runCheck: () => calls.push("check"), runMutation: () => calls.push("mutation"), write: () => {}, writeError: () => {},
    }), 1, JSON.stringify(overrides));
    assert.deepEqual(calls, []);
  }
});

test("agent command errors identify the target and stop all subsequent work", async () => {
  for (const throws of [false, true]) {
    const calls = [], errors = [];
    assert.equal(await main(["install", "--all", "--yes"], {
      catalog: catalog([plugin({ agents: ["codex", "claude-code"], agentMap: { codex: "codex", "claude-code": "claude" }, setupCommand: ["setup {agent}", "never"] }), plugin({ name: "later" })]),
      env: {}, runCheck: () => ({ status: 0 }), write: () => {}, writeError: (message) => errors.push(message),
      runMutation: async (command) => { calls.push(command); if (command === "setup claude") { if (throws) throw new Error("spawn failed"); return { status: 7 }; } return { status: 0 }; },
    }), 1);
    assert.deepEqual(calls, ["setup codex", "setup claude"]);
    assert.match(errors.join("\n"), /agent: claude-code/);
  }
});

test("detected plugin agents honor environment fallback and explicit override", async () => {
  const input = catalog([plugin({ agents: ["detected"], agentMap: { codex: "codex", "claude-code": "claude" }, setupCommand: "setup {agent}" })]);
  for (const [argv, env, expected] of [
    [[], { MY_SKILLS_AGENT: "codex,codex,claude-code", CLAUDECODE: "1" }, ["codex", "claude-code"]],
    [["--agent", "codex"], { MY_SKILLS_AGENT: "claude-code" }, ["codex"]],
    [[], { CLAUDECODE: "1" }, ["claude-code"]],
  ]) {
    const plan = await buildInstallPlan(input, parsePluginArgs(["plan", "--all", ...argv]), { env, runCheck: () => ({ status: 0 }) });
    assert.deepEqual(plan[0].agents, expected);
  }
});

test("real plugin catalog resolves all Codex targets without leaving placeholders", async () => {
  const current = JSON.parse(await readFile(new URL("../pluginset.json", import.meta.url), "utf8"));
  for (const platform of ["win32", "linux", "darwin"]) {
    const plan = await buildInstallPlan(current, parsePluginArgs(["plan", "--all"]), {
      platform, env: { CODEX_THREAD_ID: "test" }, runCheck: () => ({ status: 1 }),
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].name, "codegraph");
    for (const item of plan) {
      assert.deepEqual(item.agents, ["codex"]);
      assert.ok(item.actions.some((action) => action.stage === "setup" && action.agent === "codex"));
      assert.ok(item.actions.every((action) => !action.command.includes("{agent}")));
    }
  }
});

test("installed discovery respects custom homes, XDG, legacy aliases and returns evidence", () => {
  const home = join(process.cwd(), "fake-home");
  const xdg = join(home, "custom-config");
  const codex = join(home, "custom-codex"), claude = join(home, "custom-claude");
  const present = new Set([codex, join(claude, ".claude.json"), join(xdg, "opencode"), join(home, ".cursor"), join(home, ".clawdbot"), join(home, ".moltbot")]);
  const options = { home, env: { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, XDG_CONFIG_HOME: xdg }, exists: (path) => present.has(path) };
  const result = detectInstalledAgents(options);
  assert.deepEqual(result.map(({ agent }) => agent), ["codex", "claude-code", "cursor", "opencode", "openclaw"]);
  assert.deepEqual(result.find(({ agent }) => agent === "openclaw").paths, [join(home, ".clawdbot"), join(home, ".moltbot")]);
  assert.throws(() => detectActiveAgents(undefined, options.env, options), /Installed candidates.*codex.*cursor/);
  assert.deepEqual(detectActiveAgents(undefined, { ...options.env, CODEX_THREAD_ID: "active" }, options), ["codex"]);
  assert.deepEqual(detectInstalledAgents({ home, env: {}, exists: () => { throw new Error("denied"); } }), []);
  assert.deepEqual(detectInstalledAgents({ home, env: { XDG_CONFIG_HOME: "relative" }, exists: (path) => path === join(home, ".config", "opencode") }).map(({ agent }) => agent), ["opencode"]);
});

test("installed selection is opt-in and never falls back or ignores missing mappings", async () => {
  const home = join(process.cwd(), "fake-home");
  const input = catalog([plugin({ agents: ["detected"], agentMap: { codex: "codex", cursor: "cursor" }, setupCommand: "setup {agent}" })]);
  const discovery = { home, exists: (path) => [join(home, ".codex"), join(home, ".cursor")].includes(path) };
  const calls = [];
  const options = { catalog: input, env: { CODEX_THREAD_ID: "active" }, discovery, runCheck: () => ({ status: 0 }), runMutation: async (command) => { calls.push(command); return { status: 0 }; }, write: () => {}, writeError: () => {} };
  assert.equal(await main(["install", "--all", "--yes"], options), 0);
  assert.deepEqual(calls, ["setup codex"]);
  calls.length = 0;
  assert.equal(await main(["install", "--all", "--detect-installed", "--yes"], options), 0);
  assert.deepEqual(calls, ["setup codex", "setup cursor"]);
  calls.length = 0;
  delete input.plugins[0].agentMap.cursor;
  options.runCheck = () => { calls.push("check"); return { status: 0 }; };
  assert.equal(await main(["install", "--all", "--detect-installed", "--yes"], options), 1);
  assert.deepEqual(calls, []);
  options.discovery = { home, exists: () => false };
  assert.equal(await main(["install", "--all", "--detect-installed", "--yes"], options), 1);
  assert.deepEqual(calls, []);
  assert.throws(() => parsePluginArgs(["plan", "--all", "--agent", "codex", "--detect-installed"]), /mutually exclusive/);
});

function plugin(overrides = {}) {
  return {
    name: "gitnexus",
    profiles: ["mattpocock"],
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
    profiles: { core: {}, mattpocock: {} },
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
    () => parsePluginArgs(["install", "--profile", "mattpocock", "--all"]),
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
    plugin({ name: "one", profiles: ["mattpocock"] }),
    plugin({ name: "two", profiles: ["core"] }),
  ]);
  const args = parsePluginArgs(["plan", "--profile", "mattpocock"]);
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
    ["gitnexus"],
    ["codegraph"],
    ["codebase-memory-mcp"],
  ]);
  assert.equal(current.profiles.codegraph.exclusiveGroup, "codegraph");
  assert.equal(current.profiles.codegraph.defaultInExclusiveGroup, true);
  assert.equal(Object.hasOwn(current.profiles, "codebase-memory"), false);
  assert.deepEqual(
    selectPlugins(current, parsePluginArgs(["plan", "--profile", "superpowers,codegraph"])).map((entry) => entry.name),
    ["codegraph"],
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
      parsePluginArgs(["remove", "--plugin", "codebase-memory-mcp", "--agent", "codex"]),
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
