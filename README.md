# ModelTrace Guard Autoswitch

基于 [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace) 的独立 fork，版本 `0.3.0`。上游作者 xqy2006，fork 由 ChenCJ-io 维护，保留 MIT 许可证；来源见 [UPSTREAM.md](docs/UPSTREAM.md)。

**默认使用主配置。首次指纹异常就暂停并询问；只有用户对这一次目标明确同意后，才验证并切换。** 安装、配置主备、开启监测、确认收到提醒，都不预先授权任何切换。

## 安装和自然语言使用

从用户提供的仓库 URL 或本地目录读取 [INSTALL.md](INSTALL.md)，再执行安装助手。本仓库尚未发布 GitHub 地址；不要把上游地址当成本 fork 的安装源。可以对 Codex 说：

> 从「仓库 URL 或本地目录」安装这个插件，先读 INSTALL.md。主用「API2 copy」，备用「Doro」。出现指纹异常先询问我，每次同意后才切换。

在本地仓库根运行的等效命令：

```sh
node scripts/install-plugin.mjs --primary-name "API2 copy" --backup-name "Doro"
```

安装助手只执行本地 marketplace/plugin 安装和明确给定的主备配置，不启动网关、监测或推理，也不修改 hook 信任。安装后须按 Codex 原生机制在 `/hooks` 审阅并信任新插件。安装到某个 CLI 配置不等于该配置的所有会话都在监测。

## 用独立 CLI 接入会话

需要 CCSwitch 4.0.15 Stack 聚合模式。通过 CCSwitch 界面将主配置和第三方备用加入 Stack，保留公司默认配置；无需把 OpenAI Official 改为 CCSwitch 默认。完整网关流程推荐 Node.js 24.5+；使用 22.x 时至少为 22.21，25+ 也支持，以同时满足 zstd 和官方 HTTPS 的原生 `proxyEnv` 要求。配置检查还需要带 `sha3()` 的 `sqlite3` 命令。普通独立监测最低仍为 Node.js 18+。

```sh
AUTOSWITCH=codex-plugin/modeltrace-guard/scripts/autoswitch.mjs
node "$AUTOSWITCH" inspect
node "$AUTOSWITCH" configure --primary-name "API2 copy" --backup-name "Doro"
node "$AUTOSWITCH" gateway-start
node "$AUTOSWITCH" launch
# 明确从另一个有效的已有配置开始：
# node "$AUTOSWITCH" launch --provider-name "Doro"
```

`inspect` 列出候选；名称先完全匹配，未命中时允许唯一的不区分大小写匹配；重名时选择 ID，再用 `configure --primary-provider PRIMARY_ID --backup-provider BACKUP_ID`，不能混用 name 与 ID 参数。`configure` 可附加 `--cc-switch-dir PATH`（默认 `~/.cc-switch`）和 `--port N`（默认 `15722`）。配置须在网关停止时更新；更新会生成新配置 ID，已有路由会话不会自动迁移。设置默认备用只是保存偏好。

本版本所有 `launch`/`enable` 都要求当前 CLI 使用原生 ChatGPT 登录和 `openai` 契约；公司请求由网关选中 CCSwitch Stack 配置，不能直接把旧 API Key 登录会话当作已接入。CCSwitch 的全局 `custom` provider 与这份原生登录分别检查：插件仅为认证检查进程显式选用 `openai`，不会替用户登录或读取、复制凭据。若检查仍返回 `account: null`，须先在对应 Codex 配置中完成原生 ChatGPT 登录；公司卡可用、插件安装或离线测试通过都不能替代这一前置。

`launch` 启动一个独立的原生 Codex CLI，新会话默认走主配置，网关地址仅作用于这个进程。它不会热修改当前已开的 Desktop 或其他 CLI 窗口。`launch --resume SESSION_UUID` 可让新 CLI 尝试继续同一 thread；成功后应在这个接入网关的 CLI 中继续工作，原窗口不会因此改路由，也不保证旧认证和加密历史可用。已建立路由的 thread 保留其路由，不能用 `--provider-name` 绕过后续切换确认。

在当前会话已通过网关成功使用主配置后，明确请求“为本会话开启指纹监测”，或运行：

```sh
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs enable --session SESSION_UUID
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs status --session SESSION_UUID
```

`enable` 只开启当前路由的监测，不切换路由。仅接入网关或安装插件不会生成探针。不同会话、不同 `CODEX_HOME` 分别管理；不要让上游监测器与本插件同时监测同一 thread。

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

`disable --session SESSION_UUID` 停止监测，保留当前路由、已有 halt 和历史。`gateway-status` 查看代理状态；`gateway-stop` 停止代理，依赖它的会话后续请求将无法通过，直到网关重启。独立的 `guard.mjs start` 仍保留上游复测流程，用于用户另行请求的普通监测；它不授权切换。

```sh
npm test
npm run build
MODELTRACE_PYTHON=python3 npm run check
node codex-plugin/modeltrace-guard/scripts/guard.mjs doctor
```

`npm run check` 包含分发检查与 Python/JavaScript 评分 parity；所选 Python 须已安装 NumPy。`doctor --fork true` 可另行检查原生分支和 hook 就绪状态，会创建临时分支但不生成探针。安装助手测试使用假执行器，离线通过不等于真实路由已验收。

第三方请求经本机 CCSwitch Stack；Official 仅支持当前 CLI 原生 ChatGPT 登录、无 managed account 的目标，由网关转发到固定官方 HTTPS 地址，保留 CCSwitch 公司默认。插件不读取凭据存储、不解析或保存登录 token；HTTP 网关会接收并向选定链路转发原生认证头。配置检查使用只读 SQL 和库内摘要，不导出密钥值。

数据默认在 `${CODEX_HOME:-~/.codex}/modeltrace-guard-autoswitch`，与上游数据独立。网关 URL 含访问 capability，不应公开。指纹误报率尚未在同上下文和多语言条件下独立校准；不承诺所有端点兼容、加密历史可移植或立即取消正在运行的工具。详见 [插件说明](codex-plugin/modeltrace-guard/README.md)。
