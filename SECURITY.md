# Security Policy

## Supported versions

Only the latest release receives security fixes. Please upgrade before reporting an issue that may already be fixed.

## Reporting a vulnerability

Report vulnerabilities privately with GitHub private vulnerability reporting:

- Go to the repository's **Security** tab and click **Report a vulnerability**, or open
  https://github.com/Tibeno88/mission-control-for-claude-code/security/advisories/new

Never open a public issue for a vulnerability.

Please include:

- the affected version (`version` in `package.json`, or the commit hash)
- steps to reproduce, ideally with a minimal request or payload
- the impact you expect (what data or action is exposed)

This is a personal project with no response-time guarantee. Reports are handled on a best-effort basis.

## Threat model

Mission Control is designed for a single user on their own machine.

- The server binds to `127.0.0.1` only and has **no authentication**.
- It reads sensitive data: Claude Code transcripts in `~/.claude/` (prompts, answers, project paths). It never writes to `~/.claude/`.
- Every `/api/*` route and the `/ws` WebSocket reject a non-local `Host` header (`127.0.0.1` or `localhost`) and an `Origin` that is not local and same-origin with `Host`. This protects against DNS rebinding and cross-site WebSocket hijacking from a web page open in the same browser.
- The TASKS routes spawn the `claude` CLI (`claude -p` / `--resume`) with a user-supplied prompt and working directory. Their mutations also require `Content-Type: application/json`, which forces a CORS preflight. The `bypassPermissions` mode is refused. Inputs are validated: absolute existing working directory, model name, permission mode, and size limits.
- Local data (SQLite `cmc.db` and gzip archives) stays in `CMC_DATA_DIR` (default `~/.claude-mission-control`) and is never sent anywhere.
- Outbound network: at startup the server fetches the public LiteLLM pricing JSON from `raw.githubusercontent.com`. No user data is sent. If the fetch fails (offline), it falls back to the embedded pricing table.

## Out of scope

- Exposing the port beyond localhost (LAN, reverse proxy, tunnel, or container port publishing). This is unsupported. Anyone who can reach the port can read all transcripts.
- Other OS users or processes on the same machine can reach `127.0.0.1`. Multi-user hosts are not protected.
- Vulnerabilities in Claude Code itself. Report those to Anthropic.
