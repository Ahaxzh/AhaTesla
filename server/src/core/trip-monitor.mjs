// trip-monitor.mjs — polling worker: watches TeslaMate DB for trip boundaries
// (new drives / charging sessions) and emits events for push channels.
//
// Trip-boundary state machine semantics inherited from tesla-butler
// trip-session.mjs (github.com/manwithshit/tesla-butler): charging-between and
// inactivity-timeout recover boundaries when door/lock signals are absent;
// MQTT signals accelerate boundaries but the DB is always the source of truth.
import { getLatestChargingProcess } from "./teslamate-queries.mjs";
import { timeMs } from "./util.mjs";

export const MONITOR_DEFAULTS = Object.freeze({
  pollMs: 30_000,
  inactivityTimeoutMs: 30 * 60 * 1_000,
  finalizationDelayMs: 45_000,
  boundarySignalToleranceMs: 10_000,
  parallelLockWindowMs: 10 * 60 * 1_000
});

export function normalizeMonitorState(saved = {}) {
  return {
    version: 1,
    initialized: Boolean(saved.initialized),
    last_drive_id: Number(saved.last_drive_id) || 0,
    last_charging_id: Number(saved.last_charging_id) || 0,
    session: saved.session ? { ...saved.session } : null,
    signals: {
      locked: { initialized: false, value: null, ...(saved.signals?.locked || {}) },
      driver_front_door_open: { initialized: false, value: null, ...(saved.signals?.driver_front_door_open || {}) }
    },
    pending_events: { ...(saved.pending_events || {}) },
    sent_keys: { ...(saved.sent_keys || {}) }
  };
}

function newSession(at) {
  return {
    phase: "driving",
    segment_ids: [],
    started_at: at,
    active_started_at: at,
    last_event_at: at,
    parked_at: null,
    finalization_reason: null,
    finalize_at: null
  };
}

export class TripMonitor {
  constructor({ state = {}, onEvent = () => {}, clock = () => new Date().toISOString() } = {}) {
    this.state = normalizeMonitorState(state);
    this.onEvent = onEvent;
    this.clock = clock;
  }

  queueCurrentSession(at) {
    const session = this.state.session;
    const segmentIds = session?.segment_ids || [];
    if (segmentIds.length === 0) {
      this.state.session = null;
      return false;
    }
    const eventKey = `trip-${segmentIds.join("-")}`;
    if (!this.state.pending_events[eventKey] && !this.state.sent_keys[eventKey]) {
      const event = {
        type: "trip_end",
        eventKey,
        segment_ids: [...segmentIds],
        reason: session.finalization_reason,
        ended_at: session.parked_at || at
      };
      this.state.pending_events[eventKey] = event;
      this.onEvent(event);
    }
    this.state.session = null;
    return true;
  }

  // snapshot: {active: {id, start_at}|null, completed: [{id, start_at, end_at, charging_between}]}
  reconcile(snapshot, at = this.clock()) {
    const completed = snapshot?.completed || [];
    if (!this.state.initialized) {
      this.state.initialized = true;
      this.state.last_drive_id = Math.max(0, ...completed.map((drive) => Number(drive.id) || 0));
    }
    if (snapshot?.active && !this.state.session) {
      this.state.session = newSession(snapshot.active.start_at || at);
    }
    if (snapshot?.active && this.state.session) {
      // active drive (re)started: cancel any pending finalization — the trip
      // continues (tesla-butler semantics: DB active observation wins).
      this.state.session.phase = "driving";
      this.state.session.active_started_at = snapshot.active.start_at || at;
      this.state.session.finalize_at = null;
      this.state.session.finalization_reason = null;
    }
    for (const drive of completed) {
      const id = Number(drive.id) || 0;
      if (id <= this.state.last_drive_id) continue;
      const gapMs = timeMs(drive.start_at) - timeMs(this.state.session?.parked_at);
      const recoveredBoundary = this.state.session?.segment_ids?.length > 0
        && (Boolean(drive.charging_between)
          || (Number.isFinite(gapMs) && gapMs >= MONITOR_DEFAULTS.inactivityTimeoutMs));
      if (recoveredBoundary) {
        this.state.session.finalization_reason = drive.charging_between
          ? "charging_between"
          : "inactivity_timeout";
        this.queueCurrentSession(at);
      }
      if (!this.state.session) this.state.session = newSession(drive.start_at || at);
      const session = this.state.session;
      const wasFinalizing = session.phase === "finalizing";
      if (!session.segment_ids.includes(id)) session.segment_ids.push(id);
      if (!wasFinalizing) session.phase = "parked";
      session.parked_at = drive.end_at || at;
      session.active_started_at = null;
      session.last_event_at = drive.end_at || at;
      this.state.last_drive_id = id;
    }
    const session = this.state.session;
    if (
      session
      && !snapshot?.active
      && !session.active_started_at
      && session.phase !== "finalizing"
      && session.parked_at !== null
      && timeMs(at) - timeMs(session.parked_at) >= MONITOR_DEFAULTS.inactivityTimeoutMs
    ) {
      session.finalization_reason = "inactivity_timeout";
      this.queueCurrentSession(at);
    }
    if (
      session?.phase === "finalizing"
      && !snapshot?.active
      && !session.active_started_at
      && timeMs(session.finalize_at) !== null
      && timeMs(at) >= timeMs(session.finalize_at)
    ) {
      this.queueCurrentSession(at);
    }
    return this.pendingEvents();
  }

