// auth routes — login / logout / me / change-password / refresh / revoke-all。
// AC-3.2：Access 24h + Refresh 30d 双 Token；AC-3.3：连续 5 次失败锁 15 分钟。
import {
  hashPassword, verifyPassword, signJwt, verifyJwt,
  TOKEN_TTL_S, REFRESH_TOKEN_TTL_S, TOKEN_COOKIE, REFRESH_COOKIE,
  refreshEpoch, bumpRefreshEpoch
} from "./auth.mjs";
import { HttpError } from "./http-kit.mjs";
import { saveState } from "../core/state.mjs";

const MAX_LOGIN_FAILURES = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;

// 进程内限速状态（单实例；重启清零可接受——锁窗 15 分钟足够挡爆破）
const loginFailures = { count: 0, lockedUntil: 0 };
export function resetLoginLockoutForTest() {
  loginFailures.count = 0;
  loginFailures.lockedUntil = 0;
}

export function createAuthRoutes({ state, getSecret, saveStateFn = saveState, eventLog }) {
  function issueTokens(ctx) {
    const epoch = refreshEpoch();
    const token = signJwt({ sub: state.username, typ: "access" }, getSecret(), { ttlS: TOKEN_TTL_S });
    const refresh = signJwt({ sub: state.username, typ: "refresh", ep: epoch }, getSecret(), { ttlS: REFRESH_TOKEN_TTL_S });
    ctx.setCookie(TOKEN_COOKIE, token, { maxAge: TOKEN_TTL_S, httpOnly: true, path: "/", sameSite: "Lax" });
    ctx.setCookie(REFRESH_COOKIE, refresh, { maxAge: REFRESH_TOKEN_TTL_S, httpOnly: true, path: "/", sameSite: "Lax" });
    return token;
  }

  function loginLocked() {
    return Date.now() < loginFailures.lockedUntil;
  }

  function recordLoginFailure() {
    loginFailures.count += 1;
    if (loginFailures.count >= MAX_LOGIN_FAILURES) {
      loginFailures.lockedUntil = Date.now() + LOCK_WINDOW_MS;
      loginFailures.count = 0;
    }
  }

  return {
    async login(ctx) {
      if (loginLocked()) {
        const waitMin = Math.ceil((loginFailures.lockedUntil - Date.now()) / 60_000);
        throw new HttpError(429, "too_many_attempts", `登录失败次数过多，请 ${waitMin} 分钟后重试`);
      }
      const { username, password } = ctx.body || {};
      if (!username || !password) throw new HttpError(400, "bad_request", "username and password required");
      // AC-3.3：错误提示不区分「用户名不存在 vs 密码错误」；未初始化也同文案
      if (username !== state.username || !state.passwordHash) {
        recordLoginFailure();
        throw new HttpError(401, "invalid_credentials", "invalid username or password");
      }
      const ok = await verifyPassword(password, state.passwordHash);
      if (!ok) {
        recordLoginFailure();
        throw new HttpError(401, "invalid_credentials", "invalid username or password");
      }
      loginFailures.count = 0;
      loginFailures.lockedUntil = 0;
      const token = issueTokens(ctx);
      eventLog?.log("auth.login", { username });
      return { token, user: { username: state.username } };
    },

    // POST /api/auth/refresh（B3）：Refresh cookie → 新 Access；ep 校验 epoch
    async refresh(ctx) {
      const refreshCookie = ctx.cookies?.[REFRESH_COOKIE];
      if (!refreshCookie) throw new HttpError(401, "unauthorized", "refresh token missing");
      const payload = verifyJwt(refreshCookie, getSecret());
      if (!payload || payload.typ !== "refresh") throw new HttpError(401, "unauthorized", "invalid refresh token");
      if (Number(payload.ep ?? 0) !== refreshEpoch()) {
        throw new HttpError(401, "unauthorized", "session revoked");
      }
      const token = signJwt({ sub: state.username, typ: "access" }, getSecret(), { ttlS: TOKEN_TTL_S });
      ctx.setCookie(TOKEN_COOKIE, token, { maxAge: TOKEN_TTL_S, httpOnly: true, path: "/", sameSite: "Lax" });
      return { ok: true };
    },

    async logout(ctx) {
      ctx.setCookie(TOKEN_COOKIE, "", { maxAge: 0, httpOnly: true, path: "/", sameSite: "Lax" });
      ctx.setCookie(REFRESH_COOKIE, "", { maxAge: 0, httpOnly: true, path: "/", sameSite: "Lax" });
      return { ok: true };
    },

    async me(ctx) {
      return { username: state.username, initialized: Boolean(state.passwordHash) };
    },

    async changePassword(ctx) {
      const { oldPassword, newPassword } = ctx.body || {};
      if (!oldPassword || !newPassword) throw new HttpError(400, "bad_request", "oldPassword and newPassword required");
      if (String(newPassword).length < 8) throw new HttpError(400, "weak_password", "new password must be at least 8 characters");
      const ok = await verifyPassword(oldPassword, state.passwordHash);
      if (!ok) throw new HttpError(401, "invalid_credentials", "old password is incorrect");
      state.passwordHash = await hashPassword(newPassword);
      saveStateFn(state);
      // AC-3.2：吊销其他会话（epoch +1，旧 refresh 全失效），当前会话续发
      bumpRefreshEpoch();
      eventLog?.log("auth.password_changed", { username: state.username });
      issueTokens(ctx);
      return { ok: true };
    },

    // POST /api/auth/sessions/revoke-all（AC-3.2 手动吊销）
    async revokeAll(ctx) {
      bumpRefreshEpoch();
      ctx.setCookie(TOKEN_COOKIE, "", { maxAge: 0, httpOnly: true, path: "/", sameSite: "Lax" });
      ctx.setCookie(REFRESH_COOKIE, "", { maxAge: 0, httpOnly: true, path: "/", sameSite: "Lax" });
      eventLog?.log("auth.sessions_revoked", { username: state.username });
      return { ok: true };
    }
  };
}
