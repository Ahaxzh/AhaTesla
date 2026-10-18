# M4 · 开源 GA 计划(v1.0)— AhaTesla

**日期**:2026-10-18 · **状态**:已定稿(决策见文末) · **上一里程碑**:v2.3(设置页整合/日历 v4)

## 目标一句话

任何人 `git clone` + `docker compose up -d` + 浏览器打开 → 注册管理员 → Tesla 登录(引导) → 配置推送渠道(可选 AI 润色)→ 开始用。MIT 开源,中英双语。

## 方向判断(已定)

- **v1 不自研 Tesla 数据摄取**。Token 刷新、轮询节流、行车/充电状态机、轨迹落库是 TeslaMate 打磨多年的核心,捆绑 + 无感引导是开源版正解。原生 Fleet API 直连列为 v3.x 远期,不做承诺。
- **BYO 模型 = 文案增强**,不做对话助手(m5 再议)。仅用户自配 OpenAI 兼容端点,密钥 AES-GCM 落盘,默认关,失败回退模板——推送永不对 AI 产生依赖。
- **安全红线开源后不变**:teslamate 库只读;无账号体系/无公共后端/无遥测;秘密不入 Git/日志;AI 与推送全部是用户自配出站。

## 里程碑拆分(各自独立可交付,每步 server test + web test + build + e2e 全绿)

### m4a · 一键部署链路(双轨)⭐先行

没有"一条命令能装",其余都不存在。**两条轨道同等一等公民**:一体化(拉新用户,零 TeslaMate 前置)与存量接入(已有 TeslaMate 数据的用户,数据零迁移)。

**轨道 A · 一体化(无 TeslaMate 用户)**
- [ ] fullstack-compose 强化:必需 env 精简到 TZ 级;TeslaMate/Postgres/AhaTesla 健康检查 + depends_order;RO 只读账号创建纳入 entrypoint 幂等执行(SQL 已有)
- [ ] Setup 向导模式 B 升级"零 TeslaMate 感知":新增「Tesla 登录」步骤 = 内嵌引导卡 + deep link 跳捆绑 TeslaMate + 复用现有车辆发现轮询,车出现自动前进到车辆确认
- [ ] 验收:空目录 compose up → 向导全程不出 AhaTesla 之外界面 → 车辆出现 → 仪表盘有数据;setup.spec 模式B 用例扩展

**轨道 B · 存量接入(已有 TeslaMate 用户)**
- [ ] connect-compose 一条命令化:自动挂入用户 teslamate_default 网络(bridge 机制已有);把 README 里"手工 psql 建只读账号"吞进 entrypoint——用户提供一次 teslamate 库管理密码(或复制粘贴一条 SQL),幂等自动建 RO 账号并回填 DSN
- [ ] 向导模式 A 打磨:DSN 粘贴 → 四级校验(已有)→ 车辆确认(已有);新增「当前账号权限探测」——检测到非只读账号时自动引导降权/替换为 RO 账号(对齐 GA-02 只读红线)
- [ ] README 双轨并列,存量用户从 clone 到看到自己的数据 ≤ 5 分钟 / ≤ 3 步
- [ ] 验收:对存量 TeslaMate 实例(本机 15432 桥即真实验证环境)跑通轨道 B 全程

**通用**
- [ ] 契约先行:/api/setup 流程若有变化先改 API_CONTRACT §1

### m4b · 推送渠道 3 → 6

- [ ] 企业微信机器人(webhook + markdown 卡片 + @指定成员)
- [ ] ntfy(server URL + topic,支持自建实例)
- [ ] Bark(iOS,device key,可选自建 server)
- [ ] 全部走既有 Notifier 抽象;推送矩阵 5 事件 × 6 渠道;PushPage 六渠道平权卡片 + 各自测试按钮 + 密钥加密落盘
- [ ] 契约先行:API_CONTRACT §channels 扩展
- [ ] 单测:每渠道 dispatch 成功/失败隔离(参照 Telegram 用例);e2e:PushPage 6 卡片渲染

### m4c · BYO 模型(文案增强)

- [ ] 设置新增「AI 助手」分区:OpenAI 兼容 baseURL / apiKey / model,AES-GCM 落盘,默认关,「测试连通」按钮
- [ ] 消费点 2 个:周报/月报结语洞察段、行程结束小结洞察段;prompt 模板 + 严格长度约束,超时/报错**静默回退模板文案**
- [ ] 契约先行:/api/ai/config(GET/PUT + POST test)
- [ ] 单测:mock LLM 成功注入 / 失败回退两条路径;e2e:配置 UI 存在性

### m4d · 开源工程化(GA 打包)

- [ ] MIT LICENSE(仓库级)
- [ ] README 中英双语 + 英文 quickstart;去个人化文案(登录页 "Ahaxzh's Model 3" → 读设置/环境变量)
- [ ] i18n 收尾:行程/充电/报告/推送深页词典补全(v2.4 基建 t(key, zh) 已就绪,补 en 词典即可)
- [ ] Demo 模式:AHATELA_DEMO=1 无车可试种子数据(README 截图/试用两用)
- [ ] GH Actions:server test + web test/build + e2e(隔离实例,E2E_BASE_URL 机制已有) + docker build/push ghcr multi-arch
- [ ] v1.0.0 tag + GitHub Release + issue/PR 模板 + SECURITY.md(红线声明)
- [ ] PWA manifest theme_color 与浅色主题联动(m4 顺手项)

## 执行顺序与理由

**m4a → m4b → m4d(README/i18n 可并行) → m4c**。
部署门槛是第一生死线;渠道是可见价值;AI 是差异化卖点放后压轴,也可按热情提前。

## 已定决策记录(2026-10-18)

| 决策点 | 结论 |
|---|---|
| License | MIT |
| BYO 模型一期 | 文案增强(周报/小结洞察段),不做对话 |
| 新增渠道 | 企业微信 + ntfy + Bark 三个全做(用户:"主流的都接进来") |
| Tesla 数据来源 | v1 捆绑 TeslaMate + 向导无感引导;原生直连为 v3.x 远期 |

## 远期池(v3.x+,不承诺)

原生 Tesla Fleet API 直连(去 TeslaMate)· 「问我的车」对话助手 · 多车 UI · Discord/Slack/SMTP 渠道 · 移动端原生壳
