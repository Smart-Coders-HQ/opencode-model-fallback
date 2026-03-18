import type { Logger } from "../logging/logger.js";
import type { PluginConfig } from "../types.js";
import { ModelHealthStore } from "./model-health.js";
import { SessionStateStore } from "./session-state.js";

/**
 * Centralized in-memory store — single entry point for all state.
 */
export class FallbackStore {
  readonly health: ModelHealthStore;
  readonly sessions: SessionStateStore;

  constructor(_config: PluginConfig, logger: Logger) {
    this.sessions = new SessionStateStore();
    this.health = new ModelHealthStore({
      onTransition: (modelKey, from, to) => {
        logger.info("health.transition", { modelKey, from, to });
      },
    });
  }

  destroy(): void {
    this.health.destroy();
  }
}
