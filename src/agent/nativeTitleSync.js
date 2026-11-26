import { exchangeNativeTitles, redactAgentActivityText } from "./bridgeReporter.js";
import { nativeTitleProvider } from "./nativeTitleProvider.js";
import { accountSelectionRoot, activeAccountStateDir } from "../persistence/accounts.js";

const PAGE = 16;
const SCAN_CURSOR = "native_title_scan_cursor";
const PENDING_CURSOR = "native_title_pending_cursor";

// One worker per daemon. Only it applies cloud revisions to the local catalog.
// A read and its revision travel together; a failed network call leaves the
// desired name on the server for the next poll.
export function createNativeTitleSync({ catalog, registry, exchange = exchangeNativeTitles,
  providerFactory = nativeTitleProvider, isCurrent } = {}) {
  const root = accountSelectionRoot(catalog.stateDir);
  const current = isCurrent || (() => activeAccountStateDir(root) === catalog.stateDir);
  const options = { stateDir: catalog.stateDir, expectedAccountStateDir: catalog.stateDir, accountSelectionRoot: root };
  let inFlight;
  let nextScan = 0;
  async function sync(online) {
    if (!current()) return;
    const after = catalog.getMeta(PENDING_CURSOR) || "";
    const page = online ? await exchange({ pending_after: after, observations: [] }, options) : { pending: [] };
    if (!page || !current()) return;
    const rows = new Map();
    const add = row => { if (row) rows.set(row.conversation_id, row); };
    for (const hint of page.pending) add(catalog.nativeTitleRow(hint.agent_type, hint.native_session_id));
    const scan = Date.now() >= nextScan;
    const batch = scan ? catalog.nativeTitleRows(catalog.getMeta(SCAN_CURSOR) || "", PAGE) : [];
    for (const entry of batch) add(catalog.nativeTitleRowById(entry.conversation_id));
    const byNative = new Map([...rows.values()].map(row => [row.agent_type + ":" + row.native_session_id, row]));
    const provider = providerFactory();
    const applyNative = async (row, title, revision) => {
      const facts = registry?.sessionFacts(row.session_id);
      const liveCodex = row.agent_type === "codex" && facts?.attached && facts.runtime === "codex-app-server";
      if (!liveCodex && row.agent_type !== "agy") return provider.write(row, title).catch(() => false);
      if (liveCodex || (facts?.attached && facts.runtime === "agy-pty" && !facts.pendingInteractions)) {
        try {
          registry.enqueueCommand(row.session_id, {
            type: "agent.command", targetNativeSessionId: row.native_session_id,
            ...(revision ? { titleRevision: revision } : { localTitleRequest: title }),
            command: { kind: "slash", name: "rename", args: title },
          });
        } catch (error) {
          if (!["SESSION_NOT_ACTIVE", "SESSION_NOT_FOUND"].includes(error.code)) throw error;
        }
      }
      // Queue acceptance is not native confirmation.
      return false;
    };
    const observation = async row => {
      const native = await provider.read(row).catch(() => null);
      const confirmed = Boolean(row.title_sync_pending && native?.title === row.title);
      return { agent_type: row.agent_type, native_session_id: row.native_session_id,
        revision: row.title_revision, requested_title: row.local_title_request || "", confirmed, explicit: Boolean(native?.explicit),
        title: native?.title === row.title && row.title_revision > 0 ? row.title : redactAgentActivityText(native?.title || "", 191) };
    };
    try {
      if (!online) {
        for (const row of rows.values()) {
          if (!current() || row.title_revision || row.title_sync_pending) continue;
          if (row.local_title_request) {
            await applyNative(row, row.local_title_request, 0);
          }
          const native = await provider.read(row).catch(() => null);
          if (native?.title && current()) catalog.applyOfflineTitle(row, native);
        }
        if (scan) {
          catalog.setMeta(SCAN_CURSOR, batch.length === PAGE ? batch.at(-1).conversation_id : "");
          nextScan = Date.now() + (batch.length === PAGE ? 10_000 : 60_000);
        }
        return;
      }
      const observations = [];
      for (const row of rows.values()) observations.push(await observation(row));
      const response = observations.length ? await exchange({ observations, pending_after: after }, options) : { states: [] };
      if (!response || !current()) return;
      const receipts = [];
      for (const state of response.states) {
        if (!current()) return;
        const row = byNative.get(state.agent_type + ":" + state.native_session_id);
        if (!row || !Number.isSafeInteger(state.revision) || state.revision <= 0
            || typeof state.title !== "string" || !catalog.applyCloudTitle(row, state) || !state.pending) continue;
        const target = { ...row, local_title_request: "", title: state.title, title_revision: state.revision, title_sync_pending: true };
        let receipt = await observation(target);
        if (!receipt.confirmed && current() && await applyNative(target, state.title, state.revision)) {
          receipt = { ...receipt, confirmed: true, title: state.title };
        }
        if (receipt.confirmed) receipts.push(receipt);
      }
      if (receipts.length && current()) {
        const ack = await exchange({ observations: receipts }, options);
        if (!ack || !current()) return;
        for (const state of ack.states) {
          const row = byNative.get(state.agent_type + ":" + state.native_session_id);
          if (row) catalog.applyCloudTitle({ ...row, local_title_request: "" }, state);
        }
      }
      catalog.setMeta(PENDING_CURSOR, page.pending.length < 32 ? "" : page.pending.at(-1).conversation_id);
      if (scan) {
        catalog.setMeta(SCAN_CURSOR, batch.length === PAGE ? batch.at(-1).conversation_id : "");
        nextScan = Date.now() + (batch.length === PAGE ? 10_000 : 60_000);
      }
    } finally {
      provider.close();
    }
  }
  return (online = true) => inFlight ||= sync(online).finally(() => { inFlight = null; });
}
