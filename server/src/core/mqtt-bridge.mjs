// mqtt-bridge.mjs — MQTT 可选增强（PRD §7.1 / AC-12.1b / AC-5.1）。
//
// 设计要点：
// - **可选，非强制**：仅当 MQTT_URL 显式配置时启用；未配置时返回 null，系统
//   状态页不显示 MQTT 项（AC-5.1），纯轮询基线独立满足 60s SLA（AC-12.3）。
// - **优雅降级**：配置了但连不上时轮询照常工作；连接错误只记事件日志，不抛出、
//   不重试风暴（mqtt 库自带 reconnectPeriod 退避）。
// - **只读订阅**：仅 SUBSCRIBE teslamate 主题（车锁/车门/充电会话边界信号），
//   绝不 PUBLISH 任何车辆控制命令（安全红线）。
// - **双源一致（AC-12.1b）**：MQTT 感知的充电开始与轮询发现走同一个
//   TripMonitor.observeChargingStarted（水位游标 + eventKey 去重），同一事件
//   无论先被哪一侧发现都只会推送一次。
//
// This is AhaTesla's own implementation; no third-party source is used.

// 默认只读订阅主题（per-car 通配 1 位车 id；消息只读解析，永不发布）。
export function defaultSubscribeTopics(carId = 1) {
  return [
    `teslamate/cars/${carId}/locked`,
    `teslamate/cars/${carId}/driver_front_door_open`,
    `teslamate/cars/${carId}/plugged_in`,
    `teslamate/cars/${carId}/charging`
  ];
}

function payloadToBool(payload) {
  const text = String(payload ?? "").trim().toLowerCase();
  return text === "true" || text === "1";
}

// parseChargingBoundary: charging/plugged_in 边沿 → {kind:"start"|"done"}|null。
// 基线（prev 为 null）不构成边沿（与轮询水线同理：首帧只建基线）。
export function parseChargingBoundary(prevCharging, charging, prevPlugged, plugged) {
  if (prevCharging === false && charging === true) return { kind: "start" };
  if (prevCharging === true && charging === false) {
    // 拔枪完成充电（plugged_in 同步转 false 更强；单 charging=false 也接受）
    return { kind: "done" };
  }
  if (prevPlugged === true && plugged === false) return { kind: "done" };
  return null;
}

// 创建 MQTT 桥。任何失败（未安装依赖、连不上）都降级返回 null（纯轮询）。
// options: { url, monitor, eventLog, logger, topics, connectTimeoutMs, reconnectPeriodMs }
export async function startMqttBridge(options = {}) {
  const {
    url,
    monitor,
    eventLog,
    logger = () => {},
    topics = defaultSubscribeTopics(),
    connectTimeoutMs = 5_000,
    reconnectPeriodMs = 10_000
  } = options;

  if (!url) return null; // 未显式配置 → MQTT 项不出现（AC-5.1 / §7.1）

  let mqtt;
  try {
    mqtt = (await import("mqtt")).default;
  } catch (error) {
    logger(`mqtt module unavailable: ${error.message}`);
    return null;
  }

  return new Promise((resolve) => {
    let settled = false;
    let client;
    const signalState = { charging: null, plugged_in: null };
    const finish = (bridge) => {
      if (!settled) {
        settled = true;
        resolve(bridge);
      }
    };

    try {
      client = mqtt.connect(url, { connectTimeout: connectTimeoutMs, reconnectPeriod: reconnectPeriodMs });
    } catch (error) {
      logger(`mqtt connect failed: ${error.message}`);
      finish(null);
      return;
    }

    const bridge = {
      isConfigured: () => true,
      isConnected: () => client?.connected === true,
      close: async () => {
        try {
          await (client.endAsync?.() ?? client.end(true));
        } catch { /* already closed */ }
      }
    };

    client.on("error", (error) => {
      eventLog?.log?.("mqtt.error", { message: error.message });
      // 首连失败 → 立即降级为 null（轮询基线继续）；此后由 mqtt 库自动重连。
      if (!settled) {
        try { client.end(true); } catch { /* ignore */ }
        finish(null);
      }
    });

    client.on("connect", () => {
      logger(`mqtt connected: ${url}`);
      for (const topic of topics) client.subscribe(topic, { qos: 0 });
      finish(bridge);
    });

    client.on("message", (topic, payload) => {
      const field = topic.split("/").pop();
      const value = payloadToBool(payload);
      try {
        if (field === "locked" || field === "driver_front_door_open") {
          const changed = monitor.observeVehicleSignal(field, value);
          if (changed) eventLog?.log?.("mqtt.signal", { field, value });
          return;
        }
        if (field === "charging" || field === "plugged_in") {
          const prev = field === "charging" ? signalState.charging : signalState.plugged_in;
          if (prev === null) {
            // 首帧只建基线，不产生事件（与轮询水线同理）
            if (field === "charging") signalState.charging = value;
            else signalState.plugged_in = value;
            return;
          }
          const boundary = parseChargingBoundary(
            signalState.charging, field === "charging" ? value : signalState.charging,
            signalState.plugged_in, field === "plugged_in" ? value : signalState.plugged_in
          );
          if (field === "charging") signalState.charging = value;
          else signalState.plugged_in = value;
          if (!boundary) return;
          eventLog?.log?.("mqtt.charging_boundary", { kind: boundary.kind, source: "mqtt" });
          // 双源一致：MQTT 只负责"更早发现"，事件语义与去重完全落在轮询侧的
          // observeCharging*（水位游标 + eventKey）。MQTT 无 charging_process id，
          // 无法构造稳定 eventKey，因此这里仅记日志 + 触发一次即时轮询探测，
          // 由数据库权威行产生事件（DB 为 source of truth）。
          bridge.onBoundary?.(boundary.kind);
        }
      } catch (error) {
        eventLog?.log?.("mqtt.error", { message: error.message });
      }
    });
  });
}
