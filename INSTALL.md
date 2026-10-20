# 安装 ModelTrace Guard Autoswitch 0.3.0

这是安装前给 Codex 和使用者的入口。用户提供仓库 URL 或本地目录后，先读取本文件，再运行仓库自带安装助手。不要用关键词解析器猜测主备；由 Codex 将用户表达映射为明确配置名称，实际选择由 CLI 校验。

**安装和配置主备都不授权切换，也不会开启监测。** v0.3 在每次首次指纹异常时暂停询问，只有用户同意本次目标后才进行验证与切换。

## 取得用户指定的源码

本 fork 尚未发布 GitHub 地址。未来地址格式为 `https://github.com/<owner>/<repository>`，它只是占位模板；使用用户提供的真实 URL，不能猜测仓库名或把上游 ModelTrace 当作本 fork。

若用户给的是 URL，先将其克隆到明确的本地目录，再读该 checkout 的 `INSTALL.md`：

```sh
git clone "<用户提供的仓库URL>" "/path/to/modeltrace-guard-autoswitch"
cd "/path/to/modeltrace-guard-autoswitch"
```

若已经有本地源码，直接进入该目录。安装助手只接受本地 checkout，不代为下载远端代码。

## 运行安装助手

仅安装：

```sh
node scripts/install-plugin.mjs
```

用户已经明确说“主用 API2 copy，备用 Doro”时，可安装并保存这对偏好：

```sh
node scripts/install-plugin.mjs --primary-name "API2 copy" --backup-name "Doro"
```

也可从其他目录指定本地源码和实际 Codex 可执行文件：

```sh
node "/path/to/modeltrace-guard-autoswitch/scripts/install-plugin.mjs" \
  --source "/path/to/modeltrace-guard-autoswitch" \
  --codex "/path/to/codex"
```

助手使用当前进程环境，包括当前 `CODEX_HOME`；默认使用 `MODELTRACE_CODEX_PATH`，未设置时使用 PATH 中的 `codex`。它只影响此次调用对应的 Codex 配置，不承诺所有 CLI 配置或所有会话都已安装、接入或监测。

执行顺序是：校验本地 marketplace 与插件身份/版本，`codex plugin marketplace add LOCAL_PATH`，`codex plugin add modeltrace-guard-autoswitch@modeltrace-autoswitch`，再按需调用 `autoswitch.mjs configure --primary-name ... --backup-name ...`。执行使用 `execFile` 参数数组，不拼 shell。步骤失败即停止，不回滚已完成安装；例如配置重名失败时，插件可能已安装成功。

助手不读取认证文件、不改 hook 信任、不启动网关或推理，不调用 `enable`、`approve-switch`。主备名称需成对提供；未提供时不替用户选择。若名称有歧义，安装后用 `inspect` 选择 ID，再明确执行：

```sh
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs inspect
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs configure \
  --primary-provider PRIMARY_ID --backup-provider BACKUP_ID
```

`configure` 的名称模式和 ID 模式互斥。名称先完全匹配，未命中时允许唯一的不区分大小写匹配；重名时须选 ID，不做其他相似名称推断。需要非默认 CCSwitch 目录或端口时，在带完整主备名称或 ID 的 `configure` 命令中附加 `--cc-switch-dir PATH --port N`。配置须在网关停止时更新，新配置 ID 不会自动迁移已有路由会话。

## 信任、接入和监测是后续步骤

安装完成后，在兼容 Codex CLI 的 `/hooks` 中由用户审阅并信任插件。不要替用户执行信任修改；更新后如 hook 定义变化，再按原生机制审阅。加载新插件后，已安装技能负责后续自然语言请求。

主配置和第三方备用须通过 CCSwitch 4.0.15 界面加入 Stack；保留公司默认，不把 Official 设为全局默认。完整网关流程推荐 Node.js 24.5+；22.x 至少为 22.21，25+ 也支持，同时需要 zstd 和官方 HTTPS 的原生 `proxyEnv` 能力；配置检查需要带 `sha3()` 的 `sqlite3` CLI。所有 `launch`/`enable` 均要求当前 CLI 原生 ChatGPT 登录和 `openai` 契约；Official 目标还须没有 managed account，使用当前原生登录。

CCSwitch 全局 provider 可能是 `custom`；插件会在认证检查进程中显式选用 `openai`，不会改变全局配置或代为登录。如果此时 `account/read` 仍返回 `account: null`，须先在对应 `CODEX_HOME` 的原生 Codex 中完成 ChatGPT 登录。不要读取、复制其他配置的凭据来绕过检查，也不要把安装成功或公司卡请求成功报告成原生接入已可用。

用户要求接入时，用 `autoswitch.mjs gateway-start`、`launch` 启动独立的原生 CLI，新会话默认主配置；明确选择其他有效配置时可用 `launch --provider-name NAME`。这只为新启动的进程设置网关，不会热修改已开的 Desktop 或其他 CLI。`launch --resume UUID` 只能尝试在新 CLI 中继续同一 thread，成功后在该 CLI 内工作；原窗口保持原连接，旧认证和加密历史不保证兼容。已建立路由的 thread 不会被启动参数重新选路。

当前 thread 通过网关成功使用主配置后，用户要求监测才运行 `enable --session UUID`。`enable` 不改变路由。只有这条接入并启用的路径才进入本插件监测，安装本身没有探针费用。

首次异常时报告候选及其不确定性，等待该次选择。`acknowledge` 是已告知，不是同意。用户说“同意切到 Doro”后，解析该目标，用 `guard.mjs propose-switch --request ID --target-name "Doro"` 准备，再对该目标 ID 执行 `guard.mjs approve-switch`；每次 proposal 都产生新请求 ID，approve/wait/decline 必须使用新返回的 ID，不重复请求同一份明确同意。未获得本次同意、目标身份或配置发生变化时，不发送目标验证请求。完整命令与失败边界见 [README](README.md)。

## 本地验证

```sh
node --test tests/install-plugin.test.mjs
npm run build
MODELTRACE_PYTHON=python3 npm run check
```

安装助手测试注入假的执行器，不安装真实插件、不配置真实主备。评分 parity 需要指定 Python 环境已安装 NumPy；离线检查不能替代原生 hook、真实路由与当前账户兼容性检查。
