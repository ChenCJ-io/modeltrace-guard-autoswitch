# 安装 ModelTrace Guard Autoswitch 0.5.0

这是安装前给 Codex 和使用者的入口。用户给出仓库地址时，优先用 Git 插件市场安装（不需要克隆）；给出本地目录时，运行仓库自带的安装助手。不要用关键词解析器猜测推荐备用；由 Codex 将用户表达映射为明确配置名称，实际选择由 CLI 校验。

**安装和接入都不授权切换，也不会开启监测。** 新会话走 CCSwitch 当前选中的默认卡，插件不需要、也不保存“主渠道”。完成一次性接入后，用户照常运行 `codex`，在需要监测的对话里说“开启指纹监测”（或“使用 modeltrace-guard-autoswitch”）。每次首次指纹异常仍须暂停询问，获得本次目标的同意后才验证与切换。

## 推荐：从 GitHub 安装

本 fork 的安装源为 **https://github.com/ChenCJ-io/modeltrace-guard-autoswitch**。上游 `xqy2006/ModelTrace` 是另一项目，不要将其作为本 fork 的安装地址。

Codex CLI 0.163+ 可以直接把 Git 仓库加为插件市场，不需要克隆：

```sh
codex plugin marketplace add ChenCJ-io/modeltrace-guard-autoswitch
codex plugin add modeltrace-guard-autoswitch@modeltrace-autoswitch
```

如果之前用本地目录添加过同名市场 `modeltrace-autoswitch`，先执行 `codex plugin marketplace remove modeltrace-autoswitch`。升级用 `codex plugin marketplace upgrade modeltrace-autoswitch`，再重启 Codex。插件装在 `${CODEX_HOME:-~/.codex}/plugins/cache/modeltrace-autoswitch/modeltrace-guard-autoswitch/<版本>/`，下文的 `codex-plugin/modeltrace-guard/scripts/...` 对应其中的 `scripts/...`。

## 从源码安装

开发或无法访问 GitHub 时，先把仓库克隆到明确的本地目录，再读该 checkout 的 `INSTALL.md`：

```sh
git clone https://github.com/ChenCJ-io/modeltrace-guard-autoswitch.git
cd modeltrace-guard-autoswitch
```

若已经有本地源码，直接进入该目录。安装助手只接受本地 checkout，不代为下载远端代码。源码安装注册的是本地插件市场：Codex 每次重启都会同步该目录当时的文件，切分支或修改文件会直接改变正在使用的插件。

## 运行安装助手

仅安装：

```sh
node scripts/install-plugin.mjs
```

用户已经明确说“异常时优先推荐 OpenAI Official”时，可安装并保存这个推荐备用：

```sh
node scripts/install-plugin.mjs --backup-name "OpenAI Official"
```

也可从其他目录指定本地源码和实际 Codex 可执行文件：

```sh
node "/path/to/modeltrace-guard-autoswitch/scripts/install-plugin.mjs" \
  --source "/path/to/modeltrace-guard-autoswitch" \
  --codex "/path/to/codex"
```

助手使用当前进程环境，包括当前 `CODEX_HOME`；默认使用 `MODELTRACE_CODEX_PATH`，未设置时使用 PATH 中的 `codex`。它只影响此次调用对应的 Codex 配置，不承诺所有 CLI 配置或所有会话都已安装、接入或监测。

执行顺序是：校验本地 marketplace 与插件身份/版本，`codex plugin marketplace add LOCAL_PATH`，`codex plugin add modeltrace-guard-autoswitch@modeltrace-autoswitch`，给了推荐备用时再调用 `autoswitch.mjs configure --backup-name ...`。执行使用 `execFile` 参数数组，不拼 shell。步骤失败即停止，不回滚已完成安装；例如推荐备用重名失败时，插件可能已安装成功。`--primary-name` 已不再接受：新会话的渠道在 CCSwitch 里选默认卡。

助手不读取认证文件、不改 hook 信任、不启动网关或推理，不调用 `connect`、`use`、`enable`、`approve-switch`。推荐备用可省略，它只是异常时清单里的推荐项；未提供时不替用户选择。若名称有歧义，用 `inspect` 选择 ID，在网关停止时明确执行：

```sh
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs inspect
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs configure --backup-provider BACKUP_ID
```

