import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applySyncPlan,
  assessProvenance,
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
} from "./manage-skills.mjs";

function catalogWithProfiles(profiles, defaultProfiles = [Object.keys(profiles)[0]]) {
  return {
    schemaVersion: 1,
    defaultProfiles,
    profiles,
    skills: [],
  };
}

function action(name, overrides = {}) {
  return {
    action: "install",
    skill: {
      package: "owner/repository",
      name,
      scope: "global",
      agents: ["detected"],
      required: false,
      ...overrides,
    },
  };
}

test("groups compatible missing skills into one CLI call", () => {
  const batches = buildInstallBatches([action("alpha"), action("beta")], ["codex"]);

  assert.deepEqual(batches, [
    {
      package: "owner/repository",
      names: ["alpha", "beta"],
      scope: "global",
      agents: ["codex"],
      required: false,
    },
  ]);
  assert.deepEqual(installArgs(batches[0]), [
    "add",
    "owner/repository",
    "--skill",
    "alpha",
    "beta",
    "--agent",
    "codex",
    "--yes",
    "--global",
  ]);
});

test("keeps different scope and required policies in separate batches", () => {
  const batches = buildInstallBatches(
    [
      action("optional"),
      action("required", { required: true }),
      action("project", { scope: "project" }),
    ],
    ["codex"],
  );

  assert.equal(batches.length, 3);
});

test("uses the same local-path recognition rules as Skills CLI", () => {
  for (const source of [".", "..", "./skills", "../skills", "C:\\skills\\example", "D:/skills/example"]) {
    assert.equal(isLocalSource(source), true, source);
  }
  for (const source of ["owner/repository", "skills/example", "https://github.com/owner/repository.git"]) {
    assert.equal(isLocalSource(source), false, source);
  }
});

test("plans local sources as skipped without requiring review or installation", () => {
  const catalog = {
    profiles: { local: {} },
    skills: [
      {
        package: "./local-skills",
        names: ["local-only"],
        profiles: ["local"],
        scope: "global",
        agents: ["detected"],
        required: true,
        reviewed: false,
      },
    ],
  };

  assert.deepEqual(buildPlan(catalog, ["local"], [], []), [
    {
      skill: { ...catalog.skills[0], name: "local-only" },
      action: "skip",
      reason: "local source is not portable: ./local-skills",
    },
  ]);
});

test("current catalog groups each multi-skill source into one installation batch", async () => {
  const catalog = JSON.parse(await readFile(new URL("../skillset.json", import.meta.url), "utf8"));
  const actions = catalog.skills.flatMap((entry) =>
    entry.names.map((name) => ({ action: "install", skill: { ...entry, name } })),
  );
  const batches = buildInstallBatches(actions, ["codex"]);

  assert.ok(batches.length < actions.length);
  assert.equal(batches.find((batch) => batch.package === "mattpocock/skills").names.length, 2);
  assert.equal(batches.find((batch) => batch.package === "obra/superpowers").names.length, 14);
});

test("normalizes common GitHub source forms to one identity", () => {
  const sources = [
    "mattpocock/skills",
    "https://github.com/mattpocock/skills",
    "https://github.com/mattpocock/skills.git",
    "git@github.com:mattpocock/skills.git",
  ];
  assert.deepEqual(sources.map((source) => normalizeSource(source).id), [
    "github:mattpocock/skills",
    "github:mattpocock/skills",
    "github:mattpocock/skills",
    "github:mattpocock/skills",
  ]);
});

test("confirms matching CLI and lock evidence", () => {
  const result = assessProvenance(
    {
      name: "grill-me",
      scope: "global",
      path: "C:\\Users\\example\\.agents\\skills\\grill-me",
      source: "mattpocock/skills",
      sourceUrl: "https://github.com/mattpocock/skills.git",
      sourceType: "github",
    },
    {
      source: "https://github.com/mattpocock/skills",
      sourceUrl: "git@github.com:mattpocock/skills.git",
      sourceType: "github",
      skillPath: "skills/productivity/grill-me/SKILL.md",
    },
  );

  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.source, "mattpocock/skills");
  assert.equal(result.skillPath, "skills/productivity/grill-me/SKILL.md");
  assert.deepEqual(result.conflicts, []);
});

