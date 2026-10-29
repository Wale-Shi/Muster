# Muster — agent guide

Muster is an open-source, self-hostable take on todos.dev. Read `docs/PLAN.md` first: it is the spec.

## Rules
- TypeScript everywhere, ESM, strict mode. Node >= 22 (use built-in `node:sqlite`, no native deps).
- npm workspaces: `packages/shared`, `apps/server`, `apps/daemon`, `apps/web`. Do not introduce pnpm/yarn/bun.
- Keep modules small and readable; no speculative abstractions. Match surrounding style.
- Every package has `build`, `test` (Vitest) and `typecheck` scripts; root scripts fan out to them.
- Never call real model APIs in tests: use the `mock` runtime.
- Keep changes focused on the issue at hand and leave unrelated local work untouched.
- Do not commit unless the user asks you to.
- Finish by running `npm run typecheck && npm test` for what you touched and report results honestly.
