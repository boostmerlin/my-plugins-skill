import assert from "node:assert/strict";
import test from "node:test";
import { buildPlan, buildCleanupPlan, buildAuditFindings, executeSkillOperation, parseArgs } from "./manage-skills.mjs";

const entry = (name, profiles, extra = {}) => ({
  package: `owner/${name}`, names: [name], profiles, scope: "global", agents: ["detected"],
  required: false, reviewed: true, ...extra,
});
const installed = (name, extra = {}) => ({ name, scope: "global", agents: ["codex"], ...extra });
function catalog() {
  return {
    schemaVersion: 1, defaultProfiles: ["new"],
    profiles: { new: { exclusiveGroup: "workflow", defaultInExclusiveGroup: true }, old: { exclusiveGroup: "workflow" } },
    skills: [entry("new", ["new"]), entry("old", ["old"])],
  };
}
function dependencies(c, items, runSkills = () => assert.fail("must not mutate")) {
  return { catalog: c, detectActiveAgents: () => ["codex"], listInstalled: () => items, runSkills };
}

test("known source conflicts and protected paths block install, remove and sync before mutation", async () => {
  const conflicts = [
    { source: "other/repository" }, { source: "./personal" }, { sourceType: "local" },
    { source: "owner/old", sourceUrl: "https://github.com/other/repository" },
    { path: "C:/Users/example/.codex/plugins/cache/vendor/skill" },
    { path: "C:/Users/example/.codex/skills/.system/old" },
  ];
  for (const conflict of conflicts) {
    const c = catalog();
    const items = [installed("old", conflict)];
    assert.equal(buildPlan(c, ["old"], items, ["codex"])[0].action, "blocked");
    assert.equal(buildCleanupPlan(c, ["new"], items, ["codex"])[0].action, "blocked");
    const audit = buildAuditFindings(c, ["old"], items, ["codex"]);
    assert.match(audit.drift.join("\n"), /\[(BLOCKED|CONFLICT)\]/);
    assert.doesNotMatch(audit.drift.join("\n"), /\[MISSING\]/);
    const profileAudit = buildAuditFindings(c, ["new"], items, ["codex"], { profileAudit: true });
    assert.match(profileAudit.drift.join("\n"), /\[CONFLICT\] global:old/);
    for (const command of ["install", "remove", "sync"]) {
      const profile = command === "sync" ? "new" : "old";
      const preview = await executeSkillOperation(parseArgs([command, "--profile", profile]), dependencies(c, items));
      assert.equal(preview.preview, true);
      await assert.rejects(() => executeSkillOperation(parseArgs([command, "--profile", profile, "--yes"]), dependencies(c, items)), /blocked/i);
    }
  }
});

test("unknown and equivalent repository sources retain catalog ownership without rewriting install URLs", () => {
  const c = catalog();
  c.skills[1].package = "https://github.com/Owner/Old/tree/main/skills/old";
  for (const source of [undefined, "owner/old", "https://github.com/owner/old.git", "git@github.com:owner/old.git", "ssh://git@github.com/owner/old.git"]) {
    const items = [installed("old", { source })];
    const plan = buildPlan(c, ["old"], items, ["codex"]);
    assert.equal(plan[0].action, "ok", source);
    assert.equal(plan[0].skill.package, c.skills[1].package);
    assert.equal(buildCleanupPlan(c, ["new"], items, ["codex"])[0].action, "remove", source);
  }
});

test("source checks separate scopes but protect shared contents while adding a missing agent link", () => {
  const c = catalog();
  assert.equal(buildPlan(c, ["old"], [installed("old", { scope: "project", source: "other/repo" })], ["codex"])[0].action, "install");
  const otherAgent = installed("old", { agents: ["claude-code"], source: "other/repo" });
  assert.equal(buildPlan(c, ["old"], [otherAgent], ["codex"])[0].action, "blocked");
  assert.deepEqual(buildCleanupPlan(c, ["new"], [otherAgent], ["codex"]), []);
  const items = [installed("old", { source: "owner/old" }), otherAgent];
  assert.equal(buildCleanupPlan(c, ["new"], items, ["codex"])[0].action, "remove");
});

test("entry cleanup also blocks foreign sources before installing its replacement", async () => {
  const c = catalog();
  c.profiles = { new: {} };
  c.skills.forEach((skill, index) => {
    skill.profiles = ["new"]; skill.exclusiveGroup = "alternative";
    if (!index) skill.defaultInExclusiveGroup = true;
  });
  await assert.rejects(() => executeSkillOperation(parseArgs(["sync", "--profile", "new", "--yes"]),
    dependencies(c, [installed("old", { source: "other/repo" })])), /blocked/i);
});

