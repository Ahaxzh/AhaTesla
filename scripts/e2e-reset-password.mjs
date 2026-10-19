#!/usr/bin/env node
// scripts/e2e-reset-password.mjs
//
// e2e 凭据注入 / 还原工具（t_46fd8a8a 起：账号哈希存 SQLite ahatesla.db）。
//
//   账号表只存 scrypt 哈希，无法反推密码。本脚本用固定的「e2e 临时密码」替换
//   account.password_hash，让 Playwright e2e 可复现地登录，跑完后一键还原。
//
// 兼容：若库尚不存在且存在旧 state.json（M0 遗留），先按 server 逻辑执行一次
// JSON→SQLite 迁移，再注入 —— 保证「未重启过新代码」的仓库也能直接跑 e2e。
//
// 用法（在仓库根目录执行）：
//   注入：AHATESLA_E2E_PASSWORD='<临时密码>' node scripts/e2e-reset-password.mjs
//         node scripts/e2e-reset-password.mjs --password '<临时密码>'
//   还原：node scripts/e2e-reset-password.mjs --restore
//   帮助：node scripts/e2e-reset-password.mjs --help
//
// 幂等性：
//   - 注入时，备份文件 server/data/e2e-account-backup.json 不存在才会创建
//     （0600，仅含 username/passwordHash/role，被 .gitignore 忽略），
//     因此反复注入永远回到「e2e 之前的原始哈希」，不会被覆盖。
//   - --restore 在没有备份时安全退出（视为已还原）；还原后保留备份文件。
//
// 安全：本脚本绝不打印密码明文；备份与库文件均以 0600 落盘。

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { hashPassword } from "../server/src/api/auth.mjs";
import { openStore, migrateStateJsonIntoStore } from "../server/src/core/store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
// AHA_DATA_DIR 可覆盖（run-e2e.sh 的隔离实例用临时数据目录注入凭据）
const DATA_DIR = process.env.AHA_DATA_DIR
  ? (process.env.AHA_DATA_DIR.startsWith("/")
    ? process.env.AHA_DATA_DIR
    : join(repoRoot, process.env.AHA_DATA_DIR))
  : join(repoRoot, "server", "data");
const DB_PATH = join(DATA_DIR, "ahatesla.db");
const STATE_JSON = join(DATA_DIR, "state.json");
const BACKUP_PATH = join(DATA_DIR, "e2e-account-backup.json");

const ENV_PASSWORD_KEY = "AHATESLA_E2E_PASSWORD";

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function die(msg, code = 1) {
  process.stderr.write(`错误: ${msg}\n`);
  process.exit(code);
}

// 原子写：同目录临时文件 + rename，避免半截写入。
function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function parseArgs(argv) {
  const args = { restore: false, password: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--restore") args.restore = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--password") args.password = argv[++i];
    else if (a.startsWith("--password=")) args.password = a.slice("--password=".length);
    else die(`未知参数: ${a}（--help 查看用法）`, 2);
  }
  return args;
}

const USAGE = `用法（在仓库根目录执行）：
  注入 e2e 临时密码：
    ${ENV_PASSWORD_KEY}='<临时密码>' node scripts/e2e-reset-password.mjs
    node scripts/e2e-reset-password.mjs --password '<临时密码>'
  还原为原始状态：
    node scripts/e2e-reset-password.mjs --restore

说明：
  - 账号哈希存 server/data/ahatesla.db（SQLite，account 表）；若库不存在且存在
    旧 server/data/state.json，会先执行一次 JSON→SQLite 迁移（与 server 启动逻辑一致）。
  - 注入会先把当前账号哈希备份到 e2e-account-backup.json（仅首次，0600），
    再用临时密码的 scrypt 哈希替换 account.password_hash。
  - 注入后需重启 server 才会生效；跑完 e2e 务必执行 --restore 还原（还原后保留备份）。`;

/** 打开库：必要时先做 JSON→SQLite 一次性迁移（幂等）。 */
function openStoreWithMigration() {
  const store = openStore({ file: DB_PATH });
  if (existsSync(STATE_JSON)) {
    const r = migrateStateJsonIntoStore(store, { jsonPath: STATE_JSON });
    if (r.migrated) log(`已迁移旧 state.json → SQLite（备份：${r.backup}）`);
  }
  return store;
}

function restore() {
  if (!existsSync(BACKUP_PATH)) {
    log("未发现备份文件 server/data/e2e-account-backup.json，当前即原始状态，无需还原。");
    return 0;
  }
  const backup = JSON.parse(readFileSync(BACKUP_PATH, "utf8"));
  const store = openStoreWithMigration();
  store.putAccount({
    username: backup.username,
    passwordHash: backup.passwordHash ?? null,
    role: backup.role ?? "admin"
  });
  // 校验：读回一致才认为成功。
  const after = store.getAccount();
  if (after?.passwordHash !== (backup.passwordHash ?? null)) {
    die("还原后校验失败（account.password_hash 与备份不一致），备份文件已保留。", 3);
  }
  log("已从备份还原账号哈希（e2e-account-backup.json → ahatesla.db account 表）。");
  log("下一步：重启 server，使原始密码重新生效（env -u DB_URL -u MQTT_URL -u PORT 前缀）。");
  return 0;
}

async function inject(password, source) {
  if (!password) {
    die(
      `未提供密码。请用环境变量 ${ENV_PASSWORD_KEY}='<临时密码>' 或 --password '<临时密码>'。`
    );
  }
  if (!existsSync(DB_PATH) && !existsSync(STATE_JSON)) {
    // 隔离实例（AHA_DATA_DIR 指向临时目录）本就没有历史库 —— 创建全新账号；
    // 常驻目录缺库仍视为异常（避免误把未初始化的正式实例当成可注入对象）
    if (!process.env.AHA_DATA_DIR) {
      die(
        "未找到 server/data/ahatesla.db 或 state.json。请先启动一次 server 让它初始化状态，再执行本脚本。"
      );
    }
  }

  const store = openStoreWithMigration();
  const account = store.getAccount();

  // 首次注入才创建备份；已存在则保留（保证备份始终是 e2e 前的原始状态）。
  if (existsSync(BACKUP_PATH)) {
    log("备份文件已存在（保留旧的原始备份，不覆盖）：server/data/e2e-account-backup.json");
  } else {
    writeAtomic(BACKUP_PATH, JSON.stringify({
      username: account?.username ?? "admin",
      passwordHash: account?.passwordHash ?? null,
      role: account?.role ?? "admin"
    }, null, 2));
    log("已备份原始账号哈希：→ server/data/e2e-account-backup.json");
  }

  store.putAccount({
    username: account?.username ?? "admin",
    passwordHash: await hashPassword(password),
    role: account?.role ?? "admin"
  });

  log(`已注入 e2e 临时密码哈希（来源：${source}；明文不会显示）。`);
  log("下一步：");
  log("  1) 重启 server 使新密码生效（env -u DB_URL -u MQTT_URL -u PORT 前缀）");
  log(`  2) 运行 e2e：  ${ENV_PASSWORD_KEY}='<临时密码>' npm run test:e2e`);
  log("  3) 跑完还原：  node scripts/e2e-reset-password.mjs --restore");
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(USAGE);
    return 0;
  }
  if (args.restore) {
    if (args.password) die("--restore 与 --password 不能同时使用。", 2);
    return restore();
  }
  const envPassword = process.env[ENV_PASSWORD_KEY];
  const password = args.password ?? envPassword;
  const source = args.password ? "命令行 --password" : `环境变量 ${ENV_PASSWORD_KEY}`;
  return inject(password, source);
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => die(err?.stack || String(err))
);
