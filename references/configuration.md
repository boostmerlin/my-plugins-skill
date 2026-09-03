# Catalog configuration

`skillset.json` is the version-controlled source of truth. Never add generated paths, credentials, system Skills, or plugin-cache Skills.

```json
{
  "schemaVersion": 1,
  "defaultProfiles": ["core"],
  "profiles": { "core": { "description": "Skills installed everywhere" } },
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
- `package` is a Skills CLI source: preferably `owner/repository`/trusted Git URL, or an explicitly path-shaped local source.
- `names`, `profiles`, and `agents` are non-empty arrays. A name is unique per scope; combine profiles instead of duplicating it.
- `scope` is `global` or `project`.
- `agents: ["detected"]` must stand alone. It targets the active runtime, not `*`, and does not guarantee exclusive visibility when CLI storage is shared.
- `required: true` stops initialization when its installation batch fails; optional failures are summarized.
- `reviewed: true` is required for installation. Provenance confidence and content review are separate decisions.

## Local sources

Treat absolute paths, `./`, `../`, `.`, `..`, and Windows drive paths as local. `skills/example` is remote shorthand; use `./skills/example` for a relative path. Local entries are managed inventory but non-portable: restoration reports/skips them, and audit does not also mark them unmanaged.

## Agent resolution

Resolve `detected` in order: manager `--agent`, `MY_SKILLS_AGENT`, then Codex/Claude runtime markers. Stop on no match or ambiguity. Skills CLI chooses the physical directory from scope and agent; verify `skills list --json` when isolation matters rather than assuming a fixed path.

## Add an entry

1. Find a candidate if needed; inspect owner, repository, contents, and risk.
2. Confirm exact names with `npx skills add <package> --list`.
3. Record the smallest correct entry, keeping new/unreviewed content `reviewed: false` until explicitly approved.
4. Run `plan` and show it before installation.
