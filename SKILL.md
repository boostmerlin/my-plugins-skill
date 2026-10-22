---
name: my-plugins-skill
description: Use when users request Skills CLI catalog initialization, sync, plan, audit, provenance, discovery, changes, or updates, or external command-managed plugin planning, installation, sync, updates, or removal.
metadata:
  short-description: Manage trusted skills and external plugins
---

# My Plugins

Treat `pluginset.json` as the source of truth. `scripts/manage-skills.mjs` manages Skills through `npx skills`; `scripts/manage_plugins.mjs` manages external command-based plugins. Lock files are optional evidence, not configuration.

## Route

- Unqualified command requests (for example, "run plan" or "execute sync") target both Skills and Plugins whenever both managers support the command. Do not narrow to the most recently discussed manager. Explicit resource names, manager names, or script commands take precedence. Shared commands are plan/install/remove/sync; doctor/audit/sources are Skills-only, and the manager update command is Plugins-only. Report each side separately, including an unsupported command; failure does not mean unsupported. Preserve selectors and authorization. Only an unqualified read-only plan without a selector defaults to `plan --all` on both managers; do not add `--all` or `--yes` to modification requests.
- Before any lifecycle operation, read [references/operations.md](references/operations.md) for selection, checks, execution, and failure handling. `plan` previews sync; `install` is additive and `remove` explicitly uninstalls selected catalog entries. Plugins require a profile/plugin/all selector; Skills removal requires profile/all.
- Treat requests to "initialize my skills" and "sync my skills" as environment sync. No named profile means `sync` without selectors, using `defaultProfiles`; named profiles use `--profile`, and all compatible profiles use `--all`.
- Treat requests to "update my skills" as version updates only. Follow the managed-update workflow in operations: intersect installed and cataloged remote names per scope, then use nonempty positional name lists with `npx skills update`. Do not sync profiles, apply exclusive defaults, or run an unfiltered update.
- Before installing a requested Skill, match its exact name and source in the catalog. For an uncatalogued request, invoke `find-skills`: read its SKILL.md and follow discovery, verification, and installation. A direct CLI search is not a substitute. Keep existing installation authorization; clarify only unresolved candidates. Do not silently install a whole profile or add the Skill to the catalog. If `find-skills` is unavailable, report that limitation.
- For source confirmation, export proposals, or installed-source listings, read [references/provenance.md](references/provenance.md) and run `sources --json`. Stay offline unless remote verification is requested or accepted.
- Before editing `pluginset.json`, read [references/configuration.md](references/configuration.md). Before presenting a plan or result, read [references/reporting.md](references/reporting.md).
- For agent detection or plugin `--detect-installed`, read [references/agent-detection.md](references/agent-detection.md). Installed configuration is not evidence of the active session; never silently select installed candidates after runtime detection fails.

## Invariants

- Current catalog entries define ownership; deleting an entry ends management. Missing installation source metadata keeps catalog ownership. An explicitly different source, local installation, or protected system/plugin-cache path blocks mutation of that identity; never discard the record and treat it as missing. Do not add a provenance database or network check to lifecycle operations.
- Local catalog sources are inventory only and are skipped. Preserve unmanaged and unrelated entries. Stop on overwrite risk; do not copy credentials or install system dependencies.
- Both managers require `--yes` for every mutation and otherwise only preview, including cleanup-only sync. Show the plan before executing; existing explicit user authorization need not be requested again. Direct installs and version updates also require authorization. Install only reviewed entries; explicit removal may clean up unreviewed entries.
- Sync installs and verifies replacements before cleanup. Any installation or verification failure prevents cleanup. A skipped required local Skill or local entry alternative cannot establish a replacement. A profile with only optional local replacements blocks cleanup for that group and target agent; an actually empty chosen profile may clear its displaced peers, and usable remote replacements may coexist with skipped optional local entries. See operations for exact cleanup scope.
- Profile sharing protects against profile-only cleanup; explicit entry exclusivity can displace shared entries. Choices are invocation-local. Install/remove and plugin update allow variants together; plan/sync and explicit-profile audit enforce compatible choices.
- `detected` uses the active runtime, not `*`; absent or ambiguous detection requires an explicit target. Plugin targets need `agentMap` entries. Shared storage can expose a Skill to other agents, and plugin uninstall may remove a shared CLI or integrations for other agents.
- Display every arbitrary plugin command before execution. Run mutations sequentially, stop on failure, and report completed/pending actions. The plugin manager does not manage project indexes: never infer initialization, refresh, or index deletion from a plugin request.
- Provenance is separate from ownership and content review. Only `CONFIRMED`/`VERIFIED` remote results enter export proposals. Git evidence requires the exact `SKILL.md` to be tracked by the discovered repository; an unrelated enclosing repository alone is not evidence. Provenance does not prove unchanged content.
- `doctor`, `plan`, `audit`, and offline `sources` are read-only. Remote verification may inspect a temporary clone but never installs it.
