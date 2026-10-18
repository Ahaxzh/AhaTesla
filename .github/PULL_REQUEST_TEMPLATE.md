## 改动摘要

<!-- 一句话说清做了什么;关联 issue 用 Fixes #N -->

## 自测清单

- [ ] `cd server && npm test` 全绿
- [ ] `cd web && npm test` 全绿
- [ ] `cd web && npm run build` 通过
- [ ] e2e(涉及页面/向导/推送时):`bash scripts/run-e2e.sh` 或隔离实例跑法见 README

## 契约与红线

- [ ] 若改了接口:已先更新 `docs/API_CONTRACT.md`(唯一真相源)
- [ ] 不引入账号体系/公共后端/数据上传;对 teslamate 库只读
- [ ] 提交不含 Token/密钥/VIN/精确 GPS

## 截图(UI 改动必附,深浅色各一张)
