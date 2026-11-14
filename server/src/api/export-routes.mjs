// export routes — CSV 导出（自托管"数据是自己的"刚需：行程/充电流水带走，含 FIFO 分摊列）。
// 只读端点，走 requireAuth；只导 UI 已展示的口径（地址标签，无 GPS 坐标——红线 2）。
import { listDrivesSql, listCharging, countCharging } from "../core/teslamate-queries.mjs";
import { computeTripViews } from "./trips-routes.mjs";
import { chargeRowToView } from "./charging-routes.mjs";
import { pricingOptionsFor, instanceTimezone } from "../core/pricing-options.mjs";
import { carIdFromQuery } from "./car-scope.mjs";
import { HttpError } from "./http-kit.mjs";

/** 防呆上限：个人实例远达不到，只防异常参数拖库 */
const EXPORT_ROW_CAP = 20000;

function validIso(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (Number.isNaN(new Date(value).getTime())) throw new HttpError(400, "bad_request", `invalid ${field} timestamp`);
  return new Date(value).toISOString();
}

/** RFC 4180 转义：含逗号/引号/换行的字段包引号，引号翻倍 */
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(ctx, filename, rows) {
  // BOM 让 Excel 双击直接打开中文不乱码；\r\n 兼容老版 Excel 换行。
  // 走原生 writeHead+end（不经 ctx.json 的 JSON 序列化）
  const body = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  ctx.res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
  ctx.res.end(body);
}

const COST_SOURCE_LABEL = { manual: "已录入", geofence: "规则计价", default: "默认估算", unknown: "未知" };

export function createExportRoutes({ db, state }) {
  return {
    /** GET /api/export/trips?from&to&carId —— 行程流水 CSV（费用与列表同 FIFO 回放口径） */
    async trips(ctx) {
      const from = validIso(ctx.query.from, "from");
      const to = validIso(ctx.query.to, "to");
      const carId = carIdFromQuery(ctx, state);
      const { sql, params } = listDrivesSql({ from, to, carId });
      const rows = await db.query(sql, [...params, EXPORT_ROW_CAP, 0]);
      const items = await computeTripViews(db, rows, { state, carId });
      items.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
      const lines = items.map((v) => [
        v.startAt, v.endAt, v.startAddress, v.endAddress,
        v.distanceKm, v.durationMin, v.energyKWh ?? "", v.costCny ?? "", v.kwhPer100km ?? "", v.routeKey,
      ]);
      sendCsv(ctx, `ahatesla-trips-${new Date().toISOString().slice(0, 10)}.csv`, [
        ["开始时间", "结束时间", "起点", "终点", "里程(km)", "时长(分)", "能耗(kWh)", "电费(元)", "kWh/100km", "路线"], ...lines,
      ]);
    },

    /** GET /api/export/charging?from&to&carId —— 充电流水 CSV（费用三态来源 + SoC 区间） */
    async charging(ctx) {
      const from = validIso(ctx.query.from, "from");
      const to = validIso(ctx.query.to, "to");
      const carId = carIdFromQuery(ctx, state);
      const tz = instanceTimezone(state);
      const options = await pricingOptionsFor(db, state);
      const total = await countCharging(db, { from, to, carId, tz }).catch(() => 0);
      const rows = await listCharging(db, {
        limit: Math.min(Number(total) || EXPORT_ROW_CAP, EXPORT_ROW_CAP), offset: 0, from, to, carId, tz,
      });
      const items = rows.map((r) => chargeRowToView(r, options, state.pricing.defaultRateCnyPerKwh));
      const lines = items.map((v) => [
        v.startAt, v.endAt, v.locationName,
        v.energyAddedKWh ?? "", v.costCny ?? "", v.pricePerUnit ?? "",
        v.startBattery ?? "", v.endBattery ?? "", v.durationMin, v.powerMaxKw ?? "",
        COST_SOURCE_LABEL[v.costSource] ?? v.costSource,
      ]);
      sendCsv(ctx, `ahatesla-charging-${new Date().toISOString().slice(0, 10)}.csv`, [
        ["开始时间", "结束时间", "地点", "充入(kWh)", "电费(元)", "单价(元/kWh)", "SoC起(%)", "SoC止(%)", "时长(分)", "峰值功率(kW)", "费用来源"], ...lines,
      ]);
    },
  };
}
