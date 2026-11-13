# Contributing

Thanks for your interest in Mission Control for Claude Code. Issues and pull requests are welcome, in English or French.

## Prerequisites

- Node.js 20 or later.
- Yarn 4, enabled with `corepack enable`. The repo uses Yarn Plug'n'Play, so do not use npm.
- A C++ toolchain may be needed to build `better-sqlite3` if no prebuilt binary exists. On Debian/Ubuntu: `sudo apt install build-essential python3`.
- Claude Code installed, so that `~/.claude/` contains real session data to test against.

## Development

```bash
yarn install
yarn dev        # API on http://127.0.0.1:4517 and Vite UI; open http://localhost:5173
yarn test       # vitest, server workspace
yarn typecheck  # both workspaces
yarn build
```

Always run the server through `yarn` (for example `yarn build && yarn start`). A bare `node` command fails under Plug'n'Play.

## Guidelines

- Use conventional commits: `<type>: <description>`, with a type of feat, fix, refactor, docs, test, chore, perf or ci.
- Add or update vitest tests for server logic. `yarn test` and `yarn typecheck` must pass.
- Pin dependencies to exact versions (no `^` or `~` ranges). Pin GitHub Actions to a full commit SHA, not a tag.
- Keep the app local-only. The server must stay bound to `127.0.0.1`. Any new `/api/*` route is covered by the Host/Origin guard in `server/src/local-guard.ts`. Do not bypass it.
- Never commit personal data. Do not put real transcripts, paths or emails in tests or fixtures. Use `/home/user/...` and `me@example.com` instead.

## Pull requests

1. Fork the repository and create a branch.
2. Keep each pull request focused on one change.
3. Describe the change and how you tested it.
4. Make sure CI passes.

## Security issues

Do not open a public issue for a security problem. See [SECURITY.md](./SECURITY.md).
