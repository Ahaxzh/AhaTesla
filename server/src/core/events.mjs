// events.mjs — 事件日志（§7.1 事件日志域）。
// M0：内存环形（500 条），重启即失。M1（t_46fd8a8a）：可选 SQLite 持久后端——
// createEventLog({ store }) 时写入 events 表并裁剪保留量；list 合并读取（DB 优先）。
// 未传 store 时保持纯内存语义（既有测试/路由注入零改动）。
const MAX_EVENTS = 500;
const DB_KEEP = 2000; // DB 后端保留条数（比内存大：支持审计回看）

export function createEventLog({ limit = MAX_EVENTS, store = null } = {}) {
  const events = [];
  function log(type, detail = {}) {
    const entry = { at: new Date().toISOString(), type, ...detail };
    if (store) {
      // detail 展开进 payload（与内存形状一致），不含 at/type 本身。
      const { at: _at, type: _type, ...payload } = entry;
      try {
        store.logEvent({ at: entry.at, type, detail: payload });
        if (store.countEvents() % DB_KEEP === 0) store.pruneEvents(DB_KEEP);
      } catch { /* 事件写入失败不阻塞主流程 */ }
    } else {
      events.push(entry);
      if (events.length > limit) events.splice(0, events.length - limit);
    }
    return entry;
  }
  return {
    log,
    list({ limit: ask = 100 } = {}) {
      const cap = Math.max(1, Math.min(500, Number(ask) || 100));
      if (store) return store.listEvents(cap);
      return events.slice(-cap).reverse();
    },
    size() {
      return store ? store.countEvents() : events.length;
    }
  };
}
