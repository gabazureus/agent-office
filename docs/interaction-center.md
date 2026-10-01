# Agent interaction center

The bottom dock is the office-wide home for structured requests that pause a worker. It receives
requests over the existing worker hook or ACP connection, broadcasts them over the existing office
WebSocket, and sends the selected protocol response back to the exact provider callback. It never
parses terminal pixels or types an answer into a PTY.

## Lifecycle and safety

- `InteractionCenter` normalizes provider requests into a bounded browser-safe model. Correlation
  includes the worker and provider, and every browser reply carries an opaque id plus a version.
- Active requests are written mode `0600` and restored after an office restart. The provider hook
  retries during that restart and reattaches its private response encoder; provider-specific raw
  payloads are not sent to browsers or saved in the queue.
- Only option and field ids advertised by the provider are accepted. The first valid response wins;
  stale or duplicate clients cannot apply a second decision.
- For SDK-mediated replies, the item remains `sending` until the provider acknowledges the SDK
  call. A rejected call becomes a retryable error without claiming that the worker was unblocked.
- Worker exit/removal, provider cancellation, and deadlines close the request. Resolved items stay
  visible briefly so every open client can show the outcome.
- UI text is rendered as text nodes. Control characters and common credential forms are removed,
  values are bounded, secret answers are not persisted, and the audit log contains only request id,
  decision id, time, worker, provider, and responding client.

## Provider coverage

| Provider | Native requests handled in the dock | Protocol limits kept by the UI |
| --- | --- | --- |
| Claude Code | `PermissionRequest`, `AskUserQuestion`, and `ExitPlanMode` | One-shot allow plus only the permission scopes Claude suggests; deny/cancel are returned through the documented blocking hook output. |
| OpenCode | Permission and question events | Permission choices are exactly `once`, `always`, and `reject`; `always` stores only OpenCode's proposed project patterns. Questions use the SDK request id. |
| DeepSeek Harness | ACP `session/request_permission` | The dock shows and returns only the choice ids advertised in that ACP request. The terminal prompt remains a race-safe fallback. |
| Codex CLI | Native `PermissionRequest` | The current CLI hook can return one-shot allow or deny. Its `request_user_input` lifecycle event has no CLI hook response contract, so the dock clearly marks that request as a terminal fallback instead of inventing a reply. Moving Codex workers to the Codex App Server protocol would enable native question replies in a future adapter. |

Providers that expose only terminal text remain unchanged until they gain a structured request and
reply contract. Adding one requires an adapter `interaction` normalizer whose response encoder stays
on the server, rather than adding provider rules to the client.

## Client behavior

The dock is present in both the 3D and Lite clients. Its collapsed state reports the actionable
count; the expanded panel keeps simultaneous requests separate, prioritizes risky blocking work,
and shows recent outcomes. Escape collapses without answering, all controls are keyboard reachable,
new requests use a polite live-region announcement, and the details area scrolls independently so
the exact action buttons remain visible.
