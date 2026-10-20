# 安装 ModelTrace Guard Autoswitch 0.4.1

这是安装前给 Codex 和使用者的入口。用户提供仓库 URL 或本地目录后，先读取本文件，再运行仓库自带安装助手。不要用关键词解析器猜测主备；由 Codex 将用户表达映射为明确配置名称，实际选择由 CLI 校验。

**安装和配置主备都不授权切换，也不会开启监测或接管原生默认入口。** v0.4 完成一次性接入后，用户照常运行 `codex`，在需要监测的对话里说“使用 modeltrace-guard-autoswitch”。每次首次指纹异常仍须暂停询问，获得本次目标的同意后才验证与切换。

## 取得用户指定的源码

本 fork 的安装源为 **https://github.com/ChenCJ-io/modeltrace-guard-autoswitch**。上游 `xqy2006/ModelTrace` 是另一项目，不要将其作为本 fork 的安装地址。

若用户给的是 URL，先将其克隆到明确的本地目录，再读该 checkout 的 `INSTALL.md`：

```sh
git clone https://github.com/ChenCJ-io/modeltrace-guard-autoswitch.git
cd modeltrace-guard-autoswitch
```

若已经有本地源码，直接进入该目录。安装助手只接受本地 checkout，不代为下载远端代码。

## 运行安装助手

仅安装：

```sh
node scripts/install-plugin.mjs
```

用户已经明确说“主用 API2 copy，备用 OpenAI Official”时，可安装并保存这对偏好：

```sh
node scripts/install-plugin.mjs --primary-name "API2 copy" --backup-name "OpenAI Official"
```

也可从其他目录指定本地源码和实际 Codex 可执行文件：

```sh
node "/path/to/modeltrace-guard-autoswitch/scripts/install-plugin.mjs" \
  --source "/path/to/modeltrace-guard-autoswitch" \
  --codex "/path/to/codex"
```

助手使用当前进程环境，包括当前 `CODEX_HOME`；默认使用 `MODELTRACE_CODEX_PATH`，未设置时使用 PATH 中的 `codex`。它只影响此次调用对应的 Codex 配置，不承诺所有 CLI 配置或所有会话都已安装、接入或监测。

执行顺序是：校验本地 marketplace 与插件身份/版本，`codex plugin marketplace add LOCAL_PATH`，`codex plugin add modeltrace-guard-autoswitch@modeltrace-autoswitch`，再按需调用 `autoswitch.mjs configure --primary-name ... --backup-name ...`。执行使用 `execFile` 参数数组，不拼 shell。步骤失败即停止，不回滚已完成安装；例如配置重名失败时，插件可能已安装成功。

助手不读取认证文件、不改 hook 信任、不启动网关或推理，不调用 `connect`、`use`、`enable`、`approve-switch`。主备名称需成对提供；未提供时不替用户选择。若名称有歧义，安装后用 `inspect` 选择 ID，再明确执行：

```sh
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs inspect
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs configure \
  --primary-provider PRIMARY_ID --backup-provider BACKUP_ID
```

`configure` 的名称模式和 ID 模式互斥。名称先完全匹配，未命中时允许唯一的不区分大小写匹配；重名时须选 ID，不做其他相似名称推断。需要非默认 CCSwitch 目录或端口时，在带完整主备名称或 ID 的 `configure` 命令中附加 `--cc-switch-dir PATH --port N`。配置须在网关停止时更新，新配置 ID 不会自动迁移已有路由会话。

## 信任、接入和监测是后续步骤

安装完成后，在兼容 Codex CLI 的 `/hooks` 中由用户审阅并信任插件。v0.4 增加同步 `SessionStart` 启动 hook，旧版信任不保证覆盖新定义；不要替用户执行信任修改。加载新插件后，由技能处理后续 setup 或“使用 modeltrace-guard-autoswitch”请求，不再让用户手输专用启动器。

主配置和第三方备用须通过 CCSwitch 4.0.15 界面加入 Stack；保留公司默认，不把 Official 设为全局默认。完整网关流程推荐 Node.js 24.5+；22.x 至少为 22.21，25+ 也支持，同时需要 zstd 和官方 HTTPS 的原生 `proxyEnv` 能力；配置检查需要带 `sha3()` 的 `sqlite3` CLI。接入要求当前 Codex home 的原生 ChatGPT 登录与 `openai` 契约；Official 目标还须没有 managed account 或存储的登录快照。

