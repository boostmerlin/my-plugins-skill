# Agent detection: source analysis and local behavior

## Upstream implementations

- [skills: src/agents.ts](https://github.com/vercel-labs/skills/blob/main/src/agents.ts) defines a registry containing each agent's skill paths and `detectInstalled` function. `detectInstalledAgents` evaluates these functions with `Promise.all`, returning every match. Most rules check configuration directories, with some checking files, application locations, or project dependencies. It honors overrides such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `HERMES_HOME`, and XDG configuration paths. A shared `.agents/skills` directory alone does not establish which agent is installed.
- [CodeGraph: targets/registry.ts](https://github.com/colbymchenry/codegraph/blob/main/src/installer/targets/registry.ts) calls each target's `detect(location)`. Results distinguish `installed`, `alreadyConfigured`, and the integration configuration path. Targets support global/local scope independently. Its `auto` selection returns all installed targets, falling back to Claude when none match. An existing MCP entry establishes CodeGraph integration state, not an active session.
- [CodeGraph Claude detection](https://github.com/colbymchenry/codegraph/blob/main/src/installer/targets/claude.ts) also recognizes the global `.claude.json` file. [OpenCode detection](https://github.com/colbymchenry/codegraph/blob/main/src/installer/targets/opencode.ts) uses XDG paths even on Windows; legacy AppData paths are migration evidence rather than the current configuration location.

## Adaptation

`scripts/agent-detection.mjs` keeps runtime detection separate from global installation discovery. Configuration files can remain after uninstall, and several agents can be installed simultaneously, so discovery is evidence of configuration presence, not proof of activity or CLI availability.

Default `detected` still uses explicit override, then `MY_SKILLS_AGENT`, then the current runtime. The recognized runtimes are **Codex**, **Claude Code** (`CLAUDECODE === "1"`), and **WorkBuddy / CodeBuddy** (see below). Missing runtime evidence reports installed candidates without choosing one. Ambiguous runtime evidence still fails — e.g. `CODEX_THREAD_ID` and `CODEBUDDY_SESSION_ID` together throw `Active agent is ambiguous (...)`.

### WorkBuddy / CodeBuddy runtime

WorkBuddy (desktop) and the CodeBuddy CLI underneath it are treated as **one** runtime for installation purposes, and resolve to the Skills CLI agent id **`codebuddy`** — never `workbuddy`.

Why `codebuddy`, not `workbuddy`: the Skills CLI only accepts ids from its own registry (`codex`, `claude-code`, `codebuddy`, …). Its `codebuddy` entry maps to `.codebuddy/skills` (project) and `~/.codebuddy/skills` (global). `npx skills add … --agent workbuddy` is rejected by the CLI, so resolving to `workbuddy` would break every install. The WorkBuddy markers below therefore intentionally resolve to `codebuddy`, even though the runtime environment variable is `WORKBUDDY_*`.

Recognition (any one is sufficient, via `isCodebuddyRuntime` in `scripts/agent-detection.mjs`):

- Any of these env vars set to a non-empty value:
  `CODEBUDDY_CONFIG_DIR`, `CODEBUDDY_SESSION_ID`, `WORKBUDDY_APP_NAME`, `WORKBUDDY_CONFIG_DIR`, `WORKBUDDY_IS_PACKAGED`, `WORKBUDDY_PRODUCT_NAME`, `WORKBUDDY_USER_DATA_DIR`.
- `CODEBUDDY_HOST === "workbuddy-desktop"`.
- Any of `CLIENT_INFO_PLATFORM`, `CLIENT_INFO_IDE_TYPE`, `CLIENT_INFO_PRODUCT_NAME` equals `"WorkBuddy"`.

A single runtime matches several of its own markers, so detected ids are collected in a `Set` and de-duplicated before the count check — multiple WorkBuddy markers do **not** count as ambiguity.

A runtime id of `codebuddy` does **not** always mean `~/.codebuddy/skills` is the active global scope. The Skills CLI hardcodes `~/.codebuddy/skills`, whereas the CodeBuddy/WorkBuddy runtime reads `$CODEBUDDY_CONFIG_DIR/skills` (default `~/.codebuddy`). When a host redirects that directory, global installs land outside the scan path. `codebuddyGlobalSkillsMismatch(env, home)` compares the two and returns `{ runtimeDir, cliDir }` when they differ. `doctor` surfaces this as a `[WARN]` (read-only, no change), e.g. `Skills CLI writes C:\Users\bespb\.codebuddy\skills, this runtime scans C:\Users\bespb\.workbuddy\skills`. Remediation: set `CODEBUDDY_CONFIG_DIR=~/.codebuddy` (or symlink the redirected directory back), so both the CLI write path and the runtime scan path agree.

Note: WorkBuddy injects Claude Code compatibility variables (e.g. `CLAUDE_SESSION_ID`, `CLAUDE_PROJECT_DIR`) into the session. These are **not** treated as activity evidence — the detector only accepts `CLAUDECODE === "1"` for claude-code, so the presence of `CLAUDE_SESSION_ID` alone does not silently switch the detected agent to `claude-code`.

Plugin `--detect-installed` explicitly resolves `detected` to all discovered global candidates, bypassing runtime/environment target selection. It cannot be combined with `--agent`; explicit catalog agent lists remain authoritative. No candidates is an error, and every candidate requires a plugin-specific `agentMap` entry before any command executes. There is no implicit Claude fallback or silent filtering to supported mappings.

The initial discovery registry covers Codex, Claude Code, Cursor, Gemini CLI, OpenCode, Hermes, Kiro, Antigravity, Amp, Cline, Qwen Code, Windsurf, and OpenClaw (including legacy directory aliases). It is a deliberately bounded adaptation, not a copy of every upstream adapter. It only checks global paths, not project files, executables, running processes, or integration contents; no directory creation or package execution is involved. Environment/home/path probing is injectable for deterministic tests. Runtime and installed discovery are shared code without a dependency on either upstream package. **Adding the `codebuddy` runtime detection did not expand the global-config discovery registry** — that list still reports install evidence only and is separate from runtime activity.
