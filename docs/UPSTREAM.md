# 上游来源与 fork 边界

本仓库是 [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace) 的独立 fork。基线为 upstream `main` 的提交 [`6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2`](https://github.com/xqy2006/ModelTrace/commit/6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2)。上游作者为 **xqy2006**，自动切换扩展由 **ChenCJ-io** 维护；本 fork 不代表上游发布或官方 Codex、CCSwitch 项目。

仓库根 [LICENSE](../LICENSE) 与插件附带 LICENSE 保留原始 MIT 许可证及 `Copyright (c) 2026 xqy2006`。插件 manifest 保留上游 author，package contributors 另列 fork 维护者；新包版本为 `0.2.1`。

## 保留内容

- 上游 Web 工具、参考数据和指纹库、指纹提取与评分算法。
- Codex 原生冻结快照、每次独立临时 fork、无工具采样、复测、告警、停工、清理和仪表盘机制。
- 离线打包与评分一致性验证。`assets/provenance.json` 记录库、评分器和共享样式的来源及校验和；不会为了本 fork 自动重新采集指纹。
- 对误报、同上下文与多语言未独立校准、异步通知边界和 hook 信任的限制说明。

原项目的 Web 工具仍可用 `python -m pip install -r requirements.txt`、`python start.py` 启动；这是上游归因工具，与新增会话路由服务分别运行。基线文档可在 [上游 README](https://github.com/xqy2006/ModelTrace/blob/6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2/README.md) 和 [上游插件说明](https://github.com/xqy2006/ModelTrace/blob/6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2/codex-plugin/modeltrace-guard/README.md) 查阅。

## fork 的变化

| 项目 | 本 fork |
| --- | --- |
| Marketplace | `modeltrace-autoswitch` |
| 插件名与版本 | `modeltrace-guard-autoswitch` / `0.2.1` |
| 源码目录 | 保留 `codex-plugin/modeltrace-guard/`，便于比较与同步上游 |
| 默认数据目录 | `${CODEX_HOME:-~/.codex}/modeltrace-guard-autoswitch`，与上游目录独立 |
| 路由范围 | 本机网关按 thread 隔离，只读 CCSwitch 聚合配置 |
| 自动恢复 | 会话明确 opt-in、首检及至少 3 次复测均为强差异、源路由证据、备用路由 completed 回执和兼容指纹全部满足后才恢复 |

自动切换以 CCSwitch 4.0.15 聚合模式为集成目标：OpenAI Official 为 default，API2 为 member，通过 CCSwitch 界面完成配置。原生 Codex 继续使用官方认证，网关将授权会话的模型映射为 `ccs-key/model` 选中 API2，转备用后恢复原始模型名走 Official。插件不读取凭据存储、不解析或保存登录 token；网关会接收认证头，并只转发给本机 CCSwitch。配置检查通过 `sqlite3 -readonly` 获取身份标记和库内计算的配置摘要，不导出密钥值、不修改数据库。它不重启 Codex 应用，也不把未授权会话加入自动恢复。

首检与至少 3 次追加复测必须全部为 `difference_signal` 或 `repeated_difference`，才有资格进入切换验证；弱排序分歧只沿用原有告警、复测和停工流程。canary 失败继续停工，成功后不自动切回源路由。已授权策略不要求每次另请许可；未授权会话仍按上游规则等待用户明确恢复。路由证据证明的是本地请求路径与回执关联，指纹仍不能证明供应商内部实际模型身份。

`disable` 同时停止自动切换、探针与复测，不改变已选路由、不解除 halt；`gateway-stop` 则停止代理。网关处理 zstd 请求需要 Node 的 `zstdDecompress`，推荐 Node 24+ 或具备该能力的 22.15+；普通监测仍支持 Node 18+。`launch --resume` 不承诺迁移旧 API2 会话的认证和加密历史。

本 fork 的使用与限制以 [根 README](../README.md) 和随插件分发的技能为准。单元测试、协议模拟和评分 parity 只证明对应离线检查通过，不能当作真实供应商端到端验收或准确率评估。发布前须按实际运行环境检查路由、信任、认证、恢复与失败保留停工的行为。

0.2.1：个人备用验证通过后关闭监测与切换策略，保留路由和成功通知；旧版已切入个人的记录首次写入时收敛到停止监测。默认未启用的个人会话不产生探针，空闲的逐工具 hooks 避免重复锁和状态写盘。
