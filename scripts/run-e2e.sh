#!/usr/bin/env bash
# run-e2e.sh — 仓库根一键跑 e2e（常规 :18500 用例 + /setup 向导隔离实例用例）。
#
# 1) 从 server/.env 的 DB_URL 提取只读账号密码注入 AHATESLA_E2E_DB_PASSWORD（不落日志）。
# 2) 常规用例连常驻 :18500（登录凭据经 scripts/e2e-reset-password.mjs 注入，机制不变）。
# 3) setup 用例：shell 后台作业方式在 :18590 + 临时数据目录（AHA_DATA_DIR）拉起隔离
#    实例，全程由本脚本作为父进程持有（曾试过 daemon 化子进程——父进程退出后孤儿被
#    回收，导致 ECONNREFUSED），结束后清理，不污染常驻实例的 state.json。
set -euo pipefail
cd "$(dirname "$0")/.."

PW=$(node -e '
const { readFileSync } = require("node:fs");
const m = /postgres:\/\/[^:]+:([^@]+)@/.exec(readFileSync("server/.env","utf8"));
process.stdout.write(m ? decodeURIComponent(m[1]) : "");
')
export AHATESLA_E2E_DB_PASSWORD="$PW"

SETUP_PORT="${SETUP_E2E_PORT:-18590}"
SETUP_PID=""
SETUP_DATA_DIR=""
# 常规用例同样走隔离实例（临时数据目录 + 注入临时密码 + 独立端口）：
# 此前依赖「常驻 :18500 + 手工注密 + 手工重启」三步人工操作，换台机器必挂；
# 且向常驻实例写账号哈希本身就不干净。隔离实例连同一个只读库，数据一致。
MAIN_PORT="${MAIN_E2E_PORT:-18501}"
MAIN_PID=""
MAIN_DATA_DIR=""
E2E_PASSWORD=""
cleanup() {
  if [ -n "$SETUP_PID" ]; then
    kill "$SETUP_PID" 2>/dev/null || true
  fi
  if [ -n "$SETUP_DATA_DIR" ]; then
    rm -rf "$SETUP_DATA_DIR" 2>/dev/null || true
  fi
  if [ -n "$MAIN_PID" ]; then
    kill "$MAIN_PID" 2>/dev/null || true
  fi
  if [ -n "$MAIN_DATA_DIR" ]; then
    rm -rf "$MAIN_DATA_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

start_main_instance() {
  [ -n "$PW" ] || { echo "未从 server/.env 解析到 DB 密码，无法启动常规 e2e 实例" >&2; exit 1; }
  MAIN_DATA_DIR=$(mktemp -d /tmp/ahatesla-main-e2e-XXXXXX)
  # 先注入凭据再启动（state 只在进程启动时装载；账号库须先就位）
  E2E_PASSWORD="$(openssl rand -hex 12)"
  AHATESLA_E2E_PASSWORD="$E2E_PASSWORD" AHA_DATA_DIR="$MAIN_DATA_DIR" node scripts/e2e-reset-password.mjs >/dev/null
  AHA_DATA_DIR="$MAIN_DATA_DIR" \
  PORT="$MAIN_PORT" \
  DB_URL="postgres://ahatesla_ro:${PW}@127.0.0.1:15432/teslamate" \
  MQTT_URL="mqtt://127.0.0.1:65535" \
    node server/src/index.mjs >/dev/null 2>&1 &
  MAIN_PID=$!
  export E2E_BASE_URL="http://127.0.0.1:${MAIN_PORT}"
  export AHATESLA_E2E_PASSWORD="$E2E_PASSWORD"
  for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:${MAIN_PORT}/api/system/health-lite" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "常规 e2e 实例（:${MAIN_PORT}）启动超时" >&2
  exit 1
}

run_setup=0
setup_only=0
if [ $# -eq 0 ]; then
  run_setup=1
else
  for a in "$@"; do
    case "$a" in
      *setup.spec.mjs|setup) run_setup=1; setup_only=1 ;;
    esac
  done
fi

if [ "$run_setup" = "1" ] && [ -n "$PW" ]; then
  SETUP_DATA_DIR=$(mktemp -d /tmp/ahatesla-setup-e2e-XXXXXX)
  export SETUP_E2E_BASE_URL="http://127.0.0.1:${SETUP_PORT}"
  AHA_DATA_DIR="$SETUP_DATA_DIR" \
  PORT="$SETUP_PORT" \
  DB_URL="postgres://ahatesla_ro:${PW}@127.0.0.1:15432/teslamate" \
  MQTT_URL="mqtt://127.0.0.1:65535" \
    node server/src/index.mjs >/dev/null 2>&1 &
  SETUP_PID=$!
  for i in $(seq 1 40); do
    if curl -sf "$SETUP_E2E_BASE_URL/api/setup/status" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
fi

# 常规（非 setup-only）路径都需要隔离实例承载登录态
if [ "$setup_only" != "1" ]; then
  start_main_instance
fi

if [ "$setup_only" = "1" ]; then
  # setup 用例共享隔离实例状态（serial 语义）：单 worker + 不重试；
  # 且只跑 desktop —— mobile/desktop 两份会让第二份必然撞上"管理员已注册"锁定态。
  npx playwright test --config e2e/playwright.config.mjs --project=desktop --workers=1 --retries=0 "$@"
elif [ "$run_setup" = "1" ]; then
  # 全量：常规用例（可重试）与 setup 用例（serial、不重试）分两阶段跑，
  # 避免 setup 重试撞上"管理员已注册"的锁定态（那是语义性失败，不是 flake）。
  # 注意第一阶段必须按文件指定 e2e/e2e.spec.mjs——不能按标题 grep-invert，
  # 否则 setup.spec.mjs 里标题不含"向导"的用例（如锁死行为）会在全新实例上提前跑挂。
  npx playwright test --config e2e/playwright.config.mjs e2e/e2e.spec.mjs
  # setup 只跑 desktop 一个 project：向导用例共享同一隔离实例状态（serial 语义），
  # mobile/desktop 两份同用例会让第二份必然撞上"管理员已注册"锁定态。
  npx playwright test --config e2e/playwright.config.mjs --project=desktop --workers=1 --retries=0 e2e/setup.spec.mjs
else
  npx playwright test --config e2e/playwright.config.mjs e2e/e2e.spec.mjs
fi
