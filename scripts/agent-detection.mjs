import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";

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

export function detectActiveAgents(override, env = process.env, discovery = {}) {
  if (override) return override;

  const configured = env.MY_SKILLS_AGENT?.split(",").map((item) => item.trim()).filter(Boolean);
  if (configured?.length) return configured;

  const detected = [];
  if (
    env.CODEX_SESSION_ID ||
    env.CODEX_THREAD_ID ||
    env.CODEX_CI ||
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE
  ) {
    detected.push("codex");
  }
  if (env.CLAUDECODE === "1") detected.push("claude-code");

  if (detected.length === 1) return detected;
  if (detected.length > 1) {
    throw new Error(`Active agent is ambiguous (${detected.join(", ")}); pass --agent <id>`);
  }
  const installed = detectInstalledAgents({ ...discovery, env }).map(({ agent }) => agent);
  throw new Error("Could not detect the active agent; pass --agent <id> or set MY_SKILLS_AGENT"
    + (installed.length ? `. Installed candidates (not necessarily active): ${installed.join(", ")}` : ""));
}
