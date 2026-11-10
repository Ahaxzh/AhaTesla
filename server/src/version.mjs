// version.mjs — 单一版本源：基准版本 + 构建时注入的 git 短 SHA。
// Docker 构建：docker.yml 传 build-arg GIT_SHA=${{ github.sha }} → 显示 v1.2.0+abc1234
// 本地 compose build：不传 arg → Dockerfile 默认 local → v1.2.0+local
// 裸机开发：两者都无 → v1.2.0
const BASE = "1.2.0";
const sha = process.env.GIT_SHA || "";

export const VERSION = sha ? `${BASE}+${sha.slice(0, 7)}` : BASE;
