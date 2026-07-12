"use strict";

const { STATE_POLL_INTERVAL_MS } = require("./activeProvider");

class CascadeVisibilityMonitor {
  constructor(tracker, cascade, options = {}) {
    this.tracker = tracker;
    this.cascade = cascade;
    this.provider = options.provider || "gemini";
    this.pollIntervalMs = options.pollIntervalMs ?? STATE_POLL_INTERVAL_MS;
    this.disposed = false;
  }

  start() {
    const initialProbe = this.poll();
    this.interval = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.interval.unref?.();
    return initialProbe;
  }

  poll() {
    if (
      this.disposed
      || this.inFlight
      || typeof this.cascade?.getFocusState !== "function"
    ) {
      return this.inFlight || Promise.resolve(this.tracker.state);
    }

    const generation = this.tracker.stateGeneration;
    const operation = Promise.resolve()
      .then(() => this.cascade.getFocusState())
      .then((focusState) => {
        if (typeof focusState?.isVisible !== "boolean") {
          return this.tracker.state;
        }
        return this.tracker.applyLiveVisibility(
          this.provider,
          focusState.isVisible,
          generation
        );
      })
      .catch(() => this.tracker.state)
      .finally(() => {
        if (this.inFlight === operation) {
          this.inFlight = undefined;
        }
      });
    this.inFlight = operation;
    return operation;
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.interval);
  }
}

module.exports = { CascadeVisibilityMonitor };
