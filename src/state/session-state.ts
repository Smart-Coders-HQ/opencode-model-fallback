import type { ErrorCategory, FallbackEvent, ModelKey, SessionFallbackState } from "../types.js";

export class SessionStateStore {
  private store = new Map<string, SessionFallbackState>();

  private getFallbackActiveKey(originalModel: ModelKey, currentModel: ModelKey): string {
    return `${originalModel}->${currentModel}`;
  }

  get(sessionId: string): SessionFallbackState {
    let state = this.store.get(sessionId);
    if (!state) {
      state = this.newState(sessionId);
      this.store.set(sessionId, state);
    }
    return state;
  }

  acquireLock(
    sessionId: string,
    logger?: { debug: (msg: string, data?: Record<string, unknown>) => void }
  ): boolean {
    // This lock relies on Node's single-threaded event loop semantics.
    // If this store is ever shared across worker threads, replace with a real mutex.
    const state = this.get(sessionId);

    // Emergency TTL: if lock is older than 60 seconds, force-clear it
    if (state.isProcessing && state.lockedAt !== null) {
      const ageMs = Date.now() - state.lockedAt;
      if (ageMs > 60_000) {
        logger?.debug("lock.ttl.expired", { sessionId, ageMs });
        state.isProcessing = false;
        state.lockedAt = null;
      }
    }

    if (state.isProcessing) return false;
    state.isProcessing = true;
    state.lockedAt = Date.now();
    return true;
  }

  releaseLock(sessionId: string): void {
    const state = this.store.get(sessionId);
    if (state) {
      state.isProcessing = false;
      state.lockedAt = null;
    }
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
      trigger: "reactive",
      agentName,
    };
    state.currentModel = toModel;
    state.fallbackDepth++;
    state.lastFallbackAt = event.at;
    state.recoveryNotifiedForModel = null;
    state.fallbackHistory.push(event);
    if (agentName) state.agentName = agentName;
  }

  recordPreemptiveRedirect(
    sessionId: string,
    fromModel: ModelKey,
    toModel: ModelKey,
    agentName: string | null
  ): void {
    const state = this.get(sessionId);
    const event: FallbackEvent = {
      at: Date.now(),
      fromModel,
      toModel,
      reason: "rate_limit",
      sessionId,
      trigger: "preemptive",
      agentName,
    };

    state.currentModel = toModel;
    state.fallbackDepth++;
    state.recoveryNotifiedForModel = null;
    state.fallbackHistory.push(event);
    if (agentName) state.agentName = agentName;
  }

  setOriginalModel(sessionId: string, model: ModelKey): void {
    const state = this.get(sessionId);
    if (!state.originalModel) {
      state.originalModel = model;
      state.currentModel = model;
      state.fallbackActiveNotifiedKey = null;
    }
  }

  consumeFallbackActiveNotification(
    sessionId: string
  ): { originalModel: ModelKey; currentModel: ModelKey } | null {
    const state = this.get(sessionId);
    const { originalModel, currentModel } = state;

    if (!originalModel || !currentModel || originalModel === currentModel) return null;

    const key = this.getFallbackActiveKey(originalModel, currentModel);
    if (state.fallbackActiveNotifiedKey === key) return null;

    state.fallbackActiveNotifiedKey = key;
    return { originalModel, currentModel };
  }

  clearFallbackActiveNotification(sessionId: string): void {
    const state = this.store.get(sessionId);
    if (!state) return;
    state.fallbackActiveNotifiedKey = null;
  }

  setAgentName(sessionId: string, agentName: string): void {
    const state = this.get(sessionId);
    state.agentName = agentName;
  }

  setAgentFile(sessionId: string, agentFile: string): void {
    const state = this.get(sessionId);
    state.agentFile = agentFile;
  }

  partialReset(sessionId: string): void {
    const state = this.store.get(sessionId);
    if (!state) return;
    state.fallbackHistory = [];
    state.lastFallbackAt = null;
    state.isProcessing = false;
    state.lockedAt = null;
    state.fallbackActiveNotifiedKey = null;
    // Preserves: originalModel, currentModel, agentName, fallbackDepth
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
      agentFile: null,
      originalModel: null,
      currentModel: null,
      fallbackDepth: 0,
      isProcessing: false,
      lockedAt: null,
      lastFallbackAt: null,
      fallbackHistory: [],
      recoveryNotifiedForModel: null,
      fallbackActiveNotifiedKey: null,
    };
  }
}
