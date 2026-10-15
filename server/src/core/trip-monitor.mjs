// trip-monitor.mjs — AhaTesla trip-boundary watcher.
//
// A polling worker that watches the (read-only) TeslaMate database for the
// moments that matter to the owner: when a trip ends and when charging begins.
// It turns those moments into events for the push channels (US-12).
//
// A "trip" is modelled as a session: one or more consecutive drive segments
// separated by short parking gaps. A session is closed when a boundary is
// observed. Boundaries are recovered from the database alone (a charge that
// happened between two drives, or a parking gap longer than the inactivity
// timeout); when MQTT is configured, lock/door signals can close a session
// sooner, but the database always remains the source of truth.
//
// Event capture is a lightweight PostgreSQL poll (AC-12.1b). On the very first
// observation the monitor stamps a notification water line for both drives and
// charging sessions, so everything that predates first connect is recorded
// silently and never replayed as a push (no history storm).
//
// Sources of truth for the behaviour implemented here: docs/PRD.md US-12 /
// AC-12.1a / AC-12.1b and docs/API_CONTRACT.md §1 (event capture). This is
// AhaTesla's own implementation; no third-party source is used.
import {
  getLatestChargingProcess,
  getMaxDriveId,
  getDrivesIncremental,
  getActiveDrive,
  getChargingIncremental,
  getChargingClosedIncremental
} from "./teslamate-queries.mjs";
import { timeMs } from "./util.mjs";

export const MONITOR_DEFAULTS = Object.freeze({
  pollMs: 30_000,
  inactivityTimeoutMs: 30 * 60 * 1_000,
  finalizationDelayMs: 45_000,
  boundarySignalToleranceMs: 10_000,
  parallelLockWindowMs: 10 * 60 * 1_000
});

