// jwt middleware — authenticates the ahatesla_token cookie (or Authorization
// Bearer) and populates ctx.user. Rejects with 401 {error:{code,message}}。
// 校验：签名/过期 + typ 必须是 access（30 天 refresh token 不得当 access 用）
// + ep 与 refresh epoch 一致（revoke-all/改密后旧 access 立即失效；
// 无 ep 的存量旧 token 在其 ≤24h 自然过期前放行，避免升级即全员掉线）。
import { verifyJwt, TOKEN_COOKIE, refreshEpoch } from "./auth.mjs";
import { HttpError } from "./http-kit.mjs";

export function createJwtMiddleware({ getSecret }) {
  return function requireAuth(ctx) {
    const header = ctx.req?.headers?.authorization || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : null;
    const token = bearer || ctx.cookies?.[TOKEN_COOKIE] || null;
    if (!token) throw new HttpError(401, "unauthorized", "authentication required");
    const secret = getSecret();
    const payload = verifyJwt(token, secret);
    if (!payload || !payload.sub) throw new HttpError(401, "unauthorized", "invalid or expired token");
    if (payload.typ === "refresh") throw new HttpError(401, "unauthorized", "refresh token cannot be used for API access");
    if (payload.ep !== undefined && Number(payload.ep) !== refreshEpoch()) {
      throw new HttpError(401, "unauthorized", "session revoked");
    }
    ctx.user = { username: payload.sub };
    // continue to route handlers
  };
}
