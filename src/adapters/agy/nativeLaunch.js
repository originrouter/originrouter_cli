// Startup source is metadata, never an agent protocol selector.
export function agyManagedCommand(conversation) {
  const runtime = conversation?.runs?.[0]?.runtime;
  return runtime === 'agy-acp' ? 'agy-acp' : 'agy';
}

const valueFlags = new Set([
  '--add-dir', '--agent', '--conversation', '--resume', '-r', '--effort', '--input-format',
  '--json-schema', '--log-file', '--mode', '--model', '--new-project', '--output-format',
  '--print-timeout', '--project', '--settings', '--prompt-interactive', '-i', '--prompt',
]);

const aliases = new Map([['-r', '--conversation'], ['--resume', '--conversation'],
  ['-i', '--prompt-interactive'], ['-c', '--continue']]);

export function* agyArguments(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      yield { key: '--', raw: args.slice(i) };
      break;
    }
    const split = arg.indexOf('=');
    const name = split < 0 ? arg : arg.slice(0, split);
    const key = aliases.get(name) || name;
    const takesValue = valueFlags.has(name) || (name.startsWith('--originrouter-')
      && name !== '--originrouter-auto-approve');
    const raw = [arg];
    if (takesValue && split < 0 && i + 1 < args.length) raw.push(args[++i]);
    yield { key, raw, value: split < 0 ? raw[1] : arg.slice(split + 1) };
  }
}

export function agyOption(args, key) {
  let result;
  for (const option of agyArguments(args)) if (option.key === key) result = option.value;
  return result || null;
}

export function agySessionArguments(args = []) {
  const launchArgs = [];
  let initialMessage = null;
  for (const { key, raw, value } of agyArguments(args)) {
    if (key === '--prompt-interactive') initialMessage = value || '';
    else if (key === '--conversation' && value && raw[0] !== key && !raw[0].startsWith(key + '=')) {
      launchArgs.push(key, value);
    } else launchArgs.push(...raw);
  }
  return { args: launchArgs, initialMessage };
}

export function agyHandoverArgs(args, nativeId, { managed = false } = {}) {
  const remove = new Set(['--conversation', '--continue', '--prompt', '--prompt-interactive',
    '--originrouter-session', '--originrouter-run', '--originrouter-conversation',
    '--originrouter-task', '--originrouter-title']);
  if (managed) {
    for (const key of ['--originrouter-autonomy', '--originrouter-policy', '--originrouter-auto-allow',
      '--originrouter-auto-approve']) remove.add(key);
  }
  const kept = nativeId ? ['--conversation', nativeId] : [];
  for (const { key, raw } of agyArguments(args)) {
    if (!remove.has(key) && key !== '--') kept.push(...raw);
  }
  return kept;
}

export function replaceAgyFlags(args, overrides) {
  const keys = new Set(Object.keys(overrides).map(key => `--${key}`));
  const next = [];
  let trailing = [];
  for (const { key, raw } of agyArguments(args)) {
    if (key === '--') trailing = raw;
    else if (!keys.has(key) && !(overrides.conversation && key === '--continue')) next.push(...raw);
  }
  for (const [key, value] of Object.entries(overrides)) if (value != null) next.push(`--${key}`, String(value));
  return [...next, ...trailing];
}
