import type { SessionFallbackState, ModelKey, FallbackEvent, ErrorCategory } from "../types.js";

export class SessionStateStore {
  private store = new Map<string, SessionFallbackState>();

  get(sessionId: string): SessionFallbackState {
    if (!this.store.has(sessionId)) {
      this.store.set(sessionId, this.newState(sessionId));
    }
    return this.store.get(sessionId)!;
  }

  acquireLock(sessionId: string): boolean {
    const state = this.get(sessionId);
    if (state.isProcessing) return false;
    state.isProcessing = true;
    return true;
  }

  releaseLock(sessionId: string): void {
    const state = this.store.get(sessionId);
    if (state) state.isProcessing = false;
  }

  isInDedupWindow(sessionId: string, windowMs = 3_000): boolean {
    const state = this.get(sessionId);
    if (!state.lastFallbackAt) return false;
    return Date.now() - state.lastFallbackAt < windowMs;
  }

  recordFallback(
    sessionId: string,
    fromModel: ModelKey,
    toModel: ModelKey,
    reason: ErrorCategory,
    agentName: string | null
  ): void {
    const state = this.get(sessionId);
    const event: FallbackEvent = {
      at: Date.now(),
      fromModel,
      toModel,
      reason,
      sessionId,
    };
    state.currentModel = toModel;
    state.fallbackDepth++;
    state.lastFallbackAt = event.at;
    state.fallbackHistory.push(event);
    if (agentName) state.agentName = agentName;
  }

  setOriginalModel(sessionId: string, model: ModelKey): void {
    const state = this.get(sessionId);
    if (!state.originalModel) {
      state.originalModel = model;
      state.currentModel = model;
    }
  }

  setAgentName(sessionId: string, agentName: string): void {
    const state = this.get(sessionId);
    state.agentName = agentName;
  }

  delete(sessionId: string): void {
    this.store.delete(sessionId);
  }

  getAll(): SessionFallbackState[] {
    return Array.from(this.store.values());
  }

  private newState(sessionId: string): SessionFallbackState {
    return {
      sessionId,
      agentName: null,
      originalModel: null,
      currentModel: null,
      fallbackDepth: 0,
      isProcessing: false,
      lastFallbackAt: null,
      fallbackHistory: [],
    };
  }
}
