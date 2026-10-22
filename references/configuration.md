# Catalog configuration

`pluginset.json` is the version-controlled source of truth. Never add generated paths, credentials, system Skills, or plugin-cache Skills.

Only entries in the current catalog are managed. Deleting an entry ends management; there is no historical ownership registry. Execution, installed-source conflict checks, and cleanup rules are defined in [operations.md](operations.md).

```json
{
  "schemaVersion": 1,
  "defaultProfiles": ["core"],
  "profiles": {
    "core": { "description": "Skills installed everywhere" },
    "coding-a": {
      "description": "Coding toolset A",
      "exclusiveGroup": "coding",
      "defaultInExclusiveGroup": true
    },
    "coding-b": {
      "description": "Coding toolset B",
      "exclusiveGroup": "coding"
    }
  },
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
- Profiles with the same non-empty, case-sensitive `exclusiveGroup` are mutually exclusive for `plan`, `sync`, and explicit-profile audit; surrounding whitespace is ignored. A group must contain at least two profiles and exactly one must set `defaultInExclusiveGroup: true`.
- `defaultInExclusiveGroup` requires `exclusiveGroup`. It is used by `plan --all` and `sync --all`; it does not implicitly add a profile to ordinary selections or to `defaultProfiles`.
- `defaultProfiles` may name a non-default member of an exclusive group, but it must not contain more than one member of the same group.
- `package` is a Skills CLI source: preferably `owner/repository`/trusted Git URL, or an explicitly path-shaped local source.
- `names`, `profiles`, and `agents` are non-empty arrays. A name is unique per scope; combine profiles instead of duplicating it.
- `scope` is `global` or `project`.
- `agents: ["detected"]` must stand alone. It targets the active runtime, not `*`, and does not guarantee exclusive visibility when CLI storage is shared.
- `required: true` stops sync when its installation batch fails; optional failures are summarized and also prevent cleanup.
- `reviewed: true` is required for installation. Provenance confidence and content review are separate decisions.

## Exclusive Skill and plugin entries

Individual `skills[]` and `plugins[]` entries may also declare `exclusiveGroup` and `defaultInExclusiveGroup`. Profile groups, Skill-entry groups, and plugin-entry groups are separate namespaces, even when their names match. Each entry group needs at least two entries and exactly one boolean `defaultInExclusiveGroup: true`; a default field requires a group. Group names are non-empty, case-sensitive strings with surrounding whitespace trimmed. All Skills in one entry group must have the same `scope`. A Skill entry's entire `names` array is selected or displaced together.

Entry exclusivity applies across all profile memberships, including shared entries. `--choose <group>=<name>` is an invocation-local override, not a configuration field; a Skill name selects its entire `names` entry. Selection precedence, command restrictions, and cleanup checks are in [operations.md](operations.md#entry-alternatives).

The shipped `docs` profile contains `op7418/humanizer-zh` and `LifelongLazyLearner/qu-ai-wei` in entry group `chinese-humanizer`, defaulting to `humanizer-zh`. Both are optional, global, and target `detected`.

## External plugins

### Exclusive plugin profiles

The shipped plugins each use their own same-name profile: `gitnexus`, `codegraph`, and `codebase-memory-mcp`. All three have `exclusiveGroup: "codegraph"`; only profile `codegraph` has `defaultInExclusiveGroup: true`. The existing `mattpocock` and `superpowers` profiles remain in the separate `coding` group. Selecting a workflow alone no longer selects a plugin.

Plugin profiles use the same group schema as Skill profiles. Multiple memberships mean the plugin belongs to any listed profile, not that every profile must be selected. A shared plugin alone does not identify a unique replacement profile; select a profile or a compatible single-profile plugin when replacement is intended. See [operations.md](operations.md#external-plugin-lifecycle) for lifecycle and full-uninstall behavior.

Optional `setupCommand` and `updateCommand` may be omitted or set to JSON `null`. A null setup command is skipped; a null update command means updates are unsupported and an explicit update request fails before mutations. Required command fields, command array elements, and platform-map values cannot be null. Empty strings, objects, and arrays remain invalid.

The same `pluginset.json` may contain a top-level `plugins` array without changing the catalog version: `schemaVersion` remains `1`. Plugin entries are consumed only by `scripts/manage_plugins.mjs`; the existing Skill manager continues to operate on `skills`.

Each plugin entry has these fields:

| Field | Required | Rule |
| --- | --- | --- |
| `name` | Yes | Non-empty identifier, globally unique case-insensitively across plugins. |
| `profiles` | Yes | Non-empty array; every name must exist in the shared top-level `profiles` object. |
| `checkCommand` | Yes | Read-only availability check; exit status zero means the CLI is present. |
| `installCommand` | Yes | One CommandSpec or a non-empty ordered array of CommandSpec values to install the CLI or binary. |
| `setupCommand` | No | One CommandSpec or a non-empty ordered array of CommandSpec values to configure the integration. |
| `uninstallCommands` | Yes | Non-empty ordered array of cleanup commands. |
| `reviewed` | Yes | Boolean installation trust gate. |
| `updateCommand` | No | One CommandSpec or a non-empty ordered array; required for the update operation. |
| `agents` | No | `["detected"]` or a non-empty list of explicit agent names; `detected` must appear alone. |
| `agentMap` | No | Required for each resolved target when `agents` is present; maps agent names to upstream argument values. |
| `exclusiveGroup` | No | Non-empty entry group, independent of profile and Skill groups; at least two plugin entries per group. |
| `defaultInExclusiveGroup` | No | Boolean; requires `exclusiveGroup`, with exactly one true default per entry group. |

### Plugin agent targets

```json
{
  "agents": ["detected"],
  "agentMap": { "codex": "codex" },
  "setupCommand": {
    "default": "codegraph install --target={agent} --location=global --yes",
    "win32": "codegraph.cmd install --target={agent} --location=global --yes"
  }
}
```

Use explicit names such as `["codex", "claude-code"]` to configure multiple agents. Every actual target must have its own `agentMap` entry, even when commands do not contain placeholders. Map keys, values, and agent names accept only ASCII letters, digits, hyphens, and underscores. Empty maps, arrays, null mappings, and missing mappings are errors. The shipped plugins initially map only `codex`; verify a tool's upstream parameter before adding other mappings.

`--agent a,b` (repeatable) resolves only `detected`; explicitly configured agents are not overridden. Resolution order is CLI override, `MY_SKILLS_AGENT`, then the active runtime. Supported runtime markers and installed-agent discovery are documented in [agent-detection.md](agent-detection.md).

After selecting the platform, each command containing `{agent}` expands in target order. Arrays execute command-first: command 1 for every target, then command 2. Targets mapping to the same upstream value execute that command once. Commands without `{agent}` execute once, including shared CLI installation, update, and removal. `checkCommand` cannot contain `{agent}`. All selected targets and commands are resolved before any availability check. Errors identify the failed target and stop subsequent commands and plugins.

Legacy entries without `agents` retain their behavior, but cannot contain `{agent}` or `agentMap`. Removal remains a full uninstall: target selection does not protect other agents from shared CLI removal or upstream commands that remove all integrations. The preview explicitly reports this scope; there is no separate `--uninstall-cli` option.

`checkCommand` and every member of `uninstallCommands` use one `CommandSpec`. `installCommand`, `setupCommand`, and `updateCommand` accept either one `CommandSpec` or a non-empty array of them:

```text
CommandSpec = non-empty string
            | {
                default?: non-empty string,
                win32?: non-empty string,
                linux?: non-empty string,
                darwin?: non-empty string
              }