test("downgrades conflicting source evidence to candidate", () => {
  const result = assessProvenance(
    { name: "same-name", scope: "global", source: "owner/one", sourceUrl: null },
    { source: "owner/two", sourceUrl: null },
  );

  assert.equal(result.status, "CANDIDATE");
  assert.match(result.conflicts.join("\n"), /disagrees/);
});

test("uses independent Git or remote evidence for verified status", () => {
  const entry = { name: "example", scope: "project", source: "owner/repository", sourceUrl: null };
  const git = {
    kind: "git",
    source: "git@github.com:owner/repository.git",
    sourceUrl: "git@github.com:owner/repository.git",
    normalized: "owner/repository",
    normalizedId: "github:owner/repository",
    type: "github",
    skillPath: "skills/example/SKILL.md",
  };
  const result = assessProvenance(entry, null, git);

  assert.equal(result.status, "VERIFIED");
  assert.equal(result.scope, "project");
});

test("classifies local and unknown sources without guessing", () => {
  assert.equal(
    assessProvenance({ name: "local", scope: "global", source: "./skills/local", sourceUrl: null }, null).status,
    "LOCAL",
  );
  assert.equal(
    assessProvenance({ name: "unknown", scope: "global", source: null, sourceUrl: null }, null).status,
    "UNKNOWN",
  );
});

test("keeps same-named skills separated by scope", () => {
  const globalResult = assessProvenance(
    { name: "shared", scope: "global", source: "owner/repository", sourceUrl: null },
    null,
  );
  const projectResult = assessProvenance(
    { name: "shared", scope: "project", source: "owner/repository", sourceUrl: null },
    null,
  );

  assert.equal(globalResult.scope, "global");
  assert.equal(projectResult.scope, "project");
});

test("reads known lock fields from unfamiliar versions", () => {
  const parsed = parseSkillLock(JSON.stringify({
    version: 99,
    skills: { Example: { source: "owner/repository", futureField: true } },
    futureTopLevel: true,
  }), "global");

  assert.equal(parsed.entries.get("example").source, "owner/repository");
  assert.match(parsed.warning, /version 99/);
  assert.throws(() => parseSkillLock("not json", "global"), SyntaxError);
});

