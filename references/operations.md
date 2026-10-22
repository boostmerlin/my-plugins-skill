# Operations

Run the script by absolute path while keeping the target project as the working directory. It reads the adjacent `pluginset.json`; Skills CLI derives project scope from the working directory.

Examples below use repository-relative script paths. When this Skill is installed elsewhere, resolve those paths from its own directory without changing the target project's working directory.

## Inspection

```shell
node scripts/manage-skills.mjs doctor
node scripts/manage-skills.mjs plan [--profile core,superpowers | --all] [--agent codex]
node scripts/manage-skills.mjs audit [--profile core,superpowers | --all] [--agent codex]
node scripts/manage-skills.mjs sources [skill ...] [--json] [--verify-remote]
```

- `doctor`: dependencies, catalog validity, and agent detection.
- `plan`: missing selected Skills or agent links; defaults to configured profiles.
- `audit`: full catalog drift, including missing and unmanaged installs.
- `sources`: provenance for installed non-system Skills; see [provenance.md](provenance.md).

`--profile` accepts comma-separated profiles. Repeated values and repeated `--profile` options are merged with first-seen order preserved. `--all` cannot be combined with `--profile`. For `plan` and `sync`, it selects every ordinary profile plus the configured default from each exclusive group. For full-catalog `audit`, it selects every configured profile, including all mutually exclusive variants. `detected` resolves to the active runtime; outside a recognized session, pass `--agent` or set `MY_SKILLS_AGENT`. It never resolves to `*`, though shared CLI storage may expose a Skill to compatible agents.

Local catalog sources are inventory-only: `plan`/`sync`/`install`/`remove` report `SKIP`, `audit` reports `LOCAL`, and they are neither installed nor removed. `audit` exits `1` on drift; `sources` exits `1` on unresolved provenance or operational errors. Both only report.

## Installed identity and mutation checks

Match installed Skills to the current catalog by name and scope, then use the configured target agents for the operation. Deleting a catalog entry ends management; no historical ownership database is consulted.

- Missing source metadata keeps the existing catalog-ownership behavior. It does not require a provenance lookup, lock database, or network request before lifecycle operations.
- If the installed record explicitly identifies a different source, disagrees internally about its source, identifies a local installation, or points into a protected system/plugin-cache location, report the conflict and block mutation of that identity. Keep the record visible: treating it as missing could install over it, and treating it as an ordinary managed match could remove it.
- A cataloged local source remains inventory-only. Unmanaged installations remain outside the operation. Source confirmation and export confidence are separate workflows in [provenance.md](provenance.md).

Show the selected scope, exact names, sources, agents, and blocked/skipped items before executing. Existing explicit authorization remains valid; ask only when the required choice or authorization is missing. Stop on local overwrite risk.

## External plugin lifecycle

`--detect-installed` opts into global installed-agent discovery for `agents: ["detected"]`. It is mutually exclusive with `--agent`, bypasses `MY_SKILLS_AGENT` and runtime selection, and does not override explicit catalog targets. No candidates or a missing target mapping fails before commands run. See [agent-detection.md](agent-detection.md) for upstream source analysis and supported discovery rules.

Plugin commands accept `--agent codex,claude-code` and repeated `--agent` options to resolve catalog `agents: ["detected"]`; this does not replace the required profile/plugin/all selector and does not override explicit catalog agent lists. Without an override, use `MY_SKILLS_AGENT` or the active runtime. Missing or ambiguous detection and missing mappings fail before any checks. Preview shows target agents and fully expanded commands. Uninstall remains full removal, including shared CLI removal configured in the catalog, and may affect other agents.

```powershell
node scripts/manage_plugins.mjs plan --profile codegraph --agent codex
node scripts/manage_plugins.mjs install --plugin codegraph --agent codex --yes
```

Use `node scripts/manage_plugins.mjs update --plugin codegraph` to preview an update, and append `--yes` to execute. Profile and all selectors are also supported, including same-group plugins together. Every selected plugin must define `updateCommand` and pass its availability check; otherwise the entire update stops before mutations. Execution requires `reviewed: true`, runs update commands followed by setup, and stops globally on any failure. Update does not clean up peers or manage project indexes. `plan` previews sync; use `install` without `--yes` to preview additive installation.

Route external `plugins` plan, installation, and removal through the separate manager:

```powershell
node scripts/manage_plugins.mjs plan --plugin gitnexus
node scripts/manage_plugins.mjs install --profile gitnexus --yes
node scripts/manage_plugins.mjs sync --profile codegraph --yes
node scripts/manage_plugins.mjs remove --plugin gitnexus --yes
```

