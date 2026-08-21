import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { INTERACTION_KINDS } from "./agentInteractionContract.js";
import { APPROVAL_POLICY_REGISTRY } from "./generatedApprovalPolicyRegistry.js";

export const APPROVAL_POLICY_VERSION = APPROVAL_POLICY_REGISTRY.latest_version;
export const APPROVAL_POLICY_SUPPORTED_VERSIONS = Object.freeze([
  ...APPROVAL_POLICY_REGISTRY.versions,
]);

export const APPROVAL_POLICY_EFFECTS = Object.freeze([
  ...APPROVAL_POLICY_REGISTRY.effects,
]);

export const APPROVAL_POLICY_ACTIONS = Object.freeze([
  ...APPROVAL_POLICY_REGISTRY.actions,
]);

const EFFECT_SET = new Set(APPROVAL_POLICY_EFFECTS);
const ACTION_SET = new Set(APPROVAL_POLICY_ACTIONS);
const CONDITION_OPERATORS = new Set(APPROVAL_POLICY_REGISTRY.operators);
const SCALAR_CONDITION_OPERATORS = new Set([
  "eq", "neq", "glob", "not_glob", "contains", "not_contains",
  "starts_with", "ends_with", "path_under", "path_equals",
  "lt", "lte", "gt", "gte", "between",
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
const CONDITION_FIELDS = new Set(APPROVAL_POLICY_REGISTRY.condition_fields);
const MAX_POLICY_BYTES = 1_048_576;
const MAX_RULES = APPROVAL_POLICY_REGISTRY.limits.max_rules;
const MAX_DECLARATIONS = APPROVAL_POLICY_REGISTRY.limits.max_declarations;
const MAX_CONDITION_DEPTH = APPROVAL_POLICY_REGISTRY.limits.max_condition_depth;
const MAX_CONDITION_NODES = APPROVAL_POLICY_REGISTRY.limits.max_condition_nodes;

const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "stat", "file", "wc"]);
const SEARCH_COMMANDS = new Set(["grep", "rg", "find", "fd"]);
const LIST_COMMANDS = new Set(["ls", "tree", "dir"]);
const SHELL_EXECUTABLES = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh"]);
const PYTHON_EXECUTABLE = /^(?:python|python\d+(?:\.\d+)?|py)$/i;
const JAVASCRIPT_EXECUTABLE = /^(?:node|nodejs|deno|bun)$/i;
const OPAQUE_SCRIPT_EXECUTABLE = /^(?:ruby|perl|php|lua|r|rscript|pwsh|powershell|cmd|cmd\.exe)$/i;
const SQL_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlcmd"]);
const PACKAGE_MANAGERS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "poetry", "cargo", "gem", "composer"]);
const SAFE_PROCESS_COMMANDS = new Set([
  "arch", "basename", "date", "dirname", "echo", "expr", "false", "hostname",
  "id", "memory_pressure", "printf", "ps", "pwd", "sw_vers", "system_profiler",
  "test", "true", "type", "uname", "uptime", "vm_stat", "which", "who", "whoami",
]);
const VERSION_QUERY_EXECUTABLES = new Set([
  "brew", "bun", "cargo", "claude", "codex", "composer", "deno", "gem", "git",
  "node", "nodejs", "npm", "npx", "originrouter", "pip", "pip3", "pnpm", "poetry",
  "python", "python3", "ruby", "rustc", "uv", "yarn",
]);
const COMMAND_WRAPPERS = new Set([
  "builtin", "command", "env", "exec", "nice", "nohup", "sudo", "doas", "time",
]);

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
    return;
  }
  if (objectValue(value)) {
    for (const [key, item] of Object.entries(value)) {
      validateSubstitutions(item, `${at}.${key}`, errors);
    }
  }
}

function conditionContains(condition, predicate) {
  const value = objectValue(condition);
  if (!value) return false;
  if (predicate(value)) return true;
  if (value.not) return conditionContains(value.not, predicate);
  for (const key of ["all", "any", "none"]) {
    if (Array.isArray(value[key]) && value[key].some((item) => conditionContains(item, predicate))) {
      return true;
    }
  }
  return false;
}

function expandedRuleActions(rule) {
  if (!Array.isArray(rule?.actions) || rule.actions.length === 0) {
    return new Set(APPROVAL_POLICY_ACTIONS);
  }
  return new Set(APPROVAL_POLICY_ACTIONS.filter((action) => (
    rule.actions.some((pattern) => matchesApprovalGlob(action, pattern))
  )));
}

function ruleStaticScope(rule) {
  return canonicalApprovalPolicyJson({
    tools: Array.isArray(rule?.tools) ? [...rule.tools].sort() : null,
    when: rule?.when || null,
  });
}

function setContainsAll(left, right) {
  for (const item of right) {
    if (!left.has(item)) return false;
  }
  return true;
}

function approvalPolicyImpact(policy, rules, declarations) {
  const activeRules = rules.filter((rule) => objectValue(rule) && rule.enabled !== false);
  const affected = { allow: new Set(), deny: new Set(), ask: new Set() };
  let broadRuleCount = 0;
  for (const rule of activeRules) {
    if (!EFFECT_SET.has(rule.effect)) continue;
    const actions = expandedRuleActions(rule);
    for (const action of actions) affected[rule.effect].add(action);
    if ((!rule.actions || rule.actions.includes("*")) && !rule.tools && !rule.when) {
      broadRuleCount += 1;
    }
  }
  return {
    enabled_rule_count: activeRules.length,
    disabled_rule_count: rules.length - activeRules.length,
    declaration_count: declarations.length,
    broad_rule_count: broadRuleCount,
    action_coverage: {
      allow: affected.allow.size,
      deny: affected.deny.size,
      ask: affected.ask.size,
      total: APPROVAL_POLICY_ACTIONS.length,
    },
    defaults: {
      unmatched: policy.defaults?.unmatched || "ask",
      parse_error: policy.defaults?.parse_error || "ask",
      unknown: policy.defaults?.unknown || "ask",
    },
    enforcement: policy.metadata?.enforcement === "shadow" ? "shadow" : "enforce",
  };
}