```

For a platform map, the manager first selects the key equal to `process.platform`, then falls back to `default`. If neither exists for the current platform, validation fails. Unknown platform keys and empty command strings are invalid.

Before any command runs, validation rejects duplicate plugin names, empty arrays, unknown profile references, missing required fields, unknown plugin fields, and non-boolean `reviewed` values. Plugin profile membership does not inherit `defaultProfiles`; callers must explicitly select a profile, plugin name, or `--all`.

Command arrays may mix strings and platform maps. Nested arrays and empty arrays are invalid. Each command uses a separate shell process, so shell variables and directory changes do not carry over to the next command. Windows npm-installed CLIs should use explicit `.cmd` entries, avoiding PowerShell execution-policy dependence on `.ps1` shims. Lifecycle order and availability checks are described in operations.

```json
{
  "installCommand": [
    {
      "default": "npm install -g some-tool",
      "win32": "npm.cmd install -g some-tool"
    },
    "some-tool download-runtime"
  ],
  "setupCommand": "some-tool setup"
}
```

## Shared entries

Shared Skills belong to multiple profiles in one catalog entry, for example `"profiles": ["coding-a", "coding-b"]`. Do not duplicate a Skill entry: names remain unique per scope. Profile sharing protects against profile-only cleanup; entry exclusivity remains independent. Command-specific selection and audit behavior are in operations.

## Local sources

Treat absolute paths, `./`, `../`, `.`, `..`, and Windows drive paths as local. `skills/example` is remote shorthand; use `./skills/example` for a relative path. Local entries are managed inventory but non-portable: restoration reports/skips them, and audit does not also mark them unmanaged.

## Agent resolution

Resolve `detected` in order: manager `--agent`, `MY_SKILLS_AGENT`, then active runtime markers. Stop on no match or ambiguity; see [agent-detection.md](agent-detection.md). Skills CLI chooses the physical directory from scope and agent; verify `skills list --json` when isolation matters rather than assuming a fixed path.

## Add an entry

1. Find a candidate if needed; inspect owner, repository, contents, and risk.
2. Confirm exact names with `npx skills add <package> --list`.
3. Record the smallest correct entry, keeping new/unreviewed content `reviewed: false` until explicitly approved.
4. Run `plan` and show it before installation.
