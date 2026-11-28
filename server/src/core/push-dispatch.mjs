// push-dispatch.mjs — 推送事件投递管线（自 index.mjs 迁出，领域层）。
//
// 单一职责：monitor/巡检/断联产生的原始事件 →（富化 → 多车标记 → 矩阵投递
// → 确认去重 → 派生告警）→ 各渠道。全部推送路径共用这一条管线，保证
// deliveryMs 埋点、chargeInterrupt 派生、pending 补发语义只有一份实现。
import { getCars } from "./teslamate-queries.mjs";
import { enrichTripEndEvent, enrichChargingDoneEvent, enrichChargingStartEvent } from "./event-enrichment.mjs";

/**
 * @param {object} deps
 *   db        TeslaMate 查询（事件源车反查）
 *   state     实例状态（settings.carAliases 多车别名）
 *   notifier  渠道矩阵投递器（push-channels.createNotifier）
 *   eventLog  事件日志
 *   monitor   TripMonitor（acknowledge 去重确认）
 * @returns {{ dispatch, carsListCached, replayPending }}
 */
export function createPushDispatch({ db, state, notifier, eventLog, monitor }) {
  // ---- m4e 多车:推送事件的车辆标记(60s 车辆缓存) --------------------------
  let carsCache = { at: 0, list: null };
  async function carsListCached() {
    if (carsCache.list && Date.now() - carsCache.at < 60_000) return carsCache.list;
    try {
      const rows = await getCars(db);
      carsCache = { at: Date.now(), list: rows };
    } catch {
      carsCache = { at: Date.now(), list: carsCache.list || [] }; // 查询失败沿用旧缓存
    }
    return carsCache.list;
  }

  async function carIdOfEvent(event) {
    try {
      if (event.type === "trip_end" && Array.isArray(event.segment_ids) && event.segment_ids.length) {
        const r = await db.queryOne("SELECT car_id FROM drives WHERE id = $1", [Number(event.segment_ids[0])]);
        return r?.car_id ?? null;
      }
      if ((event.type === "charging_start" || event.type === "charging_done" || event.type === "chargeInterrupt")
        && event.charging_process_id) {
        const r = await db.queryOne("SELECT car_id FROM charging_processes WHERE id = $1", [Number(event.charging_process_id)]);
        return r?.car_id ?? null;
      }
    } catch { /* 查不到就不标记 */ }
    return null;
  }

  async function carLabelForEvent(event) {
    const cars = await carsListCached();
    if (!cars || cars.length <= 1) return null; // 单车实例:标题零变化
    const carId = event.carId ?? await carIdOfEvent(event);
    if (carId == null) return null;
    const car = cars.find((c) => Number(c.id) === Number(carId));
    if (!car) return null;
    return state.settings?.carAliases?.[String(carId)] || car.name;
  }

  async function dispatch(rawEvent) {
    // 事件富化（v2.2 + P1 b/c/d）：天气/胎压/速度/怠速 + 计价批次 + 充电预估/对比
    let event = rawEvent;
    try {
      if (event.type === "trip_end") {
        event = await enrichTripEndEvent(db, event, { state });
      } else if (event.type === "charging_done") event = await enrichChargingDoneEvent(db, event, { state });
      else if (event.type === "charging_start") event = await enrichChargingStartEvent(db, event);
    } catch (error) {
      eventLog.log("push.enrich_error", { message: error.message });
    }
    // m4e 多车:车辆标记。cars ≤1 时零变化(不挂 carLabel,标题不加后缀);
    // 多车时 trip/charging 事件按事件源车挂 `carLabel`(别名优先),标题后缀 `· 别名`。
    try {
      const label = await carLabelForEvent(event);
      if (label) event.carLabel = label;
    } catch { /* 标记失败不影响推送 */ }
    // 矩阵化投递（GA-08/AC-12.2）：多渠道并行 + 单渠道失败隔离 + deliveryMs 埋点
    const t0 = Date.now();
    const { results } = await notifier.dispatch(event);
    const deliveryMs = Date.now() - t0;
    eventLog.log("push.dispatch", { type: event.type, results, deliveryMs });
    // M2 修复：投递尝试即确认（不再只在 ≥1 渠道成功时确认）。dedupe 由
    // sent_keys 承担 —— 此前全渠道失败/矩阵全关的事件会永远卡在 pending：
    // 不重发、又堵住同 key 再触发，静音时段的 backlog 也在 kv 里无限累积。
    if (event.eventKey) monitor.acknowledge(event.eventKey);

    // P2 告警派生:充电结束且明显提前(富化层 endBattery<80 置 endedEarly)→
    // 独立更醒目的 chargeInterrupt 告警(charging_done 照常已发,两者并存)。
    // charging_done 本身每会话恰一次(monitor 去重) → 派生事件天然每会话一次。
    if (event.type === "charging_done" && event.endedEarly) {
      try {
        const alarm = await notifier.dispatch({
          type: "chargeInterrupt",
          charging_process_id: event.charging_process_id,
          endBattery: event.endBattery,
          energyKwh: event.energyKwh,
          locationName: event.locationName
        });
        eventLog.log("push.dispatch", { type: "chargeInterrupt", derived: true, results: alarm.results, deliveryMs: Date.now() - t0 });
      } catch (error) {
        eventLog.log("push.error", { message: `chargeInterrupt: ${error.message}` });
      }
    }
  }

  /** M2 修复：崩溃/重启时未完成投递的 pending 事件补发（最多 20 条、7 天内的
   *  才补 —— dedupe 保证同 key 不重推；过期事件直接丢弃并记日志）。 */
  function replayPending() {
    const pending = monitor.pendingEvents();
    const now = Date.now();
    let replayed = 0;
    for (const event of pending.slice(0, 20)) {
      const atMs = Date.parse(event.at || event.ended_at || "");
      if (Number.isFinite(atMs) && now - atMs > 7 * 24 * 3600_000) {
        if (event.eventKey) monitor.acknowledge(event.eventKey);
        eventLog?.log?.("push.pending_dropped", { eventKey: event.eventKey, type: event.type });
        continue;
      }
      replayed += 1;
      dispatch(event).catch((error) => eventLog?.log?.("push.error", { message: error.message }));
    }
    return { total: pending.length, replayed };
  }

  return { dispatch, carsListCached, replayPending };
}
