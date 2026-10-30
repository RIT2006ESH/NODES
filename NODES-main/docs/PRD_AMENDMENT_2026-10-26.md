# PRD amendment - 2026-10-26 (owner)

**Status:** authoritative for V1. `docs/PRD.md` is deliberately unchanged; this
document records the owner's overrides of two PRD rules.

**Owner:** Ritesh Singh

## A-1: remove the automatic starter link (overrides PRD 6.2)

Every newcomer joins **isolated**. Joining never creates a link, never emits a
starter-link event, and never defers an edge to a later Build. There is no
starter link for the first node or for any later node. The old
`starter` / `pendingStarter` fields are kept only so older saved Lines can still
be loaded; new joins always write them as `false`.

Consequences:

- A player who joins during Build, Warning, Repair or Result remains isolated.
- Existing historical starter edges in an old `data/line.json` are not deleted by
  the loader. They are rendered with the old starter marker so they remain
  distinguishable from player-created edges.
- The first connection for any player must be requested and accepted under A-2.

## A-2: consent-first, own-node-only connections (overrides PRD 6.3)

A player may request **only a connection between their own node and one target
node**. Third-party helper links are forbidden.

1. A selects B and chooses **Request Connection**.
2. B sees who is requesting and chooses **Accept** or **Decline**.
3. Only **Accept** creates one server-authoritative edge and broadcasts it.
4. Decline, expiry, failure or a dropped request creates no edge.

The requester sees one of `Pending`, `Accepted`, `Declined`, `Expired` or
`Failed`. Pending requests are never counted or rendered as active edges; their
indicator is amber and dashed. The server owns all request state; a client cannot
create an edge by changing local state or by sending a legacy link-creation
command. Accepted, declined, expired and failed requests are kept as a bounded
server-memory history so a repeated response replays the same terminal outcome
instead of creating a second edge; only pending requests appear in snapshots.

### Validation and timing

- Both nodes must exist, be active and be distinct.
- The requester must own the source node through its session.
- The target must not already be linked to the requester.
- The degree cap, token balance, phase restriction and Line ownership are checked
  when the request is made **and again when the target accepts**.
- Requests expire after `links.requestTtlMs` (default `30000` ms). Expiry is
  checked on the 5 Hz tick and when a response arrives.
- Tokens are charged only when Accept successfully creates the edge. A duplicate
  request, pending request or declined request costs no token.
- Only the named target session may Accept or Decline. Other sessions receive a
  failed response and cannot affect the request.
- Pending requests are ephemeral server memory: they survive a target reconnect
  through snapshots, but not a server restart. Accepted edges, sessions and
  positions remain in the normal persisted state.

## A-3: protocol v2

`create_link` is removed from the supported client protocol. The replacement
messages are `request_link` and `respond_link`, with server messages
`link_request` and `request_result`. `PROTOCOL_VERSION` is `2`.

## References

- PRD 6.2 (starter link) and 6.3 (helper links) are overridden by A-1 and A-2.
- Movement, outage, scoring and persistence rules are unchanged.
- `docs/DECISIONS.md` D-26 through D-29 record the decision and its consequences.
- `docs/STATUS.md` records the implementation, tests and browser verification.
