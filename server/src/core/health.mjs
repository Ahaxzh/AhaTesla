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
