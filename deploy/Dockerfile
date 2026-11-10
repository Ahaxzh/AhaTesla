# AhaTesla 应用镜像：Node 26 LTS 跑 server + 托管 web/dist（多阶段，无 dev 依赖进产物）
# 构建上下文 = 仓库根（connect/fullstack compose 均用 context: ..）

# ---------- 阶段1：web 构建 ----------
FROM node:26-alpine AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- 阶段2：server 依赖（仅生产） ----------
FROM node:26-alpine AS server-deps
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev

# ---------- 阶段3：运行时 ----------
FROM node:26-alpine AS runtime
ARG GIT_SHA=local
ENV GIT_SHA=${GIT_SHA}
ENV NODE_ENV=production
WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/ ./
# web 产物由 server 静态托管
COPY --from=web-build /app/web/dist ../web/dist
RUN mkdir -p /data
EXPOSE 18500
# node:sqlite 在 Alpine 需要的运行时库已内置于 node:26-alpine
CMD ["node", "src/index.mjs"]
