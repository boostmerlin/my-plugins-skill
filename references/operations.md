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

`--profile` accepts comma-separated profiles. `--all` selects every profile currently declared in `skillset.json`, so callers do not need to enumerate names; it cannot be combined with `--profile`. `detected` resolves to the active runtime; outside a recognized session, pass `--agent` or set `MY_SKILLS_AGENT`. It never resolves to `*`, though shared CLI storage may expose a Skill to compatible agents.

Local catalog sources are inventory-only: `plan`/`init` report `SKIP`, `audit` reports `LOCAL`, and restoration does not install them. `audit` exits `1` on drift; `sources` exits `1` on unresolved provenance or operational errors. Both only report.

## Initialization

```shell
node scripts/manage-skills.mjs init --profile core,coding
node scripts/manage-skills.mjs init --profile core,coding --agent codex --yes
node scripts/manage-skills.mjs init --all --agent codex --yes
```

When the user asks to initialize all/every profile, use `--all` instead of listing profile names. Omitting both selectors still uses `defaultProfiles`.

First show the plan and obtain confirmation. Interactive runs prompt; non-interactive runs use `--yes` only after confirmation. Missing remote Skills sharing source, scope, resolved agents, and `required` policy are installed as one batch. Required-batch failure stops; optional failures are collected while other batches continue. A retry skips completed installs.

## Discovery and updates

```shell
npx skills find <query> [--owner <owner>]
npx skills add <package> --list
npx skills update --global
npx skills update --project
```

Before `add` or `update`, show source, names, scope, and agents and obtain confirmation. Audit afterward. Initialization and audit never call `remove`.
