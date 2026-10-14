# Alpine-Gate (.4) NPM 反代配置说明

## 前提
- NPM 已运行于 .4，已有内网域名证书体系（如 home.xxx）
- .3 的 18500 端口对内网开放

## 步骤
1. DNS（或在 NPM custom domain）：`tesla.home.xxx → 192.168.31.3`（按实际域名）
2. NPM → Proxy Hosts → Add Proxy Host:
   - Domain: `tesla.home.xxx`
   - Scheme: `http` · Forward Hostname: `192.168.31.3` · Forward Port: `18500`
   - Websockets Support: **ON**（/ws 实时推送需要）
   - SSL 标签页：申请/选择现有内网 CA 或 Let's Encrypt DNS 证书，Force SSL ON，HTTP/2 ON
3. HSTS/CSP 无需额外配置；Service Worker 要求 secure context，NPM 提供的 https 即满足
4. iPhone Safari 打开 `https://tesla.home.xxx` → 分享 → 添加到主屏幕 → PWA 独立窗口启动

## 验证
- `curl -I https://tesla.home.xxx` 返回 200 且含 `content-type: text/html`
- DevTools → Application → Service Worker 显示 activated
