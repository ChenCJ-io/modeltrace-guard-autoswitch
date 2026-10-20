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

- **日常无感**：照常运行 `codex`，在需要的对话里说一句"使用 modeltrace-guard-autoswitch"即可开启；正常结果不打扰。
- **不污染对话**：每次探针都在当前对话的冻结快照上另开一个一次性分支执行，原对话的上下文和历史不受影响；探针进程只运行本插件自己的 hook，不会触发你装的其他 hook。
- **异常即停**：发现不一致时，主任务和它派出的子代理都会暂停，Codex 会向你说明预期模型、指纹候选和信号强弱。
- **每次都要你同意**：安装、配置、开启监测都不算授权。每次异常都由你在下一条消息里决定：切到默认备用、换一个渠道，或保持当前渠道继续。
- **先验证再切换**：同意后先向目标渠道发一次验证探针，确认请求真实完成且指纹相符，才在同一会话里切过去；验证失败则保持暂停，不会切到一个同样可疑的渠道。
- **节省额度**：切到 OpenAI 官方订阅后自动停止探针；未开启监测的会话零消耗。
- **对配置克制**：只修改当前 Codex home 的两个配置项并保存原值，随时可以一键还原；不读取、不保存任何凭据。

## 工作原理

```text
                      ┌──────────────────────── 本机 ────────────────────────┐
  codex ── 请求 ──▶   ModelTrace 网关 (127.0.0.1:15722)
                         ├──▶ CCSwitch 默认路由 ───────▶ 主渠道
                         ├──▶ CCSwitch Stack ──────────▶ 第三方备用渠道
                         └──▶ OpenAI 官方（原生 ChatGPT 登录）

  codex ── hooks ──▶   后台探针：冻结对话快照 → 一次性分支 → 挑数测试 → 指纹比对
                      └──────────────────────────────────────────────────────┘
```

1. **路由**：一次性接入后，Codex 的默认入口指向本机网关。网关按会话把请求转给 CCSwitch 的主渠道，并为每个请求留下路由回执，用来证明"这个会话实际走的是哪条路"。
2. **抽样**：开启监测的会话每 16–32 次工具调用抽查一次；会话恢复、上下文压缩或模型标签变化后也会各查一次。
3. **指纹**：探针让模型"直接挑出 N 个 1–355 之间的整数"。不同模型挑数的分布有稳定差异，插件把结果与内置指纹库（GPT 与 Claude 系列共 18 个模型）比对，判断最像哪一个。
4. **决策**：结果与预期一致就静默记录；不一致就进入"等待你决定"的状态，具体流程见下文。

指纹库、评分算法和探针框架来自上游 [xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace)，本项目在此基础上增加了网关路由、异常询问和同会话切换。

## 环境要求

| 依赖 | 要求 |
| --- | --- |
| Codex CLI | 支持插件和 hooks 的版本，并在 Codex 中使用原生 ChatGPT 登录 |
| CCSwitch | 4.0.15，开启代理模式；主渠道和第三方备用都需要在 Stack 中登记 |
| Node.js | 推荐 24.5+；22.x 需 ≥ 22.21；25+ 也支持（需要 zstd 和原生 `proxyEnv`）。版本不够时网关会拒绝启动并说明原因 |
| sqlite3 | 命令行版本，且支持 `sha3()`（用于只读检查 CCSwitch 配置） |

另外，CCSwitch 的默认卡需要是你选定的主渠道，并且要**关闭自动故障转移**。插件每次转发前都会检查这两项，不一致就拒绝转发，而不是悄悄换路。

## 快速开始

### 1. 安装

最简单的方式是把下面这段话发给 Codex（把渠道名换成你在 CCSwitch 里的实际名称）：

> 请从 https://github.com/ChenCJ-io/modeltrace-guard-autoswitch 安装这个插件。先读取 INSTALL.md，检查运行环境，完成插件安装、主备配置和普通 Codex 入口接入。主用 CCSwitch 的「我的主渠道」，备用「OpenAI Official」；配置不存在或重名时列出候选让我选择。需要登录或在 /hooks 中信任插件时引导我完成。

也可以手动安装：

```sh
git clone https://github.com/ChenCJ-io/modeltrace-guard-autoswitch.git
cd modeltrace-guard-autoswitch
node scripts/install-plugin.mjs --primary-name "我的主渠道" --backup-name "OpenAI Official"
```

安装助手只做两件事：安装插件，以及保存你明确给出的主备偏好。它不会改 Codex 默认入口，不会启动网关或监测，也不会替你信任 hooks。

### 2. 信任 hooks

在 Codex 里打开 `/hooks`，审阅并信任本插件的 hooks。插件升级后如果 hook 定义有变化，需要重新信任一次。

### 3. 接入网关（一次性）

让 Codex 帮你执行 setup 即可。等效的手动命令如下：

```sh
AUTOSWITCH=codex-plugin/modeltrace-guard/scripts/autoswitch.mjs
node "$AUTOSWITCH" inspect            # 列出 CCSwitch 中的候选渠道
node "$AUTOSWITCH" configure --primary-name "我的主渠道" --backup-name "OpenAI Official"
node "$AUTOSWITCH" connect            # 启动网关并接入 Codex 默认入口
node "$AUTOSWITCH" connection-status  # 检查接入状态
```

