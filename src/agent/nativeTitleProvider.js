// All writes are confirmed through the provider's own read API. Agy accepts
// input only in its owning, idle PTY; the daemon checks again on its next poll.
import { claudeTranscriptPathForSession } from "../runtime/claudeConversationHistory.js";
import { CodexAppServerClient } from "../adapters/codex/appServerClient.js";
import { readAgyConversationName, readClaudeTranscriptTitle, safeTitleText } from "./agentTitleSource.js";

export function nativeTitleProvider({ env = process.env } = {}) {
  let codex;
  const client = async () => {
    if (!codex) {
      codex = new CodexAppServerClient({ rpcTimeoutMs: 5000 });
      await codex.connect({ env });
    }
    return codex;
  };
  return {
    async read(row) {
      const id = row.native_session_id;
      if (row.agent_type === "claude") {
        const { getSessionInfo } = await import("@anthropic-ai/claude-agent-sdk");
        const info = await getSessionInfo(id);
        if (info?.customTitle) return { title: safeTitleText(info.customTitle), explicit: true };
        const file = row.transcript_locator || (info?.cwd && /^[a-zA-Z0-9_-]+$/.test(id)
          ? claudeTranscriptPathForSession(info.cwd, id) : "");
        return { title: readClaudeTranscriptTitle(file), explicit: false };
      }
      if (row.agent_type === "codex") {
        const { thread } = await (await client()).readThread(id);
        return { title: safeTitleText(thread?.name), explicit: Boolean(thread?.name) };
      }
      const { title } = readAgyConversationName(id, undefined, {
        expected: row.local_title_request || row.title, authoritative: Boolean(row.title_sync_pending || row.local_title_request),
      });
      return { title, explicit: false };
    },
    async write(row, title) {
      if (row.agent_type === "claude") {
        const { renameSession } = await import("@anthropic-ai/claude-agent-sdk");
        await renameSession(row.native_session_id, title);
      } else if (row.agent_type === "codex") {
        await (await client()).setThreadName(row.native_session_id, title);
      } else {
        return false;
      }
      return (await this.read(row)).title === title;
    },
    close() { codex?.disconnect(); },
  };
}

export async function renameNativeTitle(row, title) {
  const provider = nativeTitleProvider();
  try {
    return await provider.write(row, safeTitleText(title));
  } catch {
    return false;
  } finally {
    provider.close();
  }
}