Every operation requires exactly one of `--profile <a,b>`, `--plugin <a,b>`, or `--all`; the selectors are mutually exclusive and omission is an error. Names are comma-separated, trimmed, deduplicated, and selected plugins retain catalog order. The manager never falls back to `defaultProfiles`.

The plugin profiles `gitnexus`, `codegraph` (default), and `codebase-memory-mcp` share exclusive group `codegraph`, independently of the `coding` workflow group. For example, `plan --profile superpowers,codegraph` selects CodeGraph while retaining a compatible workflow choice. The plugin manager does not install the workflow's Skills; use the Skill manager separately. `plan` and `sync` reject conflicting profile or plugin selections and their `--all` selects ordinary/default-profile plugins (currently CodeGraph). Install/update/remove allow conflicting members together and their `--all` selects every plugin.

Profile cleanup requires a uniquely determined replacement profile. Selecting only a shared plugin whose memberships span alternatives does not silently choose one or trigger that group's cleanup; select a specific profile or a compatible single-profile plugin to make the choice explicit.

Only sync plans inspect installed peers owned exclusively by one displaced profile or displaced by an explicit entry group. Preview includes cleanup commands and their full-uninstall scope. With `sync --yes`, every selected plugin must finish installation and setup, then pass availability verification before any peer is removed. Each cleanup is verified immediately; a failed command or verification stops further work and reports completed and pending actions. There is no rollback. Shared plugins are preserved from profile-only cleanup; explicit entry conflicts can displace them. Unrelated and unmanaged plugins are preserved. Availability checks cannot prove that upstream configuration has no residue. For replacement workflows, migrate old plugin install commands to sync.

`plan` and the planning stage of sync/install/update/remove run read-only `checkCommand` checks for selected plugins; only plan/sync additionally inspect automatic cleanup candidates. A nonzero check status means unavailable; a check execution error aborts planning. Install and sync run `installCommand` only after a failed availability check, then run `setupCommand` when present. Setup also runs when the check succeeds so existing Codex/MCP integration can be repaired.

Without `--yes`, sync/install/update/remove display the exact resolved commands and perform no mutation. Installation additionally requires every selected entry to have `reviewed: true`; removal has no review gate, so an unreviewed entry can still be cleaned up. All mutation commands run sequentially, and any install, setup, or uninstall failure stops the entire invocation before later actions or plugins.

The plugin manager does not manage project indexes. It must never run or add `gitnexus analyze`, `gitnexus clean --all`, `codegraph init`, or `codegraph uninit`. `codebase-memory-mcp uninstall` intentionally runs without `-y`, preserving the upstream interactive choice about deleting indexes; its npm removal runs only after that command succeeds.

These command-managed integrations are separate from native Codex Marketplace plugins. Do not route Marketplace connection or removal through `manage_plugins.mjs`.

## Environment sync

### Entry alternatives

```powershell
node scripts/manage-skills.mjs plan --profile docs --choose chinese-humanizer=qu-ai-wei
node scripts/manage-skills.mjs sync --profile docs --choose chinese-humanizer=qu-ai-wei --yes
node scripts/manage-skills.mjs audit --profile docs --choose chinese-humanizer=qu-ai-wei
```

Both managers accept repeatable `--choose group=name` on plan/sync; Skills also accepts it on explicit-profile audit. All other commands reject it. Choices only affect this invocation, not the catalog or later runs. Skill names identify an entire names entry; plugin names identify one plugin. Each manager resolves its own entry groups after profile selection, using an override, the sole candidate, or the configured default. Multiple candidates with no eligible default require an explicit choice. Invalid or out-of-range choices and conflicting selections fail before external commands. An explicit plugin selector already chooses its members and cannot include two alternatives from an entry group on plan/sync.

Entry conflicts apply regardless of shared profile memberships and combine with profile conflicts without duplicate removals. Skill entry cleanup is restricted to agents common to the current operation and both entries; local and unmanaged sources remain untouched. A selected local entry alternative cannot justify cleanup. Plugin uninstall scope remains defined by its existing commands, including effects on shared integrations. Plans show the group, selected member, choice source, and cleanup reason.

Install/remove and plugin update still act on all matching entries, allow alternatives together, and never automatically remove peers. Full-catalog audit checks all variants; explicit-profile audit checks chosen entries and reports installed alternatives as conflicts.

```shell
node scripts/manage-skills.mjs sync
node scripts/manage-skills.mjs sync --profile core,superpowers
node scripts/manage-skills.mjs sync --profile core,superpowers --agent codex --yes
node scripts/manage-skills.mjs sync --all --agent codex --yes
```

Natural-language requests to initialize or sync Skills route here. Omitting both selectors uses `defaultProfiles`; named profiles use `--profile`; all compatible profiles use `--all`, which selects each exclusive group's default. Explicitly selecting more than one member of a group fails before any installation checks.

