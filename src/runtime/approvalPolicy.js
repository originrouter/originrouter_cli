import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { INTERACTION_KINDS } from "./agentInteractionContract.js";

export const APPROVAL_POLICY_VERSION = 1;

export const APPROVAL_POLICY_EFFECTS = Object.freeze([
  "allow",
  "deny",
  "ask",
]);

export const APPROVAL_POLICY_ACTIONS = Object.freeze([
  "agent.plan.continue",
  "agent.input.answer",
  "agent.form.submit",
  "agent.url.open",
  "secret.input",
  "fs.read",
  "fs.list",
  "fs.search",
  "fs.create",
  "fs.write",
  "fs.append",
  "fs.patch",
  "fs.copy",
  "fs.move",
  "fs.delete",
  "fs.permissions.write",
  "fs.unknown",
  "process.exec",
  "process.signal",
  "shell.dynamic",
  "code.python.execute",
  "code.javascript.execute",
  "code.shell.execute",
  "code.opaque",
  "network.dns.resolve",
  "network.connect",
  "network.listen",
  "network.http.read",
  "network.http.write",
  "network.transfer.upload",
  "network.transfer.download",
  "vcs.read",
  "vcs.write",
  "vcs.destructive",
  "vcs.remote.read",
  "vcs.remote.write",
  "package.read",
  "package.install",
  "package.remove",
  "package.publish",
  "db.read",
  "db.insert",
  "db.update",
  "db.delete",
  "db.schema.create",
  "db.schema.alter",
  "db.schema.drop",
  "db.transaction",
  "db.admin",
  "db.unknown",
  "system.service.read",
  "system.service.manage",
  "system.identity.manage",
  "system.schedule.manage",
  "system.storage.manage",
  "infra.read",
  "infra.write",
  "infra.destroy",
  "permission.additional",
  "tool.unknown",
]);

const EFFECT_SET = new Set(APPROVAL_POLICY_EFFECTS);
const ACTION_SET = new Set(APPROVAL_POLICY_ACTIONS);
const CONDITION_OPERATORS = new Set([
  "exists",
  "not_exists",
  "eq",
  "neq",
  "glob",
  "not_glob",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "path_under",
  "path_equals",
  "in",
  "not_in",
  "intersects",
  "contains_all",
  "lt",
  "lte",
  "gt",
  "gte",
  "between",
]);
const POLICY_KEYS = new Set([
  "$schema",
  "version",
  "id",
  "name",
  "description",
  "defaults",
  "rules",
  "declarations",
  "metadata",
]);
const DEFAULT_KEYS = new Set([
  "unmatched",
  "parse_error",
  "unknown",
]);
const RULE_KEYS = new Set([
  "id",
  "effect",
  "priority",
  "actions",
  "tools",
  "when",
  "reason",
  "enabled",
]);
const DECLARATION_KEYS = new Set([
  "id",
  "match",
  "replaces_opaque",
  "emits",
  "description",
  "enabled",
]);
const CONDITION_FIELDS = new Set([
  "action",
  "risk",
  "confidence",
  "provider",
  "runtime",
  "interaction.kind",
  "interaction.source",
  "tool.name",
  "command.raw",
  "command.executable",
  "command.argv",
  "command.cwd",
  "command.dynamic",
  "command.segment",
  "resource.kind",
  "resource.path",
  "resource.uri",
  "network.protocol",
  "network.host",
  "network.port",
  "network.method",
  "database.engine",
  "database.operation",
  "database.database",
  "database.schema",
  "database.tables",
  "code.language",
  "code.script",
  "code.module",
  "code.sha256",
  "declaration.id",
]);
const MAX_POLICY_BYTES = 1_048_576;
const MAX_RULES = 256;
const MAX_DECLARATIONS = 128;
const MAX_CONDITION_DEPTH = 16;
const MAX_CONDITION_NODES = 1024;

const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "stat", "file", "wc"]);
const SEARCH_COMMANDS = new Set(["grep", "rg", "find", "fd", "locate"]);
const LIST_COMMANDS = new Set(["ls", "tree", "dir"]);
const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh"]);
const PYTHON_EXECUTABLE = /^(?:python|python\d+(?:\.\d+)?|py)$/i;
const JAVASCRIPT_EXECUTABLE = /^(?:node|nodejs|deno|bun)$/i;
const SQL_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlcmd"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "poetry", "cargo", "gem", "composer"]);

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function safeText(value, max = 8192) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function unique(values) {
  return [...new Set(values)];
}

function issue(pathValue, message) {
  return { path: pathValue, message };
}

function validateKnownKeys(value, allowed, at, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(issue(`${at}.${key}`, "unknown field"));
  }
}

function validateSubstitutions(value, at, errors) {
  if (typeof value === "string") {
    const substitutions = value.matchAll(/\$\{([^}]+)\}/g);
    for (const match of substitutions) {
      if (!["workspace", "home", "state_dir"].includes(match[1])) {
        errors.push(issue(at, `unknown substitution \${${match[1]}}`));
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateSubstitutions(item, `${at}[${index}]`, errors));
  }
}

