import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";

// Global configuration discovery, based on vercel-labs/skills src/agents.ts
// and colbymchenry/codegraph src/installer/targets. Installation is not activity.
export function detectInstalledAgents({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  const configuredHome = (key, fallback) => env[key]?.trim() || join(home, fallback);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const configHome = xdg && isAbsolute(xdg) ? xdg : join(home, ".config");
  const claudeHome = configuredHome("CLAUDE_CONFIG_DIR", ".claude");
  const candidates = {
    codex: [configuredHome("CODEX_HOME", ".codex"), "/etc/codex"],
    "claude-code": [claudeHome, env.CLAUDE_CONFIG_DIR?.trim() ? join(claudeHome, ".claude.json") : join(home, ".claude.json")],
    cursor: [join(home, ".cursor")],
    "gemini-cli": [join(home, ".gemini")],
    opencode: [join(configHome, "opencode")],
    hermes: [configuredHome("HERMES_HOME", ".hermes")],
    kiro: [join(home, ".kiro")],
    antigravity: [join(home, ".gemini", "antigravity")],
    amp: [join(configHome, "amp")],
    cline: [join(home, ".cline")],
    "qwen-code": [join(home, ".qwen")],
    windsurf: [join(home, ".codeium", "windsurf")],
    openclaw: [".openclaw", ".clawdbot", ".moltbot"].map((dir) => join(home, dir)),
  };
  return Object.entries(candidates).flatMap(([agent, paths]) => {
    const evidence = paths.filter((path) => { try { return exists(path); } catch { return false; } });
    return evidence.length ? [{ agent, paths: evidence }] : [];
  });
}

// WorkBuddy (desktop) and the CodeBuddy CLI underneath it are one runtime for
// installation purposes, and the Skills CLI only knows it as `codebuddy`:
// `npx skills add` rejects any --agent value outside its own registry, and its
// codebuddy entry maps to .codebuddy/skills (project) and ~/.codebuddy/skills
// (global). Resolving to `workbuddy` would therefore fail every install, so the
// WorkBuddy markers below intentionally resolve to `codebuddy`.
const CODEBUDDY_ENV_MARKERS = [
  "CODEBUDDY_CONFIG_DIR",
  "CODEBUDDY_SESSION_ID",
  "WORKBUDDY_APP_NAME",
  "WORKBUDDY_CONFIG_DIR",
  "WORKBUDDY_IS_PACKAGED",
  "WORKBUDDY_PRODUCT_NAME",
  "WORKBUDDY_USER_DATA_DIR",
];
const CODEBUDDY_CLIENT_INFO_MARKERS = ["CLIENT_INFO_PLATFORM", "CLIENT_INFO_IDE_TYPE", "CLIENT_INFO_PRODUCT_NAME"];
const CODEBUDDY_HOSTS = new Set(["workbuddy-desktop"]);

function isCodebuddyRuntime(env) {
  if (CODEBUDDY_ENV_MARKERS.some((key) => env[key]?.trim())) return true;
  if (CODEBUDDY_HOSTS.has(env.CODEBUDDY_HOST?.trim())) return true;
  return CODEBUDDY_CLIENT_INFO_MARKERS.some((key) => env[key]?.trim() === "WorkBuddy");
}

export function detectActiveAgents(override, env = process.env, discovery = {}) {
  if (override) return override;

  const configured = env.MY_SKILLS_AGENT?.split(",").map((item) => item.trim()).filter(Boolean);
  if (configured?.length) return configured;

  // A single runtime can match several of its own markers, so collect unique ids.
  const detected = new Set();
  if (
    env.CODEX_SESSION_ID ||
    env.CODEX_THREAD_ID ||
    env.CODEX_CI ||
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE
  ) {
    detected.add("codex");
  }
  if (env.CLAUDECODE === "1") detected.add("claude-code");
  if (isCodebuddyRuntime(env)) detected.add("codebuddy");

  const active = [...detected];
  if (active.length === 1) return active;
  if (active.length > 1) {
    throw new Error(`Active agent is ambiguous (${active.join(", ")}); pass --agent <id>`);
  }
  const installed = detectInstalledAgents({ ...discovery, env }).map(({ agent }) => agent);
  throw new Error("Could not detect the active agent; pass --agent <id> or set MY_SKILLS_AGENT"
    + (installed.length ? `. Installed candidates (not necessarily active): ${installed.join(", ")}` : ""));
}

// The Skills CLI hardcodes ~/.codebuddy/skills for `codebuddy`, while the CodeBuddy
// and WorkBuddy runtimes read $CODEBUDDY_CONFIG_DIR/skills (default ~/.codebuddy).
// When a host redirects that directory, global installs land outside the scan path.
export function codebuddyGlobalSkillsMismatch(env = process.env, home = homedir()) {
  const configDir = env.CODEBUDDY_CONFIG_DIR?.trim();
  if (!configDir) return null;
  const runtimeDir = join(configDir, "skills");
  const cliDir = join(home, ".codebuddy", "skills");
  return resolve(runtimeDir) === resolve(cliDir) ? null : { runtimeDir, cliDir };
}
