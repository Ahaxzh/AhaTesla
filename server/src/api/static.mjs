// static.mjs — web/dist 静态托管（自 index.mjs 迁出，HTTP 层）。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".map": "application/json"
};

export { MIME };

/** 构建静态文件处理器；目录不存在返回 null（纯 API 模式）。
 *  缓存策略：HTML 与 SW 永远走网络（发版即生效）；带 hash 的构建产物长缓存；
 *  其余 1h。未命中回落 SPA index.html。 */
export function createStaticHandler(rootDir) {
  if (!rootDir || !existsSync(rootDir)) return null;
  return async (req, res, pathname) => {
    let rel = pathname === "/" ? "/index.html" : pathname;
    const filePath = join(rootDir, rel);
    if (!filePath.startsWith(rootDir)) return false;
    try {
      const content = await readFile(filePath);
      const ext = filePath.slice(filePath.lastIndexOf("."));
      const isHtml = ext === ".html" || pathname === "/";
      const isSw = rel === "/service-worker.js";
      const hashed = /-[A-Za-z0-9_-]{8}\.(js|css|png|svg|woff2?)$/.test(rel);
      const cacheControl = isHtml || isSw
        ? "no-cache, must-revalidate"
        : hashed
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600";
      res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": cacheControl });
      res.end(content);
      return true;
    } catch {
      // SPA fallback
      try {
        const index = await readFile(join(rootDir, "index.html"));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache, must-revalidate" });
        res.end(index);
        return true;
      } catch {
        return false;
      }
    }
  };
}
