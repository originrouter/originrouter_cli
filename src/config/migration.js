// One-shot migration: legacy `config.claude` block becomes a `providers`
// entry called `default-claude`. Idempotent — returns the same reference when
// nothing needs to change, so readConfig() can avoid a needless write.
//
// IMPORTANT: the legacy `config.claude` block is PRESERVED on the returned
// config. This means summarizeClaudeConfig() and the legacy `config set
// claude.<key>` commands continue to work after migration. Legacy is also
// still consulted by resolveProvider() when no currentProvider[agent] is set.

const DEFAULT_NAME = "default-claude";

export function migrateLegacyConfig(rawConfig) {
  const cfg = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  // Already migrated (or explicitly empty of legacy data) — no-op.
  if (cfg.providers || !cfg.claude) return cfg;

  const legacy = cfg.claude;
  const hasAnyLegacyField = legacy.baseUrl || legacy.apiKey || legacy.model || legacy.smallFastModel;
  if (!hasAnyLegacyField) return cfg;

  const providers = {
    [DEFAULT_NAME]: {
      name: DEFAULT_NAME,
      type: "anthropic",
      baseUrl: legacy.baseUrl || "",
      apiKey: legacy.apiKey || "",
      model: legacy.model || "",
      ...(legacy.smallFastModel ? { smallFastModel: legacy.smallFastModel } : {}),
    },
  };

  const currentProvider = {
    ...(cfg.currentProvider || {}),
    claude: cfg.currentProvider?.claude ?? DEFAULT_NAME,
  };

  return {
    ...cfg,
    providers,
    currentProvider,
    migratedAt: cfg.migratedAt || new Date().toISOString(),
  };
}