import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
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
} from "./manage-skills.mjs";

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

test("current catalog reduces 9 skills to 8 installation batches", async () => {
  const catalog = JSON.parse(await readFile(new URL("../skillset.json", import.meta.url), "utf8"));
  const actions = catalog.skills.flatMap((entry) =>
    entry.names.map((name) => ({ action: "install", skill: { ...entry, name } })),
  );
  const batches = buildInstallBatches(actions, ["codex"]);

  assert.equal(actions.length, 9);
  assert.equal(batches.length, 8);
  assert.equal(batches.find((batch) => batch.package === "mattpocock/skills").names.length, 2);
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

test("selects every configured profile without listing profile names", () => {
  const catalog = {
    defaultProfiles: ["core"],
    profiles: { core: {}, coding: {}, docs: {} },
  };

  assert.deepEqual(selectProfiles(catalog, null, true), ["core", "coding", "docs"]);
  assert.equal(parseArgs(["init", "--all"]).allProfiles, true);
  assert.throws(
    () => parseArgs(["init", "--all", "--profile", "core"]),
    /cannot be combined/,
  );
});

test("excludes Codex system and plugin-cache paths", () => {
  assert.equal(isExcludedInstalledPath("C:\\Users\\me\\.codex\\skills\\.system\\skill-creator"), true);
  assert.equal(isExcludedInstalledPath("C:\\Users\\me\\.codex\\plugins\\cache\\bundle\\skill"), true);
  assert.equal(isExcludedInstalledPath("C:\\Users\\me\\.agents\\skills\\grill-me"), false);
});
