// monitor-persistence.mjs — TripMonitor 状态的崩溃自愈持久化（自 index.mjs 迁出）。
//
// GA-39（§7.4）：monitor 状态（水线游标 + sent_keys/pending_events）持久化到
// SQLite kv，重启恢复，避免重复推送/水线重算。防抖写回（节流 2s）+ 周期兜底。
export const MONITOR_STATE_KEY = "monitor_state_v1";

/**
 * @returns {{ persist: () => void, flushNow: () => void, dispose: () => void }}
 *  persist   防抖 2s 写回（事件驱动路径调用）
 *  flushNow  立即同步写回（关停路径调用；dispose 前自动 flush）
 */
export function createMonitorPersistence({ monitor, store, eventLog, debounceMs = 2_000 } = {}) {
  let timer = null;

  function serialize() {
    try {
      // M2:sent_keys 只保留最近 500 条(eventKey 去重只需覆盖近期),
      // 防止常年运行下 kv blob 无限膨胀拖慢每次序列化。
      const keys = Object.keys(monitor.state.sent_keys || {});
      if (keys.length > 500) {
        for (const key of keys.slice(0, keys.length - 500)) delete monitor.state.sent_keys[key];
      }
      store.kvPut(MONITOR_STATE_KEY, JSON.stringify(monitor.state));
    } catch (error) {
      eventLog?.log?.("monitor.persist_error", { message: error?.message });
    }
  }

  return {
    persist() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        serialize();
      }, debounceMs);
      timer.unref?.();
    },
    flushNow() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      serialize();
    },
    dispose() {
      this.flushNow();
    }
  };
}
