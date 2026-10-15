-- 在 TeslaMate 数据库执行（超级用户）：创建 AhaTesla 只读账号
-- 幂等：重复执行安全。幂等实现用 DO 块；密码请替换。
--
--   docker compose -f docker-compose.yml exec database psql -U teslamate -d teslamate < /path/to/create-ro-user.sql
--
-- 红线：只授 SELECT —— AhaTesla 对 teslamate 库严格只读。

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ahatesla_ro') THEN
    CREATE ROLE ahatesla_ro LOGIN PASSWORD 'CHANGE_ME_PASSWORD';
  ELSE
    ALTER ROLE ahatesla_ro LOGIN PASSWORD 'CHANGE_ME_PASSWORD';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE teslamate TO ahatesla_ro;
GRANT USAGE ON SCHEMA public TO ahatesla_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ahatesla_ro;

-- TeslaMate 后续新建表（版本升级迁移）也自动对只读账号可见
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ahatesla_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE teslamate IN SCHEMA public GRANT SELECT ON TABLES TO ahatesla_ro;