function validateCondition(condition, at, state) {
  const { errors } = state;
  state.nodes += 1;
  if (state.nodes > MAX_CONDITION_NODES) {
    errors.push(issue(at, `condition tree exceeds ${MAX_CONDITION_NODES} nodes`));
    return;
  }
  if (state.depth > MAX_CONDITION_DEPTH) {
    errors.push(issue(at, `condition tree exceeds depth ${MAX_CONDITION_DEPTH}`));
    return;
  }
  const value = objectValue(condition);
  if (!value) {
    errors.push(issue(at, "condition must be an object"));
    return;
  }
  const logicalKeys = ["all", "any", "none", "not"].filter((key) => key in value);
  if (logicalKeys.length > 1) {
    errors.push(issue(at, "condition may contain only one logical operator"));
    return;
  }
  if (logicalKeys.length === 1) {
    const key = logicalKeys[0];
    const children = key === "not" ? [value.not] : value[key];
    if (!Array.isArray(children) || children.length === 0) {
      errors.push(issue(`${at}.${key}`, `${key} requires a non-empty condition list`));
      return;
    }
    if (Object.keys(value).length !== 1) {
      errors.push(issue(at, "logical condition cannot contain leaf fields"));
    }
    for (let index = 0; index < children.length; index += 1) {
      validateCondition(children[index], `${at}.${key}[${index}]`, {
        ...state,
        depth: state.depth + 1,
      });
    }
    return;
  }
  const allowedLeaf = new Set(["field", "op", "value", "case_sensitive"]);
  validateKnownKeys(value, allowedLeaf, at, errors);
  if (!CONDITION_FIELDS.has(value.field)) {
    errors.push(issue(`${at}.field`, "unknown condition field"));
  }
  if (!CONDITION_OPERATORS.has(value.op)) {
    errors.push(issue(`${at}.op`, "unknown condition operator"));
  }
  if (!["exists", "not_exists"].includes(value.op) && !("value" in value)) {
    errors.push(issue(`${at}.value`, "operator requires a value"));
  }
  if (value.case_sensitive != null && typeof value.case_sensitive !== "boolean") {
    errors.push(issue(`${at}.case_sensitive`, "case_sensitive must be boolean"));
  }
  if (value.op === "between" && (!Array.isArray(value.value) || value.value.length !== 2)) {
    errors.push(issue(`${at}.value`, "between requires [minimum, maximum]"));
  }
  validateSubstitutions(value.value, `${at}.value`, errors);
}

export function validateApprovalPolicy(raw) {
  const errors = [];
  const warnings = [];
  const policy = objectValue(raw);
  if (!policy) return { valid: false, errors: [issue("$", "policy must be an object")], warnings };
  let encoded = "";
  try {
    encoded = JSON.stringify(policy);
  } catch {
    return { valid: false, errors: [issue("$", "policy must be JSON serializable")], warnings };
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_POLICY_BYTES) {
    errors.push(issue("$", `policy exceeds ${MAX_POLICY_BYTES} bytes`));
  }
  validateKnownKeys(policy, POLICY_KEYS, "$", errors);
  if (policy.version !== APPROVAL_POLICY_VERSION) {
    errors.push(issue("$.version", `version must be ${APPROVAL_POLICY_VERSION}`));
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(policy.id || ""))) {
    errors.push(issue("$.id", "id must match [a-z0-9][a-z0-9._-]{0,63}"));
  }
  if (policy.name != null && (typeof policy.name !== "string" || policy.name.length > 128)) {
    errors.push(issue("$.name", "name must be a string no longer than 128 characters"));
  }
  const defaults = objectValue(policy.defaults) || {};
  if (policy.defaults != null && !objectValue(policy.defaults)) {
    errors.push(issue("$.defaults", "defaults must be an object"));
  }
  validateKnownKeys(defaults, DEFAULT_KEYS, "$.defaults", errors);
  for (const key of DEFAULT_KEYS) {
    if (defaults[key] != null && !EFFECT_SET.has(defaults[key])) {
      errors.push(issue(`$.defaults.${key}`, "effect must be allow, deny, or ask"));
    }
  }
  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  if (!Array.isArray(policy.rules)) errors.push(issue("$.rules", "rules must be an array"));
  if (rules.length > MAX_RULES) errors.push(issue("$.rules", `rules exceed ${MAX_RULES}`));
  const ruleIds = new Set();
  rules.forEach((rawRule, index) => {
    const at = `$.rules[${index}]`;
    const rule = objectValue(rawRule);
    if (!rule) {
      errors.push(issue(at, "rule must be an object"));
      return;
    }
    validateKnownKeys(rule, RULE_KEYS, at, errors);
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(String(rule.id || ""))) {
      errors.push(issue(`${at}.id`, "invalid rule id"));
    } else if (ruleIds.has(rule.id)) {
      errors.push(issue(`${at}.id`, "duplicate rule id"));
    } else {
      ruleIds.add(rule.id);
    }
    if (!EFFECT_SET.has(rule.effect)) errors.push(issue(`${at}.effect`, "invalid effect"));
    if (rule.priority != null && (!Number.isInteger(rule.priority) || Math.abs(rule.priority) > 1_000_000)) {
      errors.push(issue(`${at}.priority`, "priority must be an integer between -1000000 and 1000000"));
    }
    for (const key of ["actions", "tools"]) {
      if (rule[key] != null && (!Array.isArray(rule[key]) || rule[key].length === 0 || rule[key].some((item) => typeof item !== "string" || !item))) {
        errors.push(issue(`${at}.${key}`, `${key} must be a non-empty string array`));
      }
    }
    if (rule.enabled != null && typeof rule.enabled !== "boolean") {
      errors.push(issue(`${at}.enabled`, "enabled must be boolean"));
    }
    if (!rule.actions && !rule.tools && !rule.when) {
      warnings.push(issue(at, "rule matches every atom"));
    }
    if (rule.when != null) {
      validateCondition(rule.when, `${at}.when`, { errors, nodes: 0, depth: 0 });
    }
  });
  const declarations = policy.declarations == null
    ? []
    : Array.isArray(policy.declarations)
      ? policy.declarations
      : null;
  if (declarations == null) {
    errors.push(issue("$.declarations", "declarations must be an array"));
  } else {
    if (declarations.length > MAX_DECLARATIONS) {
      errors.push(issue("$.declarations", `declarations exceed ${MAX_DECLARATIONS}`));
    }
    const declarationIds = new Set();
    declarations.forEach((rawDeclaration, index) => {
      const at = `$.declarations[${index}]`;
      const declaration = objectValue(rawDeclaration);
      if (!declaration) {
        errors.push(issue(at, "declaration must be an object"));
        return;
      }
      validateKnownKeys(declaration, DECLARATION_KEYS, at, errors);
      if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(String(declaration.id || ""))) {
        errors.push(issue(`${at}.id`, "invalid declaration id"));
      } else if (declarationIds.has(declaration.id)) {
        errors.push(issue(`${at}.id`, "duplicate declaration id"));
      } else {
        declarationIds.add(declaration.id);
      }
      validateCondition(declaration.match, `${at}.match`, { errors, nodes: 0, depth: 0 });
      if (declaration.replaces_opaque != null && typeof declaration.replaces_opaque !== "boolean") {
        errors.push(issue(`${at}.replaces_opaque`, "replaces_opaque must be boolean"));
      }
      if (!Array.isArray(declaration.emits) || declaration.emits.length === 0) {
        errors.push(issue(`${at}.emits`, "emits must be a non-empty atom array"));
      } else {
        declaration.emits.forEach((rawAtom, atomIndex) => {
          const atom = objectValue(rawAtom);
          if (!atom || !ACTION_SET.has(atom.action)) {
            errors.push(issue(`${at}.emits[${atomIndex}].action`, "unknown atomic action"));
          }
          validateSubstitutions(rawAtom, `${at}.emits[${atomIndex}]`, errors);
        });
      }
    });
  }
  return { valid: errors.length === 0, errors, warnings };
}

