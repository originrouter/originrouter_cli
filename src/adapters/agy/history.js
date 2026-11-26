import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { displaySafeToolInput } from '../../runtime/displaySafeToolInput.js';

export function agyTranscriptPath(sessionId, home = homedir()) {
  if (!/^[a-zA-Z0-9_-]{1,191}$/.test(String(sessionId || ''))) return null;
  return join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
}

// Before starting an unnamed native process we only need byte offsets, not
// the contents of the user's histories. Native row times have second precision.
export function agyTranscriptOffsets(home = homedir()) {
  const offsets = new Map();
  const brain = join(home, '.gemini', 'antigravity-cli', 'brain');
  let entries;
  try { entries = readdirSync(brain, { withFileTypes: true }); } catch { return offsets; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const stat = statSync(agyTranscriptPath(entry.name, home));
      offsets.set(entry.name, { ino: stat.ino, size: stat.size });
    } catch { /* A new or empty conversation may have no transcript yet. */ }
  }
  return offsets;
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

export function agyTranscriptItems(text, { includeToolStarts = true } = {}) {
  const rows = agyTranscriptRows(text);
  const sortedRows = [...rows.values()].sort((a, b) => a.step_index - b.step_index);
  // Pre-pair completed GENERIC result rows with their PLANNER_RESPONSE tool
  // calls in FIFO order so history renders use the exact same deterministic
  // `step-${step_index}` callId as live hooks and live scans.
  const pairedCallIds = new Map();
  if (includeToolStarts) {
    const pendingSlots = [];
    for (const row of sortedRows) {
      if (row.status && !['DONE', 'ERROR'].includes(row.status)) continue;
      if (row.type === 'PLANNER_RESPONSE') {
        for (const [index] of (Array.isArray(row.tool_calls) ? row.tool_calls : []).entries()) {
          pendingSlots.push(`${row.step_index}:${index}`);
        }
      } else if (row.type === 'GENERIC') {
        const slot = pendingSlots.shift();
        if (slot) pairedCallIds.set(slot, `step-${row.step_index}`);
      }
    }
  }
  const items = [], tools = [];
  let sampledTokens = 0;
  for (const row of sortedRows) {
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
        const callId = (includeToolStarts && pairedCallIds.get(`${row.step_index}:${index}`))
          || tool.id || `${base.id}:tool-${index}`;
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
      // Live scans pair the end with the hook-emitted start, whose callId is
      // `step-${stepIdx}` — and stepIdx is the trajectory step index of this
      // very result row, verified against real hook payloads. History renders
      // pair the end FIFO with this row's planner's generated start ids
      // instead, since those starts carry `agy-step-*` ids, not `step-*`.
      eventItem('', { type: 'agent.tool_call.end', provider: 'agy',
        callId: includeToolStarts ? (fallbackId || base.id) : `step-${row.step_index}`,
        content: String(row.content || '').slice(0, 64000), isError: row.status === 'ERROR',
        ...(row.error ? { error: String(row.error) } : {}) });
    }
  }
  return items;
}

// The last model the conversation reported, or null. The runtime's own words
// on a resume: the CLI only names it in the hook payload of a turn, so a run
// that opens an existing conversation and sits idle would otherwise have no
// model to report until the next message.
export function agyTranscriptModel(text) {
  let model = null;
  for (const row of agyTranscriptRows(text).values()) {
    if (row.type === 'PLANNER_RESPONSE' && typeof row.model === 'string' && row.model.trim()) {
      model = row.model.trim();
    }
  }
  return model;
}

export function readAgyConversationHistory(transcriptPath, { beforeCursor = null, limit = 50 } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) return { messages: [], nextCursor: null, hasMore: false };
  if (statSync(transcriptPath).size > 32 * 1024 * 1024) throw new Error('Antigravity transcript exceeds the local history size limit');
  const nativeId = basename(dirname(dirname(dirname(transcriptPath))));
  const all = agyTranscriptItems(readFileSync(transcriptPath, 'utf8')).map((item, sequence) => ({ ...item, sequence,
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