test("treats a missing lock as optional and a corrupt lock as a diagnostic", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "my-skills-lock-"));
  try {
    const missing = await loadSkillLock("project", { projectDirectory: temporary });
    assert.equal(missing.error, null);
    assert.equal(missing.entries.size, 0);

    await writeFile(join(temporary, "skills-lock.json"), "not json");
    const corrupt = await loadSkillLock("project", { projectDirectory: temporary });
    assert.match(corrupt.error, /Cannot read/);
    assert.equal(corrupt.entries.size, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("resolves a linked skill to its Git origin", async (context) => {
  if (!spawnSync("git", ["--version"], { encoding: "utf8" }).stdout) context.skip("git unavailable");
  const temporary = await mkdtemp(join(tmpdir(), "my-skills-git-"));
  try {
    const repository = join(temporary, "repository");
    const skill = join(repository, "skills", "example");
    const link = join(temporary, "installed-example");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: example\ndescription: Test\n---\n");
    assert.equal(spawnSync("git", ["init", repository], { encoding: "utf8" }).status, 0);
    assert.equal(
      spawnSync("git", ["-C", repository, "remote", "add", "origin", "git@github.com:owner/repository.git"], { encoding: "utf8" }).status,
      0,
    );
    await symlink(skill, link, process.platform === "win32" ? "junction" : "dir");

    const result = await inspectGitProvenance(link);
    assert.equal(result.error, null);
    assert.equal(result.evidence.normalized, "owner/repository");
    assert.equal(result.evidence.skillPath, "skills/example/SKILL.md");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("parses remote listings after stripping terminal control sequences", () => {
  const output = "\u001b[32m|\u001b[0m    grill-me\n|      Description\n";
  assert.equal(remoteListContainsSkill(output, "grill-me"), true);
  assert.equal(remoteListContainsSkill(output, "grilling"), false);
});

test("sources stays offline unless remote verification is explicit", () => {
  assert.equal(parseArgs(["sources", "grill-me"]).verifyRemote, false);
  assert.equal(parseArgs(["sources", "grill-me", "--verify-remote"]).verifyRemote, true);
});

test("selects every compatible profile without listing profile names", () => {
  const catalog = {
    defaultProfiles: ["core"],
    profiles: { core: {}, coding: {}, docs: {} },
  };

  assert.deepEqual(selectProfiles(catalog, null, true), ["core", "coding", "docs"]);
  assert.equal(parseArgs(["sync", "--all"]).allProfiles, true);
  assert.throws(
    () => parseArgs(["sync", "--all", "--profile", "core"]),
    /cannot be combined/,
  );
});

test("merges and stably deduplicates repeated profile options", () => {
  assert.deepEqual(
    parseArgs(["sync", "--profile", "core,coding", "--profile", "coding,docs"]).profiles,
    ["core", "coding", "docs"],
  );
});

test("plans cleanup only for installed skills exclusive to displaced profiles", () => {
  const catalog = validateCatalog({
    ...catalogWithProfiles({
      core: {},
      coding1: { exclusiveGroup: "coding", defaultInExclusiveGroup: true },
      coding2: { exclusiveGroup: "coding" },
      docs: {},
    }),
    skills: [
      { package: "owner/old", names: ["old-only"], profiles: ["coding1"], scope: "global", agents: ["detected"], required: false, reviewed: true },
      { package: "owner/shared", names: ["shared"], profiles: ["coding1", "coding2"], scope: "global", agents: ["detected"], required: false, reviewed: true },
      { package: "owner/cross", names: ["cross-profile"], profiles: ["coding1", "docs"], scope: "global", agents: ["detected"], required: false, reviewed: true },
      { package: "./local", names: ["local-old"], profiles: ["coding1"], scope: "global", agents: ["detected"], required: false, reviewed: true },
      { package: "owner/new", names: ["new-only"], profiles: ["coding2"], scope: "global", agents: ["detected"], required: false, reviewed: true },
    ],
  });
  const installed = [
    { name: "old-only", scope: "global", agents: ["Codex"] },
    { name: "shared", scope: "global", agents: ["Codex"] },
    { name: "cross-profile", scope: "global", agents: ["Codex"] },
    { name: "local-old", scope: "global", agents: ["Codex"] },
    { name: "unmanaged", scope: "global", agents: ["Codex"] },
  ];

  assert.deepEqual(
    buildCleanupPlan(catalog, ["coding2"], installed, ["codex"]).map((item) => [item.skill.name, item.action]),
    [
      ["old-only", "remove"],
      ["shared", "keep"],
      ["cross-profile", "keep"],
      ["local-old", "skip"],
    ],
  );
});

test("cleanup targets only the requested agent and activated exclusive groups", () => {
  const catalog = validateCatalog({
    ...catalogWithProfiles({
      coding1: { exclusiveGroup: "coding", defaultInExclusiveGroup: true },
      coding2: { exclusiveGroup: "coding" },
      docs: {},
    }),
    skills: [
      { package: "owner/old", names: ["old-only"], profiles: ["coding1"], scope: "global", agents: ["detected"], required: false, reviewed: true },
    ],
  });

  assert.deepEqual(buildCleanupPlan(catalog, ["coding2"], [
    { name: "old-only", scope: "global", agents: ["Claude Code"] },
  ], ["codex"]), []);
  assert.deepEqual(buildCleanupPlan(catalog, ["docs"], [
    { name: "old-only", scope: "global", agents: ["Codex"] },
  ], ["codex"]), []);
});

test("cleanup handles multiple groups and every displaced member in a larger group", () => {
  const catalog = validateCatalog({
    ...catalogWithProfiles({
      coding1: { exclusiveGroup: "coding", defaultInExclusiveGroup: true },
      coding2: { exclusiveGroup: "coding" },
      coding3: { exclusiveGroup: "coding" },
      docs1: { exclusiveGroup: "docs", defaultInExclusiveGroup: true },
      docs2: { exclusiveGroup: "docs" },
    }),
    skills: [
      { package: "owner/one", names: ["one"], profiles: ["coding1"], scope: "global", agents: ["detected"], required: false, reviewed: true },
      { package: "owner/three", names: ["three"], profiles: ["coding3"], scope: "global", agents: ["detected"], required: false, reviewed: true },
      { package: "owner/docs", names: ["old-docs"], profiles: ["docs1"], scope: "global", agents: ["detected"], required: false, reviewed: true },
    ],
  });
  const installed = ["one", "three", "old-docs"].map((name) => ({ name, scope: "global", agents: ["Codex"] }));

  assert.deepEqual(
    buildCleanupPlan(catalog, ["coding2", "docs2"], installed, ["codex"])
      .filter((item) => item.action === "remove")
      .map((item) => item.skill.name),
    ["one", "three", "old-docs"],
  );
});

test("groups removals by scope and builds agent-scoped CLI arguments", () => {
  const removals = [
    { action: "remove", skill: { name: "global-a", scope: "global" } },
    { action: "remove", skill: { name: "global-b", scope: "global" } },
    { action: "remove", skill: { name: "project-a", scope: "project" } },
  ];
  const batches = buildRemovalBatches(removals, ["codex"]);

  assert.deepEqual(batches, [
    { names: ["global-a", "global-b"], scope: "global", agents: ["codex"] },
    { names: ["project-a"], scope: "project", agents: ["codex"] },
  ]);
  assert.deepEqual(removeArgs(batches[0]), [
    "remove", "global-a", "global-b", "--agent", "codex", "--yes", "--global",
  ]);
  assert.deepEqual(removeArgs(batches[1]), [
    "remove", "project-a", "--agent", "codex", "--yes",
  ]);
});

test("skips cleanup when an optional installation fails", async () => {
  const calls = [];
  const result = await applySyncPlan({
    profiles: ["coding2"],
    plan: [action("new-skill")],
    cleanupPlan: [{ action: "remove", skill: { name: "old-skill", scope: "global" } }],
    detectedAgents: ["codex"],
    cleanupAgents: ["codex"],
  }, { yes: true }, {
    runSkills(args) {
      calls.push(args);
      return { status: 1, stdout: "", stderr: "" };
    },
    listInstalled() {
      throw new Error("cleanup verification must not run");
    },
  });

  assert.equal(result.failed, true);
  assert.deepEqual(calls.map((args) => args[0]), ["add"]);
});

test("aborts cleanup when a required installation fails", async () => {
  const calls = [];
  await assert.rejects(() => applySyncPlan({
    profiles: ["coding2"],
    plan: [action("required-new", { required: true })],
    cleanupPlan: [{ action: "remove", skill: { name: "old-skill", scope: "global" } }],
    detectedAgents: ["codex"],
    cleanupAgents: ["codex"],
  }, { yes: true }, {
    runSkills(args) {
      calls.push(args);
      return { status: 1, stdout: "", stderr: "" };
    },
  }), /Required skills failed/);

  assert.deepEqual(calls.map((args) => args[0]), ["add"]);
});

test("fails sync when cleanup verification finds a residual agent link", async () => {
  const calls = [];
  const result = await applySyncPlan({
    profiles: ["coding2"],
    plan: [],
    cleanupPlan: [{ action: "remove", skill: { name: "old-skill", scope: "global" } }],
    detectedAgents: ["codex"],
    cleanupAgents: ["codex"],
  }, { yes: false }, {
    runSkills(args) {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
    listInstalled() {
      return [{ name: "old-skill", scope: "global", agents: ["Codex"] }];
    },
  });

  assert.equal(result.failed, true);
  assert.equal(result.residual.length, 1);
  assert.deepEqual(calls.map((args) => args[0]), ["remove"]);
});

test("completes cleanup when post-removal verification is clear", async () => {
  const result = await applySyncPlan({
    profiles: ["coding2"],
    plan: [],
    cleanupPlan: [{ action: "remove", skill: { name: "old-skill", scope: "global" } }],
    detectedAgents: ["codex"],
    cleanupAgents: ["codex"],
  }, { yes: false }, {
    runSkills() {
      return { status: 0, stdout: "", stderr: "" };
    },
    listInstalled() {
      return [];
    },
  });

  assert.equal(result.failed, false);
  assert.deepEqual(result.residual, []);
});

test("profile audit distinguishes missing, conflicting, managed, and unmanaged skills", () => {
  const catalog = validateCatalog({
    ...catalogWithProfiles({
      core: {},
      coding1: { exclusiveGroup: "coding", defaultInExclusiveGroup: true },
      coding2: { exclusiveGroup: "coding" },
    }),
    skills: [
      { package: "owner/core", names: ["core-skill"], profiles: ["core"], scope: "global", agents: ["detected"], required: false, reviewed: true },
      { package: "owner/old", names: ["old-skill"], profiles: ["coding1"], scope: "global", agents: ["detected"], required: false, reviewed: true },
      { package: "owner/new", names: ["new-skill"], profiles: ["coding2"], scope: "global", agents: ["detected"], required: false, reviewed: true },
    ],
  });
  const { drift } = buildAuditFindings(catalog, ["coding2"], [
    { name: "core-skill", scope: "global", agents: ["Codex"] },
    { name: "old-skill", scope: "global", agents: ["Codex"] },
    { name: "outside", scope: "global", agents: ["Codex"] },
  ], ["codex"], { profileAudit: true });

  assert.equal(drift.some((line) => line.includes("[MISSING] global:new-skill")), true);
  assert.equal(drift.some((line) => line.includes("[CONFLICT] global:old-skill")), true);
  assert.equal(drift.some((line) => line.includes("[UNMANAGED] global:outside")), true);
  assert.equal(drift.some((line) => line.includes("core-skill")), false);
});

test("init is no longer an executable command", () => {
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "manage-skills.mjs"), "init"], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: init/);
});

test("skill metadata and README prompts route environment changes through sync", async () => {
  const repositoryRoot = join(import.meta.dirname, "..");
  const [readme, skill, operations, metadata] = await Promise.all([
    readFile(join(repositoryRoot, "README.md"), "utf8"),
    readFile(join(repositoryRoot, "SKILL.md"), "utf8"),
    readFile(join(repositoryRoot, "references", "operations.md"), "utf8"),
    readFile(join(repositoryRoot, "agents", "openai.yaml"), "utf8"),
  ]);

  assert.doesNotMatch(`${readme}\n${skill}\n${operations}`, /manage-skills\.mjs init/);
  assert.match(readme, /使用 \$my-skills-skill 初始化我的 Skill。/);
  assert.match(readme, /使用 \$my-skills-skill 同步我的 Skill。/);
  assert.match(readme, /“更新”只升级已安装受管 Skill 的版本，不执行 Profile 同步/);
  assert.match(skill, /initialize my skills.*sync my skills.*environment sync/);
  assert.match(skill, /update my skills.*version updates only/);
  assert.match(metadata, /default_prompt: .*sync my environment to the default profiles/);
});

test("validates exclusive groups and their single defaults", () => {
  const catalog = catalogWithProfiles({
    core: {},
    "coding-a": { exclusiveGroup: " coding ", defaultInExclusiveGroup: true },
    "coding-b": { exclusiveGroup: "coding" },
  });

  assert.equal(validateCatalog(catalog), catalog);
  assert.equal(catalog.profiles["coding-a"].exclusiveGroup, "coding");

  assert.throws(
    () => validateCatalog(catalogWithProfiles({ only: { exclusiveGroup: "coding", defaultInExclusiveGroup: true } })),
    /at least two profiles/,
  );
  assert.throws(
    () => validateCatalog(catalogWithProfiles({
      a: { exclusiveGroup: "coding" },
      b: { exclusiveGroup: "coding" },
    })),
    /exactly one/,
  );
  assert.throws(
    () => validateCatalog(catalogWithProfiles({
      a: { exclusiveGroup: "coding", defaultInExclusiveGroup: true },
      b: { exclusiveGroup: "coding", defaultInExclusiveGroup: true },
    })),
    /exactly one/,
  );
  assert.throws(
    () => validateCatalog(catalogWithProfiles({ a: { defaultInExclusiveGroup: true } })),
    /requires exclusiveGroup/,
  );
  assert.throws(
    () => validateCatalog(catalogWithProfiles({ a: { defaultInExclusiveGroup: false } })),
    /requires exclusiveGroup/,
  );
});

test("rejects conflicting default profiles", () => {
  const catalog = catalogWithProfiles({
    "coding-a": { exclusiveGroup: "coding", defaultInExclusiveGroup: true },
    "coding-b": { exclusiveGroup: "coding" },
  }, ["coding-a", "coding-b"]);

  assert.throws(() => validateCatalog(catalog), /defaultProfiles conflict.*coding: coding-a, coding-b/);
});

test("allows defaultProfiles to choose a non-default exclusive variant", () => {
  const catalog = validateCatalog(catalogWithProfiles({
    "coding-a": { exclusiveGroup: "coding", defaultInExclusiveGroup: true },
    "coding-b": { exclusiveGroup: "coding" },
  }, ["coding-b"]));

  assert.deepEqual(selectProfiles(catalog), ["coding-b"]);
});

test("uses exclusive-group defaults for plan and sync selections", () => {
  const catalog = validateCatalog(catalogWithProfiles({
    core: {},
    "coding-a": { exclusiveGroup: "coding", defaultInExclusiveGroup: true },
    "coding-b": { exclusiveGroup: "coding" },
    docs: {},
  }));

  assert.deepEqual(selectProfiles(catalog, null, true), ["core", "coding-a", "docs"]);
  assert.deepEqual(selectProfiles(catalog, ["coding-b", "coding-b"]), ["coding-b"]);
  assert.throws(
    () => selectProfiles(catalog, ["coding-a", "coding-b"]),
    /exclusive groups.*coding: coding-a, coding-b/,
  );
});

test("reports every conflicting exclusive group", () => {
  const catalog = validateCatalog(catalogWithProfiles({
    "coding-a": { exclusiveGroup: "coding", defaultInExclusiveGroup: true },
    "coding-b": { exclusiveGroup: "coding" },
    "docs-a": { exclusiveGroup: "docs", defaultInExclusiveGroup: true },
    "docs-b": { exclusiveGroup: "docs" },
  }));

  assert.throws(
    () => selectProfiles(catalog, ["coding-a", "coding-b", "docs-a", "docs-b"]),
    /coding: coding-a, coding-b; docs: docs-a, docs-b/,
  );
});

test("allows audit selections to include every exclusive profile", () => {
  const catalog = validateCatalog(catalogWithProfiles({
    core: {},
    "coding-a": { exclusiveGroup: "coding", defaultInExclusiveGroup: true },
    "coding-b": { exclusiveGroup: "coding" },
  }));

  assert.deepEqual(
    selectProfiles(catalog, null, true, { allowConflicts: true }),
    ["core", "coding-a", "coding-b"],
  );
  assert.deepEqual(
    selectProfiles(catalog, ["coding-a", "coding-b"], false, { allowConflicts: true }),
    ["coding-a", "coding-b"],
  );
});

test("excludes Codex system and plugin-cache paths", () => {
  assert.equal(isExcludedInstalledPath("C:\\Users\\me\\.codex\\skills\\.system\\skill-creator"), true);
  assert.equal(isExcludedInstalledPath("C:\\Users\\me\\.codex\\plugins\\cache\\bundle\\skill"), true);
  assert.equal(isExcludedInstalledPath("C:\\Users\\me\\.agents\\skills\\grill-me"), false);
});