function validateCondition(condition, at, state) {
  const { errors } = state;
  const counter = state.counter || { nodes: 0 };
  counter.nodes += 1;
  if (counter.nodes > MAX_CONDITION_NODES) {
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
        counter,
        depth: state.depth + 1,
      });
    }
    return;
  }
  const allowedLeaf = new Set(["field", "op", "value", "case_sensitive", "quantifier"]);
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
  if (value.quantifier != null && !["any", "all", "none"].includes(value.quantifier)) {
    errors.push(issue(`${at}.quantifier`, "quantifier must be any, all, or none"));
  }
  if (value.op === "between" && (!Array.isArray(value.value) || value.value.length !== 2)) {
    errors.push(issue(`${at}.value`, "between requires [minimum, maximum]"));
  }
  if (Number(state.version || 1) >= 2) {
    if (["glob", "not_glob", "contains", "not_contains", "starts_with", "ends_with", "path_under", "path_equals"]
      .includes(value.op) && typeof value.value !== "string") {
      errors.push(issue(`${at}.value`, `${value.op} requires a string value`));
    }
    if (["in", "not_in", "intersects", "contains_all"].includes(value.op) && !Array.isArray(value.value)) {
      errors.push(issue(`${at}.value`, `${value.op} requires an array value`));
    }
    if (["lt", "lte", "gt", "gte"].includes(value.op) && typeof value.value !== "number") {
      errors.push(issue(`${at}.value`, `${value.op} requires a numeric value`));
    }
    if (value.op === "between" && Array.isArray(value.value)
      && value.value.some((item) => typeof item !== "number")) {
      errors.push(issue(`${at}.value`, "between bounds must be numeric"));
    }
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
  if (!APPROVAL_POLICY_SUPPORTED_VERSIONS.includes(policy.version)) {
    errors.push(issue("$.version", `version must be one of ${APPROVAL_POLICY_SUPPORTED_VERSIONS.join(", ")}`));
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(policy.id || ""))) {
    errors.push(issue("$.id", "id must match [a-z0-9][a-z0-9._-]{0,63}"));
  }
  if (policy.name != null && (typeof policy.name !== "string" || policy.name.length > 128)) {
    errors.push(issue("$.name", "name must be a string no longer than 128 characters"));
  }
  if (policy.metadata != null && !objectValue(policy.metadata)) {
    errors.push(issue("$.metadata", "metadata must be an object"));
  }
  if (policy.metadata?.enforcement != null
    && !["enforce", "shadow"].includes(policy.metadata.enforcement)) {
    errors.push(issue("$.metadata.enforcement", "enforcement must be enforce or shadow"));
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
    if (["parse_error", "unknown"].includes(key) && defaults[key] === "allow") {
      errors.push(issue(`$.defaults.${key}`, `${key} cannot automatically allow an unresolved operation`));
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
    if (rule.effect === "allow" && rule.actions?.includes("*") && !rule.when) {
      warnings.push(issue(at, "unconditional wildcard allow grants every fully classified atom"));
    }
    if (rule.effect === "allow" && rule.actions?.includes("process.exec") && !rule.when) {
      warnings.push(issue(at, "unconditional process.exec allow should be narrowed by executable and working directory"));
    }
    if (Array.isArray(rule.actions)) {
      for (const pattern of rule.actions) {
        if (!APPROVAL_POLICY_ACTIONS.some((action) => matchesApprovalGlob(action, pattern))) {
          warnings.push(issue(`${at}.actions`, `action pattern ${pattern} matches no registered atom`));
        }
      }
    }
    if (rule.enabled != null && typeof rule.enabled !== "boolean") {
      errors.push(issue(`${at}.enabled`, "enabled must be boolean"));
    }
    if (!rule.actions && !rule.tools && !rule.when) {
      warnings.push(issue(at, "rule matches every atom"));
    }
    if (rule.when != null) {
      validateCondition(rule.when, `${at}.when`, {
        errors,
        counter: { nodes: 0 },
        depth: 0,
        version: policy.version,
      });
    }
  });
  const activeRules = rules
    .map((rule, index) => ({ rule: objectValue(rule), index }))
    .filter((entry) => entry.rule && entry.rule.enabled !== false);
  for (let rightIndex = 0; rightIndex < activeRules.length; rightIndex += 1) {
    const current = activeRules[rightIndex];
    if (!EFFECT_SET.has(current.rule.effect)) continue;
    const currentActions = expandedRuleActions(current.rule);
    const currentScope = ruleStaticScope(current.rule);
    for (let leftIndex = 0; leftIndex < rightIndex; leftIndex += 1) {
      const previous = activeRules[leftIndex];
      if (!EFFECT_SET.has(previous.rule.effect)
        || ruleStaticScope(previous.rule) !== currentScope) continue;
      const previousActions = expandedRuleActions(previous.rule);
      if (!setContainsAll(previousActions, currentActions)) continue;
      const previousPath = `$.rules[${previous.index}]`;
      const currentPath = `$.rules[${current.index}]`;
      if (previous.rule.effect === current.rule.effect) {
        warnings.push(issue(
          currentPath,
          `rule is redundant because ${previousPath} already covers the same scope and actions`,
        ));
        break;
      }
      const rank = { allow: 1, ask: 2, deny: 3 };
      if (rank[previous.rule.effect] >= rank[current.rule.effect]) {
        warnings.push(issue(
          currentPath,
          `rule cannot change the decision because ${previousPath} applies ${previous.rule.effect} to the same or a broader action set`,
        ));
        break;
      }
      if (setContainsAll(currentActions, previousActions)) {
        warnings.push(issue(
          currentPath,
          `rule conflicts with ${previousPath}; overlapping atoms resolve to ${current.rule.effect === "deny" ? "deny" : "ask"}`,
        ));
        break;
      }
    }
  }
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
      validateCondition(declaration.match, `${at}.match`, {
        errors,
        counter: { nodes: 0 },
        depth: 0,
        version: policy.version,
      });
      if (declaration.replaces_opaque != null && typeof declaration.replaces_opaque !== "boolean") {
        errors.push(issue(`${at}.replaces_opaque`, "replaces_opaque must be boolean"));
      }
      if (policy.version >= 2 && declaration.replaces_opaque === true) {
        const hasScriptPath = conditionContains(declaration.match, (condition) => (
          condition.field === "code.script"
          && condition.op === "path_equals"
          && typeof condition.value === "string"
        ));
        const hasDigest = conditionContains(declaration.match, (condition) => (
          condition.field === "code.sha256"
          && condition.op === "eq"
          && /^[a-f0-9]{64}$/i.test(String(condition.value || ""))
        ));
        if (!hasScriptPath || !hasDigest) {
          errors.push(issue(
            `${at}.match`,
            "v2 declarations that replace opaque code require an exact script scope and SHA-256 digest",
          ));
        }
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
      const hasStableScope = conditionContains(declaration.match, (condition) => (
        [
          "tool.name",
          "command.executable",
          "code.script",
          "code.module",
          "code.sha256",
          "declaration.id",
        ].includes(condition.field)
      ));
      if (!hasStableScope) {
        warnings.push(issue(
          `${at}.match`,
          "declaration is broadly scoped; constrain it by tool, executable, module, or exact script identity",
        ));
      }
      if (Array.isArray(declaration.emits) && declaration.emits.length > 8) {
        warnings.push(issue(
          `${at}.emits`,
          "declaration emits many atoms; split it into smaller declarations so review impact stays auditable",
        ));
      }
    });
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    impact: approvalPolicyImpact(policy, rules, declarations || []),
  };
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

