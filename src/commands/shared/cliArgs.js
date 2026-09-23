/**
 * Side-effect-free helpers shared by command handlers.
 *
 * Command modules all receive argv arrays. Keeping the common `--name value`
 * and `--name=value` behavior here avoids a collection of subtly different
 * implementations while preserving the existing command grammar.
 */

function optionName(name) {
  const value = String(name || "");
  return value.startsWith("--") ? value : `--${value}`;
}

export function optionValues(args = [], name) {
  const option = optionName(name);
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = String(args[index]);
    if (item === option && index + 1 < args.length && !String(args[index + 1]).startsWith("--")) {
      values.push(String(args[index + 1]));
      index += 1;
      continue;
    }
    if (item.startsWith(`${option}=`)) values.push(item.slice(option.length + 1));
  }
  return values;
}

export function optionValue(args = [], name) {
  return optionValues(args, name).at(-1);
}

export function hasOption(args = [], name) {
  const option = optionName(name);
  return args.some((item) => String(item) === option);
}

export function parseOptionArgs(args = [], { booleanFlags = [] } = {}) {
  const options = {};
  const booleans = new Set(booleanFlags.map(optionName));
  for (let index = 0; index < args.length; index += 1) {
    const key = String(args[index]);
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = args[index + 1];
    if (!value || String(value).startsWith("--")) {
      if (booleans.has(key)) {
        options[key] = true;
        continue;
      }
      throw new Error(`Missing value for ${key}`);
    }
    options[key] = String(value);
    index += 1;
  }
  return options;
}
