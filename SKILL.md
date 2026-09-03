---
name: my-skills-skill
description: Manage and restore a trusted Skills CLI catalog. Use for environment sync, initialization requests, plan/audit, source provenance, discovery, review, catalog changes, or approved version updates. Excludes system and plugin-cache skills.
metadata:
  short-description: Manage and restore trusted skills
---

# My Skills

Treat `skillset.json` as the source of truth and `npx skills` as the installer. Lock files are optional CLI evidence, not managed configuration.

## Route

- Checks, plan, sync, audit, or version updates: read [references/operations.md](references/operations.md); use `scripts/manage-skills.mjs` where routed.
- Treat requests to "initialize my skills" and "sync my skills" as environment sync. Without a named profile, run `sync` with no selector so `defaultProfiles` is used; named profiles use `sync --profile`, and all compatible profiles use `sync --all`.
- Treat requests to "update my skills" as version updates only. Show the update plan and use `npx skills update`; do not implicitly sync profiles.
- Before presenting a plan, audit, sync result, or update result, read [references/reporting.md](references/reporting.md).
- For a request covering all compatible profiles, pass `--all`; never enumerate profile names in the command. It selects each exclusive group's configured default, while audit still covers every variant.
- Source confirmation or export proposals or list local installed: read [references/provenance.md](references/provenance.md); run `sources --json`. Stay offline unless remote verification is requested or accepted.
- Any `skillset.json` edit: read [references/configuration.md](references/configuration.md).
- Discovery: use `npx skills find <query> [--owner <owner>]`; explain and verify candidates before offering changes.
- New entries: first run `npx skills add <package> --list`; agree profiles, scope, agents, `required`, and review state; edit the catalog, then run `plan`.

## Invariants

- `detected` means the single active runtime, never `*`. If detection is absent or ambiguous, require `--agent <id>`. A CLI-targeted install may still be visible through a shared agent directory.
- Recognize local sources exactly as Skills CLI does: absolute paths, `./`, `../`, `.`, `..`, or Windows drive paths. Keep them as inventory only; restoration reports and skips them without adding a source-type field.
- Provenance never comes from name similarity alone. Only `CONFIRMED` or `VERIFIED` remote results may enter an export proposal; `CANDIDATE` needs user review, while `UNKNOWN` and `LOCAL` are skipped. Provenance does not prove unchanged file contents.
- `doctor`, `plan`, `audit`, and offline `sources` are read-only. Remote verification may inspect a temporary clone but never installs it.
- Profiles sharing an `exclusiveGroup` cannot be planned, synced, or explicitly audited together. Every group has exactly one `defaultInExclusiveGroup`; `--all` uses it, while full-catalog audit may inspect every variant.
- Show the exact plan and obtain confirmation before `sync --yes`, `npx skills add`, or `npx skills update`. Sync cleanup adds no separate prompt; a cleanup-only `sync` executes directly.
- Install only entries with `reviewed: true`. During sync, remove only remote catalog Skills managed exclusively by displaced profiles and only for the current target agent. Never auto-adopt or remove unmanaged, shared, non-conflicting, local, system, plugin-cache, or generated-link Skills.
- Stop on overwrite risk. Do not copy credentials or install system dependencies; report them for the owning Skill to handle.
