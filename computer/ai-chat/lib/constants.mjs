import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const __dirname = dirname(dirname(fileURLToPath(import.meta.url)));
// Honor PORT (set by some launchers) then AI_CHAT_PORT (the .env knob), else 3456.
export const PORT = parseInt(process.env.PORT || process.env.AI_CHAT_PORT || "3456", 10);
// Bind address for the cockpit. Default to loopback: the cockpit enforces no
// token of its own and is meant to sit behind the FastAPI proxy (which checks
// OWNER_TOKEN) or a localhost/tailnet-only path. Override with HOST=0.0.0.0
// ONLY behind your own firewall/auth — never expose :3456 to the open internet.
export const HOST = process.env.AI_CHAT_HOST || process.env.HOST || "127.0.0.1";
export const HOME = process.env.HOME || "/home/user";
// Workspace lock (guest cockpit — docs/decisions/20260707-scoped-guest-cockpit.md):
// when set, every session is pinned inside this directory and the workspace
// picker offers only it. Unset (the default) = zero behavior change; this is a
// UX/workspace pin for a trusted guest's dedicated cockpit instance, NOT an OS
// security boundary.
export const WORKSPACE_LOCK = process.env.SHELLTEAM_WORKSPACE_LOCK
  ? resolve(process.env.SHELLTEAM_WORKSPACE_LOCK)
  : null;
export const GUEST_NAME = process.env.SHELLTEAM_GUEST_NAME || null;
export const PUBLIC_DIR = join(__dirname, "public");
export const SESSION_FILE = join(HOME, ".claude-chat-session.json");
export const API_KEY_FILE = join(HOME, ".config", "shellteam", "api-key");
export const OPENAI_API_KEY_FILE = join(HOME, ".config", "shellteam", "openai-api-key");
export const CREDENTIALS_FILE = join(HOME, ".claude", ".credentials.json");
export const CODEX_AUTH_FILE = join(HOME, ".codex", "auth.json");
// Antigravity CLI (`agy`) writes its Google-OAuth token here after sign-in. The
// filename is `antigravity-oauth-token` (verified against agy 1.0.16 — NOT
// `oauth_tokens.json`, which the CLI never writes); its existence = signed-in.
export const ANTIGRAVITY_AUTH_FILE = join(HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token");
export const CLAUDE_CONFIG_FILE = join(HOME, ".claude.json");
export const MODEL_FILE = join(HOME, ".claude-chat-model.txt");
export const TABS_FILE = join(HOME, ".claude-chat-tabs.json");
export const CODEX_HISTORY_DIR = join(HOME, ".config", "shellteam", "codex-history");
export const BROKER_STATE_FILE = join(HOME, ".config", "shellteam", "delegation-broker.json");
export const MAX_HISTORY = 500;
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol-max";
export const DEFAULT_ANTIGRAVITY_MODEL = "gemini-3.1-pro";
// Back-compat alias — the generic "default model" is the Claude default.
export const DEFAULT_MODEL = DEFAULT_CLAUDE_MODEL;

export const BROKER_SLOT_POOLS = {
  ma: [1000, 1001, 1002, 1003],
  guest: [1100, 1101],
};

export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
export const OAUTH_SCOPES =
  "org:create_api_key user:profile user:inference user:mcp_servers user:sessions:claude_code";

export const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