function canonicalApprovalPolicyValue(value) {
  if (Array.isArray(value)) return value.map(canonicalApprovalPolicyValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalApprovalPolicyValue(value[key])]),
    );
  }
  if (value == null || ["string", "boolean", "number"].includes(typeof value)) {
    return value;
  }
  throw new TypeError(`unsupported approval policy value: ${typeof value}`);
}

export function canonicalApprovalPolicyJson(policy) {
  return JSON.stringify(canonicalApprovalPolicyValue(policy));
}

export function approvalPolicyRevision(policy) {
  return createHash("sha256")
    .update(canonicalApprovalPolicyJson(policy))
    .digest("hex");
}

export function compileApprovalPolicy(raw) {
  const validation = validateApprovalPolicy(raw);
  if (!validation.valid) {
    const error = new Error(validation.errors.map((item) => `${item.path}: ${item.message}`).join("; "));
    error.code = "APPROVAL_POLICY_INVALID";
    error.errors = validation.errors;
    throw error;
  }
  const policy = JSON.parse(JSON.stringify(raw));
  policy.defaults = {
    unmatched: "ask",
    parse_error: "ask",
    unknown: "ask",
    ...(policy.defaults || {}),
  };
  policy.rules = policy.rules
    .filter((rule) => rule.enabled !== false)
    .map((rule, index) => {
      const compiledRule = { ...rule, priority: rule.priority || 0 };
      Object.defineProperty(compiledRule, "_index", {
        value: index,
        enumerable: false,
      });
      return compiledRule;
    });
  policy.declarations = (policy.declarations || []).filter((item) => item.enabled !== false);
  return {
    policy,
    revision: approvalPolicyRevision(policy),
    warnings: validation.warnings,
  };
}

function expandValue(value, context) {
  if (typeof value === "string") {
    return value.replace(/\$\{(workspace|home|state_dir)\}/g, (_, key) => String(context[key] || ""));
  }
  if (Array.isArray(value)) return value.map((item) => expandValue(item, context));
  if (objectValue(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandValue(item, context)]));
  }
  return value;
}