`plan` and the beginning of `sync` show both installs and removals. Without `--yes`, sync only previews, including cleanup-only sync, and never prompts interactively. Missing remote Skills sharing source, scope, resolved agents, and `required` policy are installed as one batch. Any required or optional installation failure skips all cleanup. After successful installation and availability verification, cleanup removes installed remote catalog Skills displaced by exclusive profiles or entry groups, using the target-agent limits above. Non-conflicting entries remain untouched. Removal is verified by listing installed Skills again; command failures or residual links make sync exit `1`.

Profile cleanup preserves Skills shared with a non-displaced profile; explicit entry groups can displace shared entries. Apply the installed-identity checks to both replacements and removal candidates before mutation. Verify every selected remote replacement before cleanup; a failed verification prevents cleanup.

For skipped local replacements, distinguish these cases for each exclusive group and target agent:

- A selected required local Skill or local entry alternative retains its existing cleanup gate: it cannot establish the replacement.
- When the selected profile has applicable entries but all applicable replacements are optional local sources, block cleanup for that group and agent. A remote replacement for a different group or agent does not satisfy this check.
- A usable, verified remote replacement may coexist with skipped optional local entries; those optional entries alone do not block profile cleanup.
- A genuinely empty chosen profile has no replacement entries and may clear its displaced profile's managed peers. Do not mistake a profile whose entries were all skipped for an empty profile.

## Additive Skill installation and explicit removal

```powershell
node scripts/manage-skills.mjs install --profile mattpocock,superpowers
node scripts/manage-skills.mjs install --all --yes
node scripts/manage-skills.mjs remove --profile superpowers
node scripts/manage-skills.mjs remove --all --yes
```

Install and remove ignore profile and entry exclusivity without bypassing catalog validation. Install fills missing selected Skills with no peer cleanup; no selector means `defaultProfiles`. Remove requires an explicit profile/all selector, targets only selected catalog entries for their resolved agents and scope, and can remove shared selected Skills; preview lists all memberships. Both commands select all variants with `--all`, deduplicate resources, skip local sources, and require `--yes` to mutate. Removal skips missing entries, does not require review, verifies each batch, and stops on command or verification failure with completed/pending details. Neither command changes uncatalogued Skills or catalog configuration.

Explicit `audit --profile <...>` checks a realizable environment: selected Skills must exist, displaced exclusive Skills are `CONFLICT`, other catalog-managed Skills are ignored, and only identities outside the full catalog are unmanaged. It rejects mutually exclusive selections. Audit without a selector and `audit --all` remain full-catalog checks.

## Discovery

```shell
npx skills find <query> [--owner <owner>]
npx skills add <package> --list
```

For uncatalogued Skills, load `find-skills` before discovery or installation. Before `add`, show source, exact names, scope, and agents, then execute within the user's authorization. A request to install does not also authorize adding the result to `pluginset.json`; catalog changes follow [configuration.md](configuration.md).

## Managed Skill version updates

A request to "update my skills" means version updates only. This workflow uses the upstream `npx skills update` command; there is no `manage-skills.mjs update` subcommand and no profile sync or exclusive cleanup.

1. Read the current catalog and list installed Skills separately for global and project scope. Respect any user-specified names, profiles, or scope. Without that restriction, consider all installed catalog entries, including every installed exclusive variant; do not apply `defaultProfiles`, group defaults, or `--choose`.
2. Intersect installed and cataloged names within each scope. Exclude cataloged local sources and protected installations. Apply the installed-identity checks above: explicit source mismatches or local/protected installed records block the affected update and must be reported, not silently treated as missing. Missing source metadata remains eligible under catalog ownership; the export-only `CONFIRMED`/`VERIFIED` threshold does not apply.
3. Show the exact eligible names and sources, scope, exclusions, conflicts, and update commands. Honor existing authorization. If a selected identity is blocked, resolve that conflict before executing its update; do not overwrite it with a catalog reinstall.
4. Run one command per nonempty scope with explicit positional names. Never execute a bare scope-wide update when the filtered list is empty. The upstream update command does not accept `--agent`; explain shared installation visibility rather than promising agent-isolated updates.

```shell
npx skills update skill-a skill-b --global
npx skills update project-skill --project
```

For example, if global Skill A is installed and cataloged remotely, B is installed but unmanaged, and C is cataloged locally, the plan contains only `npx skills update A --global`. If A is not installed, the eligible list is empty and no update command runs. Same-named global and project Skills are evaluated separately.

Report failures and audit the requested scope afterward. Audit never calls `remove`. Source evidence and update checks do not prove that local content is unchanged; stop if a known local modification would be overwritten.
