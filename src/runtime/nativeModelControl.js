// Native catalogs belong to the running official process. This module never
// reads or writes OriginRouter route overrides.
export class NativeModelControl {
  constructor({ enabled, provider, runtime, load, apply, current = () => null }) {
    this.enabled = enabled === true; this.provider = provider; this.runtime = runtime;
    this.load = load; this.apply = apply; this.current = current; this.models = [];
  }
  async refresh() {
    if (!this.enabled) return [];
    try { this.models = (await this.load()).filter(item => item.id).slice(0, 256); }
    catch { this.models = []; }
    return this.models;
  }
  status(extra = {}) {
    return { type: 'agent.model.status', provider: this.provider, runtime: this.runtime,
      model: this.current() || null, modelProvider: null, source: 'native',
      modelControl: this.models.length ? 'supported' : 'unsupported',
      availableModels: this.models.map(item => ({ id: item.id, displayName: item.displayName || item.id, provider: '', providerName: this.provider === 'claude' ? 'Claude Code' : 'Codex' })), ...extra };
  }
  efforts() { return this.models.find(item => item.id === this.current() || item.resolvedModel === this.current())?.efforts || []; }
  async set(payload) {
    if (!this.enabled) return { accepted: false, reason: 'model_control_unsupported' };
    if (payload.provider || !this.models.some(item => item.id === payload.model)) return { accepted: false, reason: 'model_not_enabled' };
    try { await this.apply(payload.model); return { accepted: true, reason: null }; }
    catch (error) { return { accepted: false, reason: error.message || 'native_model_change_failed' }; }
  }
}
