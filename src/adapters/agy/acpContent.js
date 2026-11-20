// Content is supplied by the paired App, never fetched from a URL or read
// from a client-supplied local path. Keep it within the existing relay budget.
export const AGY_PROMPT_CONTENT_LIMIT = 768_000;

export function agyPromptContent(message, content, capabilities = {}) {
  if (content == null) return message ? [{ type: 'text', text: message }] : null;
  if (!Array.isArray(content) || content.length > 8 || Buffer.byteLength(JSON.stringify(content)) > AGY_PROMPT_CONTENT_LIMIT) return null;
  const blocks = message ? [{ type: 'text', text: message }] : [];
  for (const block of content) {
    if (block?.type === 'image' && capabilities.image === true &&
        /^image\/(png|jpeg|webp|gif)$/.test(block.mimeType || '') &&
        typeof block.data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(block.data)) {
      blocks.push({ type: 'image', mimeType: block.mimeType, data: block.data });
    } else if (block?.type === 'resource' && capabilities.embeddedContext === true &&
        typeof block.resource?.text === 'string' && typeof block.resource?.uri === 'string' &&
        block.resource.uri.startsWith('originrouter-attachment:')) {
      blocks.push({ type: 'resource', resource: { uri: block.resource.uri,
        mimeType: 'text/plain', text: block.resource.text } });
    } else return null;
  }
  return blocks.length ? blocks : null;
}

export function agyCommands(commands) {
  if (!Array.isArray(commands)) return [];
  const names = new Set();
  const entries = commands.slice(0, 128).flatMap(command => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(command?.name || '') || names.has(command.name)) return [];
    names.add(command.name);
    return [{ name: command.name, description: String(command.description || '').slice(0, 2048),
      argumentHint: String(command.input?.hint || '').slice(0, 256),
      availableDuringTask: false, source: 'native', route: 'inject' }];
  });
  for (const name of ['rename', 'export', 'quit']) if (!names.has(name)) entries.push({ name,
    ...(name === 'quit' ? { aliases: ['exit'] } : {}), source: 'app', route: 'app',
    description: name === 'rename' ? 'Rename this session' : name === 'export' ? 'Export the conversation' : 'End this session', availableDuringTask: true });
  return entries;
}

export function agyToolContent(content, rawOutput) {
  if (!Array.isArray(content)) return typeof rawOutput === 'string' ? rawOutput.slice(0, 64000) : JSON.stringify(rawOutput ?? '').slice(0, 64000);
  return content.map(item => {
    if (item.type === 'content' && item.content?.type === 'text') return item.content.text;
    if (item.type === 'diff') return `${item.path || ''}\n---\n${item.oldText || ''}\n+++\n${item.newText || ''}`;
    if (item.type === 'terminal') return `Terminal: ${item.terminalId || ''}`;
    return '';
  }).filter(Boolean).join('\n').slice(0, 64000);
}
