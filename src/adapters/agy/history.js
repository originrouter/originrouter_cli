import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { displaySafeToolInput } from '../../runtime/displaySafeToolInput.js';

export function agyTranscriptPath(sessionId, home = homedir()) {
  if (!/^[a-zA-Z0-9_-]{1,191}$/.test(String(sessionId || ''))) return null;
  return join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
}

export function agyTranscriptRows(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (Number.isInteger(row.step_index)) rows.set(row.step_index, row);
  }
  return rows;
}

export function agyTranscriptItems(text, { includeToolStarts = true, toolIdsByStep = new Map() } = {}) {
  const rows = agyTranscriptRows(text);
  const items = [], tools = [];
  let sampledTokens = 0;
  for (const row of [...rows.values()].sort((a, b) => a.step_index - b.step_index)) {
    if (row.status && !['DONE', 'ERROR'].includes(row.status)) continue;
    const base = { id: `agy-step-${row.step_index}`, sequence: row.step_index,
      createdAt: row.created_at, timestamp: row.created_at };
    const eventItem = (suffix, event) => items.push({ ...base, id: `${base.id}${suffix}`, role: 'event', event });
    if (row.type === 'USER_INPUT') {
      const content = String(row.content || '');
      const match = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
      items.push({ ...base, role: 'user', text: match ? match[1] : content });
    } else if (row.type === 'PLANNER_RESPONSE') {
      if (typeof row.thinking === 'string' && row.thinking) eventItem(':thinking', { type: 'agent.thinking', provider: 'agy', text: row.thinking.slice(0, 64000) });
      if (row.content) items.push({ ...base, role: 'assistant', text: String(row.content), model: row.model });
      for (const [index, tool] of (Array.isArray(row.tool_calls) ? row.tool_calls : []).entries()) {
        const callId = tool.id || `${base.id}:tool-${index}`;
        tools.push(callId);
        if (includeToolStarts) eventItem(`:tool-${index}`, { type: 'agent.tool_call.start', provider: 'agy', callId,
          tool: tool.name || 'Tool', input: displaySafeToolInput(tool.args) });
      }
      if (Number.isFinite(row.input_tokens) || Number.isFinite(row.output_tokens)) {
        const count = value => Math.max(0, Number(value) || 0);
        const inputTokens = count(row.input_tokens) + count(row.cache_read_tokens), outputTokens = count(row.output_tokens);
        sampledTokens += inputTokens + outputTokens;
        eventItem(':usage', { type: 'agent.usage', provider: 'agy', sampledTokens,
          tokenUsage: { inputTokens, outputTokens, cacheReadInputTokens: count(row.cache_read_tokens) }, amountMicros: null, costSource: 'unsupported' });
      }
    } else if (row.type === 'GENERIC') {
      const fallbackId = tools.shift();
      if (row.status && !['DONE', 'ERROR'].includes(row.status)) continue;
      eventItem('', { type: 'agent.tool_call.end', provider: 'agy', callId: toolIdsByStep.get(row.step_index) || fallbackId || base.id,
        content: String(row.content || '').slice(0, 64000), isError: row.status === 'ERROR',
        ...(row.error ? { error: String(row.error) } : {}) });
    }
  }
  return items;
}

export function readAgyConversationHistory(transcriptPath, { beforeCursor = null, limit = 50 } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) return { messages: [], nextCursor: null, hasMore: false };
  if (statSync(transcriptPath).size > 32 * 1024 * 1024) throw new Error('Antigravity transcript exceeds the local history size limit');
  const nativeId = basename(dirname(dirname(dirname(transcriptPath))));
  const all = agyTranscriptItems(readFileSync(transcriptPath, 'utf8')).map(item => ({ ...item,
    messageId: `${nativeId}:${item.id}`, ...(item.event ? { event: { ...item.event, eventId: `${nativeId}:${item.id}` } } : {}) }));
  const end = beforeCursor == null ? all.length : Math.max(0, Math.min(all.length, Number(beforeCursor) || 0));
  const minimum = Math.max(0, end - Math.min(100, Math.max(1, Number(limit) || 50)));
  const messages = [];
  let bytes = 0, start = end;
  for (let i = end - 1; i >= minimum; i--) {
    const item = { ...all[i], ...(all[i].text ? { text: all[i].text.slice(0, 64000) } : {}) };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (messages.length && bytes + size > 96000) break;
    messages.unshift(item); bytes += size; start = i;
  }
  return { messages, nextCursor: start ? String(start) : null, hasMore: start > 0 };
}
