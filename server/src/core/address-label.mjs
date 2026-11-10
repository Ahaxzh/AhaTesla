// address-label.mjs — TeslaMate 逆地理全链路的展示压缩。
// display_name 形如「莲前街道, 前埔村, 思明区, 厦门市, 福建省, 360008, 中国」，
// 行程列表直出太长：丢国家/邮编/省，同城去重，每端最多 2 级，往返合并。

const COUNTRIES = new Set(["中国", "中华人民共和国", "China", "Mainland China", "Hong Kong", "Macau", "Taiwan"]);
const POSTCODE_RE = /^\d{4,10}$/;
const PROVINCE_RE = /(?:维吾尔|壮族|回族)?(?:自治区|省)$/;

/** 压缩单条地址：返回净化后的段数组（最具体在前）。 */
export function compressAddressParts(displayName) {
  if (!displayName) return [];
  return String(displayName)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !COUNTRIES.has(p))
    .filter((p) => !POSTCODE_RE.test(p))
    .filter((p) => !(PROVINCE_RE.test(p) && p.length <= 10));
}

function joinSegs(segs, max = 2) {
  return segs.slice(0, max).join(" ");
}

/** 行程两端标签：同城/同区去重（两端的市、区县段相同则都不显示）、每端 2 级、往返合并。 */
export function shortRouteLabel(startDisplay, endDisplay) {
  let a = compressAddressParts(startDisplay);
  let b = compressAddressParts(endDisplay);
  if (a.length === 0 && b.length === 0) return null;
  // 行政段去重：两端都含同一「市」或同一「区/县」段 → 从两侧移除（同区行程不重复前缀）
  const adminOf = (segs, re) => segs.find((p) => re.test(p) && p.length <= 5) || null;
  const cityA = adminOf(a, /市$/);
  const cityB = adminOf(b, /市$/);
  if (cityA && cityA === cityB) [a, b] = [a.filter((p) => p !== cityA), b.filter((p) => p !== cityB)];
  const distA = adminOf(a, /[区县]$/);
  const distB = adminOf(b, /[区县]$/);
  if (distA && distA === distB) [a, b] = [a.filter((p) => p !== distA), b.filter((p) => p !== distB)];
  return pairLabel(joinSegs(a), joinSegs(b));
}

function pairLabel(a, b) {
  if (!a && !b) return null;
  if (!b || a === b) return a ? `${a}（往返）` : b;
  if (!a) return b;
  return `${a} → ${b}`;
}

/** 单端压缩（行程详情 startAddress/endAddress 字段）：最多 3 级，无 pair 去重。 */
export function shortAddressLabel(displayName) {
  const segs = compressAddressParts(displayName);
  if (segs.length === 0) return null;
  return joinSegs(segs, 3);
}