// Restore persisted state, merging defaults so older snapshots stay loadable.
export function normalizeMonitorState(saved = {}) {
  return {
    version: 1,
    initialized: Boolean(saved.initialized),
    last_drive_id: Number(saved.last_drive_id) || 0,
    last_charging_id: Number(saved.last_charging_id) || 0,
    last_charging_done_id: Number(saved.last_charging_done_id) || 0,
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

// A charging row is "open" only when it exists and has no end time yet. Written
// with explicit scoping so the intent is unambiguous (TeslaMate exposes the end
// as `end_at`; some shapes carry `end_date`).
export function isChargingSessionOpen(charging) {
  return Boolean(charging) && (charging.end_at ?? charging.end_date ?? null) === null;
}

export class TripMonitor {
  constructor({ state = {}, onEvent = () => {}, clock = () => new Date().toISOString() } = {}) {
    this.state = normalizeMonitorState(state);
    this.onEvent = onEvent;
    this.clock = clock;
  }

  // ---- session lifecycle ---------------------------------------------------

  // Close the open session: emit its trip_end (once) and clear it. A session
  // with no segments was never a trip, so it is dropped without an event.
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

  // True when the incoming drive belongs to a new session rather than the one
  // currently open: either charging happened in between, or the parked gap has
  // already exceeded the inactivity timeout.
  boundaryBefore(drive) {
    const session = this.state.session;
    if (!session || !(session.segment_ids?.length > 0)) return false;
    if (drive.charging_between) return true;
    const gapMs = timeMs(drive.start_at) - timeMs(session.parked_at);
    return Number.isFinite(gapMs) && gapMs >= MONITOR_DEFAULTS.inactivityTimeoutMs;
  }

  // Fold a freshly completed drive into the open session (creating one if
  // needed) and advance the drive cursor.
  absorbCompletedDrive(drive, at) {
    const id = Number(drive.id) || 0;
    if (id <= this.state.last_drive_id) return; // already seen this poll or earlier

    if (this.boundaryBefore(drive)) {
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

  // The database reporting an active drive outranks any pending finalization:
  // the car is moving again, so cancel the scheduled close.
  reviveActiveDrive(active, at) {
    if (!this.state.session) this.state.session = newSession(active.start_at || at);
    this.state.session.phase = "driving";
    this.state.session.active_started_at = active.start_at || at;
    this.state.session.finalize_at = null;
    this.state.session.finalization_reason = null;
  }

  // ---- reconciliation ------------------------------------------------------

  // snapshot: {active: {id, start_at}|null,
  //            completed: [{id, start_at, end_at, charging_between}],
  //            charging_rows?: [{id, start_at, end_at}],
  //            max_drive_id?: number,          // 冷启动水线（drives 侧）
  //            latest_charging_id?: number,    // 冷启动水线（charging 侧，start 游标）
  //            latest_charging_done_id?: number} // 冷启动水线（charging_done 游标）
  reconcile(snapshot, at = this.clock()) {
    const completed = Array.isArray(snapshot?.completed) ? snapshot.completed : [];
    const active = snapshot?.active || null;

    if (!this.state.initialized) {
      // First observation: stamp all notification water lines so historical
      // data is archived silently (AC-12.1b — drives + charging 双侧水线).
      this.state.initialized = true;
      const driveCursor = Number.isFinite(Number(snapshot?.max_drive_id))
        ? Number(snapshot.max_drive_id)
        : Math.max(0, ...completed.map((drive) => Number(drive.id) || 0));
      if (driveCursor > this.state.last_drive_id) this.state.last_drive_id = driveCursor;
      const chargeCursor = Number(snapshot?.latest_charging_id ?? snapshot?.charging?.id);
      if (Number.isFinite(chargeCursor) && chargeCursor > this.state.last_charging_id) {
        this.state.last_charging_id = chargeCursor;
      }
      const doneCursor = Number(snapshot?.latest_charging_done_id);
      if (Number.isFinite(doneCursor) && doneCursor > this.state.last_charging_done_id) {
        this.state.last_charging_done_id = doneCursor;
      }
    }

    if (active) this.reviveActiveDrive(active, at);

    for (const drive of completed) this.absorbCompletedDrive(drive, at);

    const session = this.state.session;
    // Idle fallback: a parked session with no activity for the whole timeout is
    // considered ended even without a lock signal.
    if (
      session
      && !active
      && !session.active_started_at
      && session.phase !== "finalizing"
      && session.parked_at !== null
      && timeMs(at) - timeMs(session.parked_at) >= MONITOR_DEFAULTS.inactivityTimeoutMs
    ) {
      session.finalization_reason = "inactivity_timeout";
      this.queueCurrentSession(at);
    }
    // Scheduled close from an earlier boundary decision: fire once due.
    if (
      session?.phase === "finalizing"
      && !active
      && !session.active_started_at
      && timeMs(session.finalize_at) !== null
      && timeMs(at) >= timeMs(session.finalize_at)
    ) {
      this.queueCurrentSession(at);
    }

    return this.pendingEvents();
  }

  // ---- signaling -----------------------------------------------------------

  // MQTT edge for `locked` / `driver_front_door_open`. The first value only
  // establishes a baseline (no transition). Returns whether the edge was acted
  // on.
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

    // Locking shortly after parking is the strong hint that the trip is over:
    // within the parallel-lock window, schedule a close after a short debounce.
    if (field === "locked" && value === true && session.phase === "parked" && session.parked_at) {
      const lockedMs = timeMs(at);
      const parkedMs = timeMs(session.parked_at);
      if (
        lockedMs !== null
        && parkedMs !== null
        && lockedMs >= parkedMs - MONITOR_DEFAULTS.boundarySignalToleranceMs
        && lockedMs - parkedMs <= MONITOR_DEFAULTS.parallelLockWindowMs
      ) {
        session.phase = "finalizing";
        session.finalization_reason = "locked";
        session.finalize_at = new Date(lockedMs + MONITOR_DEFAULTS.finalizationDelayMs).toISOString();
      }
    }
    return true;
  }

  // A new charging session means the car stopped driving: schedule the open
  // trip to close after the debounce delay, and emit charging_start.
  //
  // Guarded by the charging water line (AC-12.1b): sessions at or below the
  // cursor stamped at first connect are historical and never replay as events.
  // Dedup key `charging-start-<id>` guards against the same id being observed
  // twice (e.g. MQTT fast-path + later poll of the same row — AC-12.1b 双源一致).
  observeChargingStarted(charging, at = this.clock()) {
    const id = Number(charging?.id) || 0;
    if (id <= 0 || id <= this.state.last_charging_id) return false;
    this.state.last_charging_id = id;

    const session = this.state.session;
    if (session && session.phase !== "finalizing") {
      session.phase = "finalizing";
      session.finalization_reason = "charging_started";
      session.finalize_at = new Date(
        (timeMs(at) ?? Date.now()) + MONITOR_DEFAULTS.finalizationDelayMs
      ).toISOString();
      session.last_event_at = at;
    }

    this.emitEvent({
      type: "charging_start",
      eventKey: `charging-start-${id}`,
      charging_process_id: id,
      started_at: charging?.start_at ?? charging?.start_date ?? at,
      at
    });
    return true;
  }

  // A finished charging session produces its own notification. Guarded by the
  // charging_done water line: rows at or below the cursor (stamped at first
  // connect) are historical and archived silently, never pushed.
  observeChargingDone(charging, at = this.clock()) {
    const id = Number(charging?.id) || 0;
    if (id <= 0 || id <= this.state.last_charging_done_id) return null;
    if (isChargingSessionOpen(charging)) return null; // 未结算行不构成 charging_done
    this.state.last_charging_done_id = id;
    // 已结算行整体已知晓：同步推进 start 游标，保持「两游标 ≥ 全部已处理行」不变量
    if (id > this.state.last_charging_id) this.state.last_charging_id = id;

    const event = {
      type: "charging_done",
      eventKey: `charging-done-${id}`,
      charging_process_id: id,
      ended_at: charging?.end_at ?? charging?.end_date ?? at,
      at
    };
    this.emitEvent(event);
    return event;
  }

  // Fold an incremental batch of charging rows (id > charging cursor, from the
  // id-incremental poll) into the two charging events: open rows are potential
  // charging_start, closed rows charging_done candidates. Open rows keep their
  // cursor only on the start side, so a later close of the same row still fires
  // charging_done exactly once.
  reconcileCharging(rows, at = this.clock()) {
    const batch = (Array.isArray(rows) ? rows : []).slice().sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    for (const row of batch) {
      if (isChargingSessionOpen(row)) {
        this.observeChargingStarted(row, at);
      } else {
        this.observeChargingDone(row, at);
      }
    }
    return this.pendingEvents();
  }

  // Incremental batch of newly settled (end_date non-null) rows: feeds only the
  // charging_done cursor path. Catches rows that were observed open earlier and
  // closed later (their id never changes, so the new-row scan misses the close).
  reconcileChargingClosed(rows, at = this.clock()) {
    const batch = Array.isArray(rows) ? rows : [];
    for (const row of batch) this.observeChargingDone(row, at);
    return this.pendingEvents();
  }

  // ---- event bookkeeping ---------------------------------------------------

  // Register + hand out an event exactly once per eventKey (dedup across
  // sources and restarts). Returns false when the key was already pending or
  // already sent (no double push).
  emitEvent(event) {
    const key = event?.eventKey;
    if (!key) {
      this.onEvent(event);
      return true;
    }
    if (this.state.pending_events[key] || this.state.sent_keys[key]) return false;
    this.state.pending_events[key] = event;
    this.onEvent(event);
    return true;
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

// Poll loop used by index.mjs; db, clock and snapshot are injectable for tests.
// The snapshot is id-incremental (WHERE id > cursor, AC-12.1b §7.1): each tick
// only fetches rows newer than the persisted cursors, not a fixed tail.
export function startTripMonitorLoop({ monitor, db, pollMs = MONITOR_DEFAULTS.pollMs, getSnapshot, logger = () => {}, onPollResult = null } = {}) {
  let stopped = false;
  let waterlinePrimed = false;

  const tick = async () => {
    if (stopped) return;
    try {
      let snapshot;
      if (getSnapshot) {
        snapshot = { ...(await getSnapshot(db)) };
      } else {
        snapshot = await incrementalSnapshot(db, monitor);
      }
      // Cold start: stamp all notification water lines from the database so a
      // leftover historical session cannot fire on connect (AC-12.1b).
      if (!waterlinePrimed) {
        snapshot.max_drive_id = Math.max(Number(snapshot.max_drive_id) || 0, await getMaxDriveId(db));
        const latestCharge = await getLatestChargingProcess(db);
        const latestId = Number(latestCharge?.id) || 0;
        snapshot.latest_charging_id = Math.max(Number(snapshot.latest_charging_id) || 0, latestId);
        const latestDone = await db.queryOne(`
          SELECT COALESCE(max(cp.id), 0)::int AS max_id
          FROM charging_processes cp
          WHERE cp.end_date IS NOT NULL
        `);
        snapshot.latest_charging_done_id = Math.max(
          Number(snapshot.latest_charging_done_id) || 0,
          Number(latestDone?.max_id) || 0
        );
        waterlinePrimed = true;
        // 水线之前的历史仅静默建档：清空增量行，首帧只建水线不产生事件。
        snapshot.completed = [];
        snapshot.charging_rows = [];
      }

      monitor.reconcile(snapshot);
      if (Array.isArray(snapshot.charging_rows)) {
        monitor.reconcileCharging(snapshot.charging_rows);
      }
      // 已结算增量（open→close 的行）：单独喂给 done 游标路径
      if (Array.isArray(snapshot.charging_closed_rows)) {
        monitor.reconcileChargingClosed(snapshot.charging_closed_rows);
      }
      onPollResult?.(true);
    } catch (error) {
      onPollResult?.(false);
      logger(`trip-monitor error: ${error.message}`);
    }
  };

  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  tick();
  return {
    // 立即触发一次轮询（MQTT 边沿信号到达时用于加速捕获；不改变游标语义）。
    // 返回 tick 的 promise 便于测试 await。
    poke() {
      if (!stopped) return tick();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

// Incremental snapshot: only rows past the persisted cursors, plus the active
// drive. All queries are read-only SELECTs with tiny id-cursor predicates.
// charging_rows = 新行（start 候选，游标 max(start,done)）；
// charging_closed_rows = 已结算行（done 候选，done 游标——open→close 的行 id 不变，
// 必须单独增量扫描）。
async function incrementalSnapshot(db, monitor) {
  const completed = await getDrivesIncremental(db, monitor.state.last_drive_id);
  const active = await getActiveDrive(db);
  const chargeCursor = Math.max(monitor.state.last_charging_id, monitor.state.last_charging_done_id);
  const chargingRows = await getChargingIncremental(db, chargeCursor);
  const chargingClosedRows = await getChargingClosedIncremental(db, monitor.state.last_charging_done_id);
  return {
    completed,
    active,
    charging_rows: chargingRows,
    charging_closed_rows: chargingClosedRows
  };
}