export function approvalPolicyCapabilities() {
  const registry = {
    versions: APPROVAL_POLICY_SUPPORTED_VERSIONS,
    latest_version: APPROVAL_POLICY_VERSION,
    actions: APPROVAL_POLICY_ACTIONS,
    operators: [...CONDITION_OPERATORS].sort(),
    condition_fields: [...CONDITION_FIELDS].sort(),
    max_rules: MAX_RULES,
    max_declarations: MAX_DECLARATIONS,
    max_condition_depth: MAX_CONDITION_DEPTH,
    max_condition_nodes: MAX_CONDITION_NODES,
    path_canonicalization: APPROVAL_POLICY_REGISTRY.path_canonicalization,
    unknown_operations: APPROVAL_POLICY_REGISTRY.unknown_operations,
  };
  return {
    ...registry,
    registry_hash: createHash("sha256")
      .update(canonicalApprovalPolicyJson(registry))
      .digest("hex"),
  };
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

function lexicalPath(value, base) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return path.resolve(homedir(), text.slice(2));
  return path.resolve(base || process.cwd(), text);
}

function resolvedPolicyPath(value, base) {
  const requested = lexicalPath(value, base);
  if (!requested) return { path: "", requested, trusted: false };

  let cursor = requested;
  const missing = [];
  while (true) {
    try {
      lstatSync(cursor);
      try {
        const canonical = realpathSync.native(cursor);
        let hardLinked = false;
        let device = null;
        if (!missing.length) {
          try {
            const metadata = statSync(canonical);
            hardLinked = metadata.isFile() && metadata.nlink > 1;
            device = metadata.dev;
          } catch {}
        } else {
          try { device = statSync(canonical).dev; } catch {}
        }
        return {
          path: missing.length ? path.join(canonical, ...missing) : canonical,
          requested,
          trusted: true,
          hardLinked,
          device,
        };
      } catch {
        return { path: requested, requested, trusted: false };
      }
    } catch (error) {
      if (!error || !["ENOENT", "ENOTDIR"].includes(error.code)) {
        return { path: requested, requested, trusted: false };
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) return { path: requested, requested, trusted: false };
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function pathIsUnder(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function policyPathResolution(resolved, context) {
  if (!resolved.trusted) return "unresolved";
  if (resolved.hardLinked) return "hardlink";
  const workspaceBoundary = resolvedPolicyPath(context.workspace, context.workspace);
  if (resolved.device != null
    && workspaceBoundary.device != null
    && resolved.device !== workspaceBoundary.device) {
    return "mount-boundary";
  }
  return "canonical";
}

function compareLeaf(actual, condition, context) {
  const expected = expandValue(condition.value, context);
  const caseSensitive = condition.case_sensitive !== false;
  const missing = actual === undefined || actual === null;
  if (missing) {
    if (condition.op === "exists") return false;
    if (condition.op === "not_exists") return true;
    return false;
  }
  if (Array.isArray(actual) && SCALAR_CONDITION_OPERATORS.has(condition.op)) {
    const quantifier = condition.quantifier
      || (context.rule_effect === "allow" ? "all" : "any");
    const nested = { ...condition };
    delete nested.quantifier;
    const matches = actual.map((item) => compareLeaf(item, nested, context));
    if (quantifier === "all") return matches.length > 0 && matches.every(Boolean);
    if (quantifier === "none") return matches.every((item) => !item);
    return matches.some(Boolean);
  }
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
      if (context.path_match_mode === "requested") {
        const root = lexicalPath(expected, context.workspace_requested || context.workspace);
        if (!root) return false;
        const values = Array.isArray(actual) ? actual : [actual];
        return values.some((item) => {
          const candidate = lexicalPath(item, context.workspace_requested || context.workspace);
          return Boolean(candidate) && pathIsUnder(candidate, root);
        });
      }
      const root = resolvedPolicyPath(expected, context.workspace);
      if (!root.trusted) return false;
      const values = Array.isArray(actual) ? actual : [actual];
      return values.some((item) => {
        const candidate = resolvedPolicyPath(item, context.workspace);
        return candidate.trusted && pathIsUnder(candidate.path, root.path);
      });
    }
    case "path_equals": {
      if (context.path_match_mode === "requested") {
        const expectedPath = lexicalPath(expected, context.workspace_requested || context.workspace);
        if (!expectedPath) return false;
        const values = Array.isArray(actual) ? actual : [actual];
        return values.some((item) => (
          lexicalPath(item, context.workspace_requested || context.workspace) === expectedPath
        ));
      }
      const expectedPath = resolvedPolicyPath(expected, context.workspace);
      if (!expectedPath.trusted) return false;
      const values = Array.isArray(actual) ? actual : [actual];
      return values.some((item) => {
        const candidate = resolvedPolicyPath(item, context.workspace);
        return candidate.trusted && candidate.path === expectedPath.path;
      });
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
    "process.opaque",
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

function collectPathValues(value, key = "", result = [], state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (result.length >= 128 || value == null || state.nodes > 4096 || depth > 32) return result;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPathValues(item, key, result, state, depth + 1));
    return result;
  }
  if (typeof value !== "object") {
    if (/^(?:file_?path|path|cwd|destination|target|old_?path|new_?path)$/i.test(key)) {
      const text = safeText(value, 4096);
      if (text) result.push(text);
    }
    return result;
  }
  for (const [childKey, child] of Object.entries(value)) {
    collectPathValues(child, childKey, result, state, depth + 1);
  }
  return result;
}

function pathAtom(request, action, candidate, context, extra = {}, base = context.workspace) {
  const resolved = resolvedPolicyPath(candidate, base);
  const resolution = policyPathResolution(resolved, context);
  const {
    confidence: requestedConfidence,
    resource: extraResource,
    ...rest
  } = extra;
  return baseAtom(request, action, {
    ...rest,
    confidence: resolved.trusted ? requestedConfidence : "low",
    resource: {
      kind: "path",
      path: resolved.path || safeText(candidate, 4096),
      requested_path: resolved.requested,
      path_resolution: resolution,
      ...(extraResource || {}),
    },
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
      if (quote !== "'" && (char === "`" || char === "$")) dynamic = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "`" || char === "$" || ["*", "?", "[", "{"].includes(char)) {
      dynamic = true;
    }
    if (char === "~" && token.length === 0) dynamic = true;
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

function wrappedCommandTokens(executable, args) {
  let index = 0;
  const consumesValue = new Set(
    executable === "sudo" || executable === "doas"
      ? ["-u", "-g", "-h", "-p", "-C", "-T", "--user", "--group", "--host", "--prompt", "--chdir"]
      : executable === "env"
        ? ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]
        : executable === "nice"
          ? ["-n", "--adjustment"]
          : [],
  );
  while (index < args.length) {
    const token = args[index];
    if (executable === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) break;
    const key = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    index += consumesValue.has(key) && !token.includes("=") ? 2 : 1;
  }
  return args.slice(index);
}

function executableName(value) {
  return path.basename(String(value || "")).toLowerCase();
}

function commandAtom(request, raw, tokens, cwd, segment, dynamic = false, cwdResolution = "canonical", requestedCwd = cwd) {
  return baseAtom(request, "process.exec", {
    confidence: cwdResolution === "canonical" ? "high" : "low",
    command: {
      raw: safeText(raw, 8192),
      executable: executableName(tokens[0]),
      argv: tokens.slice(1, 128).map((item) => safeText(item, 2048)),
      cwd,
      requested_cwd: requestedCwd,
      cwd_resolution: cwdResolution,
      dynamic,
      segment,
    },
  });
}

function scriptHash(scriptPath) {
  try {
    if (!scriptPath || !existsSync(scriptPath)) return "";
    if (statSync(scriptPath).size > 16 * 1024 * 1024) return "";
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
  const normalized = statement.trim();
  const keywords = [...normalized.matchAll(/\b([a-z]+)\b/gi)]
    .map((match) => match[1].toUpperCase());
  const operations = {
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
    MERGE: ["db.update", "merge"],
    COPY: ["db.unknown", "copy"],
    CALL: ["db.unknown", "call"],
    EXEC: ["db.unknown", "exec"],
    EXECUTE: ["db.unknown", "execute"],
    VACUUM: ["db.admin", "vacuum"],
    ATTACH: ["db.admin", "attach"],
    DETACH: ["db.admin", "detach"],
    PRAGMA: ["db.unknown", "pragma"],
  };
  const priority = [
    "DROP", "TRUNCATE", "DELETE", "ALTER", "GRANT", "REVOKE", "VACUUM",
    "ATTACH", "DETACH", "UPDATE", "MERGE", "INSERT", "CREATE", "COPY",
    "CALL", "EXEC", "EXECUTE", "PRAGMA", "ROLLBACK", "COMMIT", "BEGIN",
    "START", "SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN",
  ];
  const keyword = priority.find((candidate) => keywords.includes(candidate))
    || keywords[0]
    || "";
  if (keyword === "SELECT" && /\bINTO\s+(?:OUTFILE|DUMPFILE|TEMP|TEMPORARY|TABLE)\b/i.test(normalized)) {
    return ["db.unknown", "select_into"];
  }
  return operations[keyword] || ["db.unknown", keyword.toLowerCase() || "unknown"];
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
  const rawSql = String(sql || "");
  if (Buffer.byteLength(rawSql, "utf8") > 256 * 1024) {
    return [baseAtom(request, "db.unknown", {
      confidence: "low",
      database: { engine, operation: "oversized", database, tables: [] },
    })];
  }
  const statements = sqlStatements(rawSql);
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

function semanticCommandAtoms(request, command, segment, context, depth = 0) {
  const tokens = segment.tokens;
  if (!tokens.length) return [];
  const executable = executableName(tokens[0]);
  const cwdPath = resolvedPolicyPath(request?.payload?.cwd || context.workspace, context.workspace);
  const cwd = cwdPath.path;
  const cwdResolution = policyPathResolution(cwdPath, context);
  const atoms = [commandAtom(
    request,
    command,
    tokens,
    cwd,
    segment.separator,
    segment.dynamic,
    cwdResolution,
    cwdPath.requested,
  )];
  const args = tokens.slice(1);
  const positional = optionValues(args);
  let classified = SAFE_PROCESS_COMMANDS.has(executable);
  const versionQuery = VERSION_QUERY_EXECUTABLES.has(executable)
    && args.length > 0
    && args.every((item) => ["--version", "-V", "-v", "version"].includes(item));
  if (versionQuery) return atoms;

  if (COMMAND_WRAPPERS.has(executable)) {
    classified = true;
    if (["sudo", "doas"].includes(executable)) {
      atoms.push(baseAtom(request, "system.identity.manage", { command: atoms[0].command }));
    }
    const lookupOnly = executable === "command" && ["-v", "-V"].includes(args[0]);
    const nested = lookupOnly ? [] : wrappedCommandTokens(executable, args);
    if (nested.length && depth < 8) {
      atoms.push(...semanticCommandAtoms(request, command, {
        tokens: nested,
        separator: segment.separator,
        dynamic: segment.dynamic,
        redirections: segment.redirections,
      }, context, depth + 1));
    } else if (!nested.length && !lookupOnly) {
      atoms.push(baseAtom(request, "tool.unknown", {
        confidence: "low",
        command: atoms[0].command,
      }));
    }
  }
  if (executable === "xargs") {
    classified = true;
    atoms.push(baseAtom(request, "shell.dynamic", { confidence: "low", command: atoms[0].command }));
  }
  if (segment.dynamic || ["eval", "source", "."].includes(executable)) {
    classified = true;
    atoms.push(baseAtom(request, "shell.dynamic", { confidence: "low", command: atoms[0].command }));
  }
  if (SHELL_EXECUTABLES.has(executable)) {
    classified = true;
    atoms.push(baseAtom(request, "code.shell.execute", { command: atoms[0].command }));
    if (args.includes("-c") || args.includes("--command")) {
      atoms.push(baseAtom(request, "shell.dynamic", { confidence: "low", command: atoms[0].command }));
      const commandIndex = args.findIndex((item) => item === "-c" || item === "--command");
      const nestedCommand = commandIndex >= 0 ? args[commandIndex + 1] : "";
      if (nestedCommand && depth < 8) {
        atoms.push(...shellSegments(nestedCommand).flatMap((nested) => (
          semanticCommandAtoms(request, nestedCommand, nested, context, depth + 1)
        )));
      }
    }
  }
  if (READ_COMMANDS.has(executable)) {
    classified = true;
    positional.forEach((item) => atoms.push(pathAtom(request, "fs.read", item, context, {}, cwd)));
  }
  if (SEARCH_COMMANDS.has(executable)) {
    classified = true;
    const searchPaths = executable === "find"
      ? positional.slice(0, 1)
      : positional.slice(1);
    (searchPaths.length ? searchPaths : [cwd]).forEach((item) => atoms.push(
      pathAtom(request, "fs.search", item, context, { command: atoms[0].command }, cwd),
    ));
    if (args.some((item) => ["-delete", "-exec", "-execdir"].includes(item))) {
      atoms.push(baseAtom(request, "shell.dynamic", { confidence: "low", command: atoms[0].command }));
    }
  }
  if (LIST_COMMANDS.has(executable)) {
    classified = true;
    atoms.push(pathAtom(request, "fs.list", positional.at(-1) || cwd, context, {}, cwd));
  }
  if (["rm", "rmdir"].includes(executable)) {
    classified = true;
    positional.forEach((item) => atoms.push(pathAtom(request, "fs.delete", item, context, {}, cwd)));
  }
  if (["mkdir", "touch", "mktemp"].includes(executable)) {
    classified = true;
    positional.forEach((item) => atoms.push(pathAtom(request, "fs.create", item, context, {}, cwd)));
  }
  if (executable === "cp" && positional.length >= 2) {
    classified = true;
    positional.slice(0, -1).forEach((item) => atoms.push(pathAtom(request, "fs.read", item, context, {
      resource: { role: "source" },
    }, cwd)));
    atoms.push(pathAtom(request, "fs.copy", positional.at(-1), context, {
      resource: { role: "destination" },
    }, cwd));
  }
  if (executable === "mv" && positional.length >= 2) {
    classified = true;
    positional.slice(0, -1).forEach((item) => atoms.push(pathAtom(request, "fs.move", item, context, {
      resource: { role: "source" },
    }, cwd)));
    atoms.push(pathAtom(request, "fs.move", positional.at(-1), context, {
      resource: { role: "destination" },
    }, cwd));
  }
  if (["chmod", "chown", "chgrp"].includes(executable)) {
    classified = true;
    positional.slice(1).forEach((item) => atoms.push(pathAtom(request, "fs.permissions.write", item, context, {}, cwd)));
  }
  if (executable === "sed") {
    classified = true;
    const target = positional.at(-1);
    if (target) atoms.push(pathAtom(request, args.some((item) => item === "-i" || item.startsWith("-i")) ? "fs.write" : "fs.read", target, context, {}, cwd));
  }
  if (segment.redirections.length) {
    const target = tokens.at(-1);
    if (target) atoms.push(pathAtom(request, segment.redirections.some((item) => item.includes(">")) ? "fs.write" : "fs.read", target, context, {}, cwd));
  }
  if (executable === "git") {
    classified = true;
    const verb = args.find((item) => !item.startsWith("-")) || "";
    if (["status", "log", "diff", "show", "branch", "rev-parse", "ls-files"].includes(verb)) atoms.push(baseAtom(request, "vcs.read", { command: atoms[0].command }));
    else if (["fetch", "pull", "clone"].includes(verb)) atoms.push(baseAtom(request, "vcs.remote.read", { command: atoms[0].command }));
    else if (verb === "push") atoms.push(baseAtom(request, "vcs.remote.write", { command: atoms[0].command }));
    else if (["reset", "clean"].includes(verb) || (verb === "checkout" && args.includes("--")) || verb === "restore") atoms.push(baseAtom(request, "vcs.destructive", { command: atoms[0].command }));
    else atoms.push(baseAtom(request, "vcs.write", { command: atoms[0].command }));
  }
  if (["curl", "wget"].includes(executable)) {
    classified = true;
    const url = args.find((item) => /^https?:\/\//i.test(item)) || "";
    let method = valueAfter(args, ["-X", "--request"]).toUpperCase();
    if (!method) method = args.some((item) => ["-d", "--data", "--data-raw", "--data-binary", "--form"].includes(item)) ? "POST" : "GET";
    const write = !["GET", "HEAD", "OPTIONS"].includes(method);
    let parsed;
    try { parsed = url ? new URL(url) : null; } catch { parsed = null; }
    atoms.push(baseAtom(request, write ? "network.http.write" : "network.http.read", {
      confidence: parsed ? "high" : "low",
      network: {
        protocol: parsed?.protocol?.replace(":", "") || "http",
        host: parsed?.hostname || "",
        port: Number(parsed?.port || (parsed?.protocol === "https:" ? 443 : 80)),
        method,
      },
      resource: { kind: "uri", uri: url },
    }));
    const output = valueAfter(args, ["-o", "--output", "-O"]);
    if (output) atoms.push(pathAtom(request, "fs.write", output, context, {}, cwd));
    if (args.some((item) => ["-T", "--upload-file"].includes(item))) {
      atoms.push(baseAtom(request, "network.transfer.upload", { network: { protocol: "http", host: parsed?.hostname || "", port: Number(parsed?.port || 0) } }));
    }
  }
  if (["ssh", "scp", "rsync"].includes(executable)) {
    classified = true;
    const remote = args.find((item) => item.includes("@") || /^[a-z0-9.-]+:/i.test(item)) || "";
    const host = remote.replace(/^[^@]+@/, "").split(":")[0];
    atoms.push(baseAtom(request, "network.connect", {
      confidence: host ? "high" : "low",
      network: { protocol: executable, host, port: executable === "ssh" ? 22 : 0 },
    }));
    if (["scp", "rsync"].includes(executable)) {
      atoms.push(baseAtom(request, remote === args.at(-1) ? "network.transfer.upload" : "network.transfer.download", {
        network: { protocol: executable, host, port: 0 },
      }));
    }
  }
  if (PACKAGE_MANAGERS.has(executable)) {
    classified = true;
    const verb = args.find((item) => !item.startsWith("-")) || "";
    const executionVerb = ["exec", "run", "run-script", "start", "test", "dlx", "x", "create"].includes(verb)
      || executable === "npx";
    const action = executionVerb
      ? (executable === "npx" || ["exec", "dlx", "x", "create"].includes(verb) ? "package.install" : "package.read")
      : ["install", "add", "i", "sync", "update", "upgrade"].includes(verb)
        ? "package.install"
        : ["remove", "uninstall", "rm"].includes(verb)
          ? "package.remove"
          : ["publish", "release"].includes(verb)
            ? "package.publish"
            : "package.read";
    atoms.push(baseAtom(request, action, { command: atoms[0].command }));
    if (executionVerb || ["build", "publish", "release"].includes(verb)) {
      atoms.push(baseAtom(request, "code.opaque", {
        confidence: "low",
        code: { language: "package-script", module: executable, script: "", sha256: "" },
        command: atoms[0].command,
      }));
    }
  }
  if (executable === "brew") {
    classified = true;
    const verb = args.find((item) => !item.startsWith("-")) || "";
    if (verb === "services") {
      const serviceVerb = args.slice(args.indexOf(verb) + 1)
        .find((item) => !item.startsWith("-")) || "list";
      atoms.push(baseAtom(
        request,
        serviceVerb === "list" ? "system.service.read" : "system.service.manage",
        { command: atoms[0].command },
      ));
    } else if (["install", "upgrade", "update", "tap"].includes(verb)) {
      atoms.push(baseAtom(request, "package.install", { command: atoms[0].command }));
    } else if (["uninstall", "remove", "rm", "untap"].includes(verb)) {
      atoms.push(baseAtom(request, "package.remove", { command: atoms[0].command }));
    } else {
      atoms.push(baseAtom(request, "package.read", { command: atoms[0].command }));
    }
  }
  if (["systemctl", "service", "launchctl"].includes(executable)) {
    classified = true;
    const verb = args.find((item) => !item.startsWith("-")) || "";
    atoms.push(baseAtom(request, ["status", "show", "list", "is-active"].includes(verb) ? "system.service.read" : "system.service.manage", { command: atoms[0].command }));
  }
  if (["docker", "podman", "kubectl", "helm", "terraform"].includes(executable)) {
    classified = true;
    const verb = args.find((item) => !item.startsWith("-")) || "";
    const action = ["get", "list", "show", "inspect", "logs", "ps", "plan", "status"].includes(verb)
      ? "infra.read"
      : ["destroy", "delete", "rm", "down"].includes(verb)
        ? "infra.destroy"
        : "infra.write";
    atoms.push(baseAtom(request, action, { command: atoms[0].command }));
  }
  if (PYTHON_EXECUTABLE.test(executable)) {
    classified = true;
    const moduleIndex = args.indexOf("-m");
    const codeIndex = args.indexOf("-c");
    const scriptPath = !args[0]?.startsWith("-") ? resolvedPolicyPath(args[0], cwd) : null;
    const script = scriptPath?.path || "";
    const code = {
      language: "python",
      script,
      module: moduleIndex >= 0 ? safeText(args[moduleIndex + 1], 512) : "",
      sha256: scriptHash(script),
      inline: codeIndex >= 0,
      requested_script: scriptPath?.requested || "",
      script_resolution: scriptPath
        ? policyPathResolution(scriptPath, context)
        : "canonical",
    };
    atoms.push(baseAtom(request, "code.python.execute", { code, command: atoms[0].command }));
    atoms.push(baseAtom(request, "code.opaque", { confidence: "low", code, command: atoms[0].command }));
  }
  if (JAVASCRIPT_EXECUTABLE.test(executable)) {
    classified = true;
    const codeIndex = args.indexOf("-e");
    const scriptPath = !args[0]?.startsWith("-") ? resolvedPolicyPath(args[0], cwd) : null;
    const script = scriptPath?.path || "";
    const code = {
      language: "javascript",
      script,
      module: "",
      sha256: scriptHash(script),
      inline: codeIndex >= 0,
      requested_script: scriptPath?.requested || "",
      script_resolution: scriptPath
        ? policyPathResolution(scriptPath, context)
        : "canonical",
    };
    atoms.push(baseAtom(request, "code.javascript.execute", { code, command: atoms[0].command }));
    atoms.push(baseAtom(request, "code.opaque", { confidence: "low", code, command: atoms[0].command }));
  }
  if (OPAQUE_SCRIPT_EXECUTABLE.test(executable)) {
    classified = true;
    const inline = args.some((item) => ["-e", "-c", "/c", "-command"].includes(item.toLowerCase()));
    const scriptCandidate = !inline && !args[0]?.startsWith("-") && !args[0]?.startsWith("/")
      ? args[0]
      : "";
    const scriptPath = scriptCandidate ? resolvedPolicyPath(scriptCandidate, cwd) : null;
    const code = {
      language: executable.replace(/\.exe$/i, ""),
      script: scriptPath?.path || "",
      module: "",
      sha256: scriptHash(scriptPath?.path || ""),
      inline,
      requested_script: scriptPath?.requested || "",
      script_resolution: scriptPath
        ? policyPathResolution(scriptPath, context)
        : "canonical",
    };
    atoms.push(baseAtom(request, "code.opaque", {
      confidence: "low",
      code,
      command: atoms[0].command,
    }));
  }
  if (SQL_CLIENTS.has(executable)) {
    classified = true;
    const sql = valueAfter(args, ["-e", "--execute", "-c", "--command"])
      || (executable === "sqlite3" ? args.slice(1).join(" ") : "");
    const database = executable === "sqlite3" ? safeText(args[0], 1024) : valueAfter(args, ["-d", "--dbname", "--database"]);
    atoms.push(...sqlAtoms(request, sql, executable, database));
  }
  if (!classified) {
    atoms.push(baseAtom(request, "process.opaque", {
      confidence: "low",
      command: atoms[0].command,
      resource: { kind: "executable", value: tokens[0] },
    }));
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
  if (["bash", "command", "exec", "execcommand", "shell"].includes(tool)) {
    const atoms = commandAtoms(request, context);
    const additional = payload.additional_permissions || payload.network_approval_context;
    if (additional && (typeof additional !== "object" || Object.keys(additional).length > 0)) {
      atoms.push(baseAtom(request, "permission.additional", {
        resource: { kind: "permission", requested: additional },
      }));
    }
    return atoms;
  }
  if (tool === "permissions") return [baseAtom(request, "permission.additional", { resource: { kind: "permission", requested: payload.requested || payload.additional_permissions || {} } })];
  if (["read", "readfile"].includes(tool)) return collectPathValues(input).map((item) => pathAtom(request, "fs.read", item, context));
  if (["ls", "list", "glob"].includes(tool)) {
    const paths = collectPathValues(input);
    return (paths.length ? paths : [context.workspace]).map((item) => (
      pathAtom(request, tool === "glob" ? "fs.search" : "fs.list", item, context)
    ));
  }
  if (["grep", "search"].includes(tool)) {
    const paths = collectPathValues(input);
    return (paths.length ? paths : [context.workspace]).map((item) => (
      pathAtom(request, "fs.search", item, context)
    ));
  }
  if (tool === "websearch") {
    return [baseAtom(request, "network.http.read", {
      resource: { kind: "query" },
      network: { protocol: "https", host: "", port: 443, method: "GET" },
    })];
  }
  if (["write", "multiedit", "notebookedit"].includes(tool)) {
    const paths = collectPathValues(input);
    return paths.length
      ? paths.map((item) => pathAtom(request, "fs.write", item, context))
      : [baseAtom(request, "fs.unknown", {
          confidence: "low",
          resource: { kind: "path", operation: "write" },
        })];
  }
  if (["edit", "applypatch", "file_change", "filechange"].includes(tool)) {
    const paths = collectPathValues(input);
    return paths.length
      ? paths.map((item) => pathAtom(request, "fs.patch", item, context))
      : [baseAtom(request, "fs.unknown", {
          confidence: "low",
          resource: { kind: "path", operation: "patch" },
        })];
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
    const replacementScoped = conditionContains(declaration.match, (condition) => (
      condition.field === "code.script"
      && condition.op === "path_equals"
      && typeof condition.value === "string"
    )) && conditionContains(declaration.match, (condition) => (
      condition.field === "code.sha256"
      && condition.op === "eq"
      && /^[a-f0-9]{64}$/i.test(String(condition.value || ""))
    ));
    if (declaration.replaces_opaque && replacementScoped) {
      next = next.filter((atom) => !(atom.action === "code.opaque" && atom.command?.raw === matched.command?.raw));
    }
    for (const emitted of declaration.emits) {
      const expanded = expandValue(emitted, context);
      const normalized = { ...expanded };
      if (expanded.resource?.kind === "path" && expanded.resource.path) {
        const resolved = resolvedPolicyPath(expanded.resource.path, context.workspace);
        normalized.resource = {
          ...expanded.resource,
          path: resolved.path,
          requested_path: resolved.requested,
          path_resolution: policyPathResolution(resolved, context),
        };
        if (normalized.resource.path_resolution !== "canonical") {
          normalized.confidence = "low";
        }
      }
      next.push(baseAtom(request, expanded.action, {
        ...normalized,
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
  const workspacePath = resolvedPolicyPath(workspace, process.cwd());
  const homePath = resolvedPolicyPath(homedir(), process.cwd());
  const statePath = stateDir ? resolvedPolicyPath(stateDir, workspacePath.path) : null;
  const context = {
    workspace: workspacePath.path,
    workspace_requested: workspacePath.requested,
    workspace_resolution: workspacePath.trusted ? "canonical" : "unresolved",
    home: homePath.path,
    state_dir: statePath?.path || "",
    policy_version: policy?.version || 1,
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

function atomWithRequestedPaths(atom) {
  let changed = false;
  let next = atom;
  if (atom.resource?.requested_path && atom.resource.requested_path !== atom.resource.path) {
    next = {
      ...next,
      resource: { ...atom.resource, path: atom.resource.requested_path },
    };
    changed = true;
  }
  if (atom.command?.requested_cwd && atom.command.requested_cwd !== atom.command.cwd) {
    next = {
      ...next,
      command: { ...atom.command, cwd: atom.command.requested_cwd },
    };
    changed = true;
  }
  if (atom.code?.requested_script && atom.code.requested_script !== atom.code.script) {
    next = {
      ...next,
      code: { ...atom.code, script: atom.code.requested_script },
    };
    changed = true;
  }
  return changed ? next : null;
}

function atomHasUnresolvedPath(atom) {
  return (atom.resource?.path_resolution && atom.resource.path_resolution !== "canonical")
    || (atom.command?.cwd_resolution && atom.command.cwd_resolution !== "canonical")
    || (atom.code?.script_resolution && atom.code.script_resolution !== "canonical");
}

function atomRequiresHumanReview(atom) {
  return atom.confidence === "low"
    || [
      "code.opaque",
      "db.unknown",
      "fs.unknown",
      "process.opaque",
      "shell.dynamic",
      "tool.unknown",
    ].includes(atom.action);
}

function ruleMatches(rule, atom, context) {
  if (rule.actions && !rule.actions.some((pattern) => matchesApprovalGlob(atom.action, pattern))) return false;
  if (rule.tools && !rule.tools.some((pattern) => matchesApprovalGlob(atom.tool?.name || "", pattern, { caseSensitive: false }))) return false;
  if (!rule.when) return true;
  const canonicalContext = { ...context, rule_effect: rule.effect };
  const canonicalMatch = evaluateApprovalCondition(rule.when, atom, canonicalContext);
  const requestedAtom = atomWithRequestedPaths(atom);
  if (!requestedAtom) return canonicalMatch;
  const requestedMatch = evaluateApprovalCondition(rule.when, requestedAtom, {
    ...context,
    workspace: context.workspace_requested || context.workspace,
    path_match_mode: "requested",
    rule_effect: rule.effect,
  });
  return rule.effect === "allow"
    ? canonicalMatch && requestedMatch
    : canonicalMatch || requestedMatch;
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
  const matchedEffect = effects.has("deny")
    ? "deny"
    : effects.has("ask")
      ? "ask"
      : effects.has("allow")
        ? "allow"
        : defaultEffect(policy, atom);
  const unsafePath = atomHasUnresolvedPath(atom);
  const requiresHuman = atomRequiresHumanReview(atom);
  const effect = matchedEffect === "allow" && (unsafePath || requiresHuman)
    ? "ask"
    : matchedEffect;
  return {
    effect,
    atom,
    matchedRules: matched.map((rule) => ({
      id: rule.id,
      effect: rule.effect,
      priority: rule.priority,
      reason: rule.reason || null,
    })),
    fallback: matchedEffect === "allow" && (unsafePath || requiresHuman)
      ? (unsafePath ? "unresolved_path" : "insufficient_classification")
      : matched.length
        ? null
        : effect,
  };
}

export function evaluateApprovalPolicy(compiled, atoms, context = {}) {
  const policy = compiled.policy || compiled;
  const evaluationContext = { ...context, policy_version: policy.version || 1 };
  const decisions = atoms.map((atom) => atomDecision(policy, atom, evaluationContext));
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
    $schema: "https://originrouter.com/schemas/approval-policy-v2.schema.json",
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
        actions: ["process.exec", "vcs.read", "package.read", "system.service.read", "infra.read"],
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
