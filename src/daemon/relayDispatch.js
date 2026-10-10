/**
 * The daemon's relay dispatch chain, as a callable function.
 *
 * This used to be three lines inline in `connectEvents`, which is where the
 * `agent.workspace.browse` outage lived: `collaborationRuntime` grew a
 * responder for a type `sessionManager` already answered, sat earlier in this
 * chain, and returned `true` for frames that were not really its own — so the
 * chain stopped there and the phone waited out its 30-second timeout. Nothing
 * about the symptom pointed at the chain, because nothing in it was testable.
 *
 * Order is the contract: each handler returns `true` only for frames it owns,
 * and the first `true` ends the chain. A type belongs to exactly one handler.
 * Tests should drive this function, not call `handleRelayEvent` directly —
 * a direct call skips the chain, and a chain-level bug is invisible to it.
 *
 * Pure move: the logic is unchanged from `daemon.js`.
 */
export function createRelayDispatch({ collaborationRuntime, externalAgentRelayRouter, sessionManager }) {
  return async function dispatchRoutedRelayEvent(routed) {
    const collaborationHandled = await collaborationRuntime.handleRelayEvent(routed);
    if (collaborationHandled) return true;
    const externalHandled = await externalAgentRelayRouter.handle(routed);
    if (externalHandled) return true;
    sessionManager.handleEvent(routed);
    return true;
  };
}
