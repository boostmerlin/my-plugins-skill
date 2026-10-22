# Source provenance

Use the deterministic script for installed non-system Skills; never infer provenance from names or layouts.

```shell
node scripts/manage-skills.mjs sources [skill ...] [--json] [--verify-remote]
```

The working directory defines project scope. Global and project results remain separate. `--json` returns stable `{ "schemaVersion": 1, "results": [], "diagnostics": [] }`; each result includes `name`, `scope`, `status`, `source`, `sourceType`, `installedPath`, `skillPath`, `evidence`, `conflicts`, and `errors`. Unresolved/error results exit `1` but preserve the report.

## Evidence and status

Evidence order:

1. Global/project `npx skills list --json`.
2. Global `~/.agents/.skill-lock.json` or project `skills-lock.json`.
3. Installed path's real target and Git `remote.origin.url`, only when that repository tracks the exact resolved Skill directory's `SKILL.md`.
4. With `--verify-remote` only, `npx skills add <source> --list` for an unresolved candidate.

Missing locks are normal. Report malformed or unfamiliar locks and use readable known fields. If CLI listing fails, continue with lock records but do not treat lock-only data as proof of installation. Normalize GitHub shorthand, HTTPS, `.git`, and SSH forms to `owner/repository`; never silently resolve conflicting identities.

Resolve installation links before inspecting Git. Finding an enclosing repository is insufficient: an untracked `.agents/skills/example/SKILL.md` inside an unrelated project must not inherit that project's origin. Match the exact repository-relative `SKILL.md` path, including literal characters such as brackets. When it is untracked, omit Git evidence and retain the CLI/lock evidence without adding a source conflict. A tracked file may still have local modifications; tracking establishes repository membership, not byte integrity.

- `CONFIRMED`: CLI and matching lock sources agree.
- `VERIFIED`: Git origin or explicit remote listing independently corroborates a source.
- `CANDIDATE`: one uncorroborated hint or conflicting evidence.
- `UNKNOWN`: no credible hint.
- `LOCAL`: path-shaped local source without conflicting remote evidence.

This proves provenance, not byte integrity; do not interpret `skillFolderHash` as a local modification check.

These confidence levels govern source confirmation and export, not ordinary catalog ownership. Lifecycle operations do not require a new provenance database, Git inspection, or network verification when installation metadata is absent. Their explicit source/local/protected conflict rules are in [operations.md](operations.md#installed-identity-and-mutation-checks).

## Export

- Propose only `CONFIRMED`/`VERIFIED` remote sources.
- Require user review for `CANDIDATE`; never use same-name presence alone as proof.
- Leave `UNKNOWN` installed and unmanaged; never delete it.
- Exclude `LOCAL` from cross-machine restoration proposals; intentionally cataloged local inventory remains restore-skipped.
- Exclude `.codex/skills/.system` and `.codex/plugins/cache`.
