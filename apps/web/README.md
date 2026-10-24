# Muster web (M3)

React 19, TypeScript, Vite, Tailwind v4, TanStack Query, React Router,
react-markdown/remark-gfm, dnd-kit, and Lucide. Fonts are bundled locally.

From the repository root:

```sh
npm install
npm run dev --workspace @muster/web
npm run typecheck --workspace @muster/web
npm run build --workspace @muster/web
npm test --workspace @muster/web
```

The dev server uses port 5173 and proxies `/api` and `/mcp` to
`http://localhost:7420`. Production output is `apps/web/dist`.
`npm run dev` at the root starts both server and web concurrently. `npm run build && npm start` serves the production SPA from 7420.

Keyboard: Cmd/Ctrl+B sidebar, Cmd/Ctrl+K search, N new task,
Cmd/Ctrl+Alt+B workspace board, Cmd/Ctrl+Alt+Enter review completion.
Search uses Tab/Shift+Tab for categories and arrow keys/Enter for results.
Enter sends messages; Shift+Enter inserts a newline.

Theme defaults to the system setting and cycles System → Dark → Light.
Sidebar state, workspace divider, todo divider, and board visibility persist
in localStorage. On small screens use the panel buttons or horizontal swipes.

## Integrated server contract (M4)

Shared models and event schemas in `packages/shared` define the contract. The pending steer tray loads from REST, supports edit/retract before dispatch, displays in-flight delivery, and removes messages only after an ACK event. Usage comes from server-side turn snapshots and includes Chief; changing an agent does not rewrite old breakdowns. Chief activity restores from persisted topic fields. Unread badges remain local to the browser session.

SSE provides persistent IDs and replay after `Last-Event-ID`. Deltas carry message/turn IDs plus complete message snapshots and increasing revisions. The client upserts these and reconciles history fetch races without duplicating replayed text.

Board dragging supports Review → Done. Other phases dropped into Done show an explanation; task-to-composer drops become removable number references.

Tests cover all phase mappings, the seven-day Done cutoff, diff parsing and
filtering, rendered board placement, and streaming cache reconciliation.
