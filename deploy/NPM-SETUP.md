# NPM (Nginx Proxy Manager) HTTPS 反代配置说明

PWA 通知与 Service Worker 需要 secure context(HTTPS),自托管常用 NPM 反代实现。

## 前提
- 一台运行 NPM 的机器(示例:`192.168.1.4`),已有内网域名证书体系(示例:`home.example.com`)
- AhaTesla 所在主机(示例:`192.168.1.10`)的 18500 端口对内网开放

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
