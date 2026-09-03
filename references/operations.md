# Operations

Run the script by absolute path while keeping the target project as the working directory. It reads the adjacent `skillset.json`; Skills CLI derives project scope from the working directory.

## Inspection

```shell
node scripts/manage-skills.mjs doctor
node scripts/manage-skills.mjs plan [--profile core,coding | --all] [--agent codex]
node scripts/manage-skills.mjs audit [--profile core,coding | --all] [--agent codex]
node scripts/manage-skills.mjs sources [skill ...] [--json] [--verify-remote]
```

- `doctor`: dependencies, catalog validity, and agent detection.
- `plan`: missing selected Skills or agent links; defaults to configured profiles.
- `audit`: full catalog drift, including missing and unmanaged installs.
- `sources`: provenance for installed non-system Skills; see [provenance.md](provenance.md).

`--profile` accepts comma-separated profiles. Repeated values and repeated `--profile` options are merged with first-seen order preserved. `--all` cannot be combined with `--profile`. For `plan` and `sync`, it selects every ordinary profile plus the configured default from each exclusive group. For full-catalog `audit`, it selects every configured profile, including all mutually exclusive variants. `detected` resolves to the active runtime; outside a recognized session, pass `--agent` or set `MY_SKILLS_AGENT`. It never resolves to `*`, though shared CLI storage may expose a Skill to compatible agents.

Local catalog sources are inventory-only: `plan`/`sync` report `SKIP`, `audit` reports `LOCAL`, and sync neither installs nor removes them. `audit` exits `1` on drift; `sources` exits `1` on unresolved provenance or operational errors. Both only report.

## Environment sync

```shell
node scripts/manage-skills.mjs sync
node scripts/manage-skills.mjs sync --profile core,coding2
node scripts/manage-skills.mjs sync --profile core,coding2 --agent codex --yes
node scripts/manage-skills.mjs sync --all --agent codex --yes
```

Natural-language requests to initialize or sync Skills route here. Omitting both selectors uses `defaultProfiles`; named profiles use `--profile`; all compatible profiles use `--all`, which selects each exclusive group's default. Explicitly selecting more than one member of a group fails before any installation checks.

`plan` and the beginning of `sync` show both installs and removals. Interactive sync prompts only when installation is needed; non-interactive installation uses `--yes` only after plan confirmation. Cleanup-only sync executes without a second prompt. Missing remote Skills sharing source, scope, resolved agents, and `required` policy are installed as one batch. Any required or optional installation failure skips all cleanup. After successful installation, cleanup removes only installed remote catalog Skills managed exclusively by displaced profiles, scoped to the current target agent. Removal is verified by listing installed Skills again; command failures or residual links make sync exit `1`.

Explicit `audit --profile <...>` checks a realizable environment: selected Skills must exist, displaced exclusive Skills are `CONFLICT`, other catalog-managed Skills are ignored, and only identities outside the full catalog are unmanaged. It rejects mutually exclusive selections. Audit without a selector and `audit --all` remain full-catalog checks.

## Discovery and updates

```shell
npx skills find <query> [--owner <owner>]
npx skills add <package> --list
npx skills update --global
npx skills update --project
```

Before `add` or a version update, show source, names, scope, and agents and obtain confirmation. A request to "update my skills" means this version-update workflow only and does not run environment sync. Audit afterward. Audit never calls `remove`.
