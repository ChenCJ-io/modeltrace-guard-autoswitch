# ModelTrace Guard Autoswitch

基于 [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace) 的独立 fork，在原有 Codex 指纹监测上增加**按会话授权、验证后恢复的单向路由切换**。上游作者 xqy2006；fork 扩展由 ChenCJ-io 维护。版本 `0.2.0`，来源与许可证见 [UPSTREAM.md](docs/UPSTREAM.md)。

## 原理

```text
原生 Codex（ChatGPT 登录）
  → 本机网关（按 thread 隔离）
  → CCSwitch 聚合：OpenAI Official 为默认，API2 为成员
```

网关为新建、未启用策略的会话选择 Official。明确启用自动切换后，网关为该会话把模型映射成 `ccs-key/model`，由 CCSwitch 选中 API2。插件不读取凭据存储、不解析或保存登录 token；作为 HTTP 中间层，网关会接收认证头，并只转发给本机 CCSwitch。它不修改 CCSwitch 数据库或全局 provider。

监测沿用上游的原生冻结快照：首次指纹异常立即告知并暂停工作，再从同一快照独立复测。只有首检与至少 3 次有效复测全部为强差异信号（`difference_signal` 或 `repeated_difference`）、每次源路由证据匹配且会话已授权，才尝试 Official。弱排序分歧仍走原有告警、复测和停工流程，不触发自动切换。备用路由的 canary 必须同时具有真实 `completed` 回执和兼容指纹，成功后才解除暂停并继续原任务；失败保留停工状态。一次授权执行一次单向切换，不会自动切回 API2。未授权会话保留上游停工行为。

## 安装与接入

网关建议使用 **Node.js 24+**，或提供 `node:zlib.zstdDecompress` 的 Node.js 22.15+；缺少该函数时，zstd 请求返回 HTTP 415。普通指纹监测的最低要求仍为 Node.js 18+。还需要支持原生 fork 和受信任 hooks 的 Codex 运行时、带 `sha3()` 函数的 `sqlite3` 命令，以及 CCSwitch **4.0.15 聚合模式**。

通过 CCSwitch 界面把 OpenAI Official 设为聚合默认，把 API2 加入聚合成员。配置与网关就绪检查通过 `sqlite3 -readonly` 获取身份标记、监听地址和配置摘要。SQLite 在库内计算摘要，密钥值不会返回给插件；任一 provider 配置变化都会暂停路由。备用只接受连接配置为空、没有保存 API Key 的原生 Official 卡。

在本仓库根目录安装本地插件：

```sh
npm run build
codex plugin marketplace add .
codex plugin add modeltrace-guard-autoswitch@modeltrace-autoswitch
```

在 Codex CLI 的 `/hooks` 中审阅并信任插件 hooks，再加载插件。安装本身不会开启监测或自动切换。不要跳过信任检查；探针只能在无工具的临时 fork 内运行。

以下命令在仓库根运行。Provider ID 从自己的 CCSwitch 配置中选择，示例不含任何账户信息：

```sh
AUTOSWITCH=codex-plugin/modeltrace-guard/scripts/autoswitch.mjs
node "$AUTOSWITCH" inspect
node "$AUTOSWITCH" configure --source-provider API2_ID --fallback-provider OFFICIAL_ID
node "$AUTOSWITCH" gateway-start
node "$AUTOSWITCH" launch
# 尝试重新附着已有会话：node "$AUTOSWITCH" launch --resume SESSION_UUID
```

`configure` 的可选参数为 `--cc-switch-dir PATH`（默认 `~/.cc-switch`）和 `--port N`（默认 `15722`）；上游地址从 CCSwitch 配置读取。`launch` 检查原生 ChatGPT 登录后，仅为此次 Codex 进程传入 `model_provider="openai"` 与本机网关 `openai_base_url`，不修改全局配置。当前会话不能热接入网关；可尝试重新附着同一 thread，或新开会话，无须重启整个应用。`--resume` 不迁移旧 API2 会话的认证与加密历史，不能保证它可继续使用；以实际认证和成功回执检查为准，失败时需新建官方认证会话。

进入接入网关的会话、完成一次原生请求后，明确请求使用本插件开启自动切换，或在已授权的目标会话中运行：

```sh
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs enable --session SESSION_UUID
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs status --session SESSION_UUID
```

`enable` 要求该 thread 已有网关回执且原生 `account/read` 返回 ChatGPT 认证，再为它开启监测和 API2 源路由。授权包含“满足切换条件并验证成功后继续原任务”，无须每次重新请求许可。暂停期间仍需报告异常；canary 失败不能靠普通 `resume` 命令自动绕过。

`disable --session SESSION_UUID` 仅关闭自动切换策略，保留已选路由、已有 halt 和持续监测；停止监测使用 `guard.mjs stop`。`gateway-status` 查看代理状态；`gateway-stop` 会停止代理，依赖它的会话后续请求将无法通过，直到网关重新启动。

数据默认独立保存在 `${CODEX_HOME:-~/.codex}/modeltrace-guard-autoswitch`；旧插件的数据目录与监测状态保持独立。本机网关地址含访问 capability，属于本地凭据，不应提交到 Git 或公开分享。

## 验证

```sh
npm test
npm run build
node -p 'typeof require("node:zlib").zstdDecompress'
MODELTRACE_PYTHON=python3 npm run check
node codex-plugin/modeltrace-guard/scripts/guard.mjs doctor
```

zstd 检查应输出 `function`。`npm run check` 先检查分发元数据，再运行 `verify-parity.mjs` 比对 Python/JavaScript 评分；`MODELTRACE_PYTHON` 指定的解释器必须已安装 NumPy（可从 `requirements.txt` 安装）。仅有 Node 或另一个 Python 环境中的依赖不足以运行 parity。`doctor --fork true` 另可检查原生 fork、hook 与清理就绪状态，会创建临时分支但不生成探针。离线测试不证明真实供应商路由或自动恢复已在你的环境中成功；接入结果以实际状态、路由证据与 canary 回执为准。

## 当前限制

- 指纹结果是候选库内的相似性判断，不能证明真实后端身份或“降智”。同快照与多语言误报率尚未独立校准，重复结果也可能相关。
- 只支持本期实现的原生 Responses 请求链路；独立的 web search、images 等端点会明确失败，不承诺完整端点兼容。加密历史可能不可移植，无法保证跨路由无损续接。
- 不能立即取消已经运行的工具或请求；受支持工作工具的暂停在 hook 边界生效。网关需要保持运行，独立会话的原生认证和可用性仍受本地 Codex、CCSwitch 与供应商状态影响。
- 不自动改 CCSwitch 配置、不自动切回 API2、不迁移旧监测状态。官方默认/API2 成员配置通过 CCSwitch 界面完成；首次 hook 信任仍须按 Codex 原生机制由用户审阅。

上游的网页归因工具、指纹库与离线评分器仍保留；其历史说明及本 fork 的差异见 [UPSTREAM.md](docs/UPSTREAM.md)。

本插件与上游监测器不能同时监测同一 thread；`enable` 会检查上游状态和新插件的 hook 信任。多个 Codex 配置沿用各自原生 `CODEX_HOME`，数据互相隔离；请在个人订阅已登录的配置环境中运行接入命令。