`connect` 只修改当前 `CODEX_HOME` 中的 `model_provider` 和 `openai_base_url` 两项，并保存原值；它只影响之后新建的会话，不会动认证信息、其他 Codex home、CCSwitch 的默认卡，也不会改已经打开的对话。

### 4. 在对话中开启监测

新建一个普通的 Codex 会话，对它说：

> 使用 modeltrace-guard-autoswitch。

监测只对当前会话生效，其他会话不受影响。安装或接入时所在的旧会话没有经过网关，无法中途接管，需要新开一个会话。

## 发现异常后会发生什么

1. **暂停**：插件拦下主任务和子代理的后续工具调用。Codex 向你报告预期模型、指纹候选和信号强弱。它只是候选，不是定论。
2. **等你回复**：在你的下一条消息里告诉 Codex 你的决定，例如：
   - "同意切到 OpenAI Official"：切到默认备用；
   - "切到「另一个渠道」"：换一个 CCSwitch 中的渠道；
   - "不用切，继续"：保留当前渠道，恢复工作。
3. **验证**：同意后，插件先向目标渠道发一次验证探针。只有拿到真实的完成回执、并且指纹相符，才在同一会话里切换并继续任务，历史保留；验证失败则保持暂停，由你重新选择。
4. **之后**：切到官方订阅后停止探针，以免持续消耗个人额度；切到第三方渠道后继续监测，下次异常会再次询问。插件不会自动切回主渠道。

切换、拒绝或恢复，都只接受你在异常报告**之后**发出的回复，而且一条回复只能用于一次决定。Codex 不能在报告的同一轮里替你点头，你的沉默、超时或之前的笼统授权也都不算同意。

## 命令参考

日常使用中，这些命令都由插件技能代为执行，你只需要用自然语言和 Codex 交流。下面列出来，方便排查问题和手动管理。

**接入与管理**（`node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs <命令>`）

| 命令 | 作用 |
| --- | --- |
| `inspect` | 列出 CCSwitch 中的候选渠道 |
| `configure --primary-name A --backup-name B` | 保存主备渠道；重名时改用 `--primary-provider ID` / `--backup-provider ID` |
| `connect` / `disconnect` | 接入网关；或还原 `connect` 修改过的两项配置 |
| `connection-status` | 检查之后新建的会话是否会经过网关 |
| `use --session ID` / `disable --session ID` | 为会话开启 / 停止监测 |
| `status --session ID` | 查看会话的路由和监测状态 |
| `gateway-status` / `gateway-start` / `gateway-stop` | 管理本机网关进程 |

**异常处理**（`node codex-plugin/modeltrace-guard/scripts/guard.mjs <命令>`）

| 命令 | 作用 |
| --- | --- |
| `propose-switch --request ID [--target-name NAME]` | 为本次异常选择切换目标，会生成新的请求 ID |
| `approve-switch --request ID --target-provider ID` | 记录你对本次目标的同意，并开始验证 |
| `wait-switch --request ID` | 等待验证结果 |
| `decline-switch --request ID` | 不切换，保留当前渠道继续 |
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

如果网关起不来（例如 hooks 用到的 `node` 版本太旧），新会话开始时会提示具体原因，并给出 `disconnect` 命令，让你先恢复原来的 Codex 入口。

## 安全与隐私

- 网关只监听 `127.0.0.1`，会校验 Host 和 Origin。网关 URL 中带有访问凭证，请不要公开。
- 插件不读取凭据存储，也不解析或保存登录 token。但网关会接收 Codex 的认证头，并转发到你选定的链路，这是转发请求所必需的。
- 检查 CCSwitch 配置时只使用只读 SQL，返回的是身份标记和在数据库内计算的摘要，不导出密钥，也不修改数据库。
- 状态数据保存在 `${CODEX_HOME:-~/.codex}/modeltrace-guard-autoswitch`，与上游插件的数据互不干扰。

## 局限性

请把监测结果当作**线索，而不是证据**。

- 指纹比对是闭集判断：只能在指纹库内的模型之间选出"最像"的一个，库外的模型会被归到最接近的候选上。
- 误报率尚未在相同上下文、多语言的条件下独立校准；结果一致也不代表全程可靠。
- 每次探针都会按整段上下文向当前渠道发一次请求，会消耗额度。
- 探针用到的冻结快照在删除前，会以「ModelTrace 临时探针快照」的名字出现在 Codex 的会话列表里，请不要继续这个会话；清理失败时插件会按退避间隔自动重试。
- 插件能确认你在异常报告之后回复过，但不解析回复内容。"同意切到哪里"由 Codex 理解并转述。
- 第三方备用经 CCSwitch Stack 转发，需要上游兼容；独立的 web search / images 端点暂不支持；加密的推理历史不一定能跨渠道延续。

## 卸载

```sh
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs disconnect    # 还原 Codex 默认入口
node codex-plugin/modeltrace-guard/scripts/autoswitch.mjs gateway-stop  # 停止网关
codex plugin remove modeltrace-guard-autoswitch@modeltrace-autoswitch
codex plugin marketplace remove modeltrace-autoswitch
```

如果不再需要历史记录，可以删除上面提到的数据目录。

## 开发

```sh
npm test                               # 运行全部测试
npm run build                          # 重新打包插件资源
MODELTRACE_PYTHON=python3 npm run check  # 分发检查 + Python/JS 评分一致性（需要 NumPy）
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
