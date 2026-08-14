import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "schemas", "approval-policy-registry.json");
const source = JSON.parse(readFileSync(sourcePath, "utf8"));
const check = process.argv.includes("--check");

const jsTarget = path.join(root, "src", "runtime", "generatedApprovalPolicyRegistry.js");

const js = `// GENERATED FILE. Run npm run generate:approval-policy-registry.\n` +
  `// Source: schemas/approval-policy-registry.json\n\n` +
  `export const APPROVAL_POLICY_REGISTRY = Object.freeze(${JSON.stringify(source, null, 2)});\n`;

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
