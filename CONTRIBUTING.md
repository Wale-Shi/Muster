# Contributing to Muster

Read [AGENTS.md](AGENTS.md), [docs/PLAN.md](docs/PLAN.md) (the spec), and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before making changes. The
[daemon](apps/daemon/README.md) and [web](apps/web/README.md) guides describe
their package-specific contracts.

## Development

Use a current Node.js 22 release (or Node 24), npm, and Git. With nvm installed,
`nvm install && nvm use` selects the version in `.nvmrc`.

```sh
npm ci
npm run dev
```

In a second terminal, run `npm run daemon`, then open <http://localhost:5173>.
Use a disposable Git repository and mock agents for local experiments. Set
Chief to mock too if you want to try orchestration without a model account.

## Conventions

- Use TypeScript, ESM, and strict mode. Keep modules small and match nearby code.
- Use npm workspaces: `packages/shared`, `apps/server`, `apps/daemon`, and
  `apps/web`. Do not introduce another package manager or native SQLite dependencies.
- Keep domain schemas and shared protocol types in `packages/shared`; update
  architecture documentation when changing contracts.
- Preserve unrelated local work and keep changes focused on the issue or milestone.
- Use the mock runtime or local protocol peers in tests. Never call real model APIs
  in tests or require provider credentials in CI.
- When changing dependencies, use npm and include the matching `package-lock.json`.
  Verify `npm ci` succeeds without pre-existing build output.

Each package provides `build`, `test`, and `typecheck` scripts; root commands
run across workspaces. A focused check can use, for example,
`npm test --workspace @muster/daemon`.

## Validation

Run the full checks before submitting:

```sh
npm run typecheck && npm test
npm run build
npm run e2e
```

Build before e2e: it starts the compiled server and a mock-only daemon in temporary
directories. It verifies plan/confirm/build/review/merge, steering, parallel worktrees,
Chief MCP delegation, production SPA routes, and SSE replay. It cleans up its
processes and data. Tests use temporary repositories and do not need a configured
Git identity or model credentials. CI runs these checks on Node 22, 24 and 25 on
Linux.

## Issues and pull requests

For bugs, include reproduction steps, expected and actual behavior, OS, Node/npm
versions, and relevant logs with secrets removed. For feature proposals, explain
the workflow and check the deferred features in PLAN §1 first.

For pull requests, explain the problem, resulting behavior, and validation results.
Include screenshots for UI changes and document any configuration changes.

Contributions are provided under the project's [MIT license](LICENSE).
