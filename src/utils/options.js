export function parseOptions(args) {
  const options = {};
  const rest = [];

  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--relay") {
      options.relay = args[index + 1];
      index += 1;
      continue;
    }
    if (item === "--relay-mode") {
      options.relayMode = args[index + 1];
      index += 1;
      continue;
    }
    if (item === "--device") {
      options.device = args[index + 1];
      index += 1;
      continue;
    }
    if (item === "--executor") {
      options.executor = args[index + 1];
      index += 1;
      continue;
    }
    if (item === "--local-port") {
      const raw = args[index + 1];
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`--local-port must be an integer in [0, 65535] (got '${raw}')`);
      }
      options.localPort = parsed;
      index += 1;
      continue;
    }
    if (item === "--bind") {
      options.bind = args[index + 1];
      index += 1;
      continue;
    }
    if (item === "--allow-lan") {
      options.allowLan = true;
      continue;
    }
    rest.push(item);
  }

  return { options, rest };
}
