// health.mjs — 数据源失联横幅与边界的共享状态（AC-5.2 / §6.4）。
//
// 探活失败计数：连续 2 次（≈ 60s，30s 轮询间隔）失败 → 断连；恢复 → 清零。
// “失联 > 2 分钟”判定基于 firstFailAt 时间戳。trip-monitor 循环每帧调用
// recordProbe(dbOk)；/api/system/health-lite 匿名读取状态供前端横幅轮询。
//
// 纯内存（进程内单实例）；重启后由第一帧探活重建。

const state = {
  consecutiveFails: 0,
  firstFailAt: null,   // ms epoch
  lastOkAt: null,
  lastFailAt: null
};

export function recordProbe(ok, now = Date.now()) {
  if (ok) {
    state.consecutiveFails = 0;
    state.firstFailAt = null;
    state.lastOkAt = now;
  } else {
    state.consecutiveFails += 1;
    state.lastFailAt = now;
    if (!state.firstFailAt) state.firstFailAt = now;
  }
  return healthState(now);
}

export function healthState(now = Date.now()) {
  const down = state.consecutiveFails >= 2;
  const outageMs = down && state.firstFailAt ? now - state.firstFailAt : 0;
  return {
    dbOk: !down,
    consecutiveFails: state.consecutiveFails,
    outageMs,
    bannerLevel: !down ? null : outageMs > 2 * 60_000 ? "error" : "warn"
  };
}

export function resetHealth() {
  state.consecutiveFails = 0;
  state.firstFailAt = null;
  state.lastOkAt = null;
  state.lastFailAt = null;
}

// ---- P2 告警:断联/恢复边沿观察者 -------------------------------------------
// 每次 recordProbe 后调用 observe(result)：断联持续超阈值时触发一次 onOutage，
// 恢复时若曾通知过则触发一次 onRecovered(带断联总时长)。纯边沿语义，天然各一次。
export function createOutageWatcher({ thresholdMs = 10 * 60_000, onOutage, onRecovered } = {}) {
  let notified = false;    // 本次断联是否已推送过
  let outageStart = null;  // ms epoch
  return {
    observe(result, now = Date.now()) {
      if (!result?.dbOk) {
        if (!outageStart) outageStart = now;
        if (!notified && result.outageMs >= thresholdMs) {
          notified = true;
          onOutage?.(result.outageMs);
        }
        return null;
      }
      if (notified && outageStart) {
        const totalMs = now - outageStart;
        notified = false;
        outageStart = null;
        onRecovered?.(totalMs);
        return "recovered";
      }
      notified = false;
      outageStart = null;
      return null;
    },
    // 测试辅助
    _reset() { notified = false; outageStart = null; }
  };
}