test("installation verification rejects a foreign replacement and preserves the old skill", async () => {
  const c = catalog(), items = [installed("old")], calls = [];
  const result = await executeSkillOperation(parseArgs(["sync", "--profile", "new", "--yes"]), dependencies(c, items, args => {
    calls.push(args[0]);
    items.push(installed("new", { source: "other/repo" }));
    return { status: 0 };
  }));
  assert.equal(result.failed, true);
  assert.deepEqual(calls, ["add"]);
  assert.deepEqual(result.verificationFailures, ["new"]);
});

test("foreign same-name residuals still fail explicit and sync removal verification", async () => {
  for (const command of ["remove", "sync"]) {
    const c = catalog(), items = [installed("new"), installed("old", { source: "owner/old" })];
    const result = await executeSkillOperation(parseArgs([command, "--profile", command === "sync" ? "new" : "old", "--yes"]), dependencies(c, items, () => {
      items[1].source = "other/repo";
      return { status: 0 };
    }));
    assert.equal(result.failed, true);
  }
});

test("an optional local-only replacement blocks profile cleanup and audits the blocked cleanup", async () => {
  const c = catalog(); c.skills[0].package = "./local-new";
  const items = [installed("old")];
  assert.equal(buildCleanupPlan(c, ["new"], items, ["codex"])[0].action, "blocked");
  assert.match(buildAuditFindings(c, ["new"], items, ["codex"], { profileAudit: true }).drift.join("\n"), /\[CONFLICT\] global:old/);
  await assert.rejects(() => executeSkillOperation(parseArgs(["sync", "--profile", "new", "--yes"]), dependencies(c, items)), /local/);
});

test("empty profiles and established remote replacements permit cleanup with optional locals", async () => {
  for (const withReplacement of [false, true]) {
    const c = catalog();
    if (withReplacement) c.skills.push(entry("local", ["new"], { package: "./local" }));
    else c.skills.shift();
    const items = [installed("old"), ...(withReplacement ? [installed("new")] : [])], calls = [];
    const result = await executeSkillOperation(parseArgs(["sync", "--profile", "new", "--yes"]), dependencies(c, items, args => {
      calls.push(args);
      items.splice(items.findIndex(item => item.name === "old"), 1);
      return { status: 0 };
    }));
    assert.equal(result.failed, false);
    assert.deepEqual(calls, [["remove", "old", "--agent", "codex", "--yes", "--global"]]);
  }
});

test("a remote replacement on another agent or in another group cannot justify cleanup", async () => {
  for (const differentGroup of [false, true]) {
    const c = catalog(); c.skills[0].package = "./local";
    const remote = entry("remote", ["new"], { agents: ["claude-code"] });
    if (differentGroup) {
      c.profiles.second = { exclusiveGroup: "second", defaultInExclusiveGroup: true };
      c.profiles.previous = { exclusiveGroup: "second" };
      remote.profiles = ["second"]; remote.agents = ["codex"];
    }
    c.skills.push(remote);
    const profiles = differentGroup ? "new,second" : "new";
    await assert.rejects(() => executeSkillOperation(parseArgs(["sync", "--profile", profiles, "--yes"]),
      dependencies(c, [installed("old"), installed("remote", { agents: remote.agents })])), /local/);
  }
});

test("a local alternative on an agent without the old skill does not block cleanup elsewhere", async () => {
  const c = catalog();
  c.skills[0].agents = ["codex"];
  c.skills.push(entry("local", ["new"], { package: "./local", agents: ["claude-code"] }));
  const items = [installed("new"), installed("old")], calls = [];
  const cleanup = buildCleanupPlan(c, ["new"], items, ["codex", "claude-code"]);
  assert.equal(cleanup[0].action, "remove");
  assert.deepEqual(cleanup[0].agents, ["codex"]);
  const result = await executeSkillOperation(parseArgs(["sync", "--profile", "new", "--yes"]), {
    ...dependencies(c, items, args => { calls.push(args); items.pop(); return { status: 0 }; }),
    detectActiveAgents: () => ["codex", "claude-code"],
  });
  assert.equal(result.failed, false);
  assert.deepEqual(calls, [["remove", "old", "--agent", "codex", "--yes", "--global"]]);
});
