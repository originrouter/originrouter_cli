// Stage 5: static smoke test for the local-console.html page.
//
// We do NOT spin up a browser. The wire side of the new routes is covered
// by tests/localApi.test.js; this file guards against regressions in the
// page's hooks (disabled buttons, missing form id, deleted dispatch kinds,
// dropped Log path row, lost daemon-discovery URL).
//
// Path resolution: defaults to ../originrouter-test/local-console.html
// relative to tests/. Override with $LOCAL_CONSOLE_HTML for CI / other
// layouts.

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const htmlPath = process.env.LOCAL_CONSOLE_HTML
  || join(repo, "..", "originrouter-test", "local-console.html");

if (!existsSync(htmlPath)) {
  console.error(`local-console.html not found at: ${htmlPath}`);
  console.error("Set LOCAL_CONSOLE_HTML to the absolute path if the repos are not siblings.");
  process.exit(1);
}
const html = readFileSync(htmlPath, "utf8");

const checks = [
  // The form is built dynamically: form.id = "provider-form" after createElement.
  { name: "provider form id assignment",  re: /form\.id\s*=\s*["']provider-form["']|createElement\(["']form["']\)/ },
  { name: "save button",                  re: /textContent\s*=\s*["']Save["']/ },
  { name: "+ New provider button",        re: /\+\s*New provider/ },
  { name: "confirm() in delete handler",  re: /confirm\([^)]*Delete provider/ },
  { name: "usable-for-claude label",      re: /Can set Claude route|Set as Claude Model route/ },
  { name: "postControl: providerAdd",     re: /providerAdd\s*:/ },
  { name: "postControl: providerEdit",    re: /providerEdit\s*:/ },
  { name: "postControl: providerRemove",  re: /providerRemove\s*:/ },
  { name: "postControl: useProvider",     re: /useProvider\s*:/ },
  { name: "proxy panel Log path row",     re: /\[\s*["']Log path["']/ },
  { name: "local API discovery",          re: /LOCAL_API_BASE/ },

  // Stage 6 additions.
  { name: "token URL param parsing",      re: /URLSearchParams\(location\.search\)\.get\(["']token["']\)/ },
  { name: "localStorage token key",       re: /originrouter\.token/ },
  { name: "Save token button",            re: /id=["']save-token["']/ },
  { name: "tokenHeader() helper",         re: /function\s+tokenHeader/ },
  { name: "Authorization Bearer header",  re: /Bearer\s+\$\{authToken\}/ },
  { name: "crashed CSS class",            re: /\.dot\.crashed/ },
  { name: "showError helper",             re: /function\s+showError/ },
  { name: "toast-host element",           re: /id=["']toast-host["']/ },
  { name: "lastExitReason rendering",     re: /lastExitReason\s*===\s*["']crashed["']/ },
  { name: "proxy log tail fetch",         re: /\/proxy\/logs\?tail=/ },
  { name: "3-state pill handling",        re: /no-daemon|token-mismatch/ },
  { name: "last-refreshed timestamp",     re: /id=["']last-refreshed["']/ },
  { name: "refreshAll on write",          re: /function\s+refreshAll/ },

  // Stage 7 additions.
  { name: "catalog endpoint fetched",     re: /\/catalog\/litellm-providers/ },
  { name: "litellmProvider select",       re: /\.name\s*=\s*["']litellmProvider["']|name=["']litellmProvider["']/ },
  { name: "draftProfile helper",          re: /function\s+draftProfile/ },
  { name: "providerToDraft migration",    re: /openai-compatible.*custom_openai|custom_openai.*openai-compatible/ },
  { name: "schema-only badge",            re: /schema-only/ },
  { name: "bedrock inlineCreds checkbox", re: /inlineCreds/ },
  { name: "warnings display",             re: /provider-form-warnings|warnings\.map/ },
  { name: "passthrough catalog fields",   re: /awsRegion|vertexProject|hfToken/ },

  // Stage 7.5 / 7.6 additions.
  { name: "routes sidebar section",       re: /id=["']sidebar-routes["']/ },
  { name: "routes section heading",       re: /Routes \(Stage 7\.5\)/ },
  { name: "refreshRoutesSidebar helper",  re: /function\s+refreshRoutesSidebar/ },
  { name: "fetchRoutes helper",           re: /function\s+fetchRoutes/ },
  { name: "routes payload normalization", re: /rawRoutes\.claude\s*\|\|\s*rawRoutes/ },
  { name: "GET /routes called",           re: /\/routes\b/ },
  { name: "proxy panel mode row",         re: /proxy\.mode\s*===\s*["']route["']/ },
  { name: "proxy panel aliases row",      re: /proxy\.aliases/ },
  { name: "proxy panel routesHash row",   re: /proxy\.routesHash/ },
  // Stage 7.6 additions.
  { name: "main alias literal",           re: /originrouter-claude-model/ },
  { name: "fast alias literal",           re: /originrouter-claude-fast-model/ },

  // Stage 7.8 additions. smallFastModel is [legacy]; the fast route is
  // owned by the routes layer. New provider form has no smallFastModel
  // input. Detail view exposes two buttons; sidebar exposes Clear Fast.
  { name: "fast route button label",      re: /Set as Claude Fast route/ },
  { name: "postControl: routeSetSmall",   re: /routeSetSmall\s*:/ },
  { name: "postControl: routeClearSmall", re: /routeClearSmall\s*:/ },
  { name: "clear fast route button",      re: /clear-fast-route|Clear Fast route/ },
  { name: "onSetAsFastRoute handler",     re: /function\s+onSetAsFastRoute/ },
  { name: "onClearFastRoute handler",     re: /function\s+onClearFastRoute/ },
];

for (const c of checks) {
  assert.match(html, c.re, `local-console.html missing: ${c.name}`);
}

// Stage 7.8: the new-provider form must NOT render a smallFastModel
// input. The form is built dynamically via field(label, name, ...) calls
// in rebuildFormBody. If anyone re-introduces `field("smallFastModel",
// "smallFastModel", ...)` (or a similar dynamic input), the form will
// start asking for the field again and the deprecation story breaks.
// The new form renders only the Model input for the litellm catalog.
assert.doesNotMatch(
  html,
  /field\(\s*["']smallFastModel["']\s*,\s*["']smallFastModel["']/,
  "Stage 7.8: smallFastModel form input must be removed from the new-provider form",
);

assert.doesNotMatch(
  html,
  /\.name\s*=\s*["']type["']|name=["']type["']/,
  "Stage 7.6 provider form must not expose a Type select",
);

assert.doesNotMatch(
  html,
  /localApiBase\s*\(/,
  "local-console.html must use LOCAL_API_BASE; localApiBase() is not defined",
);

// Spot-check that the read paths still hit the local API routes.
for (const path of ["/providers", "/proxy/status", "/local/status"]) {
  assert.ok(html.includes(path), `expected reference to ${path}`);
}

// Stage 7.9 additions: Agents / Routes page (new top tab).
//
// Don't over-pin to `id: "..."` literal syntax — the implementation may
// assign the id via `el.id = "..."`, `setAttribute("id", "...")`, or an
// object literal. Loose patterns guard against deletions, not style.
const routePageAssertions = [
  { name: "top tab Routes button",            re: /data-mode=["']routes["']/ },
  { name: "renderRoutesDetail function",      re: /async\s+function\s+renderRoutesDetail\s*\(/ },
  { name: "setMode routes branch",            re: /mode\s*===\s*["']routes["'][\s\S]{0,200}?renderRoutesDetail\s*\(\s*\)/ },
  { name: "routeSetMain postControl entry",   re: /routeSetMain[\s\S]{0,80}?\/routes\/claude\/main/ },
  { name: "Save Model button label",          re: /["']Save Model["']/ },
  { name: "Save Fast button label",           re: /["']Save Fast["']/ },
  { name: "Clear Fast button label",          re: /["']Clear Fast["']/ },
  // Stage 8.2: Codex is wired to /routes/codex/main (replaces the
  // Stage 7.9 disabled placeholder; the obsolete `Codex select id` /
  // `Codex disabled attribute` / `Codex wired note` assertions above were
  // removed — see the `doesNotMatch` blocks at the end of this file).
  { name: "postControl: routeSetCodexMain",    re: /routeSetCodexMain\s*:\s*\{[^}]*\/routes\/codex\/main/ },
  { name: "postControl: routeClearCodexMain",  re: /routeClearCodexMain\s*:\s*\{[^}]*\/routes\/codex\/main[^}]*DELETE/ },
  { name: "onSetAsCodexRoute handler",         re: /function\s+onSetAsCodexRoute/ },
  { name: "onClearCodexRoute handler",         re: /function\s+onClearCodexRoute/ },
  { name: "Set as Codex Model route button",   re: /Set as Codex Model route/ },
  { name: "Save Codex Model button label",     re: /["']Save Codex Model["']/ },
  { name: "Clear Codex Model button label",    re: /["']Clear Codex Model["']/ },
  // IDs are computed at runtime via `${idPrefix}-save`; assert the source
  // pattern that produces the Codex prefix (not the resolved literal).
  { name: "idPrefix uses agentKey for codex",  re: /idPrefix\s*=\s*agentKey\s*===\s*["']claude["']\s*\?\s*`routes-\$\{slotKey\}`\s*:\s*`routes-\$\{agentKey\}-\$\{slotKey\}`/ },
  { name: "routes-codex-main-select id",       re: /`\$\{idPrefix\}-select`/ },
  { name: "routes-codex-main-save id",         re: /`\$\{idPrefix\}-save`/ },
  { name: "routes-codex-main-clear id",        re: /`\$\{idPrefix\}-clear`/ },
  { name: "sidebar clear-codex-route button",  re: /clearBtn\.id\s*=\s*["']clear-codex-route["']/ },
  { name: "sidebar Clear Codex route label",   re: /Clear Codex route/ },
  { name: "codex alias literal",               re: /originrouter-codex-model/ },
  { name: "codex no Claude fallback note",     re: /does not use Claude Model or Fast Model/ },
  { name: "codex unset current copy",          re: /Codex will not start until set/ },
  { name: "routes.codex.main path read",       re: /routes\.codex\?\.main|routes\.codex\.main/ },
  { name: "Routes providers list container",  re: /routes-providers-list/ },
  { name: "Provider edit button id pattern",  re: /routes-provider-edit-/ },
  { name: "Alias text originrouter-claude-model",      re: /originrouter-claude-model/ },
  { name: "Alias text originrouter-claude-fast-model",  re: /originrouter-claude-fast-model/ },
  { name: "Page header Agents / Routes",      re: /Agents\s*\/\s*Routes/ },
  { name: "Routes sidebar kept",              re: /sidebar-routes/ },
  { name: "Sidebar Clear Fast button kept",   re: /clear-fast-route/ },
  { name: "Routes disabled reason visible",   re: /Save disabled: local daemon is not connected|Already saved/ },
];
for (const { name, re } of routePageAssertions) {
  assert.match(html, re, `routes page: ${name}`);
}

// Stage 7.9: dropdown filter must explicitly exclude the literal "(unset)"
// model placeholder. Without this, providers whose model field is unset
// would still slip through `p.model` truthy and show up in the dropdown.
assert.match(
  html,
  /p\.model\s*!==\s*["']\(unset\)["']|model\s*&&\s*[^&|]*!==\s*["']\(unset\)["']/,
  "routes page: dropdown filter must exclude (unset) model placeholder",
);

// Stage 8.2: the disabled Codex placeholder from Stage 7.9 is replaced
// with a real routing block. These patterns must NOT appear anywhere in
// local-console.html (including HTML/JS comments — the regex matches the
// entire file as a string).
assert.doesNotMatch(
  html,
  /routes-codex-select[\s\S]{0,400}?disabled\s*=\s*true/,
  "Stage 8.2: routes-codex-select placeholder is replaced; the disabled attribute must be gone",
);
assert.doesNotMatch(
  html,
  /Codex routing is not wired yet/,
  "Stage 8.2: Codex placeholder copy replaced (note: also remove any residual string inside HTML comments — the regex matches anywhere in the file, not just visible text)",
);

console.log("local-console smoke ok");
