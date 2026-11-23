// Native notifications and turn/start responses may cross in flight.
// A late completion or response must not clear/revive a different active turn.
export class CodexTurnState {
  constructor() { this.finished = new Set(); }
  observe(event, currentTurnId, threadId) {
    const eventThread = event.thread_id || event.params?.threadId;
    if (threadId && eventThread && eventThread !== threadId) return { accepted: false, currentTurnId };
    const id = event.turn_id || event.params?.turnId;
    if (event.type === 'task_started') {
      if (id && this.finished.has(id)) return { accepted: false, currentTurnId };
      return { accepted: true, currentTurnId: id || currentTurnId };
    }
    if (id) {
      const duplicate = this.finished.has(id);
      this.finished.add(id);
      while (this.finished.size > 128) this.finished.delete(this.finished.values().next().value);
      if (duplicate || (currentTurnId && id !== currentTurnId)) return { accepted: false, currentTurnId };
    }
    return { accepted: true, currentTurnId: null };
  }
  acknowledgeStart(id, currentTurnId) {
    if (!id || this.finished.has(id)) return currentTurnId;
    return currentTurnId || id;
  }
}
