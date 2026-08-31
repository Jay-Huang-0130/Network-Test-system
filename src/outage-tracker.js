class OutageTracker {
  constructor(database, threshold = 3, onEvent = () => {}) {
    this.database = database;
    this.threshold = threshold;
    this.onEvent = onEvent;
    this.states = new Map();
  }

  observe(sessionId, nodeId, targetKey, success, recordedAt) {
    const key = `${nodeId}:${targetKey}`;
    const state = this.states.get(key) || { failures: 0, firstFailureAt: null, outageId: null };
    if (!success) {
      if (state.failures === 0) state.firstFailureAt = recordedAt;
      state.failures += 1;
      if (state.failures === this.threshold) {
        state.outageId = this.database.openOutage(sessionId, nodeId, targetKey, state.firstFailureAt);
        this.onEvent({ type: 'outage-start', nodeId, targetKey, startedAt: state.firstFailureAt });
      }
    } else {
      if (state.outageId) {
        this.database.closeOutage(state.outageId, recordedAt);
        this.onEvent({ type: 'outage-end', nodeId, targetKey, endedAt: recordedAt });
      }
      state.failures = 0; state.firstFailureAt = null; state.outageId = null;
    }
    this.states.set(key, state);
  }

  closeAll(sessionId, endedAt) {
    this.database.closeSessionOutages(sessionId, endedAt);
    this.states.clear();
  }
}

module.exports = { OutageTracker };
