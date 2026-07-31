import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "schemas", "approval-policy-registry.json");
const source = JSON.parse(readFileSync(sourcePath, "utf8"));
const check = process.argv.includes("--check");

const jsTarget = path.join(root, "src", "runtime", "generatedApprovalPolicyRegistry.js");
const appTargetArgument = process.argv.find((value) => value.startsWith("--dart-output="));
const appTarget = appTargetArgument
  ? path.resolve(root, appTargetArgument.slice("--dart-output=".length))
  : path.resolve(root, "..", "originrouter_app", "lib", "features", "agent", "generated", "approval_policy_registry.g.dart");

const js = `// GENERATED FILE. Run npm run generate:approval-policy-registry.\n` +
  `// Source: schemas/approval-policy-registry.json\n\n` +
  `export const APPROVAL_POLICY_REGISTRY = Object.freeze(${JSON.stringify(source, null, 2)});\n`;

function dartString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function dartList(name, values, type = "String") {
  return `const List<${type}> ${name} = <${type}>[\n${values.map((value) => `  ${dartString(value)},`).join("\n")}\n];`;
}

const dart = `// GENERATED FILE. Run originrouter-cli/scripts/generate-approval-policy-registry.mjs.\n` +
  `// Source: originrouter-cli/schemas/approval-policy-registry.json\n\n` +
  `const int approvalPolicyGeneratedVersion = ${source.latest_version};\n` +
  `const List<int> approvalPolicyGeneratedSupportedVersions = <int>[${source.versions.join(", ")}];\n` +
  `${dartList("approvalPolicyGeneratedEffects", source.effects)}\n` +
  `${dartList("approvalPolicyGeneratedActions", source.actions)}\n` +
  `${dartList("approvalPolicyGeneratedOperators", source.operators)}\n` +
  `${dartList("approvalPolicyGeneratedConditionFields", source.condition_fields)}\n` +
  `const int approvalPolicyGeneratedMaxRules = ${source.limits.max_rules};\n` +
  `const int approvalPolicyGeneratedMaxDeclarations = ${source.limits.max_declarations};\n` +
  `const int approvalPolicyGeneratedMaxConditionDepth = ${source.limits.max_condition_depth};\n` +
  `const int approvalPolicyGeneratedMaxConditionNodes = ${source.limits.max_condition_nodes};\n` +
  `const String approvalPolicyGeneratedPathCanonicalization = ${dartString(source.path_canonicalization)};\n` +
  `const String approvalPolicyGeneratedUnknownOperations = ${dartString(source.unknown_operations)};\n`;

function writeOrCheck(target, content) {
  if (check) {
    let current = "";
    try { current = readFileSync(target, "utf8"); } catch {}
    if (current !== content) {
      console.error(`generated approval policy registry is stale: ${target}`);
      process.exitCode = 1;
    }
    return;
  }
  writeFileSync(target, content);
}

writeOrCheck(jsTarget, js);
if (appTargetArgument || existsSync(path.dirname(appTarget))) {
  writeOrCheck(appTarget, dart);
}

for (const version of source.versions) {
  const schemaPath = path.join(root, "schemas", `approval-policy-v${version}.schema.json`);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const schemaActions = schema?.$defs?.atom?.properties?.action?.enum;
  if (JSON.stringify(schemaActions) !== JSON.stringify(source.actions)) {
    console.error(`approval policy schema action registry is stale: ${schemaPath}`);
    process.exitCode = 1;
  }
  const leaf = schema?.$defs?.condition?.oneOf?.find((item) => (
    item?.required?.includes("field") && item?.required?.includes("op")
  ));
  if (JSON.stringify(leaf?.properties?.field?.enum) !== JSON.stringify(source.condition_fields)) {
    console.error(`approval policy schema condition fields are stale: ${schemaPath}`);
    process.exitCode = 1;
  }
  if (JSON.stringify(leaf?.properties?.op?.enum) !== JSON.stringify(source.operators)) {
    console.error(`approval policy schema operators are stale: ${schemaPath}`);
    process.exitCode = 1;
  }
  if (schema?.properties?.rules?.maxItems !== source.limits.max_rules
      || schema?.properties?.declarations?.maxItems !== source.limits.max_declarations) {
    console.error(`approval policy schema limits are stale: ${schemaPath}`);
    process.exitCode = 1;
  }
}
