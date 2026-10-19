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
  getActiveDrives,
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

// 桶键：car_id 缺失（null/undefined/0/非法）归"无主桶"，单车实例零变化。
function carKey(carId) {
  const id = Number(carId);
  return Number.isInteger(id) && id > 0 ? String(id) : "null";
}

// Restore persisted state, merging defaults so older snapshots stay loadable.
// v2（m4e 后续）：sessions 与游标按车分桶。v1 快照自动迁移 —— 全局游标作为
// 所有车的水线地板（宁可静默也不回放），全局 session 归入无主桶。
export function normalizeMonitorState(saved = {}) {
  const legacyDriveFloor = Number(saved.last_drive_id) || 0;
  const legacyChargeFloor = Number(saved.last_charging_id) || 0;
  const legacyDoneFloor = Number(saved.last_charging_done_id) || 0;
  const v2 = saved.version >= 2;
  const driveCursors = {};
  const chargeCursors = {};
  const doneCursors = {};
  if (v2) {
    for (const [key, value] of Object.entries(saved.drive_cursors || {})) driveCursors[key] = Number(value) || 0;
    for (const [key, value] of Object.entries(saved.charge_cursors || {})) chargeCursors[key] = Number(value) || 0;
    for (const [key, value] of Object.entries(saved.done_cursors || {})) doneCursors[key] = Number(value) || 0;
  }
  if (legacyDriveFloor > 0 && !Object.keys(driveCursors).length) driveCursors.null = legacyDriveFloor;
  if (legacyChargeFloor > 0 && !Object.keys(chargeCursors).length) chargeCursors.null = legacyChargeFloor;
  if (legacyDoneFloor > 0 && !Object.keys(doneCursors).length) doneCursors.null = legacyDoneFloor;

  const sessions = {};
  if (v2) {
    for (const [key, session] of Object.entries(saved.sessions || {})) {
      if (session && Array.isArray(session.segment_ids)) sessions[key] = { ...session };
    }
  } else if (saved.session && Array.isArray(saved.session.segment_ids)) {
    sessions.null = { ...saved.session };
  }

  return {
    version: 2,
    initialized: Boolean(saved.initialized),
    drive_cursors: driveCursors,
    charge_cursors: chargeCursors,
    done_cursors: doneCursors,
    sessions,
    // ---- v1 兼容访问器（测试与旧调用点直接读写 state.session / state.last_*_id） ----
    get last_drive_id() {
      return Math.max(0, ...Object.values(this.drive_cursors));
    },
    set last_drive_id(value) {
      const v = Number(value) || 0;
      if (v > (this.drive_cursors.null || 0)) this.drive_cursors.null = v;
    },
    get last_charging_id() {
      return Math.max(0, ...Object.values(this.charge_cursors));
    },
    set last_charging_id(value) {
      const v = Number(value) || 0;
      if (v > (this.charge_cursors.null || 0)) this.charge_cursors.null = v;
    },
    get last_charging_done_id() {
      return Math.max(0, ...Object.values(this.done_cursors));
    },
    set last_charging_done_id(value) {
      const v = Number(value) || 0;
      if (v > (this.done_cursors.null || 0)) this.done_cursors.null = v;
    },
    get session() {
      return this.sessions.null ?? null;
    },
    set session(value) {
      if (value) this.sessions.null = value;
      else delete this.sessions.null;
    },
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

  // ---- session lifecycle（m4e 按车分桶） --------------------------------------

  /** 桶有效水线：max(本桶, 无主桶底线) */
  bucketFloor(map, key) {
    const own = Number(map?.[key]) || 0;
    const floor = Number(map?.null) || 0;
    return Math.max(own, floor);
  }

  sessionFor(carId, createAt = null) {
    const key = carKey(carId);
    if (!this.state.sessions[key] && createAt !== null) {
      this.state.sessions[key] = newSession(createAt);
    }
    return this.state.sessions[key] ?? null;
  }

  // Close the open session: emit its trip_end (once) and clear it. A session
  // with no segments was never a trip, so it is dropped without an event.
  queueCurrentSession(at, carId = null) {
    const key = carKey(carId);
    const session = this.state.sessions[key];
    const segmentIds = session?.segment_ids || [];
    if (segmentIds.length === 0) {
      delete this.state.sessions[key];
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
    delete this.state.sessions[key];
    return true;
  }

  // True when the incoming drive belongs to a new session rather than the one
  // currently open: either charging happened in between, or the parked gap has
  // already exceeded the inactivity timeout.
  boundaryBefore(drive) {
    const session = this.sessionFor(drive.car_id);
    if (!session || !(session.segment_ids?.length > 0)) return false;
    if (drive.charging_between) return true;
    const gapMs = timeMs(drive.start_at) - timeMs(session.parked_at);
    return Number.isFinite(gapMs) && gapMs >= MONITOR_DEFAULTS.inactivityTimeoutMs;
  }

  // Fold a freshly completed drive into the open session (creating one if
  // needed) and advance the drive cursor.
  absorbCompletedDrive(drive, at) {
    const id = Number(drive.id) || 0;
    const key = carKey(drive.car_id);
    const cursor = this.bucketFloor(this.state.drive_cursors, key);
    if (id <= cursor) return; // already seen this poll or earlier（按车游标）

    if (this.boundaryBefore(drive)) {
      const session = this.sessionFor(drive.car_id);
      session.finalization_reason = drive.charging_between
        ? "charging_between"
        : "inactivity_timeout";
      this.queueCurrentSession(at, drive.car_id);
    }

    if (!this.sessionFor(drive.car_id)) {
      this.state.sessions[key] = newSession(drive.start_at || at);
    }
    const session = this.state.sessions[key];
    const wasFinalizing = session.phase === "finalizing";
    if (!session.segment_ids.includes(id)) session.segment_ids.push(id);
    if (!wasFinalizing) session.phase = "parked";
    session.parked_at = drive.end_at || at;
    session.active_started_at = null;
    session.last_event_at = drive.end_at || at;
    this.state.drive_cursors[key] = id;
  }

  // The database reporting an active drive outranks any pending finalization:
  // the car is moving again, so cancel the scheduled close.
  reviveActiveDrive(active, at) {
    const key = carKey(active?.car_id);
    if (!this.state.sessions[key]) this.state.sessions[key] = newSession(active.start_at || at);
    const session = this.state.sessions[key];
    session.phase = "driving";
    session.active_started_at = active.start_at || at;
    session.finalize_at = null;
    session.finalization_reason = null;
  }

  // ---- reconciliation ------------------------------------------------------

  // snapshot: {actives?: [{id, car_id, start_at}],      // m4e：按车活跃行
  //            active: {id, car_id?, start_at}|null,    // 兼容单行
  //            completed: [{id, car_id, start_at, end_at, charging_between}],
  //            charging_rows?: [{id, car_id, start_at, end_at}],
  //            max_drive_id?: number,          // 冷启动水线（drives 侧）
  //            latest_charging_id?: number,    // 冷启动水线（charging 侧，start 游标）
  //            latest_charging_done_id?: number} // 冷启动水线（charging_done 游标）
  reconcile(snapshot, at = this.clock()) {
    const completed = Array.isArray(snapshot?.completed) ? snapshot.completed : [];
    const actives = Array.isArray(snapshot?.actives)
      ? snapshot.actives.filter(Boolean)
      : snapshot?.active
        ? [snapshot.active]
        : [];
    const activeByKey = new Map(actives.map((a) => [carKey(a.car_id), a]));

    if (!this.state.initialized) {
      // First observation: stamp all notification water lines so historical
      // data is archived silently (AC-12.1b — drives + charging 双侧水线).
      // v2：地板写入所有已知桶（含无主桶）—— 绝不回放历史。
      this.state.initialized = true;
      const driveCursor = Number.isFinite(Number(snapshot?.max_drive_id))
        ? Number(snapshot.max_drive_id)
        : Math.max(0, ...completed.map((drive) => Number(drive.id) || 0));
      const chargeCursor = Number(snapshot?.latest_charging_id ?? snapshot?.charging?.id);
      const doneCursor = Number(snapshot?.latest_charging_done_id);
      const buckets = new Set([...activeByKey.keys(), ...completed.map((d) => carKey(d.car_id)), "null"]);
      for (const bucket of buckets) {
        if (driveCursor > (this.state.drive_cursors[bucket] || 0)) this.state.drive_cursors[bucket] = driveCursor;
        if (Number.isFinite(chargeCursor) && chargeCursor > (this.state.charge_cursors[bucket] || 0)) {
          this.state.charge_cursors[bucket] = chargeCursor;
        }
        if (Number.isFinite(doneCursor) && doneCursor > (this.state.done_cursors[bucket] || 0)) {
          this.state.done_cursors[bucket] = doneCursor;
        }
      }
    }

    for (const active of actives) this.reviveActiveDrive(active, at);
    // 快照无活动行程的桶:残留 active_started_at 只能是僵尸行/崩溃遗留
    // (实测:被 2025 年 NULL-end 行喂出的幽灵"driving"让闲置结算永久失效)。
    // 快照是"当前是否在开"的唯一事实源 → 清残留,让闲置超时路径恢复工作。
    for (const [key, session] of Object.entries(this.state.sessions)) {
      if (activeByKey.has(key) || !session?.active_started_at) continue;
      session.active_started_at = null;
      if (session.phase === "driving" && session.parked_at) {
        session.phase = "parked";
      }
    }

    for (const drive of completed) this.absorbCompletedDrive(drive, at);

    // Idle fallback / scheduled close（按车逐桶判定）
    for (const key of Object.keys(this.state.sessions)) {
      const session = this.state.sessions[key];
      const active = activeByKey.get(key) ?? null;
      if (
        session
        && !active
        && !session.active_started_at
        && session.phase !== "finalizing"
        && session.parked_at !== null
        && timeMs(at) - timeMs(session.parked_at) >= MONITOR_DEFAULTS.inactivityTimeoutMs
      ) {
        session.finalization_reason = "inactivity_timeout";
        this.queueCurrentSession(at, key === "null" ? null : Number(key));
      }
      const current = this.state.sessions[key];
      if (
        current?.phase === "finalizing"
        && !active
        && !current.active_started_at
        && timeMs(current.finalize_at) !== null
        && timeMs(at) >= timeMs(current.finalize_at)
      ) {
        this.queueCurrentSession(at, key === "null" ? null : Number(key));
      }
    }

    return this.pendingEvents();
  }

  // ---- signaling -----------------------------------------------------------

  // MQTT edge for `locked` / `driver_front_door_open`. The first value only
  // establishes a baseline (no transition). Returns whether the edge was acted
  // on. m4e：carId 指定对应车的会话（缺省无主桶，兼容旧调用）。
  observeVehicleSignal(field, value, at = this.clock(), carId = null) {
    const signal = this.state.signals[field];
    if (!signal || typeof value !== "boolean") return false;
    if (!signal.initialized) {
      signal.initialized = true;
      signal.value = value;
      return false;
    }
    if (signal.value === value) return false;
    signal.value = value;

    const session = this.sessionFor(carId);
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
  // m4e：游标按车分桶 —— 另一辆车的新充电不得推高本车的 start 游标。
  // 桶内判重取 max(本桶, 无主桶底线)：防旧版迁移态把历史行当新事件。
  observeChargingStarted(charging, at = this.clock()) {
    const id = Number(charging?.id) || 0;
    const key = carKey(charging?.car_id);
    if (id <= 0 || id <= this.bucketFloor(this.state.charge_cursors, key)) return false;
    this.state.charge_cursors[key] = id;

    const session = this.sessionFor(charging?.car_id);
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
  // m4e：done 游标同样按车 —— A 车晚结算的会话不能被 B 车更高的 done 游标吞掉。
  observeChargingDone(charging, at = this.clock()) {
    const id = Number(charging?.id) || 0;
    const key = carKey(charging?.car_id);
    if (id <= 0 || id <= this.bucketFloor(this.state.done_cursors, key)) return null;
    if (isChargingSessionOpen(charging)) return null; // 未结算行不构成 charging_done
    this.state.done_cursors[key] = id;
    // 已结算行整体已知晓：同步推进该桶 start 游标，保持「两游标 ≥ 已处理行」不变量
    if (id > (this.state.charge_cursors[key] || 0)) this.state.charge_cursors[key] = id;

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
  let ticking = false; // 慢库下防 tick 重入（5 条顺序查询 × 15s 超时可超一个周期）

  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      let snapshot;
      if (getSnapshot) {
        snapshot = { ...(await getSnapshot(db)) };
      } else {
        snapshot = await incrementalSnapshot(db, monitor);
      }
      // 兼容单活跃行快照：归一为 actives 数组（reconcile 内部处理两种形态）
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
    } finally {
      ticking = false;
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
// drives (per car). All queries are read-only SELECTs with tiny id-cursor
// predicates. 查询游标取各车桶的最小值（漏掉的行由 monitor 内按车游标再过滤），
// charging_rows = 新行（start 候选，游标 max(start,done)）；
// charging_closed_rows = 已结算行（done 候选，done 游标——open→close 的行 id 不变，
// 必须单独增量扫描）。
async function incrementalSnapshot(db, monitor) {
  // 有效游标 = max(本桶, 无主桶底线)，再对各桶取 min 作为全局增量起点：
  // ① 旧版 v1 迁移(底线只在 null 桶,车桶空) → 起点取底线,绝不重放历史
  //   (只排除 null 的做法曾导致游标归零,历史充电被当新事件全部重推)
  // ② B1 饿死(底线钉死在初始水线,车桶已前进) → 取车桶,新行照常取到
  // ③ 车桶意外落后于底线 → 自动抬回,自愈
  const minCursor = (map) => {
    const entries = Object.entries(map || {}).map(([key, value]) => [key, Number(value)]);
    const floor = entries.find(([key]) => key === "null")?.[1] ?? 0;
    const carValues = entries.filter(([key]) => key !== "null").map(([, v]) => v).filter(Number.isFinite);
    if (!carValues.length) return Number.isFinite(floor) ? floor : 0;
    return Math.min(...carValues.map((v) => Math.max(v, floor)));
  };
  const completed = await getDrivesIncremental(db, minCursor(monitor.state.drive_cursors));
  const actives = await getActiveDrives(db);
  const chargeCursor = Math.min(
    minCursor(monitor.state.charge_cursors),
    minCursor(monitor.state.done_cursors)
  );
  const chargingRows = await getChargingIncremental(db, chargeCursor);
  const chargingClosedRows = await getChargingClosedIncremental(db, minCursor(monitor.state.done_cursors));
  return {
    completed,
    actives,
    active: actives[0] ?? null,
    charging_rows: chargingRows,
    charging_closed_rows: chargingClosedRows
  };
}

// 测试钩子（仅测试引用；不参与生产路径）
export const __testIncrementalSnapshot = incrementalSnapshot;
