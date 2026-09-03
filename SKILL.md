---
name: my-skills-skill
description: Manage and restore a trusted Skills CLI catalog. Use for environment initialization, plan/audit, source provenance, discovery, review, catalog changes, or approved updates. Excludes system and plugin-cache skills.
metadata:
  short-description: Manage and restore trusted skills
---

# My Skills

Treat `skillset.json` as the source of truth and `npx skills` as the installer. Lock files are optional CLI evidence, not managed configuration.

## Route

- Checks, plan, init, audit, or updates: read [references/operations.md](references/operations.md); use `scripts/manage-skills.mjs` where routed.
- Before presenting a plan, audit, initialization result, or update result, read [references/reporting.md](references/reporting.md).
- For a request covering all/every profile, pass `--all`; never enumerate profile names in the command.
- Source confirmation or export proposals or list local installed: read [references/provenance.md](references/provenance.md); run `sources --json`. Stay offline unless remote verification is requested or accepted.
- Any `skillset.json` edit: read [references/configuration.md](references/configuration.md).
- Discovery: use `npx skills find <query> [--owner <owner>]`; explain and verify candidates before offering changes.
- New entries: first run `npx skills add <package> --list`; agree profiles, scope, agents, `required`, and review state; edit the catalog, then run `plan`.

## Invariants

- `detected` means the single active runtime, never `*`. If detection is absent or ambiguous, require `--agent <id>`. A CLI-targeted install may still be visible through a shared agent directory.
- Recognize local sources exactly as Skills CLI does: absolute paths, `./`, `../`, `.`, `..`, or Windows drive paths. Keep them as inventory only; restoration reports and skips them without adding a source-type field.
- Provenance never comes from name similarity alone. Only `CONFIRMED` or `VERIFIED` remote results may enter an export proposal; `CANDIDATE` needs user review, while `UNKNOWN` and `LOCAL` are skipped. Provenance does not prove unchanged file contents.
- `doctor`, `plan`, `audit`, and offline `sources` are read-only. Remote verification may inspect a temporary clone but never installs it.
- Show the exact plan and obtain confirmation before `init --yes`, `npx skills add`, or `npx skills update`. Audit after mutation.
- Install only entries with `reviewed: true`. Never auto-adopt, remove, or overwrite Skills; exclude system Skills, plugin caches, and generated links.
- Stop on overwrite risk. Do not copy credentials or install system dependencies; report them for the owning Skill to handle.
