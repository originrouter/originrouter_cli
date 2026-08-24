import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@originrouter/cli";
const MODULE_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function ancestorDirectories(path) {
  const values = [];
  let current = resolve(path);
  const root = parse(current).root;
  while (true) {
    values.push(current);
    if (current === root) return values;
    current = dirname(current);
  }
}

function isPnpmLayout(path) {
  return path.includes(`${join("node_modules", ".pnpm")}`)
    || ancestorDirectories(path).some((dir) => existsSync(join(dir, "node_modules", ".modules.yaml")));
}

function isBunLayout(path) {
  return path.includes(".bun/install/global") || path.includes(".bun\\install\\global");
}

function linkedPackageRoot(packageRoot) {
  try {
    const lexicalRoot = resolve(packageRoot);
    const parent = dirname(lexicalRoot);
    const entry = join(parent, "cli");
    return existsSync(entry) && lstatSync(entry).isSymbolicLink();
  } catch {
    return false;
  }
}

export function detectInstallContext({
  packageRoot = MODULE_PACKAGE_ROOT,
  entryPath = process.argv[1],
  env = process.env,
} = {}) {
  const lexicalRoot = resolve(packageRoot);
  let canonicalRoot = lexicalRoot;
  try { canonicalRoot = realpathSync(lexicalRoot); } catch {}
  const paths = [lexicalRoot, canonicalRoot, resolve(entryPath || lexicalRoot)];
  const inNodeModules = paths.some((path) => path.includes(`${join("node_modules", "@originrouter", "cli")}`));
  const linked = linkedPackageRoot(lexicalRoot)
    || (!inNodeModules && existsSync(join(canonicalRoot, ".git")));

  let method = "source";
  if (!linked && paths.some(isPnpmLayout)) method = "pnpm";
  else if (!linked && (paths.some(isBunLayout) || /\bbun\//.test(env.npm_config_user_agent || ""))) method = "bun";
  else if (!linked && inNodeModules) method = "npm";

  const commands = {
    npm: { command: "npm", args: ["install", "--global", `${PACKAGE_NAME}@latest`] },
    pnpm: { command: "pnpm", args: ["add", "--global", `${PACKAGE_NAME}@latest`] },
    bun: { command: "bun", args: ["install", "--global", `${PACKAGE_NAME}@latest`] },
  };
  const action = commands[method] || null;
  let writable = false;
  if (action) {
    try {
      accessSync(dirname(lexicalRoot), fsConstants.W_OK);
      writable = true;
    } catch {}
  }
  return {
    method,
    package_root: canonicalRoot,
    package_json_path: join(lexicalRoot, "package.json"),
    linked,
    writable,
    command: action?.command || null,
    args: action?.args || [],
    command_string: action ? [action.command, ...action.args].join(" ") : null,
  };
}

export function readInstalledVersion(installContext) {
  const path = installContext?.package_json_path
    || (installContext?.package_root ? join(installContext.package_root, "package.json") : null);
  if (!path) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return typeof value?.version === "string" ? value.version.trim() : null;
  } catch {
    return null;
  }
}
