#!/usr/bin/env node
// scripts/setup-e2e-server.mjs — 向导 e2e 的隔离实例管理器（t_3f9fe52a）。
//
//   start : 在独立端口 + 临时数据目录拉起 AhaTesla（AHA_DATA_DIR），输出 JSON
//           { pid, port, baseUrl, dataDir }；密码经 env 注入，绝不打印。
//   stop  : --pid <pid> 结束进程并清理临时目录。
//
// 为什么不用 spec 内 spawn：Playwright worker 的进程环境裁剪曾导致子进程
// spawn 间歇 ENOENT；由本脚本在 runner 侧常驻，spec 只连 HTTP。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

const cmd = process.argv[2];
const RO_PASSWORD = process.env.AHATESLA_E2E_DB_PASSWORD || "";

if (cmd === "start") {
  const port = Number(process.env.SETUP_E2E_PORT) || 18590;
  const dataDir = mkdtempSync(join(tmpdir(), "ahatesla-setup-e2e-"));
  const dbUrl = `postgres://ahatesla_ro:${encodeURIComponent(RO_PASSWORD)}@127.0.0.1:15432/teslamate`;
  const child = spawn(process.execPath, [join(REPO, "server", "src", "index.mjs")], {
    cwd: join(REPO, "server"),
    env: {
      ...process.env,
      PORT: String(port),
      DB_URL: dbUrl,
      MQTT_URL: "mqtt://127.0.0.1:65535",
      AHA_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });
  child.unref();
  process.stdout.write(JSON.stringify({ pid: child.pid, port, baseUrl: `http://127.0.0.1:${port}`, dataDir }) + "\n");
  process.exit(0);
}

if (cmd === "stop") {
  const pid = Number(process.argv.find((a, i) => process.argv[i - 1] === "--pid"));
  const dataDir = process.argv.find((a, i) => process.argv[i - 1] === "--data-dir");
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  if (dataDir) {
    setTimeout(() => rmSync(dataDir, { recursive: true, force: true }), 500);
  }
  process.exit(0);
}

process.stderr.write("usage: setup-e2e-server.mjs start|stop [--pid N] [--data-dir D]\n");
process.exit(2);
