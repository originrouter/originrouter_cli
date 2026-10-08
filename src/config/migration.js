// One-shot migration: legacy `config.claude` block becomes a `providers`
// entry called `default-claude`. Idempotent — returns the same reference when
// nothing needs to change, so readConfig() can avoid a needless write.
//
// IMPORTANT: the legacy `config.claude` block is PRESERVED on the returned
// config. This means summarizeClaudeConfig() and the legacy `config set
// claude.<key>` commands continue to work after migration. Legacy is also
// still consulted by resolveProvider() when no currentProvider[agent] is set.

const DEFAULT_NAME = "default-claude";

// `claude.small` used to be a real route slot: it drove
// ANTHROPIC_SMALL_FAST_MODEL and, transitively, ANTHROPIC_DEFAULT_HAIKU_MODEL.
// It is no longer a slot — the four auxiliary families (opus/sonnet/haiku/fable)
// now each default to inheriting the primary model instead.
//
// This is the one *behavioural* regression of the change: a user who relied on
// a cheaper fast model now gets the primary model for the Haiku family, i.e.
// they pay more. There is no data migration (by decision) — the value is simply
// dropped — so this warning is the only compensation. Callers surface it once
// on `originrouter claude` startup and once from `originrouter doctor`; it is
// never persisted, so it survives as an advisory until the user re-routes.
const ROUTES_MIGRATION_WARNING =
  "claude.small is no longer a route slot. The Claude Code auxiliary families "
  + "(opus/sonnet/haiku/fable) now inherit the primary model by default. If you "
  + "relied on a cheaper fast model, set claude.haiku explicitly.";

// Returns the warning string when the config still carries the legacy `small`
// slot, otherwise null. Read-only: never mutates the config and never writes.
export function claudeRoutesMigrationWarning(rawConfig) {
  const cfg = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const small = cfg.routes && cfg.routes.claude && cfg.routes.claude.small;
  return small ? ROUTES_MIGRATION_WARNING : null;
}

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