`configure` 的名称模式和 ID 模式互斥。名称先完全匹配，未命中时允许唯一的不区分大小写匹配；重名时须选 ID，不做其他相似名称推断。推荐备用必须是能直连的卡、OpenAI Official 或 CCSwitch 聚合成员，不能是只能经 CCSwitch 默认路由使用的默认卡。需要非默认 CCSwitch 目录或端口时附加 `--cc-switch-dir PATH --port N`（省略时沿用当前配置）。不带推荐备用的 `configure` 会清除推荐。重新配置保留网关访问凭证（Codex 的入口地址不变）；只改推荐备用时连配置 ID 也保留，网关运行中也可以改，已打开的会话不受影响。改端口或 CCSwitch 目录会生成新的配置 ID：先停网关，改完再 `connect`，已有会话需要新开。

`connect` 在没有配置时会自动创建，因此多数用户不需要运行 `configure`。0.5 之前的配置（固定主渠道，schema 1/2）读取时报告 `CONFIG_OUTDATED`，开场提示会给出终端里的 `connect` 命令；`connect` 先确认 CCSwitch 有默认卡、Codex 已登录且启动 hook 已信任，全部通过后才停止旧网关、按原 CCSwitch 目录和端口生成新配置（原推荐备用仍可用时保留）并启动新网关。在 Codex 会话里执行时，这个会话之后无法继续，需要新开。配置过期期间 `gateway-start` 和 `configure` 会拒绝，`gateway-stop` 可以停掉旧网关。

## 安装后先检查环境

安装完成后运行只读检查，把结果逐项告诉用户（未通过和待完成的项附上修法）：

```sh
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs check
```

它按顺序检查 Node、sqlite3、Codex 登录、hooks 信任、CCSwitch 数据与代理模式、CCSwitch 默认卡（新会话能否用上它；只能经 CCSwitch 的默认卡还检查自动故障转移）、插件配置、网关、普通入口接入和可用渠道，不改动、不启动、不信任任何东西。CCSwitch 设置、登录和 `/hooks` 信任由用户自己完成；`ready: true` 只表示环境就绪，不是任何切换的同意。

## 信任、接入和监测是后续步骤

安装完成后，在兼容 Codex CLI 的 `/hooks` 中由用户审阅并信任插件。v0.4 增加同步 `SessionStart` 启动 hook，旧版信任不保证覆盖新定义；不要替用户执行信任修改。加载新插件后，由技能处理后续 setup 或“使用 modeltrace-guard-autoswitch”请求，不再让用户手输专用启动器。

CCSwitch 4.0.15 中 Codex 须处于代理模式（路由或聚合）并选中默认卡：新会话的第一次请求落在这张卡上，此后该会话固定使用这张卡，直到用户在对话里切换；之后在 CCSwitch 里换默认卡只影响更新的会话。CCSwitch 的直连模式会在换卡时改写 Codex 配置、绕开网关，因此不支持。按 key 计费、使用 Responses API 的卡由网关直连，不需要额外设置；默认卡不能直连时（需要 CCSwitch 转换格式，或 Copilot、xAI 这类由 CCSwitch 管登录的卡），会话经 CCSwitch 默认路由，须关闭自动故障转移，且 CCSwitch 默认卡换掉后该会话停止转发；Copilot、xAI 这类卡不是默认卡时须加入聚合才能切过去。插件只检查，不替用户改卡。完整网关流程推荐 Node.js 24.5+；22.x 至少为 22.21，25+ 也支持，同时需要 zstd 和官方 HTTPS 的原生 `proxyEnv` 能力；配置检查需要带 `sha3()` 的 `sqlite3` CLI。接入要求当前 Codex home 已登录并使用 `openai` 契约：ChatGPT 账号或 API key 都可以（没有 OpenAI 账号时可用 `codex login --with-api-key` 登录任意 key，网关转发时会换成渠道卡自己的 key）；只有 Official 需要 ChatGPT 登录，且须没有 managed account 或存储的登录快照。

会话会用到 OpenAI Official 且本机需要代理才能访问 `chatgpt.com` 时，接入后执行 `node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs network` 确认 `gateway.reachable` 为 `true`。默认 `auto` 会自动使用网关进程的 `HTTPS_PROXY` 或系统 HTTPS 代理；只有用户明确给出代理地址时，才执行 `network --official-proxy http://HOST:PORT`。

经 CCSwitch 默认路由的请求保留 Codex 协议头和模型名，避免 Stack 清理客户端标记引发 “only allows Codex official clients” 403；每次转发前校验该卡仍是 CCSwitch 默认卡、自动故障转移已关闭，检测到漂移就拒绝请求。直连时，只在该卡是当前会话路由时，每次请求从 CCSwitch 只读取出这张卡的地址、key 和自定义请求头，在内存中使用；卡的身份摘要变了就拒绝转发。

