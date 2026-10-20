# 上游来源与 fork 边界

本仓库是 [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace) 的独立 fork。基线为 upstream `main` 的提交 [`6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2`](https://github.com/xqy2006/ModelTrace/commit/6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2)。上游作者为 **xqy2006**，fork 由 **ChenCJ-io** 维护；不代表上游发布或官方 Codex、CCSwitch 项目。

根 [LICENSE](../LICENSE) 与插件 LICENSE 保留 MIT 许可证及 `Copyright (c) 2026 xqy2006`。manifest 保留上游 author，package contributors 另列 fork 维护者。当前版本 `0.4.0`。

## 保留内容

- 上游 Web 工具、参考数据、指纹库和评分算法。
- 原生冻结快照、独立临时 fork、无工具采样、通知、停工保护、清理与仪表盘。
- 普通独立 `guard.mjs start` 的上游监测与复测流程；它不授权路由切换。
- 离线打包与评分一致性检查，来源和校验和见插件 `assets/provenance.json`；不自动重新采集指纹。
- 对误报、同上下文和多语言未独立校准、异步通知边界及 hook 信任的限制。

原 Web 工具仍可用 `python -m pip install -r requirements.txt`、`python start.py` 启动，与会话网关分别运行。基线文档见 [上游 README](https://github.com/xqy2006/ModelTrace/blob/6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2/README.md) 与 [上游插件说明](https://github.com/xqy2006/ModelTrace/blob/6cd4a8ff0f3f4e49d6d6969dd2fbadfa1569fde2/codex-plugin/modeltrace-guard/README.md)。

## v0.4 的使用契约

插件和 marketplace 名称继续保留 `modeltrace-guard-autoswitch` / `modeltrace-autoswitch`；名称不表示预授权自动切换。源码目录仍为 `codex-plugin/modeltrace-guard/`，默认数据目录为 `${CODEX_HOME:-~/.codex}/modeltrace-guard-autoswitch`，与上游监测数据独立。

v0.4 使用普通 `codex` 作为日常入口。用户请求 setup 或使用插件后，技能执行一次性 `connect`：只修改当前 Codex home 的基础用户配置 `model_provider` 与 `openai_base_url`，保存原值，采用版本与原值校验；影响未来新会话，不动认证、其他 home、CCSwitch 默认卡或运行中的 thread，不重启 daemon。`disconnect` 安全恢复仍归插件拥有的两键原值，不停止已有会话或网关。

接入数据目录须与普通启动一致；自定义目录需共同继承 `MODELTRACE_AUTOSWITCH_DATA`。CCSwitch 退出、重启或切卡可能重写入口；仅用户再次请求时可显式 connect，并且仍须主卡未变、两键各自属于原值或旧 owned 值。其他漂移拒绝覆盖，后台不自动修复。

用户在已接入的对话里说“使用 modeltrace-guard-autoswitch”，技能执行 `use`，仅为该主渠道 thread 开启监测。接入和服务启动不启用所有会话检测；个人初始路线保持不检测。未经过网关的旧会话须先完成准备，再新建普通会话一次；不能承诺热接管。同步 `SessionStart` hook 仅在有效的已拥有接入配置下准备网关，不改默认值、不启用监测、不自动修复 CCSwitch 漂移。

v0.3 引入的**每次异常单独确认**保持不变：首次有效不一致立即暂停并生成 `awaiting_approval` 请求。强差异与弱排序分歧都需如实报告。等待用户期间，不追加隐式复测、不请求备用。安装、connect、配置默认主备、开启监测、提醒收悉、沉默和超时都不是切换授权；旧版预授权不代表对新异常的同意。

用户可同意默认备用，也可指定另一个 CCSwitch 配置。`guard.mjs propose-switch` 创建新的待同意请求，不发送目标请求；后续 approve/wait/decline 必须使用新返回的请求 ID。`guard.mjs approve-switch` 要求该次明确同意并绑定目标 ID；目标身份或配置变化需重新选择、同意。验证取得真实 completed 回执和兼容指纹后才切换并恢复任务。Official 成功后停止探针；第三方目标成功后继续监测，下一次异常再次询问。不自动切回主配置。`guard.mjs decline-switch` 保留当前路由并恢复普通监测；`disable` 停监测但保留路由和 halt。

主服务和第三方目标经本机 CCSwitch Stack，需通过界面加入成员。保留公司默认配置；Official 目标仅支持没有 managed account 的当前 CLI 原生 ChatGPT 登录，由网关使用固定官方 HTTPS 端点透传认证头。插件不读取凭据存储、不解析或保存 token；只读 SQL 返回身份标记和库内计算的配置摘要，不导出密钥值、不修改数据库。

## 安装与证据范围

[INSTALL.md](../INSTALL.md) 是安装前入口。安装助手使用 `execFile` 参数数组安装本地 marketplace/plugin，仅在用户已明确给出名称时保存主备；不执行 connect、不启动监测、不读取认证文件、不修改 hook 信任。后续自然语言 setup/use 与安装授权分别处理。仓库未发布时只使用用户给出的 URL 或本地目录，不借用上游发布身份。

完整网关流程同时需要 zstd 和官方 HTTPS 的原生 `proxyEnv`，推荐 Node 24.5+；22.x 至少为 22.21，25+ 也支持。普通独立监测仍支持 Node 18+。配置检查依赖带 `sha3()` 的 `sqlite3`。接入要求当前 home 的原生 ChatGPT 登录；`launch` 仅作为高级诊断兼容入口保留。`connection-status` 证明未来默认配置，当前请求路径须由对应 thread 回执证明；账号或额度 UI 不证明渠道。任何入口均不承诺迁移旧认证和加密历史。

使用流程以 [根 README](../README.md) 和随插件技能为准。单元测试、假执行器、协议模拟和评分 parity 只证明对应离线检查，不代表真实供应商端到端验收或归因准确率。路由回执证明本地请求路径关联，指纹不证明供应商内部实际模型身份。
