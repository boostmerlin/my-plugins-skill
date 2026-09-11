# Agent detection: source analysis and local behavior

## Upstream implementations

- [skills: src/agents.ts](https://github.com/vercel-labs/skills/blob/main/src/agents.ts) defines a registry containing each agent's skill paths and `detectInstalled` function. `detectInstalledAgents` evaluates these functions with `Promise.all`, returning every match. Most rules check configuration directories, with some checking files, application locations, or project dependencies. It honors overrides such as `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `HERMES_HOME`, and XDG configuration paths. A shared `.agents/skills` directory alone does not establish which agent is installed.
- [CodeGraph: targets/registry.ts](https://github.com/colbymchenry/codegraph/blob/main/src/installer/targets/registry.ts) calls each target's `detect(location)`. Results distinguish `installed`, `alreadyConfigured`, and the integration configuration path. Targets support global/local scope independently. Its `auto` selection returns all installed targets, falling back to Claude when none match. An existing MCP entry establishes CodeGraph integration state, not an active session.
- [CodeGraph Claude detection](https://github.com/colbymchenry/codegraph/blob/main/src/installer/targets/claude.ts) also recognizes the global `.claude.json` file. [OpenCode detection](https://github.com/colbymchenry/codegraph/blob/main/src/installer/targets/opencode.ts) uses XDG paths even on Windows; legacy AppData paths are migration evidence rather than the current configuration location.

## Adaptation

`scripts/agent-detection.mjs` keeps runtime detection separate from global installation discovery. Configuration files can remain after uninstall, and several agents can be installed simultaneously, so discovery is evidence of configuration presence, not proof of activity or CLI availability.

Default `detected` still uses explicit override, then `MY_SKILLS_AGENT`, then the current Codex/Claude Code runtime. Missing runtime evidence reports installed candidates without choosing one. Ambiguous runtime evidence still fails.

Plugin `--detect-installed` explicitly resolves `detected` to all discovered global candidates, bypassing runtime/environment target selection. It cannot be combined with `--agent`; explicit catalog agent lists remain authoritative. No candidates is an error, and every candidate requires a plugin-specific `agentMap` entry before any command executes. There is no implicit Claude fallback or silent filtering to supported mappings.

The initial discovery registry covers Codex, Claude Code, Cursor, Gemini CLI, OpenCode, Hermes, Kiro, Antigravity, Amp, Cline, Qwen Code, Windsurf, and OpenClaw (including legacy directory aliases). It is a deliberately bounded adaptation, not a copy of every upstream adapter. It only checks global paths, not project files, executables, running processes, or integration contents; no directory creation or package execution is involved. Environment/home/path probing is injectable for deterministic tests. Runtime and installed discovery are shared code without a dependency on either upstream package.
