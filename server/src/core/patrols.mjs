// patrols.mjs — 告警巡检（自 index.mjs 迁出，领域层）。
//
// 三条巡检（胎压 24h / 低电量 24h / 保养 7 天），由监控循环每帧触发；
// 节流时间戳经 SQLite kv 持久化（saveState 白名单会静默丢非白名单字段，
// 重启即重推）。一次巡检只推一条告警（多车问题明日再报）。
import { checkTirePressure, checkBatteryLow } from "./alerts.mjs";
import { maintenanceStatus } from "./maintenance.mjs";

export function createPatrols({ db, state, store, dispatch, carsListCached }) {
  // m4e 多车:逐车巡检,事件带 carId(push-dispatch 据此挂车名后缀)。
  async function carListOrDefault() {
    try {
      const cars = await carsListCached();
      if (cars?.length) return cars;
    } catch { /* 车表不可达 → 全库巡检 */ }
    return [{ id: null }];
  }

  /** 胎压巡检：四轮最低 <2.6bar 越限且距上次告警 ≥24h 才推。 */
  async function patrolTirePressure() {
    const now = Date.now();
    const lastTireAlertAt = Number(store.kvGet("alerts:lastTireAlertAt")) || 0;
    if (lastTireAlertAt && now - lastTireAlertAt < 24 * 3600_000) return;
    const cars = await carListOrDefault();
    for (const car of cars) {
      const r = await checkTirePressure(db, { carId: car.id });
      if (!r) continue;
      store.kvPut("alerts:lastTireAlertAt", String(now));
      await dispatch({
        type: "tirePressure", carId: r.carId ?? car.id, tirePressure: r, minBar: r.min, suggest: r.suggest
      }).catch(() => {});
      break;
    }
  }

  /** 低电量巡检（v2.5）：最新电量 <20% 且无进行中充电（alerts.checkBatteryLow 判定）。 */
  async function patrolBatteryLow() {
    const now = Date.now();
    const lastAt = Number(store.kvGet("alerts:lastBatteryLowAlertAt")) || 0;
    if (lastAt && now - lastAt < 24 * 3600_000) return;
    const cars = await carListOrDefault();
    for (const car of cars) {
      const r = await checkBatteryLow(db, { carId: car.id });
      if (!r) continue;
      store.kvPut("alerts:lastBatteryLowAlertAt", String(now));
      await dispatch({
        type: "batteryLow", carId: r.carId ?? car.id, batteryLevel: r.batteryLevel, thresholdPct: r.thresholdPct
      }).catch(() => {});
      break;
    }
  }

  /** 保养里程巡检（v2.5，7 天节流；只在有到期项时推送）。 */
  async function patrolMaintenance() {
    const now = Date.now();
    const lastAt = Number(store.kvGet("alerts:lastMaintenanceAlertAt")) || 0;
    if (lastAt && now - lastAt < 7 * 24 * 3600_000) return;
    try {
      const status = await maintenanceStatus(db, store, { carId: state.datasource?.carId ?? null });
      const due = status.items.filter((i) => i.due);
      if (!due.length) return;
      store.kvPut("alerts:lastMaintenanceAlertAt", String(now));
      await dispatch({
        type: "maintenance", odometerKm: status.odometerKm, items: status.items
      }).catch(() => {});
    } catch { /* 巡检失败静默 */ }
  }

  /** 监控循环每帧调用：三巡检并发（各自节流，互不阻塞）。 */
  function runAll() {
    void patrolTirePressure();
    void patrolBatteryLow();
    void patrolMaintenance();
  }

  return { runAll, patrolTirePressure, patrolBatteryLow, patrolMaintenance };
}