function fieldValue(atom, field) {
  let current = atom;
  for (const part of field.split(".")) {
    if (!objectValue(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function textCompare(actual, expected, caseSensitive, operation) {
  const normalize = (value) => caseSensitive === false
    ? String(value ?? "").toLowerCase()
    : String(value ?? "");
  if (Array.isArray(actual)) return actual.some((item) => operation(normalize(item), normalize(expected)));
  return operation(normalize(actual), normalize(expected));
}

function globRegExp(pattern, caseSensitive = true) {
  const value = String(pattern ?? "");
  let source = "^";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "*") {
      if (value[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[\\^$+?.()|{}\[\]]/g, "\\$&");
    }
  }
  source += "$";
  return new RegExp(source, caseSensitive === false ? "i" : "");
}

export function matchesApprovalGlob(actual, pattern, { caseSensitive = true } = {}) {
  if (Array.isArray(actual)) return actual.some((item) => matchesApprovalGlob(item, pattern, { caseSensitive }));
  return globRegExp(pattern, caseSensitive).test(String(actual ?? ""));
}

function normalizedPath(value, base) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return path.resolve(homedir(), text.slice(2));
  return path.resolve(base || process.cwd(), text);
}

function compareLeaf(actual, condition, context) {
  const expected = expandValue(condition.value, context);
  const caseSensitive = condition.case_sensitive !== false;
  switch (condition.op) {
    case "exists": return actual !== undefined && actual !== null;
    case "not_exists": return actual === undefined || actual === null;
    case "eq": return Array.isArray(actual)
      ? actual.some((item) => compareLeaf(item, { ...condition, op: "eq" }, context))
      : (caseSensitive === false && typeof actual === "string" && typeof expected === "string"
          ? actual.toLowerCase() === expected.toLowerCase()
          : actual === expected);
    case "neq": return !compareLeaf(actual, { ...condition, op: "eq" }, context);
    case "glob": return matchesApprovalGlob(actual, expected, { caseSensitive });
    case "not_glob": return !matchesApprovalGlob(actual, expected, { caseSensitive });
    case "contains": return textCompare(actual, expected, caseSensitive, (a, b) => a.includes(b));
    case "not_contains": return !textCompare(actual, expected, caseSensitive, (a, b) => a.includes(b));
    case "starts_with": return textCompare(actual, expected, caseSensitive, (a, b) => a.startsWith(b));
    case "ends_with": return textCompare(actual, expected, caseSensitive, (a, b) => a.endsWith(b));
    case "path_under": {
      const root = normalizedPath(expected, context.workspace);
      const values = Array.isArray(actual) ? actual : [actual];
      return values.some((item) => {
        const candidate = normalizedPath(item, context.workspace);
        return candidate === root || candidate.startsWith(`${root}${path.sep}`);
      });
    }
    case "path_equals": {
      const expectedPath = normalizedPath(expected, context.workspace);
      const values = Array.isArray(actual) ? actual : [actual];
      return values.some((item) => normalizedPath(item, context.workspace) === expectedPath);
    }
    case "in": return Array.isArray(expected) && expected.some((item) => compareLeaf(actual, { ...condition, op: "eq", value: item }, context));
    case "not_in": return !compareLeaf(actual, { ...condition, op: "in" }, context);
    case "intersects": {
      const left = Array.isArray(actual) ? actual : [actual];
      const right = Array.isArray(expected) ? expected : [expected];
      return left.some((item) => right.some((candidate) => compareLeaf(item, { ...condition, op: "eq", value: candidate }, context)));
    }
    case "contains_all": {
      const left = Array.isArray(actual) ? actual : [actual];
      const right = Array.isArray(expected) ? expected : [expected];
      return right.every((candidate) => left.some((item) => compareLeaf(item, { ...condition, op: "eq", value: candidate }, context)));
    }
    case "lt": return Number(actual) < Number(expected);
    case "lte": return Number(actual) <= Number(expected);
    case "gt": return Number(actual) > Number(expected);
    case "gte": return Number(actual) >= Number(expected);
    case "between": return Number(actual) >= Number(expected[0]) && Number(actual) <= Number(expected[1]);
    default: return false;
  }
}

export function evaluateApprovalCondition(condition, atom, context = {}) {
  if (condition.all) return condition.all.every((item) => evaluateApprovalCondition(item, atom, context));
  if (condition.any) return condition.any.some((item) => evaluateApprovalCondition(item, atom, context));
  if (condition.none) return condition.none.every((item) => !evaluateApprovalCondition(item, atom, context));
  if (condition.not) return !evaluateApprovalCondition(condition.not, atom, context);
  return compareLeaf(fieldValue(atom, condition.field), condition, context);
}

function riskForAction(action) {
  if ([
    "secret.input",
    "fs.delete",
    "fs.permissions.write",
    "shell.dynamic",
    "code.opaque",
    "network.listen",
    "network.http.write",
    "network.transfer.upload",
    "vcs.destructive",
    "vcs.remote.write",
    "package.publish",
    "db.delete",
    "db.schema.alter",
    "db.schema.drop",
    "db.admin",
    "db.unknown",
    "system.service.manage",
    "system.identity.manage",
    "system.schedule.manage",
    "system.storage.manage",
    "infra.write",
    "infra.destroy",
    "permission.additional",
    "tool.unknown",
  ].includes(action)) return "high";
  if (["fs.write", "fs.patch", "fs.move", "db.update", "package.install", "package.remove"].includes(action)) return "medium";
  return "normal";
}

function baseAtom(request, action, extra = {}) {
  return {
    action,
    risk: riskForAction(action),
    confidence: extra.confidence || "high",
    provider: safeText(request?.provider, 32),
    runtime: safeText(request?.runtime, 32),
    interaction: {
      kind: safeText(request?.kind, 32),
      source: safeText(request?.source, 32),
    },
    tool: { name: safeText(request?.payload?.tool || request?.tool || "unknown", 128).toLowerCase() },
    ...extra,
  };
}

function collectPathValues(value, key = "", result = []) {
  if (result.length >= 128 || value == null) return result;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPathValues(item, key, result));
    return result;
  }
  if (typeof value !== "object") {
    if (/^(?:file_?path|path|cwd|destination|target|old_?path|new_?path)$/i.test(key)) {
      const text = safeText(value, 4096);
      if (text) result.push(text);
    }
    return result;
  }
  for (const [childKey, child] of Object.entries(value)) collectPathValues(child, childKey, result);
  return result;
}

function pathAtom(request, action, candidate, context, extra = {}) {
  const resolved = normalizedPath(candidate, context.workspace);
  return baseAtom(request, action, {
    resource: { kind: "path", path: resolved || safeText(candidate, 4096) },
    ...extra,
  });
}

