# Catalog configuration

`skillset.json` is the version-controlled source of truth. Never add generated paths, credentials, system Skills, or plugin-cache Skills.

```json
{
  "schemaVersion": 1,
  "defaultProfiles": ["core"],
  "profiles": {
    "core": { "description": "Skills installed everywhere" },
    "coding-a": {
      "description": "Coding toolset A",
      "exclusiveGroup": "coding",
      "defaultInExclusiveGroup": true
    },
    "coding-b": {
      "description": "Coding toolset B",
      "exclusiveGroup": "coding"
    }
  },
  "skills": [{
    "package": "owner/repository",
    "names": ["example-skill-1", "example-skill-2"],
    "profiles": ["core"],
    "scope": "global",
    "agents": ["detected"],
    "required": true,
    "reviewed": true
  }]
}
```

## Rules

- `schemaVersion` is `1`; every default/referenced profile must exist.
- Profiles with the same non-empty, case-sensitive `exclusiveGroup` are mutually exclusive for `plan`, `sync`, and explicit-profile audit; surrounding whitespace is ignored. A group must contain at least two profiles and exactly one must set `defaultInExclusiveGroup: true`.
- `defaultInExclusiveGroup` requires `exclusiveGroup`. It is used by `plan --all` and `sync --all`; it does not implicitly add a profile to ordinary selections or to `defaultProfiles`.
- `defaultProfiles` may name a non-default member of an exclusive group, but it must not contain more than one member of the same group.
- `package` is a Skills CLI source: preferably `owner/repository`/trusted Git URL, or an explicitly path-shaped local source.
- `names`, `profiles`, and `agents` are non-empty arrays. A name is unique per scope; combine profiles instead of duplicating it.
- `scope` is `global` or `project`.
- `agents: ["detected"]` must stand alone. It targets the active runtime, not `*`, and does not guarantee exclusive visibility when CLI storage is shared.
- `required: true` stops sync when its installation batch fails; optional failures are summarized and also prevent cleanup.
- `reviewed: true` is required for installation. Provenance confidence and content review are separate decisions.

## Exclusive profiles

Explicitly selecting two members of one group is rejected before runtime detection or installation inspection:

```shell
node scripts/manage-skills.mjs plan --profile coding-a,coding-b
```

Shared Skills belong to both profiles in one catalog entry, for example `"profiles": ["coding-a", "coding-b"]`. Do not duplicate a Skill entry: names remain unique per scope.

For `plan` and `sync`, `--all` selects every profile outside an exclusive group plus the default member of each group. Sync removes installed remote Skills that are managed exclusively by displaced members, while preserving shared, non-conflicting, unmanaged, and local-source Skills. `audit --all` remains a full-catalog audit and includes every member because it never changes anything.

## Local sources

Treat absolute paths, `./`, `../`, `.`, `..`, and Windows drive paths as local. `skills/example` is remote shorthand; use `./skills/example` for a relative path. Local entries are managed inventory but non-portable: restoration reports/skips them, and audit does not also mark them unmanaged.

## Agent resolution

Resolve `detected` in order: manager `--agent`, `MY_SKILLS_AGENT`, then Codex/Claude runtime markers. Stop on no match or ambiguity. Skills CLI chooses the physical directory from scope and agent; verify `skills list --json` when isolation matters rather than assuming a fixed path.

## Add an entry

1. Find a candidate if needed; inspect owner, repository, contents, and risk.
2. Confirm exact names with `npx skills add <package> --list`.
3. Record the smallest correct entry, keeping new/unreviewed content `reviewed: false` until explicitly approved.
4. Run `plan` and show it before installation.
