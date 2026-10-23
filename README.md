# ModelTrace Guard Autoswitch

[![tests](https://github.com/ChenCJ-io/modeltrace-guard-autoswitch/actions/workflows/plugin-tests.yml/badge.svg)](https://github.com/ChenCJ-io/modeltrace-guard-autoswitch/actions/workflows/plugin-tests.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node](https://img.shields.io/badge/node-%E2%89%A522.21-brightgreen.svg)

一个配合 [CCSwitch](https://github.com/farion1231/cc-switch) 使用的 **Codex CLI 插件**：在你日常使用 Codex 的过程中，后台抽样检测当前渠道背后的模型是否与预期一致（降智 / 掉包监测）；一旦发现异常就暂停任务并询问你，经你同意后把**同一个会话**无缝切到备用路由。

> A Codex CLI plugin that fingerprints the model behind your CCSwitch route, pauses on mismatch, and switches the same conversation to a backup route only with your consent.

---

## 为什么需要它

通过中转或第三方渠道使用 Codex 时，你看到的模型名只是一个标签。渠道可能悄悄换成更便宜的模型、降低推理强度，或在高峰期切换后端，而从对话里很难察觉。

本插件在不打断工作的前提下，定期让模型做一个小测试，用它的"答题习惯"判断背后的模型。结果一致时完全静默；不一致时立即停下来交给你决定，而不是让你在不知情的情况下继续干活。

## 特性

- **日常无感**：照常运行 `codex`，在需要的对话里说一句“开启指纹监测”即可开启；正常结果不打扰。
- **开场告知渠道**：每次新开或恢复会话，都会先显示这个会话走哪个渠道、是否在监测；没经过插件网关时（例如 CCSwitch 改写了配置）会直接说明实际走的是哪里，个人订阅不会在你不知情时被用掉。
- **不污染对话**：每次探针都在当前对话的冻结快照上另开一个一次性分支执行，原对话的上下文和历史不受影响；探针进程只运行本插件自己的 hook，不会触发你装的其他 hook。
- **异常即停**：发现不一致时，主任务和它派出的子代理都会暂停，Codex 会向你说明预期模型、指纹候选和信号强弱。
- **每次都要你同意**：安装、配置、开启监测都不算授权。每次异常都会列出 CCSwitch 里所有 Codex 渠道，由你在下一条消息里回编号决定切到哪个，或保持当前渠道继续。
- **先验证再切换**：同意后先向目标渠道发一次验证探针，确认请求真实完成且指纹相符，才在同一会话里切过去；验证失败则保持暂停，不会切到一个同样可疑的渠道。
- **节省额度**：切到 OpenAI 官方订阅后自动停止探针；未开启监测的会话零消耗。
- **对配置克制**：只修改当前 Codex home 的两个配置项并保存原值，随时可以一键还原；不改 CCSwitch，不保存任何凭据。
- **CCSwitch 只当渠道目录**：主渠道和 CCSwitch 里的其他普通渠道（按 key 计费的中转）都由网关直连，不需要在 CCSwitch 里开代理、对齐默认卡、关故障转移或加 Stack。

## 工作原理

```text
                      ┌──────────────────────── 本机 ────────────────────────┐
  codex ── 请求 ──▶   ModelTrace 网关 (127.0.0.1:15722)
                         ├──▶ 直连（用该卡自己的 key）──▶ 主渠道和 CCSwitch 里的其他渠道
                         ├──▶ CCSwitch 本机代理 ────────▶ 由 CCSwitch 管登录的卡（Copilot、xAI）
                         └──▶ OpenAI 官方（原生 ChatGPT 登录）

  codex ── hooks ──▶   后台探针：冻结对话快照 → 一次性分支 → 挑数测试 → 指纹比对
                      └──────────────────────────────────────────────────────┘
```

1. **路由**：一次性接入后，Codex 的默认入口指向本机网关。网关按会话把请求发往这个会话当前的渠道（新会话是主渠道），并为每个请求留下路由回执，用来证明"这个会话实际走的是哪条路"。
2. **抽样**：开启监测的会话每 16–32 次工具调用抽查一次；会话恢复、上下文压缩或模型标签变化后也会各查一次。
3. **指纹**：探针让模型"直接挑出 N 个 1–355 之间的整数"。不同模型挑数的分布有稳定差异，插件把结果与内置指纹库（GPT 与 Claude 系列共 19 个模型，包括 `gpt-6.1-sol`）比对，判断最像哪一个。
4. **决策**：结果与预期一致就静默记录；不一致就进入"等待你决定"的状态，具体流程见下文。

指纹库、评分算法和探针框架来自上游 [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace)，本项目在此基础上增加了网关路由、异常询问和同会话切换。

## 环境要求

| 依赖 | 要求 |
| --- | --- |
| Codex CLI | 支持插件和 hooks 的版本，并在 Codex 中使用原生 ChatGPT 登录 |
| CCSwitch | 4.0.15，里面有你的 Codex 渠道卡即可。只有用到 Copilot、xAI 这类由 CCSwitch 管登录的卡（要开代理模式并加入聚合），或主渠道不能直连时，才需要 CCSwitch 的代理 |
| Node.js | 推荐 24.5+；22.x 需 ≥ 22.21；25+ 也支持（需要 zstd 和原生 `proxyEnv`）。版本不够时网关会拒绝启动并说明原因 |
| sqlite3 | 命令行版本，且支持 `sha3()`（用于只读检查 CCSwitch 配置） |

主渠道不能直连时（例如它只支持 Chat Completions、要 CCSwitch 转换格式），或沿用 0.5 之前的配置时，主渠道走 CCSwitch 的默认路由：这时 CCSwitch 要开代理模式，默认卡需要是主渠道，并且要**关闭自动故障转移**。插件每次转发前都会检查这几项，不一致就拒绝转发，而不是悄悄换路。

不确定哪项没满足时，装好插件后对 Codex 说“检查 ModelTrace 环境”（或运行 `autoswitch.mjs check`）。它会逐项列出通过、待完成或未通过，并给出每项的修法，只读、不改任何东西。

### 访问 OpenAI Official 的网络（代理）

备用渠道是 OpenAI Official 时，请求由本机网关（Node 进程）直接发往 `chatgpt.com`。Codex 本身会走系统代理，Node 不会；而网关常由 hook 或工具调用拉起，环境里不一定带 `HTTPS_PROXY`。所以网关按下面的顺序自己决定出网方式（`auto`，默认，无需配置）：

1. 网关进程的 `HTTPS_PROXY` / `https_proxy`（同时遵守 `NO_PROXY`）
2. 操作系统的系统 HTTPS 代理：macOS 读 `scutil --proxy`，Windows 读「Internet 设置」；Linux 没有统一的系统代理，只看环境变量
3. 直连

出网方式大约每 15 秒、以及每次连接失败后重新判断一次。开关 VPN、换代理端口都不用重启网关。需要固定某个代理时：

```sh
AUTOSWITCH=codex-plugin/modeltrace-guard/scripts/autoswitch.mjs
node "$AUTOSWITCH" network                                          # 查看网关实际的出网方式，并做一次不带凭证的连通性检查
node "$AUTOSWITCH" network --official-proxy http://127.0.0.1:7890   # 固定代理，立即生效
node "$AUTOSWITCH" network --official-proxy direct                  # 强制直连
node "$AUTOSWITCH" network --official-proxy auto                    # 恢复自动
```

这个设置只影响网关去 Official 的出网方式，不属于主备配置：不用停网关，不会生成新的配置 ID，也不影响已有会话的路由和切换同意。代理只承载到 `chatgpt.com` 的 TLS 隧道。只支持 HTTP(S) 代理；系统代理只开了 SOCKS 或 PAC 时，`network` 会提示 `socks_unsupported` / `pac_unsupported`，请改填 HTTP 代理端口。代理地址里的账号密码会以 0600 权限保存在数据目录的 `network.json`，所有输出都会打码。

批准切到 Official 前，插件会先检查网关能否连到 Official；连不上会返回 `OFFICIAL_UNREACHABLE`。这时不会记录批准，请求保持待确认，修好网络后再确认一次即可。

## 快速开始

### 1. 安装

在终端运行两条命令，不需要下载源码：

```sh
codex plugin marketplace add ChenCJ-io/modeltrace-guard-autoswitch
codex plugin add modeltrace-guard-autoswitch@modeltrace-autoswitch
```

也可以把下面这段话发给 Codex，让它代劳（渠道名换成你在 CCSwitch 里的实际名称）：

> 请安装 ModelTrace Guard Autoswitch：运行 `codex plugin marketplace add ChenCJ-io/modeltrace-guard-autoswitch` 和 `codex plugin add modeltrace-guard-autoswitch@modeltrace-autoswitch`，然后按仓库里的 INSTALL.md 检查运行环境、把 CCSwitch 的「我的主渠道」设为主渠道，并接入普通 Codex 入口。配置不存在或重名时列出候选让我选择；需要登录或在 /hooks 中信任插件时引导我完成。

升级到新版本：运行 `codex plugin marketplace upgrade modeltrace-autoswitch`，重启 Codex，再说一次“检查 ModelTrace 环境”；提示网关是旧版本时，让 Codex 重启插件网关。

开发或无法访问 GitHub 时，可以从源码安装：

```sh
git clone https://github.com/ChenCJ-io/modeltrace-guard-autoswitch.git
cd modeltrace-guard-autoswitch
node scripts/install-plugin.mjs --primary-name "我的主渠道"
```

安装助手只做两件事：安装插件，以及保存你明确给出的主渠道（和可选的推荐备用）。它不会改 Codex 默认入口，不会启动网关或监测，也不会替你信任 hooks。注意源码安装用的是本地插件市场：Codex 每次重启都会把这个目录当时的文件同步进去，在里面切分支或改文件会直接改变正在用的插件，日常使用建议用上面的 GitHub 方式。

### 2. 信任 hooks

在 Codex 里打开 `/hooks`，审阅并信任本插件的 hooks。插件升级后如果 hook 定义有变化，需要重新信任一次。

之后可以先对 Codex 说“检查 ModelTrace 环境”，看看还差哪几步。

### 3. 接入网关（一次性）

让 Codex 帮你执行 setup 即可。等效的手动命令如下：

```sh
AUTOSWITCH=codex-plugin/modeltrace-guard/scripts/autoswitch.mjs
node "$AUTOSWITCH" inspect            # 列出 CCSwitch 中的候选渠道
node "$AUTOSWITCH" configure --primary-name "我的主渠道" --backup-name "OpenAI Official"   # --backup-name 可省略
node "$AUTOSWITCH" connect            # 启动网关并接入 Codex 默认入口
node "$AUTOSWITCH" connection-status  # 检查接入状态
```

`connect` 只修改当前 `CODEX_HOME` 中的 `model_provider` 和 `openai_base_url` 两项，并保存原值；它只影响之后新建的会话，不会动认证信息、其他 Codex home、CCSwitch 的默认卡，也不会改已经打开的对话。

### 4. 在对话中开启监测

新建一个普通的 Codex 会话。会话一打开，插件会先显示一行渠道提示，例如：

```text
ModelTrace：本会话走「我的主渠道」（主渠道，第三方中转），指纹监测未开启。需要时对 Codex 说“开启指纹监测”：每 16–32 次工具调用抽查一次，每次按当前上下文多发一个请求。
```

需要监测时，对 Codex 说：

> 开启指纹监测。

说“使用 modeltrace-guard-autoswitch”也可以。监测只对当前会话生效，其他会话不受影响。安装或接入时所在的旧会话没有经过网关，无法中途接管，需要新开一个会话。

渠道提示的几种情况：

| 情况 | 提示内容 |
| --- | --- |
| 经网关、在主渠道 | 渠道名，监测是否开启；未开启时附开启方法 |
| 已切到 OpenAI Official | 说明不做指纹监测，新会话仍走主渠道 |
| 没经过网关 | 实际走的渠道（CCSwitch 当前卡、OpenAI 官方个人订阅等），不能监测和切换 |
| 会话属于旧的网关配置 | 提示新开会话 |

提示语言跟随系统：先看 `MODELTRACE_LANG`（`zh` / `en`），再看 `LC_ALL` / `LC_MESSAGES` / `LANG`，macOS 上再看系统首选语言。上下文压缩不会重复提示。

## 发现异常后会发生什么

1. **暂停**：插件拦下主任务和子代理的后续工具调用。Codex 向你报告预期模型、指纹候选和信号强弱。它只是候选，不是定论。
2. **列出渠道，等你回复**：Codex 会实时读取 CCSwitch，把所有 Codex 渠道列成清单，例如：

   ```text
   1. OpenAI Official（推荐）  官方登录，切换后停止监测，消耗个人订阅；上次抽查与预期一致
   0. 不切换，继续用 我的主渠道
   2. 渠道 B                   第三方中转，切换后继续监测
   暂不可选：渠道 C（只支持 Chat Completions，需要 CCSwitch 转换格式）
   ```

   在你的下一条消息里回编号或渠道名即可，例如“1”“切到 渠道 B”或“0”。配置了备用时，它排在第一位并标为推荐，单说“同意”就指它。每个编号绑定的是列出时那张卡的身份，卡在这之后被改过，会重新列出再问你。
3. **验证**：同意后，插件先向目标渠道发一次验证探针。只有拿到真实的完成回执、并且指纹相符，才在同一会话里切换并继续任务，历史保留；验证失败则保持暂停，由你重新选择。
4. **之后**：切到官方订阅后停止探针，以免持续消耗个人额度；切到第三方渠道后继续监测，下次异常会再次询问。验证失败时会重新列出清单（附上这次失败的结果），由你重新选择。插件不会自动切回主渠道。

切换、拒绝或恢复，都只接受你在异常报告**之后**发出的回复，而且一条回复只能用于一次决定。Codex 不能在报告的同一轮里替你点头，你的沉默、超时或之前的笼统授权也都不算同意。

## 在对话中主动切换渠道

没有异常时，你也可以直接让 Codex 切换当前会话的渠道，例如「切回主渠道」「切到 API2 copy」「切到 OpenAI Official」。只说「换个渠道」时，Codex 会先列出可选渠道再问你：

- **只改当前会话**：走插件网关按会话选路，不改 CCSwitch 的默认卡，不影响其他会话，Codex 也不用重启。
- **先验证再切**：和异常切换一样，先向目标渠道发一次探针，要求回执完整、指纹相符才切。切回主渠道时，如果它还是降智的模型，验证不通过，会话保留在当前渠道，暂停自动解除，Codex 会告诉你原因。每次切换消耗目标渠道的一次探针。
- **切换后**：切到主渠道或第三方渠道后自动恢复监测，之后再出现异常仍会提醒；切到 Official 后照旧停止监测。
- **前提**：当前会话已经开启监测（说过“开启指纹监测”），并且没有未处理的异常（有异常时按上面的流程回复）。普通渠道不需要在 CCSwitch 里做任何设置；Copilot、xAI 这类由 CCSwitch 管登录的卡需要先加入聚合。

切换只在你明确要求时发生，Codex 不会自己发起，也不会在失败后自动重试。

## 命令参考

日常使用中，这些命令都由插件技能代为执行，你只需要用自然语言和 Codex 交流。下面列出来，方便排查问题和手动管理。

**接入与管理**（`node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs <命令>`）

| 命令 | 作用 |
| --- | --- |
| `check` | 只读检查整套环境（Node、sqlite3、Codex 登录与 hooks、CCSwitch、主渠道、网关、接入状态、可切换渠道），每项附修法 |
| `inspect` | 列出 CCSwitch 中的候选渠道 |
| `configure --primary-name A [--backup-name B]` | 保存主渠道和可选的推荐备用；重名时改用 `--primary-provider ID` / `--backup-provider ID` |
| `connect` / `disconnect` | 接入网关；或还原 `connect` 修改过的两项配置 |
| `connection-status` | 检查之后新建的会话是否会经过网关 |
| `use --session ID` / `disable --session ID` | 为会话开启 / 停止监测 |
| `status --session ID` | 查看会话的路由和监测状态 |
| `gateway-status` / `gateway-start` / `gateway-stop` | 管理本机网关进程 |
| `network [--official-proxy auto\|direct\|URL]` | 查看或设置网关访问 OpenAI Official 的出网方式，立即生效 |

**异常处理**（`node codex-plugin/modeltrace-guard/scripts/guard.mjs <命令>`）

| 命令 | 作用 |
| --- | --- |
| `candidates [--request ID]` | 列出 CCSwitch 里所有 Codex 渠道：可选的编号、不可选的原因、切换后是否继续监测、上次抽查结果；带请求 ID 时把编号绑定到本次异常 |
| `choose --request ID --pick N` | 记录你对本次异常的回答（编号或 `--target-name`），一步完成选定、同意并开始验证 |
| `propose-switch --request ID [--target-name NAME]` | 为本次异常选择切换目标，会生成新的请求 ID |
| `approve-switch --request ID --target-provider ID` | 记录你对本次目标的同意，并开始验证 |
| `wait-switch --request ID` | 等待验证结果 |
| `decline-switch --request ID` | 不切换，保留当前渠道继续 |
| `switch-route --target-name NAME` | 你在对话里主动要求切换当前会话的渠道（含切回主渠道）；先验证指纹再切，失败则保留当前渠道 |
| `dashboard` | 打开本地监测仪表盘 |
| `doctor` | 检查插件资源完整性；`doctor --fork true` 额外检查原生分支能力 |

### 常见状态

| 状态 | 含义与处理 |
| --- | --- |
| `connection_setup_required` | 还没完成一次性接入，先执行 setup / `connect` |
| `new_conversation_required` | 当前对话创建于接入之前，新开一个会话再开启监测 |
| `gateway_request_failed` | 请求经过了网关，但上游报错（如 403），按返回的 HTTP 状态排查渠道本身 |
| `gateway_request_unconfirmed` | 这个会话还没有完整的路由回执，正常对话一轮后再试 |
| `gateway_configuration_changed` | 主备配置已经变更，新开一个会话 |
| `gateway_not_ready` | CCSwitch 未运行、默认卡不是主渠道，或自动故障转移未关闭 |
| `upgrade_required` | 插件升级后旧网关进程仍在运行，执行 `gateway-stop` 再 `gateway-start` |
| `OFFICIAL_UNREACHABLE` / `official_network_unreachable` | 网关连不上 OpenAI Official（如 `ECONNRESET via a direct connection`），是本机网络或代理问题，不是账号或指纹问题。用 `network` 查看，必要时用 `network --official-proxy` 指定代理 |

如果网关起不来（例如 hooks 用到的 `node` 版本太旧），新会话开始时会提示具体原因，并给出 `disconnect` 命令，让你先恢复原来的 Codex 入口。

## 安全与隐私

- 网关只监听 `127.0.0.1`，会校验 Host 和 Origin。网关 URL 中带有访问凭证，请不要公开。
- 网关会接收 Codex 的认证头（你的 ChatGPT 登录），但只转发给本机 CCSwitch（经 CCSwitch 的路由）或固定的 OpenAI 官方地址，从不发给直连的中转。插件不解析、不保存登录 token。
- **直连会读取所选那张卡的 key**：会话走某个直连渠道（包括直连的主渠道）时，网关每次请求都从 CCSwitch 只读取出这张卡的 `base_url`、key 和自定义请求头，只发往这张卡自己的地址；key 只在内存里用，不写日志、回执或状态文件，也不输出。卡在 CCSwitch 里被改过（换了 key 或地址），之前的同意即失效，需要重新选择。
- 中转返回的重定向一律拦下，不会让 Codex 带着任何凭据跟随跳转；`base_url` 只接受 https（本机地址可用 http）。
- 检查 CCSwitch 配置时只使用只读 SQL，不修改数据库。
- 状态数据保存在 `${CODEX_HOME:-~/.codex}/modeltrace-guard-autoswitch`，与上游插件的数据互不干扰。

## 局限性

请把监测结果当作**线索，而不是证据**。

- 指纹比对是闭集判断：只能在指纹库内的模型之间选出"最像"的一个，库外的模型会被归到最接近的候选上。
- 误报率尚未在相同上下文、多语言的条件下独立校准；结果一致也不代表全程可靠。
- 每次探针都会按整段上下文向当前渠道发一次请求，会消耗额度。
- 探针用到的冻结快照在删除前，会以「ModelTrace 临时探针快照」的名字出现在 Codex 的会话列表里，请不要继续这个会话；清理失败时插件会按退避间隔自动重试。
- 插件能确认你在异常报告之后回复过，但不解析回复内容。"同意切到哪里"由 Codex 理解并转述。
- 直连只支持 Responses API（`wire_api = "responses"`）的渠道；只支持 Chat Completions、需要 CCSwitch 转换格式的渠道，以及从环境变量取 key 的渠道不能直连。直连请求不经过 CCSwitch，不会出现在它的用量统计里。独立的 web search / images 端点暂不支持；加密的推理历史不一定能跨渠道延续。

## 卸载

```sh
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs disconnect    # 还原 Codex 默认入口
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs gateway-stop  # 停止网关
codex plugin remove modeltrace-guard-autoswitch@modeltrace-autoswitch
codex plugin marketplace remove modeltrace-autoswitch
```

如果不再需要历史记录，可以删除上面提到的数据目录。

## 开发

### 为新模型采集参考指纹

仅在用户明确要求并授权额度消耗时运行。`collect-native-reference.mjs` 使用当前 Codex home 的原生登录和 CCSwitch 中无账号绑定的 `OpenAI Official`，独立创建一次性会话。它保留全局默认卡，通过网关选择官方固定 HTTPS 路径；不会读取认证文件，也不使用手写推理请求。

```sh
node scripts/collect-native-reference.mjs \
  --plugin-root /absolute/installed/plugin/cache \
  --model gpt-6.1-sol --reasoning-effort max \
  --output /absolute/new/collection-directory \
  --limit 36 --max-credits 65
```

每次请求仅回答一次，原始输出和 token 用量先落盘，再验证完整官方 `response.completed` 回执。拒绝响应中断、路由变化、明显数量偏离及规则序列；不会自动写入训练库。输出目录必须是新目录，`--offset N --limit M` 可从已完成的任务之后分段续采。采集按每百万非缓存输入/缓存输入/输出 token 为 50/2.5/250 credits 估算用量，并在下一条请求前预留 2.5 credits；这是请求前估算，单条真实消耗仍可能超过预留，不代表订阅额度的百分比。

`--split heldout --suite-json /absolute/new-challenges.json` 用于不进入训练的独立验证。验证任务应使用新的 challenge ID 和真实监测提示词；参考数据和留出数据须分别保存。新模型需完整覆盖现有 12 个环境、36 个 `query-*`，确认来源与质量后才合并到 `data/gpt_reference.jsonl`，重建 GPT、统一库和静态站点数据，执行下面的打包与检查。参考采集入口不由普通监测自动调用。

合并参考并重建库后，使用独立样本离线评分：

```sh
node scripts/evaluate-native-reference.mjs \
  --bank data/unified_bank.json --model gpt-6.1-sol \
  --samples /absolute/heldout-directory/samples.jsonl
```

该评估检查官方回执、训练/留出分离和重复输出，仅报告候选及相似度；少量独立样本不能证明长期或同上下文的误报率。

`gpt-6.1-sol` 的本次参考设置是 `max`、Standard、Codex CLI 0.163.0。其他推理强度、长上下文和更多语言的准确率仍需分别验证。

**已知区分限制：** 这批数据中 `gpt-6.1-sol` 与 `gpt-6-astra` 的数字分布容易混淆。新增模型的单次分组交叉验证仅正确 19/36，实际监测提示词的独立官方样本正确 4/6，另 2 条被归为 `gpt-6-astra`。指纹已收录，但这对模型的单次结果不足以可靠识别替换。因此插件把这两个模型登记为**已知混淆组**（`codex-plugin/modeltrace-guard/assets/confusable-groups.json`）：预期是其中一个、第一候选是另一个，且组内合计权重 ≥ 0.5 时按兼容计，不暂停、不发起切换；切换到 Official 的目标验证也按同一口径通过。代价是这两个模型之间的真实替换检测不到（本来就分不清）；组外模型（例如被判成 `gpt-5.6-luna`）的判定不变。混淆组绑定指纹库哈希，重建指纹库后自动失效，直到重新验证。完整采集与验证记录见 [验收记录](docs/GPT-6.1-SOL-REFERENCE.md)。

```sh
npm test                               # 运行全部测试
npm run build                          # 重新打包插件资源
MODELTRACE_PYTHON=python3 npm run check  # 分发检查 + Python/JS 评分一致性（需要 NumPy）
node codex-plugin/validate-reference-data.mjs # 已登记模型的来源、数量与质量检查
```

```text
codex-plugin/modeltrace-guard/   插件本体
├── hooks/hooks.json             hook 注册
├── skills/modeltrace-guard/     技能说明（Codex 如何使用本插件）
├── scripts/                     网关、探针、状态与切换逻辑
├── web/                         本地仪表盘
└── tests/                       测试
scripts/install-plugin.mjs       安装助手
data/                            指纹库与参考样本
*.py, static/, templates/        上游 ModelTrace Web 工具
```

测试使用模拟的 Codex、CCSwitch 和上游服务，离线通过不代表真实渠道已端到端验收。版本变化见 [CHANGELOG.md](CHANGELOG.md)。更细的行为约定见 [INSTALL.md](INSTALL.md)、[插件说明](codex-plugin/modeltrace-guard/README.md) 和 [技能说明](codex-plugin/modeltrace-guard/skills/modeltrace-guard/SKILL.md)。

## 致谢与许可

本项目是 [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace) 的独立 fork，指纹库、评分算法、Web 工具和探针框架均来自上游，作者 xqy2006；fork 由 ChenCJ-io 维护，来源与改动边界见 [UPSTREAM.md](docs/UPSTREAM.md)。

本项目与 OpenAI、CCSwitch 均无关联。以 [MIT](LICENSE) 许可证发布。
