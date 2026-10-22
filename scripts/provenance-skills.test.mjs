import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { assessProvenance, inspectGitProvenance } from "./manage-skills.mjs";

const gitAvailable = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;

function git(repository, ...args) {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
}

async function withRepository(inspect) {
  const temporaryRoot = await realpath(tmpdir());
  const temporary = await mkdtemp(join(temporaryRoot, "my-skills-provenance-"));
  try {
    git(temporary, "init");
    git(temporary, "remote", "add", "origin", "git@github.com:owner/project.git");
    await inspect(temporary);
  } finally {
    const resolved = await realpath(temporary);
    assert.equal(dirname(resolved), temporaryRoot);
    assert.ok(basename(resolved).startsWith("my-skills-provenance-"));
    await rm(resolved, { recursive: true, force: true });
  }
}

async function writeSkill(repository, directory) {
  const skill = join(repository, directory);
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: example\ndescription: Test\n---\n");
  return skill;
}

test("untracked nested skills do not inherit the enclosing repository's origin", { skip: !gitAvailable }, async () => {
  await withRepository(async (repository) => {
    const skill = await writeSkill(repository, ".agents/skills/example");
    const result = await inspectGitProvenance(skill);
    assert.deepEqual(result, { evidence: null, error: null });
    assert.equal(assessProvenance({ name: "example", scope: "project", path: skill }, null, result.evidence).status, "UNKNOWN");
  });
});

test("an unrelated enclosing repository does not contradict matching CLI and lock evidence", { skip: !gitAvailable }, async () => {
  await withRepository(async (repository) => {
    const skill = await writeSkill(repository, ".agents/skills/example");
    const inspected = await inspectGitProvenance(skill);
    const result = assessProvenance(
      { name: "example", scope: "project", path: skill, source: "owner/skills" },
      { source: "owner/skills" },
      inspected.evidence,
    );
    assert.equal(result.status, "CONFIRMED");
    assert.deepEqual(result.conflicts, []);
  });
});

test("a tracked SKILL.md supplies repository provenance without requiring a commit", { skip: !gitAvailable }, async () => {
  await withRepository(async (repository) => {
    const skill = await writeSkill(repository, "skills/example");
    git(repository, "add", "--", "skills/example/SKILL.md");
    const result = await inspectGitProvenance(skill);
    assert.equal(result.error, null);
    assert.equal(result.evidence.normalized, "owner/project");
    assert.equal(result.evidence.skillPath, "skills/example/SKILL.md");
  });
});

test("tracking checks treat bracketed skill paths literally", { skip: !gitAvailable }, async () => {
  await withRepository(async (repository) => {
    await writeSkill(repository, "skills/t");
    git(repository, "add", "--", "skills/t/SKILL.md");
    const skill = await writeSkill(repository, "skills/[tool]");
    assert.deepEqual(await inspectGitProvenance(skill), { evidence: null, error: null });

    git(repository, "--literal-pathspecs", "add", "--", "skills/[tool]/SKILL.md");
    const result = await inspectGitProvenance(skill);
    assert.equal(result.error, null);
    assert.equal(result.evidence.skillPath, "skills/[tool]/SKILL.md");
  });
});
