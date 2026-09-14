---
name: my-plugins-skill
description: Use when users request Skills CLI catalog initialization, sync, plan, audit, provenance, discovery, changes, or updates, or external command-managed plugin planning, installation, or removal.
metadata:
  short-description: Manage trusted skills and external plugins
---

# My Plugins

Treat `pluginset.json` as the source of truth and `npx skills` as the installer. Lock files are optional CLI evidence, not managed configuration.

## Route

- Unqualified command requests (for example, "run plan" or "execute sync") target both Skills and Plugins whenever both managers support the command. Do not narrow the request to the manager discussed most recently. If only one supports it, run that manager and explicitly identify the unsupported side. Explicit resource names, manager names, or a concrete script command take precedence. Currently plan/install/remove/sync are shared; doctor/audit/sources are Skills-only and the manager update command is Plugins-only. Preserve supplied selectors and authorization; do not silently add --all or --yes to modification commands. For an unqualified read-only plan with no selector, use plan --all on both managers. Report each side separately; a failed operation is not evidence that the command is unsupported.

- Before installing a requested Skill, check whether its exact name and source match an entry in the current `pluginset.json`. If it is absent, invoke the `find-skills` skill: read its SKILL.md and follow its discovery, verification, and installation workflow. Do not substitute a direct CLI search for invoking that skill, silently install a whole Profile, or add the result to the catalog without a request to manage it. Existing installation authorization remains valid; clarify only unresolved candidate/source choices. If `find-skills` is unavailable, report the missing skill rather than claiming to have used it.

- Installed-agent discovery: only use plugin `--detect-installed` when targeting locally installed agents rather than the current session. Read [references/agent-detection.md](references/agent-detection.md). Configuration presence is not active-session evidence; never silently select installed candidates after runtime detection fails.

- Plugin agent targets: resolve `agents: ["detected"]` using `--agent`, `MY_SKILLS_AGENT`, then active runtime; explicit lists remain authoritative. Require an `agentMap` entry for every target. Show expanded `{agent}` commands and targets; shared commands execute once. Missing/ambiguous targets fail before checks. Plugin removal remains full uninstall and may affect other agents through shared CLI removal; explain that scope before execution.

- External plugin updates: use `scripts/manage_plugins.mjs update` with an explicit selector; preview without `--yes`, execute authorized updates with `--yes`. Require `updateCommand`, an available CLI, and `reviewed: true`; run setup after updating and stop on any failure. Update allows same-group plugins together and never cleans up peers. Skill version updates still use `npx skills update`.

- Checks, plan, sync, audit, or version updates: read [references/operations.md](references/operations.md); use `scripts/manage-skills.mjs` where routed.
- External plugin plan/install/remove/sync requests: read [references/operations.md](references/operations.md), then use `scripts/manage_plugins.mjs`. Require an explicit profile, plugin name, or `--all`; never infer project initialization. `plan` previews `sync`; use `sync` for replacement, and `install` for additive installation with no peer cleanup.
- Skills additive install and explicit removal: use `scripts/manage-skills.mjs install` or `remove`. Both allow mutually exclusive profiles together. Install defaults to `defaultProfiles`; remove requires explicit `--profile` or `--all`. Explicit removal can include shared Skills in the selection; list their profile memberships and resolved target agents. Skip local sources and leave uncatalogued Skills untouched.
- Treat requests to "initialize my skills" and "sync my skills" as environment sync. Without a named profile, run `sync` with no selector so `defaultProfiles` is used; named profiles use `sync --profile`, and all compatible profiles use `sync --all`.
- Treat requests to "update my skills" as version updates only. Show the update plan and use `npx skills update`; do not implicitly sync profiles.
- Before presenting a plan, audit, sync result, or update result, read [references/reporting.md](references/reporting.md).
- For all compatible profiles, use `plan --all` or `sync --all`; these select each exclusive group's configured default. `install --all`, `remove --all`, and plugin `update --all` select every variant. Audit still covers every variant.
- Source confirmation or export proposals or list local installed: read [references/provenance.md](references/provenance.md); run `sources --json`. Stay offline unless remote verification is requested or accepted.
- Any `pluginset.json` edit: read [references/configuration.md](references/configuration.md).
- Discovery of uncatalogued Skills: invoke `find-skills` and follow its workflow; `npx skills find <query> [--owner <owner>]` is a tool within that workflow, not a substitute for loading the skill.
- New entries: first run `npx skills add <package> --list`; agree profiles, scope, agents, `required`, and review state; edit the catalog, then run `plan`.

## Invariants

- `detected` means the single active runtime, never `*`. If detection is absent or ambiguous, require `--agent <id>`. A CLI-targeted install may still be visible through a shared agent directory.
- Recognize local sources exactly as Skills CLI does: absolute paths, `./`, `../`, `.`, `..`, or Windows drive paths. Keep them as inventory only; restoration reports and skips them without adding a source-type field.
- Provenance never comes from name similarity alone. Only `CONFIRMED` or `VERIFIED` remote results may enter an export proposal; `CANDIDATE` needs user review, while `UNKNOWN` and `LOCAL` are skipped. Provenance does not prove unchanged file contents.
- `doctor`, `plan`, `audit`, and offline `sources` are read-only. Remote verification may inspect a temporary clone but never installs it.
- Profiles sharing an `exclusiveGroup` cannot be planned, synced, or explicitly audited together. Every group has exactly one `defaultInExclusiveGroup`; plan/sync `--all` uses it. Install/remove and plugin update allow all variants together; full-catalog audit may inspect every variant.
- Management scope comes only from the current `pluginset.json`; deleting an entry ends management, and sync must not infer historical ownership. Sync affects selected profiles and displaced members of their groups, preserving unrelated profiles. It is not a machine-wide purge.
- Both managers require `--yes` for every mutation: install, remove, sync, and plugin update. Without it they only preview, including cleanup-only sync, and never prompt interactively. Show the plan before authorized execution; existing explicit user authorization need not be requested again. Direct `npx skills add` or version updates also require authorization.
- Install only entries with `reviewed: true`. During sync, remove only remote catalog Skills managed exclusively by displaced profiles and only for the current target agent. Never auto-adopt or remove unmanaged, shared, non-conflicting, local, system, plugin-cache, or generated-link Skills.
- Plugin installation requires both `reviewed: true` and explicit `--yes` confirmation. Plugin removal requires `--yes` but remains available for unreviewed entries.
- Display every arbitrary catalog command before execution. Run plugin mutations sequentially and stop globally on the first failure.
- Project indexes are outside this Skill's management scope: never infer or run project initialization, refresh, or index deletion from a plugin request.
- Stop on overwrite risk. Do not copy credentials or install system dependencies; report them for the owning Skill to handle.