function shellSegments(command) {
  const segments = [];
  let tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;
  let dynamic = false;
  let redirections = [];
  const flushToken = () => {
    if (token.length) tokens.push(token);
    token = "";
  };
  const flushSegment = (separator = "") => {
    flushToken();
    if (tokens.length || redirections.length) segments.push({ tokens, separator, dynamic, redirections });
    tokens = [];
    redirections = [];
    dynamic = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      token += char;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
      if (char === "`" || (char === "$" && command[index + 1] === "(")) dynamic = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "`" || (char === "$" && command[index + 1] === "(")) dynamic = true;
    if (/\s/.test(char)) {
      flushToken();
      if (char === "\n") flushSegment("newline");
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (["&&", "||", ">>", "<<", "2>", "1>"].includes(pair)) {
      flushToken();
      if (["&&", "||"].includes(pair)) flushSegment(pair);
      else redirections.push(pair);
      index += 1;
      continue;
    }
    if ([";", "|"].includes(char)) {
      flushSegment(char);
      continue;
    }
    if ([">", "<"].includes(char)) {
      flushToken();
      redirections.push(char);
      continue;
    }
    token += char;
  }
  flushSegment("");
  return segments;
}

function optionValues(tokens) {
  return tokens.filter((item) => item && !item.startsWith("-"));
}

function executableName(value) {
  return path.basename(String(value || "")).toLowerCase();
}

function commandAtom(request, raw, tokens, cwd, segment, dynamic = false) {
  return baseAtom(request, "process.exec", {
    command: {
      raw: safeText(raw, 8192),
      executable: executableName(tokens[0]),
      argv: tokens.slice(1, 128).map((item) => safeText(item, 2048)),
      cwd,
      dynamic,
      segment,
    },
  });
}

function scriptHash(scriptPath) {
  try {
    if (!scriptPath || !existsSync(scriptPath)) return "";
    return createHash("sha256").update(readFileSync(scriptPath)).digest("hex");
  } catch {
    return "";
  }
}

function sqlStatements(sql) {
  const statements = [];
  let current = "";
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const pair = sql.slice(index, index + 2);
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (pair === "*/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (!quote && pair === "--") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!quote && pair === "/*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote && sql[index - 1] !== "\\") quote = "";
      continue;
    }
    if (["'", '"', "`"].includes(char)) {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function sqlOperation(statement) {
  const normalized = statement.replace(/^\s*WITH\b[\s\S]*?\)\s*/i, "").trim();
  const keyword = normalized.match(/^([a-z]+)/i)?.[1]?.toUpperCase() || "";
  return {
    SELECT: ["db.read", "select"],
    SHOW: ["db.read", "show"],
    DESCRIBE: ["db.read", "describe"],
    DESC: ["db.read", "describe"],
    EXPLAIN: ["db.read", "explain"],
    INSERT: ["db.insert", "insert"],
    UPDATE: ["db.update", "update"],
    DELETE: ["db.delete", "delete"],
    CREATE: ["db.schema.create", "create"],
    ALTER: ["db.schema.alter", "alter"],
    DROP: ["db.schema.drop", "drop"],
    TRUNCATE: ["db.schema.drop", "truncate"],
    GRANT: ["db.admin", "grant"],
    REVOKE: ["db.admin", "revoke"],
    BEGIN: ["db.transaction", "begin"],
    START: ["db.transaction", "begin"],
    COMMIT: ["db.transaction", "commit"],
    ROLLBACK: ["db.transaction", "rollback"],
  }[keyword] || ["db.unknown", keyword.toLowerCase() || "unknown"];
}