CCSwitch 全局 provider 可能是 `custom`；认证检查会为自己的进程显式选用 `openai`，不会代为登录。若返回 `account: null`，先核对实际 Codex home、provider 和原生登录，不推断用户从未登录，不读取或复制其他配置的凭据来绕过检查。

用户要求 setup 或使用插件时，技能可完成一次性 `autoswitch.mjs connect` 准备，并如实说明范围：仅将当前 Codex home 的 `model_provider`、`openai_base_url` 默认值接到网关，保存两键原值，影响未来新会话；不改 auth、不动其他 home（例如 `.codex-personal`）、不重启 daemon、不热改旧 thread，也不启用全部会话监测。`connect` 使用原生版本与原值校验，遇到外部修改或配置覆盖不擅自覆盖；CCSwitch 没有开代理模式或没有默认卡时，`connect` 在改动任何东西之前报错。

接入与普通 `codex` 启动必须找到同一数据目录；仅命令行使用、普通启动不继承的 `--data-dir` 不可 connect。需要自定义目录时，让两者继承相同的 `MODELTRACE_AUTOSWITCH_DATA`。

首次安装所在的旧会话可能尚未经过网关。技能执行 `use --session UUID` 后若返回 `connection_setup_required`，先完成缺少的 connect；仅返回 `new_conversation_required` 时，明确告知用户新建一个普通 Codex 会话一次，再说“开启指纹监测”。若已有失败回执，处理 `gateway_request_failed` 中的具体错误；若选路尚未收到回执，处理 `gateway_request_unconfirmed`；配置不一致为 `gateway_configuration_changed`；新会话用不了 CCSwitch 默认卡时为 `gateway_not_ready`，原因在 `gateway.newConversations`。不得把写盘成功、相同 thread ID 或账号额度 UI 当作旧窗口已改道的证据。`launch` 仅保留为高级诊断兼容入口，不作为正常流程。

正常新会话由同步 `SessionStart` 的 `startup.mjs` 在已拥有且有效的接入配置就绪时保证网关启动，并显示该会话走哪张卡、能否用（默认卡用不了时说明原因）；它不启用监测或自动修复 CCSwitch 漂移。单独 `gateway-start` 也不会接入原生默认入口。`connection-status` 检查未来新会话默认值，当前会话实际渠道要由其成功网关回执证明。

CCSwitch 退出、重启或用户切卡可能重写入口，setup 不保证永久占有。用户再次要求使用插件时，允许显式 connect 重连：当前两个键须逐项等于保存的原值或旧 owned 值；任意其他配置继续拒绝。启动 hook 只报告漂移，不自动重连。

用户在当前会话要求使用插件时，技能执行 `use`：已接网关的会话在它当前的卡上启用监测（已切换过渠道或停过监测的会话也一样），个人 Official 路线保持不检测；成功切入个人后也不再排周期探针。重复 use 不清 halt、不授权切换。`disconnect` 仅安全恢复仍归插件拥有的两键原值，不改现有会话、监测或网关运行状态。

用户在对话里要求切换当前会话（“切到 渠道 B”）时，技能执行 `guard.mjs switch-route --target-name NAME`：不要求先开启监测（没有策略的会话会获得一个只用于切换的策略，监测保持关闭），先验证目标再切，失败保留当前渠道。只改该会话的网关路由，不改 CCSwitch 默认卡。

首次异常时报告候选及其不确定性，等待该次选择。`acknowledge` 是已告知，不是同意。报告并 acknowledge 后，用 `guard.mjs candidates --request ID` 列出 CCSwitch 中所有 Codex 渠道并请用户回编号；用户回复编号或渠道名后执行 `guard.mjs choose --request ID --pick N`（或 `--target-name`），一步完成选定、同意并开始验证。改选与提议不同的目标会产生新请求 ID，wait/decline 必须使用新返回的 ID，不重复请求同一份明确同意。未获得本次同意、目标身份或配置发生变化时，不发送目标验证请求。完整命令与失败边界见 [README](README.md)。

## 本地验证

```sh
node --test tests/install-plugin.test.mjs
npm run build
MODELTRACE_PYTHON=python3 npm run check
```

安装助手测试注入假的执行器，不安装真实插件、不配置真实推荐备用。评分 parity 需要指定 Python 环境已安装 NumPy；离线检查不能替代原生 hook、真实路由与当前账户兼容性检查。
