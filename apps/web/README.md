# Muster web (M3)

React 19, TypeScript, Vite, Tailwind v4, TanStack Query, React Router,
react-markdown/remark-gfm, dnd-kit, and Lucide. Fonts are bundled locally.

From the repository root:

```sh
npm install --package-lock=false
npm run dev --workspace @muster/web
npm run typecheck --workspace @muster/web
npm run build --workspace @muster/web
npm test --workspace @muster/web
```

The dev server uses port 5173 and proxies `/api` and `/mcp` to
`http://localhost:7420`. Production output is `apps/web/dist`.
M3 changes only `apps/web`; the coordinator must regenerate the root
`package-lock.json` before using `npm ci`.

Keyboard: Cmd/Ctrl+B sidebar, Cmd/Ctrl+K search, N new task,
Cmd/Ctrl+Alt+B workspace board, Cmd/Ctrl+Alt+Enter review completion.
Search uses Tab/Shift+Tab for categories and arrow keys/Enter for results.
Enter sends messages; Shift+Enter inserts a newline.

Theme defaults to the system setting and cycles System → Dark → Light.
Sidebar state, workspace divider, todo divider, and board visibility persist
in localStorage. On small screens use the panel buttons or horizontal swipes.

## M1 contract limits and client behavior

- No queued-message list, delivery event, edit, or retract endpoint exists.
  The tray shows messages observed via SSE in this browser session, labels
  delivery as unknown, and clears at turn completion. It does not claim
  that a queued message is still undelivered.
- Usage is aggregate-only. Client breakdowns load todo builds, exclude Chief,
  use current agent/model assignments, and group days by build creation date.
  Workspace totals come directly from `/api/usage` and include Chief.
- Topics expose no persisted active-turn or unread state. Chief activity and
  unread indicators reflect events observed during this browser session;
  associated todo phases can be restored from REST.
- SSE has no replay IDs, and delta payloads omit message/turn IDs. One
  EventSource updates message caches directly, buffers messages during the
  initial history fetch, and reconciles history at completion/reconnect.
  Independently concurrent Chief turns on the same topic cannot be reliably
  separated by the client until REST reconciliation.
- Board dragging supports the server's Review → Done action. Other phases
  dropped into Done show an explanation; arbitrary phase moves are not
  attempted. Task-to-composer drops become removable number references.

Tests cover all phase mappings, the seven-day Done cutoff, diff parsing and
filtering, rendered board placement, and streaming cache reconciliation.