function extractSqlTables(statement) {
  const values = [];
  const pattern = /\b(?:from|join|into|update|table)\s+([`"\[]?[a-zA-Z0-9_.-]+[`"\]]?)/gi;
  for (const match of statement.matchAll(pattern)) {
    values.push(match[1].replace(/^[`"\[]|[`"\]]$/g, ""));
  }
  return unique(values).slice(0, 64);
}

function sqlAtoms(request, sql, engine = "unknown", database = "") {
  const statements = sqlStatements(String(sql || ""));
  if (!statements.length) {
    return [baseAtom(request, "db.unknown", {
      confidence: "low",
      database: { engine, operation: "unknown", database, tables: [] },
    })];
  }
  return statements.slice(0, 64).map((statement) => {
    const [action, operation] = sqlOperation(statement);
    return baseAtom(request, action, {
      confidence: action === "db.unknown" ? "low" : "high",
      database: {
        engine,
        operation,
        database,
        tables: extractSqlTables(statement),
        statement: safeText(statement, 8192),
      },
    });
  });
}

function valueAfter(tokens, names) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (names.includes(tokens[index])) return tokens[index + 1];
  }
  return "";
}

function semanticCommandAtoms(request, command, segment, context) {
  const tokens = segment.tokens;
  if (!tokens.length) return [];
  const executable = executableName(tokens[0]);
  const cwd = normalizedPath(request?.payload?.cwd || context.workspace, context.workspace);
  const atoms = [commandAtom(request, command, tokens, cwd, segment.separator, segment.dynamic)];
  const args = tokens.slice(1);
  const positional = optionValues(args);
  if (segment.dynamic || ["eval", "source", "."].includes(executable)) {
    atoms.push(baseAtom(request, "shell.dynamic", {
      confidence: "low",
      command: atoms[0].command,
    }));
  }
  if (SHELL_EXECUTABLES.has(executable)) {
    atoms.push(baseAtom(request, "code.shell.execute", { command: atoms[0].command }));
    if (args.includes("-c") || args.includes("--command")) {
      atoms.push(baseAtom(request, "shell.dynamic", { confidence: "low", command: atoms[0].command }));
    }
  }
  if (READ_COMMANDS.has(executable)) positional.forEach((item) => atoms.push(pathAtom(request, "fs.read", item, context)));
  if (SEARCH_COMMANDS.has(executable)) atoms.push(baseAtom(request, "fs.search", { command: atoms[0].command }));
  if (LIST_COMMANDS.has(executable)) atoms.push(pathAtom(request, "fs.list", positional.at(-1) || cwd, context));
  if (executable === "rm" || executable === "rmdir") positional.forEach((item) => atoms.push(pathAtom(request, "fs.delete", item, context)));
  if (["mkdir", "touch", "mktemp"].includes(executable)) positional.forEach((item) => atoms.push(pathAtom(request, "fs.create", item, context)));
  if (executable === "cp" && positional.length >= 2) {
    atoms.push(pathAtom(request, "fs.read", positional[0], context));
    atoms.push(pathAtom(request, "fs.copy", positional.at(-1), context));
  }
  if (executable === "mv" && positional.length >= 2) {
    atoms.push(pathAtom(request, "fs.move", positional.at(-1), context, {
      source: normalizedPath(positional[0], context.workspace),
    }));
  }
  if (["chmod", "chown", "chgrp"].includes(executable)) {
    positional.slice(1).forEach((item) => atoms.push(pathAtom(request, "fs.permissions.write", item, context)));
  }
  if (executable === "sed") {
    const target = positional.at(-1);
    if (target) atoms.push(pathAtom(request, args.some((item) => item === "-i" || item.startsWith("-i")) ? "fs.write" : "fs.read", target, context));
  }
  if (segment.redirections.length) {
    const target = tokens.at(-1);
    if (target) atoms.push(pathAtom(request, segment.redirections.some((item) => item.includes(">")) ? "fs.write" : "fs.read", target, context));
  }
  if (executable === "git") {
    const verb = args.find((item) => !item.startsWith("-")) || "";
    if (["status", "log", "diff", "show", "branch", "rev-parse", "ls-files"].includes(verb)) atoms.push(baseAtom(request, "vcs.read", { command: atoms[0].command }));
    else if (["fetch", "pull", "clone"].includes(verb)) atoms.push(baseAtom(request, "vcs.remote.read", { command: atoms[0].command }));
    else if (["push"].includes(verb)) atoms.push(baseAtom(request, "vcs.remote.write", { command: atoms[0].command }));
    else if (["reset", "clean"].includes(verb) || (verb === "checkout" && args.includes("--")) || verb === "restore") atoms.push(baseAtom(request, "vcs.destructive", { command: atoms[0].command }));
    else atoms.push(baseAtom(request, "vcs.write", { command: atoms[0].command }));
  }
  if (["curl", "wget"].includes(executable)) {
    const url = args.find((item) => /^https?:\/\//i.test(item)) || "";
    let method = valueAfter(args, ["-X", "--request"]).toUpperCase();
    if (!method) method = args.some((item) => ["-d", "--data", "--data-raw", "--data-binary", "--form"].includes(item)) ? "POST" : "GET";
    const write = !["GET", "HEAD", "OPTIONS"].includes(method);
    let parsed;
    try { parsed = url ? new URL(url) : null; } catch { parsed = null; }
    atoms.push(baseAtom(request, write ? "network.http.write" : "network.http.read", {
      network: {
        protocol: parsed?.protocol?.replace(":", "") || "http",
        host: parsed?.hostname || "",
        port: Number(parsed?.port || (parsed?.protocol === "https:" ? 443 : 80)),
        method,
      },
      resource: { kind: "uri", uri: url },
    }));
    const output = valueAfter(args, ["-o", "--output", "-O"]);
    if (output) atoms.push(pathAtom(request, "fs.write", output, context));
  }
  if (["ssh", "scp", "rsync"].includes(executable)) {
    const remote = args.find((item) => item.includes("@") || /^[a-z0-9.-]+:/i.test(item)) || "";
    const host = remote.replace(/^[^@]+@/, "").split(":")[0];
    atoms.push(baseAtom(request, "network.connect", {
      network: { protocol: executable, host, port: executable === "ssh" ? 22 : 0 },
    }));
    if (["scp", "rsync"].includes(executable)) {
      atoms.push(baseAtom(request, remote === args.at(-1) ? "network.transfer.upload" : "network.transfer.download", {
        network: { protocol: executable, host, port: 0 },
      }));
    }
  }
  if (PACKAGE_MANAGERS.has(executable)) {
    const verb = args.find((item) => !item.startsWith("-")) || "";
    const action = ["install", "add", "i", "sync", "update", "upgrade"].includes(verb)
      ? "package.install"
      : ["remove", "uninstall", "rm"].includes(verb)
        ? "package.remove"
        : ["publish", "release"].includes(verb)
          ? "package.publish"
          : "package.read";
    atoms.push(baseAtom(request, action, { command: atoms[0].command }));
  }
  if (["systemctl", "service", "launchctl"].includes(executable)) {
    const verb = args.find((item) => !item.startsWith("-")) || "";
    atoms.push(baseAtom(request, ["status", "show", "list", "is-active"].includes(verb) ? "system.service.read" : "system.service.manage", { command: atoms[0].command }));
  }
  if (["docker", "podman", "kubectl", "helm", "terraform"].includes(executable)) {
    const verb = args.find((item) => !item.startsWith("-")) || "";
    const action = ["get", "list", "show", "inspect", "logs", "ps", "plan", "status"].includes(verb)
      ? "infra.read"
      : ["destroy", "delete", "rm", "down"].includes(verb)
        ? "infra.destroy"
        : "infra.write";
    atoms.push(baseAtom(request, action, { command: atoms[0].command }));
  }
  if (PYTHON_EXECUTABLE.test(executable)) {
    const moduleIndex = args.indexOf("-m");
    const codeIndex = args.indexOf("-c");
    const script = !args[0]?.startsWith("-") ? normalizedPath(args[0], cwd) : "";
    const code = {
      language: "python",
      script,
      module: moduleIndex >= 0 ? safeText(args[moduleIndex + 1], 512) : "",
      sha256: scriptHash(script),
      inline: codeIndex >= 0,
    };
    atoms.push(baseAtom(request, "code.python.execute", { code, command: atoms[0].command }));
    atoms.push(baseAtom(request, "code.opaque", { confidence: "low", code, command: atoms[0].command }));
  }
  if (JAVASCRIPT_EXECUTABLE.test(executable)) {
    const codeIndex = args.indexOf("-e");
    const script = !args[0]?.startsWith("-") ? normalizedPath(args[0], cwd) : "";
    const code = {
      language: "javascript",
      script,
      module: "",
      sha256: scriptHash(script),
      inline: codeIndex >= 0,
    };
    atoms.push(baseAtom(request, "code.javascript.execute", { code, command: atoms[0].command }));
    atoms.push(baseAtom(request, "code.opaque", { confidence: "low", code, command: atoms[0].command }));
  }
  if (SQL_CLIENTS.has(executable)) {
    const sql = valueAfter(args, ["-e", "--execute", "-c", "--command"])
      || (executable === "sqlite3" ? args.slice(1).join(" ") : "");
    const database = executable === "sqlite3" ? safeText(args[0], 1024) : valueAfter(args, ["-d", "--dbname", "--database"]);
    atoms.push(...sqlAtoms(request, sql, executable, database));
  }
  return atoms;
}

function commandAtoms(request, context) {
  const command = safeText(request?.payload?.command || request?.payload?.tool_input?.command, 32_768);
  if (!command) return [baseAtom(request, "tool.unknown", { confidence: "low" })];
  const segments = shellSegments(command);
  if (!segments.length) return [baseAtom(request, "tool.unknown", { confidence: "low" })];
  return segments.flatMap((segment) => semanticCommandAtoms(request, command, segment, context));
}

function toolAtoms(request, context) {
  const payload = objectValue(request?.payload) || {};
  const input = objectValue(payload.tool_input) || objectValue(payload.input) || payload;
  const tool = safeText(payload.tool || request?.tool || "unknown", 128).replace(/[^a-z0-9_]/gi, "").toLowerCase();
  if (["bash", "command", "exec", "execcommand", "shell"].includes(tool)) return commandAtoms(request, context);
  if (tool === "permissions") return [baseAtom(request, "permission.additional", { resource: { kind: "permission", requested: payload.requested || payload.additional_permissions || {} } })];
  if (["read", "readfile"].includes(tool)) return collectPathValues(input).map((item) => pathAtom(request, "fs.read", item, context));
  if (["ls", "list", "glob"].includes(tool)) return collectPathValues(input).map((item) => pathAtom(request, tool === "glob" ? "fs.search" : "fs.list", item, context));
  if (["grep", "search", "websearch"].includes(tool)) return [baseAtom(request, tool === "websearch" ? "network.http.read" : "fs.search", { resource: { kind: "query" } })];
  if (["write", "multiedit", "notebookedit"].includes(tool)) {
    const paths = collectPathValues(input);
    return (paths.length ? paths : [context.workspace]).map((item) => pathAtom(request, "fs.write", item, context));
  }
  if (["edit", "applypatch", "file_change", "filechange"].includes(tool)) {
    const paths = collectPathValues(input);
    return (paths.length ? paths : [context.workspace]).map((item) => pathAtom(request, "fs.patch", item, context));
  }
  if (["webfetch"].includes(tool)) {
    const uri = safeText(input.url || payload.url, 4096);
    let parsed;
    try { parsed = uri ? new URL(uri) : null; } catch { parsed = null; }
    return [baseAtom(request, "network.http.read", {
      resource: { kind: "uri", uri },
      network: { protocol: parsed?.protocol?.replace(":", "") || "https", host: parsed?.hostname || "", port: Number(parsed?.port || 443), method: "GET" },
    })];
  }
  if (/^(?:sql|database|postgres|mysql|sqlite)/.test(tool) && typeof (input.sql || input.query || input.statement) === "string") {
    return sqlAtoms(request, input.sql || input.query || input.statement, safeText(input.engine || tool, 32), safeText(input.database, 512));
  }
  return [baseAtom(request, "tool.unknown", { confidence: "low", resource: { kind: "tool", value: tool } })];
}

function declarationAtoms(atoms, declarations, context, request) {
  let next = atoms.slice();
  const applied = [];
  for (const declaration of declarations) {
    const matched = next.find((atom) => evaluateApprovalCondition(declaration.match, atom, context));
    if (!matched) continue;
    applied.push(declaration.id);
    if (declaration.replaces_opaque) {
      next = next.filter((atom) => !(atom.action === "code.opaque" && atom.command?.raw === matched.command?.raw));
    }
    for (const emitted of declaration.emits) {
      const expanded = expandValue(emitted, context);
      next.push(baseAtom(request, expanded.action, {
        ...expanded,
        action: expanded.action,
        risk: expanded.risk || riskForAction(expanded.action),
        declaration: { id: declaration.id },
      }));
    }
  }
  return { atoms: next, declarations: applied };
}

export function atomizeApprovalRequest(request, {
  workspace = process.cwd(),
  stateDir = "",
  policy = null,
} = {}) {
  const context = {
    workspace: normalizedPath(workspace, process.cwd()),
    home: homedir(),
    state_dir: stateDir,
  };
  let atoms;
  if (request?.containsSecret) {
    atoms = [baseAtom(request, "secret.input", { confidence: "high" })];
  } else if (request?.kind === INTERACTION_KINDS.CONFIRM) {
    atoms = [baseAtom(request, "agent.plan.continue")];
  } else if (request?.kind === INTERACTION_KINDS.QUESTIONS) {
    atoms = [baseAtom(request, "agent.input.answer")];
  } else if (request?.kind === INTERACTION_KINDS.FORM) {
    atoms = [baseAtom(request, "agent.form.submit")];
  } else if (request?.kind === INTERACTION_KINDS.URL) {
    atoms = [baseAtom(request, "agent.url.open", { resource: { kind: "uri", uri: safeText(request?.payload?.url, 4096) } })];
  } else if (request?.kind === INTERACTION_KINDS.PERMISSION) {
    atoms = toolAtoms(request, context);
  } else {
    atoms = [baseAtom(request, "tool.unknown", { confidence: "low" })];
  }
  if (!atoms.length) atoms = [baseAtom(request, "tool.unknown", { confidence: "low" })];
  const declared = declarationAtoms(atoms, policy?.declarations || [], context, request);
  return { atoms: declared.atoms, declarations: declared.declarations, context };
}

function ruleMatches(rule, atom, context) {
  if (rule.actions && !rule.actions.some((pattern) => matchesApprovalGlob(atom.action, pattern))) return false;
  if (rule.tools && !rule.tools.some((pattern) => matchesApprovalGlob(atom.tool?.name || "", pattern, { caseSensitive: false }))) return false;
  return !rule.when || evaluateApprovalCondition(rule.when, atom, context);
}

function defaultEffect(policy, atom) {
  if (atom.confidence === "low" || atom.action === "shell.dynamic") return policy.defaults.parse_error;
  if (!ACTION_SET.has(atom.action) || atom.action === "tool.unknown" || atom.action.endsWith(".unknown")) return policy.defaults.unknown;
  return policy.defaults.unmatched;
}

function atomDecision(policy, atom, context) {
  const matched = policy.rules
    .filter((rule) => ruleMatches(rule, atom, context))
    .sort((a, b) => b.priority - a.priority || a._index - b._index);
  const effects = new Set(matched.map((rule) => rule.effect));
  const effect = effects.has("deny")
    ? "deny"
    : effects.has("ask")
      ? "ask"
      : effects.has("allow")
        ? "allow"
        : defaultEffect(policy, atom);
  return {
    effect,
    atom,
    matchedRules: matched.map((rule) => ({
      id: rule.id,
      effect: rule.effect,
      priority: rule.priority,
      reason: rule.reason || null,
    })),
    fallback: matched.length ? null : effect,
  };
}

export function evaluateApprovalPolicy(compiled, atoms, context = {}) {
  const policy = compiled.policy || compiled;
  const decisions = atoms.map((atom) => atomDecision(policy, atom, context));
  const effect = decisions.some((item) => item.effect === "deny")
    ? "deny"
    : decisions.every((item) => item.effect === "allow")
      ? "allow"
      : "ask";
  return {
    effect,
    policyId: policy.id,
    revision: compiled.revision || approvalPolicyRevision(policy),
    decisions,
  };
}

export function evaluateApprovalRequest(request, rawPolicy, options = {}) {
  const compiled = rawPolicy?.policy && rawPolicy?.revision
    ? rawPolicy
    : compileApprovalPolicy(rawPolicy);
  const normalized = atomizeApprovalRequest(request, {
    ...options,
    policy: compiled.policy,
  });
  const result = evaluateApprovalPolicy(compiled, normalized.atoms, normalized.context);
  if (request?.containsSecret && result.effect === "allow") result.effect = "ask";
  return {
    ...result,
    declarations: normalized.declarations,
    atoms: normalized.atoms,
  };
}

export function protectedApprovalPolicy() {
  return {
    $schema: "https://originrouter.com/schemas/approval-policy-v1.schema.json",
    version: 1,
    id: "protected",
    name: "Protected defaults",
    description: "Routine workspace operations only. Unknown and high-risk work asks the user.",
    defaults: { unmatched: "ask", parse_error: "ask", unknown: "ask" },
    rules: [
      {
        id: "allow-plan-continuation",
        effect: "allow",
        actions: ["agent.plan.continue"],
      },
      {
        id: "allow-workspace-files",
        effect: "allow",
        actions: ["fs.read", "fs.list", "fs.search", "fs.create", "fs.write", "fs.patch"],
        when: { field: "resource.path", op: "path_under", value: "${workspace}" },
      },
      {
        id: "allow-routine-processes",
        effect: "allow",
        actions: ["process.exec", "vcs.read", "package.read"],
        when: { field: "command.cwd", op: "path_under", value: "${workspace}" },
      },
      {
        id: "deny-secret-auto-input",
        effect: "deny",
        actions: ["secret.input"],
      },
    ],
  };
}