0.4.1 的主通道实际使用普通 CCSwitch 默认路由，保留 Codex 协议头和模型名，避免 Stack 清理客户端标记引发 “only allows Codex official clients” 403。默认卡必须仍为配置的主通道，且 CCSwitch 自动故障切换必须关闭；插件只检查，不替用户改卡。第三方备用仍走 Stack，需要单独验证兼容性；Official 备用不受该分支影响。

CCSwitch 全局 provider 可能是 `custom`；认证检查会为自己的进程显式选用 `openai`，不会代为登录。若返回 `account: null`，先核对实际 Codex home、provider 和原生登录，不推断用户从未登录，不读取或复制其他配置的凭据来绕过检查。

用户要求 setup 或使用插件时，技能可完成一次性 `autoswitch.mjs connect` 准备，并如实说明范围：仅将当前 Codex home 的 `model_provider`、`openai_base_url` 默认值接到网关，保存两键原值，影响未来新会话；不改 auth、不动其他 home（例如 `.codex-personal`）、不重启 daemon、不热改旧 thread，也不启用全部会话监测。`connect` 使用原生版本与原值校验，遇到外部修改或配置覆盖不擅自覆盖。

接入与普通 `codex` 启动必须找到同一数据目录；仅命令行使用、普通启动不继承的 `--data-dir` 不可 connect。需要自定义目录时，让两者继承相同的 `MODELTRACE_AUTOSWITCH_DATA`。

首次安装所在的旧会话可能尚未经过网关。技能执行 `use --session UUID` 后若返回 `connection_setup_required`，先完成缺少的 connect；仅返回 `new_conversation_required` 时，明确告知用户新建一个普通 Codex 会话一次，再说“使用 modeltrace-guard-autoswitch”。若已有失败回执，处理 `gateway_request_failed` 中的具体错误；若选路尚未收到回执，处理 `gateway_request_unconfirmed`；配置不一致为 `gateway_configuration_changed`。不得把写盘成功、相同 thread ID 或账号额度 UI 当作旧窗口已改道的证据。`launch` 仅保留为高级诊断兼容入口，不作为正常流程。

正常新会话由同步 `SessionStart` 的 `startup.mjs` 在已拥有且有效的接入配置就绪时保证网关启动；它不启用监测或自动修复 CCSwitch 漂移。单独 `gateway-start` 也不会接入原生默认入口。`connection-status` 检查未来新会话默认值，当前会话实际渠道要由其成功网关回执证明。

CCSwitch 退出、重启或用户切卡可能重写入口，setup 不保证永久占有。用户再次要求使用插件时，允许显式 connect 重连：CCSwitch 须仍选中配置的主卡，当前两个键须逐项等于保存的原值或旧 owned 值；任意其他配置继续拒绝。启动 hook 只报告漂移，不自动重连。

用户在当前会话要求使用插件时，技能执行 `use`：已接网关的主渠道 thread 才启用监测，个人初始路线保持不检测；成功切入个人后也不再排周期探针。重复 use 不重开已停策略、不清 halt、不授权切换。`disconnect` 仅安全恢复仍归插件拥有的两键原值，不改现有会话、监测或网关运行状态。

首次异常时报告候选及其不确定性，等待该次选择。`acknowledge` 是已告知，不是同意。用户说“同意切到 Doro”后，解析该目标，用 `guard.mjs propose-switch --request ID --target-name "Doro"` 准备，再对该目标 ID 执行 `guard.mjs approve-switch`；每次 proposal 都产生新请求 ID，approve/wait/decline 必须使用新返回的 ID，不重复请求同一份明确同意。未获得本次同意、目标身份或配置发生变化时，不发送目标验证请求。完整命令与失败边界见 [README](README.md)。

## 本地验证

```sh
node --test tests/install-plugin.test.mjs
npm run build
MODELTRACE_PYTHON=python3 npm run check
```

安装助手测试注入假的执行器，不安装真实插件、不配置真实主备。评分 parity 需要指定 Python 环境已安装 NumPy；离线检查不能替代原生 hook、真实路由与当前账户兼容性检查。
