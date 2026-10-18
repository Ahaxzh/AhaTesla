// car-scope.mjs — m4e 多车:请求级 carId 解析与车辆清单。
//
// 解析链:?carId= 显式参数 > settings.primaryCarId(设置页「车辆」) >
// datasource.carId(向导绑定,复用 teslamate-queries.resolveCarId)>
// null(数据层不过滤,保持单库单车旧行为)。
// 数据层查询的 carId 过滤由并行改造承接:options 型查询统一读 opts.carId。
import { HttpError } from "./http-kit.mjs";
import { resolveCarId } from "../core/teslamate-queries.mjs";

/**
 * 从请求查询串解析生效 carId。非法值(非正整数)直接 400。
 * 返回 number | null(null = 不过滤,由数据层决定默认语义)。
 */
export function carIdFromQuery(ctx, state) {
  const raw = ctx.query?.carId;
  if (raw === undefined || raw === null || raw === "") {
    const primary = Number(state?.settings?.primaryCarId);
    if (Number.isInteger(primary) && primary > 0) return primary;
    const bound = resolveCarId(state, null);
    return Number.isInteger(bound) && bound > 0 ? bound : null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, "bad_request", "carId must be a positive integer");
  }
  return n;
}

/** SQL 片段:carId 非 null 时返回 ` AND d.car_id = N`(N 已校验为正整数,内联安全)。 */
export function carFilterSql(carId, column = "d.car_id") {
  return carId ? ` AND ${column} = ${carId}` : "";
}

/**
 * 车辆清单(TeslaMate cars 表,只读直查——刻意不经过 teslamate-queries,
 * 该文件由数据层并行改造持有,避免合并冲突)。
 */
export async function listCars(db) {
  return db.query("SELECT id, name FROM cars ORDER BY id ASC");
}

/**
 * /api/cars 响应体:teslamate 车辆 + 设置页别名/主车标记。
 * settings.carAliases: Record<string, string>(carId → 别名)。
 */
export async function carsPayload(db, state) {
  const rows = await listCars(db);
  const aliases = state?.settings?.carAliases ?? {};
  const primary = Number(state?.settings?.primaryCarId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    alias: aliases[String(r.id)] || null,
    isPrimary: primary ? Number(r.id) === primary : false
  }));
}
