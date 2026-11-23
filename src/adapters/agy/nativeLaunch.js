// Startup source is metadata, never an agent protocol selector.
export function agyManagedCommand(conversation) {
  const runtime = conversation?.runs?.[0]?.runtime;
  return runtime === 'agy-acp' ? 'agy-acp' : 'agy';
}

export function agySessionArguments(args = []) {
  const launchArgs = [];
  let initialMessage = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--prompt-interactive', '-i'].includes(arg)) initialMessage = args[++i] || '';
    else if (arg.startsWith('--prompt-interactive=')) initialMessage = arg.slice(21);
    else if (arg === '--resume') launchArgs.push('--conversation', args[++i]);
    else if (arg.startsWith('--resume=')) launchArgs.push(arg.replace('--resume=', '--conversation='));
    else launchArgs.push(arg);
  }
  return { args: launchArgs, initialMessage };
}

export function replaceAgyFlags(args, overrides) {
  const keys = new Set(Object.keys(overrides).map(key => `--${key}`));
  const next = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].split('=')[0];
    if (overrides.conversation && ['-c', '--continue'].includes(flag)) continue;
    if (keys.has(flag)) { if (!args[i].includes('=')) i++; }
    else next.push(args[i]);
  }
  for (const [key, value] of Object.entries(overrides)) if (value != null) next.push(`--${key}`, String(value));
  return next;
}
