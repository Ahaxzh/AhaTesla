// events.mjs — in-memory ring of runtime events (push records, errors) for
// GET /api/system/events. Also feeds the /ws stream when implemented.
const MAX_EVENTS = 500;

export function createEventLog({ limit = MAX_EVENTS } = {}) {
  const events = [];
  function log(type, detail = {}) {
    const entry = { at: new Date().toISOString(), type, ...detail };
    events.push(entry);
    if (events.length > limit) events.splice(0, events.length - limit);
    return entry;
  }
  return {
    log,
    list({ limit: ask = 100 } = {}) {
      return events.slice(-Math.max(1, Math.min(500, Number(ask) || 100))).reverse();
    },
    size() {
      return events.length;
    }
  };
}
