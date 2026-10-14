// jwt middleware — authenticates the ahatesla_token cookie (or Authorization
// Bearer) and populates ctx.user. Rejects with 401 {error:{code,message}}.
import { verifyJwt, TOKEN_COOKIE } from "./auth.mjs";
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
    ctx.user = { username: payload.sub };
    // continue to route handlers
  };
}
