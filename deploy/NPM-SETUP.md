# NPM (Nginx Proxy Manager) HTTPS 反代配置说明

PWA 通知与 Service Worker 需要 secure context(HTTPS),自托管常用 NPM 反代实现。

## 前提
- 一台运行 NPM 的机器(示例:`192.168.1.4`),已有内网域名证书体系(示例:`home.example.com`)
- NPM 能转发到 AhaTesla 的 18500。两个 compose 默认只绑 `127.0.0.1:18500`,所以二选一:
  - NPM 与 AhaTesla **同一台机器**:Forward Hostname 填 `127.0.0.1`(或容器网关 IP)
  - NPM 在**另一台机器**(示例:`192.168.1.4` → `192.168.1.10`):把 compose 的端口映射改绑
    内网网卡,如 `"192.168.1.10:18500:18500"`(仅局域网可达;18500 是唯一需要暴露给 NPM 的端口,
    4000/TeslaMate 管理页**严禁**这样暴露,只走 SSH 隧道)

## 步骤
1. DNS(或在 NPM custom domain):`tesla.home.example.com → 192.168.1.10`(按实际域名/IP)
2. NPM → Proxy Hosts → Add Proxy Host:
   - Domain: `tesla.home.example.com`
   - Scheme: `http` · Forward Hostname: `192.168.1.10` · Forward Port: `18500`
   - Websockets Support: **ON**(实时推送需要)
   - SSL 标签页:申请/选择现有内网 CA 或 Let's Encrypt DNS 证书,Force SSL ON,HTTP/2 ON
3. HSTS/CSP 无需额外配置;Service Worker 要求 secure context,NPM 提供的 https 即满足
4. iPhone Safari 打开 `https://tesla.home.example.com` → 分享 → 添加到主屏幕 → PWA 独立窗口启动(装到主屏幕后即可开启 Web Push 通知,见设置 → 推送)

## 验证
- `curl -I https://tesla.home.example.com` 返回 200 且含 `content-type: text/html`
- DevTools → Application → Service Worker 显示 activated

> 注:示例 IP/域名均为占位,按自己环境替换。
