// http-kit.mjs — minimal Express-style routing over node:http. Zero deps.
import { createServer as createHttpServer } from "node:http";
import { Readable } from "node:stream";

const MAX_BODY = 1_000_000;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    // 畸形百分号编码不应炸掉整个请求（URIError 此前发生在 try 块之外）
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += buf.length;
    if (size > MAX_BODY) throw new HttpError(413, "payload_too_large", "request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonBody(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
}

function serialize(req, status, body) {
  const data = JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: data
  };
}

export function createApp({ onError = () => {} } = {}) {
  const middleware = [];
  const routes = []; // {method, pattern, keys, regex, handlers}

  function addRoute(method, pattern, ...handlers) {
    const keys = [];
    const regex = new RegExp("^" + pattern.replace(/\//g, "\\/").replace(/:([A-Za-z_][\w-]*)/g, (_, key) => {
      keys.push(key);
      return "([^/]+)";
    }) + "$");
    routes.push({ method: method.toUpperCase(), pattern, keys, regex, handlers });
  }

  const app = {
    use(fn) {
      middleware.push(fn);
      return app;
    },
    get: (p, ...h) => (addRoute("GET", p, ...h), app),
    post: (p, ...h) => (addRoute("POST", p, ...h), app),
    put: (p, ...h) => (addRoute("PUT", p, ...h), app),
    delete: (p, ...h) => (addRoute("DELETE", p, ...h), app),
    routes,
    async handle(req, res) {
      const url = new URL(req.url, "http://localhost");
      const ctx = {
        req,
        res,
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        params: {},
        cookies: parseCookies(req.headers.cookie),
        body: {},
        // helpers
        setHeader(k, v) {
          res.setHeader(k, v);
          return ctx;
        },
        status(code) {
          ctx.__status = code;
          return ctx;
        },
        json(body, code) {
          const out = serialize(req, code || ctx.__status || 200, body);
          res.writeHead(out.status, out.headers);
          res.end(out.body);
          return ctx;
        },
        setCookie(name, value, { maxAge, httpOnly = true, path = "/", sameSite = "Lax", secure } = {}) {
          let cookie = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
          if (httpOnly) cookie += "; HttpOnly";
          if (maxAge !== undefined) cookie += `; Max-Age=${maxAge}`;
          // Secure 标记：HTTPS（反代 x-forwarded-proto 或 TLS socket）下自动带上，
          // 防 token 经明文 HTTP 链路被嗅探；localhost HTTP 开发不受影响。
          const isHttps = secure
            ?? (req.socket?.encrypted === true
              || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https");
          if (isHttps) cookie += "; Secure";
          const prev = res.getHeader("set-cookie");
          const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
          list.push(cookie);
          res.setHeader("set-cookie", list);
          return ctx;
        }
      };
      try {
        ctx.body = parseJsonBody(await readBody(req));
        for (const fn of middleware) {
          await fn(ctx, () => {});
        }
        for (const route of routes) {
          if (route.method !== req.method) continue;
          const match = ctx.path.match(route.regex);
          if (!match) continue;
          route.keys.forEach((key, i) => {
            ctx.params[key] = decodeURIComponent(match[i + 1]);
          });
          for (const handler of route.handlers) {
            const result = await handler(ctx);
            if (result !== undefined && result !== null && !res.writableEnded) {
              ctx.json(result);
            }
            if (res.writableEnded) return ctx;
          }
          if (!res.writableEnded) ctx.json({}); // all handlers called next-equivalent
          return ctx;
        }
        throw new HttpError(404, "not_found", `no route for ${req.method} ${ctx.path}`);
      } catch (error) {
        const httpError = error instanceof HttpError
          ? error
          : new HttpError(500, "internal", "internal error");
        // 5xx 不回传原始 error.message（pg/SQL/URL 错误可能携带内部片段）；
        // 详情经 onError 进事件日志。
        if (httpError.status >= 500) onError(error);
        if (!res.writableEnded) {
          ctx.json({ error: { code: httpError.code, message: httpError.status >= 500 ? "internal error" : httpError.message } }, httpError.status);
        }
        return ctx;
      }
    },
    listen(port, host, cb) {
      const server = createHttpServer((req, res) => {
        app.handle(req, res).catch(() => {
          if (!res.writableEnded) res.destroy();
        });
      });
      return server.listen(port, host, cb);
    },
    handler: (req, res) => app.handle(req, res),
    close() {}
  };
  return app;
}

// Direct invocation helper for tests (no sockets).
export async function fetchApp(app, method, path, { body, headers = {}, cookie } = {}) {
  const chunks = [];
  let status = 0;
  let respHeaders = {};
  const req = Readable.from(body !== undefined ? [JSON.stringify(body)] : []) ;
  Object.assign(req, {
    method,
    url: path,
    headers: {
      ...headers,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {})
    }
  });
  const res = {
    headersSent: false,
    setHeader(k, v) {
      respHeaders[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return respHeaders[k.toLowerCase()];
    },
    writeHead(code, hdrs) {
      status = code;
      respHeaders = { ...respHeaders, ...Object.fromEntries(Object.entries(hdrs).map(([k, v]) => [k.toLowerCase(), v])) };
      this.headersSent = true;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.writableEnded = true;
    },
    destroy() {
      this.writableEnded = true;
    },
    writableEnded: false
  };
  await app.handle(req, res);
  const text = Buffer.concat(chunks).toString("utf8");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* non-json */ }
  return { status, headers: respHeaders, json, text, setCookie: respHeaders["set-cookie"] };
}
