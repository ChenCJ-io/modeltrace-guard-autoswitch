# ModelTrace Guard Autoswitch

基于 [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace) 的独立 fork，版本 `0.4.1`。上游作者 xqy2006，fork 由 ChenCJ-io 维护，保留 MIT 许可证；来源见 [UPSTREAM.md](docs/UPSTREAM.md)。

**默认使用主配置。首次指纹异常就暂停并询问；只有用户对这一次目标明确同意后，才验证并切换。** 安装、配置主备、开启监测、确认收到提醒，都不预先授权任何切换。

完成一次性接入后，照常在终端运行 `codex`，在需要监测的对话里说：

> 使用 modeltrace-guard-autoswitch。

技能会执行 `autoswitch.mjs use`，只为这条已接入的会话启用监测。无需专用启动器；其他会话不会因此开始检测，个人 Official 会话默认不检测。

## 安装和自然语言使用

本项目地址：[ChenCJ-io/modeltrace-guard-autoswitch](https://github.com/ChenCJ-io/modeltrace-guard-autoswitch)。新用户可以直接把下面这段话发给 Codex：

> 请从 https://github.com/ChenCJ-io/modeltrace-guard-autoswitch 安装这个插件。先读取 INSTALL.md，检查运行环境并完成插件安装、主备配置和普通 Codex 入口接入。主用 CCSwitch 的 API2 copy，备用 OpenAI Official；配置不存在或重名时列出实际候选让我选择。需要登录、填写供应商凭据或在 /hooks 中信任插件时引导我完成，然后继续配置。在对话中开启指纹监测，异常立即暂停并询问，只有我明确同意本次目标后才验证并切换。最后根据真实路由回执和监测状态报告结果；首次安装的旧会话无法接入时，说明新对话的启用方法。

首次使用仍需要用户已有可用的 CCSwitch 主通道、当前 Codex home 的原生 ChatGPT 登录，并亲自信任插件 hooks；一段指令可以发起完整流程，不代表零交互或预先批准切换。

在本地仓库根运行的等效命令：

```sh
git clone https://github.com/ChenCJ-io/modeltrace-guard-autoswitch.git
cd modeltrace-guard-autoswitch
node scripts/install-plugin.mjs --primary-name "API2 copy" --backup-name "OpenAI Official"
```

安装助手只执行本地 marketplace/plugin 安装和明确给定的主备配置，不修改原生 Codex 的默认入口、不启动网关、监测或推理，也不修改 hook 信任。安装后须按 Codex 原生机制在 `/hooks` 审阅并信任新插件，包括 v0.4 新增的同步启动 hook。

## 一次性接入普通 codex

需要 CCSwitch 代理模式和已登记的 Stack 配置。通过 CCSwitch 界面登记主配置和第三方备用，将默认卡保持为选定的主配置（例如 API2 copy），并关闭 CCSwitch 自动故障切换。0.4.1 的主通道使用普通默认路由，保留原始模型名和 Codex 协议头；第三方备用才使用 Stack 前缀，Official 不需要成为全局默认。完整网关流程推荐 Node.js 24.5+；使用 22.x 时至少为 22.21，25+ 也支持，以同时满足 zstd 和官方 HTTPS 的原生 `proxyEnv` 要求。配置检查还需要带 `sha3()` 的 `sqlite3` 命令。普通独立监测最低仍为 Node.js 18+。

```sh
AUTOSWITCH=codex-plugin/modeltrace-guard/scripts/autoswitch.mjs
node "$AUTOSWITCH" inspect
node "$AUTOSWITCH" configure --primary-name "API2 copy" --backup-name "OpenAI Official"
node "$AUTOSWITCH" connect
node "$AUTOSWITCH" connection-status
```

这些准备可由已安装技能完成，无需用户手输命令。用户要求 setup 或使用插件时，技能会说明一次性接入的范围，再执行准备；仅安装插件不会自动接管默认入口。

`connect` 检查原生登录、同步启动 hook 和 CCSwitch 就绪状态，启动网关，然后仅修改**当前 `CODEX_HOME` 基础用户配置**的 `model_provider="openai"` 与 `openai_base_url`，保存这两个键的原值。写入使用版本和原值校验；配置冲突时不覆盖其他修改。它影响未来新会话的默认入口，不修改认证、其他 Codex home（例如 `.codex-personal`）或 CCSwitch 默认卡，不重启 daemon，也不热改已开的 thread。接入网关不等于开启所有会话的监测。

接入和普通启动须使用同一数据目录：单独在 connect 命令上传入、普通 `codex` 启动时找不到的 `--data-dir` 会被拒绝。自定义目录需让两者继承相同的 `MODELTRACE_AUTOSWITCH_DATA`。

首次安装或接入所在的旧对话没有经过网关时，`use` 会返回 `connection_setup_required` 或 `new_conversation_required`。技能先完成缺少的一次性准备；之后用户只需新建一个普通 Codex 会话，再说“使用 modeltrace-guard-autoswitch”。旧对话不能被报告为已经热接管，也不能把写盘成功当作当前请求改道成功。

已经经过网关但返回 403 等错误的线程会返回 `gateway_request_failed`，附带 HTTP/SSE 状态和排查提示，不再错误地建议反复新建对话。尚无完整回执为 `gateway_request_unconfirmed`；旧配置的回执为 `gateway_configuration_changed`。这些状态不启用监测、不授权切换。主通道首请求失败时尚无法执行对话中的技能，须先修复传输；不能把 403 当作指纹不一致，也不能声称已进入审批切换流程。

已配置入口但主卡漂移、自动故障切换未关闭或服务不可用时，`use` 返回 `gateway_not_ready`，先修复具体原因。升级后 `gateway-status` 还会核对运行中的 `implementationVersion`；`upgrade_required` 表示旧进程尚未退出。获授权的升级流程应停止并从新安装包重启本插件网关，保留原配置和各线程路由；启动 hook 不会擅自打断正在进行的请求。

`inspect` 列出候选；名称先完全匹配，未命中时允许唯一的不区分大小写匹配；重名时选择 ID，再用 `configure --primary-provider PRIMARY_ID --backup-provider BACKUP_ID`，不能混用 name 与 ID 参数。`configure` 可附加 `--cc-switch-dir PATH`（默认 `~/.cc-switch`）和 `--port N`（默认 `15722`）。配置须在网关停止时更新；更新会生成新配置 ID，已有路由会话不会自动迁移。设置默认备用只是保存偏好。

接入要求当前 Codex home 的原生 ChatGPT 登录和 `openai` 契约，公司请求由网关送往 CCSwitch 普通主路由。每次转发校验默认卡和自动故障切换设置，配置漂移时拒绝请求。认证检查为自己的进程显式选用 `openai`，不会代为登录或复制凭据。若返回 `account: null`，按实际结果核对当前 home 和原生登录，不能推断用户从未登录或读取另一配置的凭据补齐。

新增的同步 `SessionStart` hook（`startup.mjs`）只在本插件拥有且仍有效的接入配置就绪时保证网关启动；它不启用监测、不改默认入口，也不自动修复 CCSwitch 配置漂移。`gateway-start` 单独启动服务，不会让普通 Codex 自动接入。

一次性接入并不永久占有配置：CCSwitch 退出、重启或用户切卡可能重写入口。后台只报告问题；用户再次请求使用插件时，技能可显式执行 connect 重连，但仅限 CCSwitch 仍选中配置的主卡，且当前两键逐项等于保存的原值或旧网关值。其他值仍拒绝覆盖，不能后台自动抢回入口。

## 在当前对话使用

正常运行 `codex` 后，在对话中提出使用插件即可。技能调用的等效命令为：

```sh
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs use --session SESSION_UUID
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs status --session SESSION_UUID
```

`use` 要求这条 thread 已有成功的网关回执，才启用其主渠道监测；重复使用不重置既有策略、绕过 halt 或授权切换。个人初始路线和成功切入 Official 的路线保持停监测，避免额外周期探针；明确的普通诊断请求仍可用 `guard.mjs start`。不同会话和 Codex home 分别管理，不让上游监测器同时监测同一 thread。

`connection-status` 说明**未来新会话**的默认配置是否就绪；当前实际渠道须看该 thread 的网关回执与路由状态。账号头像、订阅额度 UI、服务已启动或配置写入成功，都不是当前请求路径的证据。

`launch`、`launch --resume UUID` 和 `launch --provider-name NAME` 保留为高级诊断兼容入口，使用独立进程覆盖配置，不作为日常使用步骤。它们不热改原窗口，也不保证旧认证和加密历史能跨路线延续。

## 异常后的选择

首次有效指纹不一致会进入 `awaiting_approval` 并暂停工作。强差异与弱排序分歧都会说明，但都不是后端身份或“降智”证明。此时不会偷偷追加复测，也不会请求备用。用户可同意默认备用、指定另一个配置，或拒绝切换继续当前路由。

| 命令 | 含义 |
| --- | --- |
| `propose-switch --request REQUEST_ID` | 为默认备用创建新的待同意方案，不发送目标请求 |
| `propose-switch --request REQUEST_ID --target-name "Doro"` | 为本次异常选择其他目标；重名时改用 `--target-provider ID` |
| `approve-switch --request REQUEST_ID --target-provider ID` | 仅在用户对本次目标明确同意后执行 |
| `wait-switch --request REQUEST_ID` | 仅批准后等待原生 canary 验证 |
| `decline-switch --request REQUEST_ID` | 保留当前路由并继续任务，第三方监测按普通间隔恢复 |

上述四个异常处理子命令使用 `node codex-plugin/modeltrace-guard/scripts/guard.mjs` 调用。每次 `propose-switch` 都返回新的请求 ID，后续批准、等待或拒绝必须使用返回值或 status 中的当前 ID。若默认备用已是当前配置，须明确另选目标，不能自动回主。“同意切到 Doro”已经是本次选择，不需要再反复确认。提醒 `acknowledge` 仅表示已经告知；沉默、超时、安装和 `enable` 都不算同意。目标身份或配置变更后，需要重新选择并同意。

批准后仍须取得真实 `completed` 回执和兼容指纹，才提交目标路由并恢复工作；失败保持暂停。失败收尾后，可按用户明确选择的新目标，从当前失败请求创建新 proposal，并用返回的新 ID 记录用户对该目标的本次同意；已经说清的同意不重复询问，旧批准不会沿用。切到 Official 成功后停止探针，避免继续消耗个人订阅；切到第三方成功后继续本会话监测，下次异常再次询问。不会自动切回主配置。

## 管理、验证与边界

`disable --session SESSION_UUID` 停止监测，保留当前路由、已有 halt 和历史。`disconnect` 仅在两项默认值仍由本插件拥有时安全恢复其原值；冲突时不覆盖用户后续修改。它不改变运行中的 thread 或监测状态，也不关闭网关。`gateway-status` 查看代理状态；`gateway-stop` 停止代理，依赖它的会话后续请求将无法通过，直到网关重启。独立的 `guard.mjs start` 仍保留上游复测流程，用于用户另行请求的普通监测；它不授权切换。

```sh
npm test
npm run build
MODELTRACE_PYTHON=python3 npm run check
node codex-plugin/modeltrace-guard/scripts/guard.mjs doctor
```

`npm run check` 包含分发检查与 Python/JavaScript 评分 parity；所选 Python 须已安装 NumPy。`doctor --fork true` 可另行检查原生分支和 hook 就绪状态，会创建临时分支但不生成探针。安装助手测试使用假执行器，离线通过不等于真实路由已验收。

主通道经本机 CCSwitch 普通默认路由；第三方备用经 Stack（其请求头清理行为仍须与上游兼容）。Official 仅支持当前 CLI 原生 ChatGPT 登录、无 managed account 的目标，由网关转发到固定官方 HTTPS 地址，保留 CCSwitch 公司默认。插件不读取凭据存储、不解析或保存登录 token；HTTP 网关会接收并向选定链路转发原生认证头。配置检查使用只读 SQL 和库内摘要，不导出密钥值。

数据默认在 `${CODEX_HOME:-~/.codex}/modeltrace-guard-autoswitch`，与上游数据独立。网关 URL 含访问 capability，不应公开。指纹误报率尚未在同上下文和多语言条件下独立校准；不承诺所有端点兼容、加密历史可移植或立即取消正在运行的工具。详见 [插件说明](codex-plugin/modeltrace-guard/README.md)。
