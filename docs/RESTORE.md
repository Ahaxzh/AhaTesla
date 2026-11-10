# 数据备份与恢复指南 — TeslaMate 库 + AhaTesla 自有数据

> 适用：全栈版（fullstack-compose）与接入版（connect-compose）。
> 背景知识：AhaTesla 对 TeslaMate 库**只读**（红线 1），两套数据互补且互不替代：
> - **TeslaMate 库** = 原料（原始行程/充电/位置/状态）
> - **AhaTesla 卷** = 台账（电价规则、FIFO 批次消耗、推送配置与凭据、账号、事件日志）
>
> 详细存储设计见 [STORAGE.md](STORAGE.md)。

## 一、两套数据，分开备份

### TeslaMate 库（全栈版；接入版备份你自己栈里的库）

```bash
# 定期备份（pg_dump 纯 SQL 格式，可跨版本向前恢复）
docker compose -f deploy/fullstack-compose.yml --profile fullstack exec -T teslamate-db \
  psql -U teslamate -d teslamate > teslamate-backup-$(date +%F).sql
```

### AhaTesla 自有数据（两个文件：ahatesla.db + secret.key）

```bash
# 备份（卷名前缀 = compose 项目名：全栈 ahatesla-fullstack / 接入 ahatesla）
docker run --rm -v ahatesla-fullstack_ahatesla-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/ahatesla-data-$(date +%F).tgz -C /data .
```

> ⚠️ `secret.key` 必须一起备份：它加密着全部渠道凭据与数据源 DSN，丢了密文即死。有它，登录态（cookie）也能在恢复后保持有效。

## 二、恢复 TeslaMate 库（迁移/换机场景）

以「把备份灌入一套新的全栈栈」为例（实测路径：Ubuntu 4.4.0 → Mac OrbStack 全新栈）：

```bash
cd AhaTesla   # 仓库根；备份文件假定在 ~/Downloads/teslamate-backup.sql

# 1. 停 TeslaMate（别停数据库）
docker compose -f deploy/fullstack-compose.yml --profile fullstack stop teslamate

# 2. 清空 schema（新栈里的演示/测试数据作废）
docker compose -f deploy/fullstack-compose.yml --profile fullstack exec -T teslamate-db \
  psql -U teslamate -d teslamate \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO teslamate;"

# 3. 灌入备份
cat ~/Downloads/teslamate-backup.sql | docker compose -f deploy/fullstack-compose.yml --profile fullstack exec -T \
  teslamate-db psql -U teslamate -d teslamate

# 4. ★ 恢复后的标准动作：重建查询统计（pg_dump 不含统计信息）
#    跳过这步：首次打开仪表盘会让 planner 在全史数据上选错计划（慢几十秒），
#    autovacuum 虽会最终兜底，但手动 ANALYZE 一步到位（秒级）。
docker compose -f deploy/fullstack-compose.yml --profile fullstack exec -T teslamate-db \
  psql -U teslamate -d teslamate -c "ANALYZE;"

# 5. 重启 TeslaMate（启动时自动跑 schema 迁移，向前兼容旧备份）
docker compose -f deploy/fullstack-compose.yml --profile fullstack start teslamate
```

### 恢复后清单

- [ ] TeslaMate 重新登录：新版 TM（4.4+）的 API token **不随库走**（不入库不落盘）——打开 `:4000/sign_in` 贴一对新 token（iOS「Auth app for Tesla」本地生成最安全；网页工具需向第三方输特斯拉密码，慎用）
- [ ] 判断 TM 是否在采数：看 `positions.max(date)` 是否随车辆活动推进，**不要**只看 `drives.max(end_date)`（车睡着不产生 drive，属正常）
- [ ] AhaTesla 仪表盘出全史数据：向导时绑定的车 id 与备份一致则直接出；若空，重置 AhaTesla 数据卷重走向导（见下）

### 备份是 .dump / .backup（pg_dump 自定义格式）时

第 3 步换成：

```bash
docker compose -f deploy/fullstack-compose.yml --profile fullstack exec -T teslamate-db \
  pg_restore -U teslamate -d teslamate --no-owner --clean --if-exists < teslamate-backup.dump
```

## 三、恢复 AhaTesla 自有数据

```bash
docker compose -f deploy/fullstack-compose.yml --profile fullstack stop ahatesla
docker volume rm ahatesla-fullstack_ahatesla-data && docker volume create ahatesla-fullstack_ahatesla-data
docker run --rm -v ahatesla-fullstack_ahatesla-data:/data -v $(pwd):/backup alpine \
  sh -c "tar xzf /backup/ahatesla-data-YYYY-MM-DD.tgz -C /data && chown -R 1000:1000 /data"
docker compose -f deploy/fullstack-compose.yml --profile fullstack start ahatesla
```

> 恢复后账号/电价/推送配置原样回来（secret.key 同行则加密数据可直接解密）。
> 若只恢复了 TM 库而没带 AhaTesla 卷：向导重走一遍即可，原料（TM 数据）已在。

## 四、常见坑（实测记录）

| 症状 | 原因 | 处置 |
|---|---|---|
| 恢复后首次打开仪表盘极慢，之后正常 | PG 全冷缓存 + 统计缺失（planner 慢计划） | 第 4 步 `ANALYZE;`；一次性现象 |
| 恢复后 TM 提示贴 token | 新版 TM token 不随库走 | `:4000/sign_in` 重新登录 |
| 多实例共用一对 token 互踢 | Tesla refresh token 轮换 | 每实例独立生成一对 |
| 仪表盘有数据但账本/电价不对 | AhaTesla 卷（电价规则、FIFO 批次）没跟过来 | 按「三」恢复 AhaTesla 卷，或向导重配电价 |
