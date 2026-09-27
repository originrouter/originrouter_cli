import { AgentCatalog } from "../persistence/agentCatalog.js";
import { permissionConfiguration } from "./agentPermissionState.js";

export function createAgentPermissionStateTracker(metadata, { now = Date.now } = {}) {
  let revision = 0;
  let current = null;
  let boundConversationId = null;
  return {
    get revision() { return revision; },
    capture(configuration, { changed = false, conversationId = metadata.conversationId } = {}) {
      const next = permissionConfiguration(configuration);
      const catalog = new AgentCatalog({ stateDir: metadata.stateDir });
      try {
        const captured = catalog.db.transaction(() => {
          catalog.ensureSessionForPermissionState({ ...metadata, conversationId });
          const saved = catalog.getConversationPermissionState(conversationId);
          const nextRevision = !current || changed || conversationId !== boundConversationId
            ? Math.max(now(), revision + 1, Number(saved?.revision || 0) + 1)
            : revision;
          const state = { ...next, revision: nextRevision, sessionId: metadata.sessionId };
          catalog.saveConversationPermissionState(metadata.sessionId, state);
          return state;
        })();
        current = captured;
        revision = captured.revision;
        boundConversationId = conversationId;
        return revision;
      } finally {
        catalog.close();
      }
    },
  };
}
