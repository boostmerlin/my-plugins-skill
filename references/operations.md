# Operations

Run the script by absolute path while keeping the target project as the working directory. It reads the adjacent `pluginset.json`; Skills CLI derives project scope from the working directory.

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

Only sync plans inspect installed peers owned exclusively by one displaced profile. Preview includes cleanup commands and their full-uninstall scope. With `sync --yes`, every selected plugin must finish installation and setup, then pass availability verification before any peer is removed. Each cleanup is verified immediately; a failed command or verification stops further work and reports completed and pending actions. There is no rollback. Shared, unrelated, and unmanaged plugins are preserved. Availability checks cannot prove that upstream configuration has no residue. For replacement workflows, migrate old plugin install commands to sync.

`plan` and the planning stage of sync/install/update/remove run read-only `checkCommand` checks for selected plugins; only plan/sync additionally inspect automatic cleanup candidates. A nonzero check status means unavailable; a check execution error aborts planning. Install and sync run `installCommand` only after a failed availability check, then run `setupCommand` when present. Setup also runs when the check succeeds so existing Codex/MCP integration can be repaired.

Without `--yes`, sync/install/update/remove display the exact resolved commands and perform no mutation. Installation additionally requires every selected entry to have `reviewed: true`; removal has no review gate, so an unreviewed entry can still be cleaned up. All mutation commands run sequentially, and any install, setup, or uninstall failure stops the entire invocation before later actions or plugins.

The plugin manager does not manage project indexes. It must never run or add `gitnexus analyze`, `gitnexus clean --all`, `codegraph init`, or `codegraph uninit`. `codebase-memory-mcp uninstall` intentionally runs without `-y`, preserving the upstream interactive choice about deleting indexes; its npm removal runs only after that command succeeds.

These command-managed integrations are separate from native Codex Marketplace plugins. Do not route Marketplace connection or removal through `manage_plugins.mjs`.

## Environment sync

```shell
node scripts/manage-skills.mjs sync
node scripts/manage-skills.mjs sync --profile core,superpowers
node scripts/manage-skills.mjs sync --profile core,superpowers --agent codex --yes
node scripts/manage-skills.mjs sync --all --agent codex --yes
```

Natural-language requests to initialize or sync Skills route here. Omitting both selectors uses `defaultProfiles`; named profiles use `--profile`; all compatible profiles use `--all`, which selects each exclusive group's default. Explicitly selecting more than one member of a group fails before any installation checks.

`plan` and the beginning of `sync` show both installs and removals. Without `--yes`, sync only previews, including cleanup-only sync, and never prompts interactively. Missing remote Skills sharing source, scope, resolved agents, and `required` policy are installed as one batch. Any required or optional installation failure skips all cleanup. After successful installation, cleanup removes only installed remote catalog Skills managed exclusively by displaced profiles, scoped to the current target agent. Other profiles remain untouched. Removal is verified by listing installed Skills again; command failures or residual links make sync exit `1`.

## Additive Skill installation and explicit removal

```powershell
node scripts/manage-skills.mjs install --profile mattpocock,superpowers
node scripts/manage-skills.mjs install --all --yes
node scripts/manage-skills.mjs remove --profile superpowers
node scripts/manage-skills.mjs remove --all --yes
```

Install and remove ignore profile exclusivity without bypassing catalog validation. Install fills missing selected Skills with no peer cleanup; no selector means `defaultProfiles`. Remove requires an explicit profile/all selector, targets only selected catalog entries for their resolved agents and scope, and can remove shared selected Skills; preview lists all memberships. Both commands select all variants with `--all`, deduplicate resources, skip local sources, and require `--yes` to mutate. Removal skips missing entries, does not require review, verifies each batch, and stops on command or verification failure with completed/pending details. Neither command changes uncatalogued Skills or catalog configuration.

Explicit `audit --profile <...>` checks a realizable environment: selected Skills must exist, displaced exclusive Skills are `CONFLICT`, other catalog-managed Skills are ignored, and only identities outside the full catalog are unmanaged. It rejects mutually exclusive selections. Audit without a selector and `audit --all` remain full-catalog checks.

## Discovery and updates

```shell
npx skills find <query> [--owner <owner>]
npx skills add <package> --list
npx skills update --global
npx skills update --project
```

Before `add` or a version update, show source, names, scope, and agents and obtain confirmation. A request to "update my skills" means this version-update workflow only and does not run environment sync. Audit afterward. Audit never calls `remove`.