  // MQTT signal (locked / driver_front_door_open edges).
  observeVehicleSignal(field, value, at = this.clock()) {
    const signal = this.state.signals[field];
    if (!signal || typeof value !== "boolean") return false;
    if (!signal.initialized) {
      signal.initialized = true;
      signal.value = value;
      return false;
    }
    if (signal.value === value) return false;
    signal.value = value;
    const session = this.state.session;
    if (!session || session.phase === "finalizing") return false;
    session.last_event_at = at;
    if (field === "locked" && value === true && session.phase === "parked" && session.parked_at) {
      const lockedMs = timeMs(at);
      const parkedMs = timeMs(session.parked_at);
      if (lockedMs !== null && parkedMs !== null
        && lockedMs >= parkedMs - MONITOR_DEFAULTS.boundarySignalToleranceMs
        && lockedMs - parkedMs <= MONITOR_DEFAULTS.parallelLockWindowMs) {
        session.phase = "finalizing";
        session.finalization_reason = "locked";
        session.finalize_at = new Date(lockedMs + MONITOR_DEFAULTS.finalizationDelayMs).toISOString();
      }
    }
    return true;
  }

  observeChargingStarted(charging, at = this.clock()) {
    const session = this.state.session;
    if (session && session.phase !== "finalizing") {
      session.phase = "finalizing";
      session.finalization_reason = "charging_started";
      session.finalize_at = new Date(timeMs(at) + MONITOR_DEFAULTS.finalizationDelayMs).toISOString();
      session.last_event_at = at;
    }
    const id = Number(charging?.id) || 0;
    const isNew = id > this.state.last_charging_id;
    if (isNew) this.state.last_charging_id = id;
    return isNew;
  }

  observeChargingDone(charging, at = this.clock()) {
    const event = {
      type: "charging_done",
      charging_process_id: Number(charging?.id) || null,
      ended_at: charging?.end_at || at
    };
    this.onEvent(event);
    return event;
  }

  acknowledge(eventKey, at = this.clock()) {
    if (!eventKey || !this.state.pending_events[eventKey]) return false;
    delete this.state.pending_events[eventKey];
    this.state.sent_keys[eventKey] = at;
    return true;
  }

  pendingEvents() {
    return Object.values(this.state.pending_events);
  }

  toJSON() {
    return structuredClone(this.state);
  }
}

// Poll loop wrapper used by index.mjs; clock and db injectable for tests.
export function startTripMonitorLoop({ monitor, db, pollMs = MONITOR_DEFAULTS.pollMs, getSnapshot, logger = () => {} } = {}) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const snapshot = await (getSnapshot || defaultSnapshot(db));
      monitor.reconcile(snapshot);
      const charging = await getLatestChargingProcess(db);
      if (charging && charging.end_at === null || charging?.end_date === null) {
        monitor.observeChargingStarted(charging);
      }
    } catch (error) {
      logger(`trip-monitor error: ${error.message}`);
    }
  };
  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

async function defaultSnapshot(db) {
  const rows = await db.query(`
    SELECT d.id, d.start_date AS start_at, d.end_date AS end_at
    FROM drives d
    WHERE d.end_date IS NOT NULL
    ORDER BY d.end_date DESC
    LIMIT 50
  `);
  const active = await db.queryOne(`
    SELECT d.id, d.start_date AS start_at
    FROM drives d
    WHERE d.end_date IS NULL
    ORDER BY d.start_date DESC
    LIMIT 1
  `);
  return {
    completed: rows.slice().reverse(),
    active: active ? { id: active.id, start_at: active.start_at } : null
  };
}
