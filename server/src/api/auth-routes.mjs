// auth routes — login / logout / me / change-password.
import { hashPassword, verifyPassword, signJwt, TOKEN_TTL_S, TOKEN_COOKIE } from "./auth.mjs";
import { HttpError } from "./http-kit.mjs";
import { saveState } from "../core/state.mjs";

export function createAuthRoutes({ state, getSecret, saveStateFn = saveState, eventLog }) {
  function issueToken(ctx) {
    const token = signJwt({ sub: state.username }, getSecret(), { ttlS: TOKEN_TTL_S });
    ctx.setCookie(TOKEN_COOKIE, token, { maxAge: TOKEN_TTL_S, httpOnly: true, path: "/", sameSite: "Lax" });
    return token;
  }

  return {
    async login(ctx) {
      const { username, password } = ctx.body || {};
      if (!username || !password) throw new HttpError(400, "bad_request", "username and password required");
      if (username !== state.username) throw new HttpError(401, "invalid_credentials", "invalid username or password");
      if (!state.passwordHash) throw new HttpError(500, "not_initialized", "server state has no password; restart to initialize");
      const ok = await verifyPassword(password, state.passwordHash);
      if (!ok) throw new HttpError(401, "invalid_credentials", "invalid username or password");
      const token = issueToken(ctx);
      eventLog?.log("auth.login", { username });
      return { token, user: { username: state.username } };
    },

    async logout(ctx) {
      ctx.setCookie(TOKEN_COOKIE, "", { maxAge: 0, httpOnly: true, path: "/" });
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
      eventLog?.log("auth.password_changed", { username: state.username });
      issueToken(ctx); // rotate token so the user stays logged in
      return { ok: true };
    }
  };
}
