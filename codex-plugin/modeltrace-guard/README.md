# ModelTrace Guard Autoswitch

独立 fork `0.5.0`，上游作者 xqy2006，fork 维护者 ChenCJ-io，保留 MIT。完整安装入口为仓库根 [INSTALL.md](../../INSTALL.md)，主要使用流程见 [README](../../README.md)。

内置指纹库包含 `gpt-6.1-sol` 的 36 条官方原生参考（max、Standard、Codex CLI 0.163.0）。新参考采集须由用户另行明确请求；普通监测不运行采集入口，也不自动扩展指纹库。

该模型是实验参考：与 `gpt-6-astra` 容易混淆，独立官方样本单条正确 4/6，另 2 条被归为 Astra。单条分组交叉验证中新模型仅正确 19/36，候选不能证明渠道替换。两者登记为已知混淆组（`assets/confusable-groups.json`，绑定当前指纹库哈希）：第一候选落在预期模型的组内且组内合计权重 ≥ 0.5 时按兼容计，不暂停、不发起切换，目标验证同样适用；组外候选的判定不变。参考已加入库，不代表归因准确率已校准；详见源码仓库 `docs/GPT-6.1-SOL-REFERENCE.md`。

完成一次性接入后，照常运行 `codex`，在需要监测的对话里说“开启指纹监测”（或“使用 modeltrace-guard-autoswitch”）。技能执行 `autoswitch.mjs use`，只为当前已接入的主渠道 thread 开启监测；个人会话默认不检测，无需专用启动器。

## 主配置、异常询问和本次切换

默认使用用户配置的主服务，例如 我的主渠道。安装插件、connect、保存主备和 use/enable 都不授权切换。通过网关成功使用主配置并显式开启监测后，首次有效指纹不一致立即暂停并进入 `awaiting_approval`；此时不隐式复测、不请求备用。

所有命令在本插件目录执行：

```sh
node scripts/autoswitch.mjs inspect
node scripts/autoswitch.mjs configure --primary-name "我的主渠道" --backup-name "另一个渠道"   # 备用可省略，只是推荐项
node scripts/autoswitch.mjs connect
node scripts/autoswitch.mjs connection-status
# 之后在普通 codex 新会话中，技能执行：
node scripts/autoswitch.mjs use --session SESSION_UUID
node scripts/autoswitch.mjs status --session SESSION_UUID
```

这是技能执行的准备和管理命令，不要求用户手工启动另一套 CLI。安装助手只安装插件、可选保存明确的主备，不调用 connect。用户随后要求 setup 或使用插件时，技能完成一次性 connect 并说明范围：仅修改当前 Codex home 的 `model_provider`、`openai_base_url` 两项未来新会话默认值，保存原值；不修改 auth、其他 home（例如 `.codex-personal`）、CCSwitch 默认卡或旧 thread，不重启 daemon。写入采用原生版本和原值校验，冲突时不覆盖外部修改。

connect 的数据目录必须与普通启动一致，不能仅用命令行 `--data-dir` 指向普通 `codex` 找不到的位置；自定义目录需共同继承 `MODELTRACE_AUTOSWITCH_DATA`。CCSwitch 退出、重启或切卡可能重写入口；用户再次要求使用插件时，可显式 connect 重连，但只接受 CCSwitch 主卡未变且两键逐项为原值或旧 owned 值的情形。其他配置不覆盖，启动 hook 只报告，不后台抢回入口。

首次安装所在的旧会话没有网关回执时，use 返回 `connection_setup_required` 或 `new_conversation_required`。完成缺少的准备后，新建一个普通 Codex 会话一次，再说“使用 modeltrace-guard-autoswitch”；不能把旧窗口报告为已热接管。

已有失败回执返回 `gateway_request_failed`，附带 HTTP/SSE 状态，须排查传输而不是反复新开对话；未确认回执为 `gateway_request_unconfirmed`，配置已变为 `gateway_configuration_changed`。这些状态均不授权切换。

名称先完全匹配，未命中时允许唯一的不区分大小写匹配；重名时从 `inspect` 选 ID，使用 `configure --primary-provider ID --backup-provider ID`，不能混用 name/ID。配置须在网关停止时更新；新配置 ID 不会自动迁移旧路由会话。

接入要求当前 Codex home 的原生 ChatGPT 登录和 `openai` 契约。认证检查为自己的 app-server 进程显式选用 `openai`，避免 CCSwitch 全局 `custom` 配置掩盖原生认证状态，不会代为登录。若返回 `account: null`，核对这个进程的 home/provider 与原生登录；不推断用户从未登录，不复制另一配置的凭据。

同步 `SessionStart` hook 的 `startup.mjs` 在本插件拥有且有效的接入配置就绪时保证网关启动，不启用监测、不改默认值、不自动修复 CCSwitch 漂移。会话打开或恢复时（上下文压缩不算），它还会直接向用户显示一行渠道提示：本会话走哪个渠道、监测是否开启以及开启方法；没经过网关的会话会说明实际去向（CCSwitch 当前卡、OpenAI 官方个人订阅等），不输出任何 URL 或凭证。新会话的提示是首个请求将获得的路由，实际路由仍以网关回执为准。`gateway-start` 单独启动服务，不等于接入默认入口。`connection-status` 说明未来新会话的配置；当前请求渠道要看对应 thread 的成功回执，账号或额度 UI 不是路由证据。

`launch`、`launch --provider-name NAME`、`launch --resume UUID` 保留为高级诊断兼容命令，不作为普通使用步骤。它们不热改原窗口，不保证旧认证和加密历史兼容，也不覆盖已有 thread 的选路或切换确认。

异常报告包含预期模型、指纹候选、时间及强弱信号；指纹不等于后端身份或降智证据。`acknowledge` 只是确认已告知，不是用户批准。目标操作如下：

```sh
# 列出 CCSwitch 中所有 Codex 渠道，把编号绑定到本次异常（不发送请求）：
node scripts/guard.mjs candidates --request REQUEST_ID
# 用户在报告之后回复了编号或渠道名：一步完成选定、同意并开始验证
node scripts/guard.mjs choose --request REQUEST_ID --pick N
node scripts/guard.mjs wait-switch --request RETURNED_REQUEST_ID
# 用户回 0 或选择继续当前路由：
node scripts/guard.mjs decline-switch --request REQUEST_ID
# 只针对单个提议目标时仍可用：
node scripts/guard.mjs propose-switch --request REQUEST_ID --target-name "另一个渠道"
node scripts/guard.mjs approve-switch --request REQUEST_ID --target-provider TARGET_ID
```

清单按“推荐备用、主渠道、官方、其他”编号，每项写明切换后是否继续监测和上次抽查结果；不能直连（非 Responses API、key 来自环境变量等）、由 CCSwitch 管登录但未加入聚合、绑定了其他账号等不可选的卡也会列出并说明原因。编号绑定列出时的卡身份，卡被改过会拒绝并要求重新列出。`choose` 改选与提议不同的目标、或在验证失败后重新选择时，都会创建新请求；每次 `propose-switch` 也都创建新请求；后续 approve/wait/decline 必须读取并使用返回的新 ID。“同意切到 另一个渠道”已经包含本次明确选择，解析到唯一配置后可执行批准，不反复询问。默认备用、历史授权、沉默或超时均不能代替本次同意；目标身份或配置改变需重新选择并同意。`propose-switch` 不提供目标时使用默认备用，也可用 `--target-provider ID` 消除重名歧义；默认备用已是当前配置时，须让用户另选目标，不能自动回主。

批准后才运行目标路由的原生 canary，真实 `completed` 回执与兼容指纹全部通过才切换并解除本次暂停；失败保持 halt。失败收尾后，用户明确改选目标时可从当前失败请求创建新 proposal，使用新 ID 记录对新目标的本次同意；已经说清的同意不重复询问，不能继承旧批准。Official 成功后停止探针，第三方目标成功后继续监测，下一次异常再次询问。拒绝待批准的切换会保留当前路由、恢复任务与普通间隔监测。不会自动回主。

`disable --session UUID` 停止监测，保留路由、已有 halt 和证据。`disconnect` 仅恢复仍归插件拥有的两键原值，不覆盖用户后续修改，不改变现有会话或监测，也不关闭网关。`gateway-stop` 停止代理，依赖它的会话请求随后会失败，直到重新启动；`gateway-status` 用于查看服务状态。

## 运行环境和边界

需要支持原生快照 fork、临时任务删除、同步工具拦截和异步 hooks 的 Codex App Server。完整网关流程推荐 Node.js 24.5+；22.x 至少为 22.21，25+ 也支持，以满足 zstd 与官方 HTTPS 的原生 `proxyEnv` 要求。普通独立监测仍可使用 Node.js 18+。配置检查依赖提供 `sha3()` 的 `sqlite3` CLI，通过只读 SQL 获取身份和配置摘要，不导出密钥。

网关访问 Official 的出网方式与主备配置分开管理。默认 `auto` 依次使用网关进程的 `HTTPS_PROXY`、系统 HTTPS 代理（macOS `scutil`、Windows Internet 设置）、直连，约每 15 秒及每次连接失败后重新判断；`autoswitch.mjs network` 查看网关实际出网并做无凭证连通性检查，`network --official-proxy auto|direct|http(s)://HOST:PORT` 立即生效，不需停网关、不改配置 ID、不迁移路由。只支持 HTTP(S) 代理。切到 Official 前 `approve-switch` 会先做连通性检查，失败返回 `OFFICIAL_UNREACHABLE`，不记录批准。

用户也可在对话中主动切换当前会话的渠道（「切回主渠道」「切到 API2 copy」）：技能执行 `guard.mjs switch-route --target-name NAME`，只改该会话的网关路由，不改 CCSwitch 默认卡；切换前同样先做一次目标验证（完整回执 + 指纹兼容），切回仍在降智的中转时验证失败、保留当前渠道并自动解除暂停。成功切到主渠道或第三方后恢复监测，切到 Official 后停止监测。需已执行 use，且没有未处理的异常。

CCSwitch 4.0.15 里有渠道卡即可；能直连的主渠道和其他普通渠道都不需要 CCSwitch 的代理、默认卡或故障转移设置，也不需要加入 Stack。保留公司默认。Official 仅支持无 managed account 的当前 CLI 原生 ChatGPT 登录，网关转发到固定官方 HTTPS 地址。网关会接收原生认证头，只转发给本机 CCSwitch 或固定官方地址，不解析或保存 token，也不修改 CCSwitch 数据库。独立 web search/images 端点尚不支持；加密历史不一定能跨路由使用。

0.5 起配置主渠道时，能直连的主渠道保存为直连；不能直连（例如需要 CCSwitch 转换格式）、由 CCSwitch 管登录的主渠道，以及 0.5 之前保存的配置，使用 CCSwitch 普通默认路由：模型名和原生 Codex 请求头保持不变，转发前校验 CCSwitch 代理、默认卡仍为主通道、自动故障切换关闭，检测到漂移会拒绝请求，不自动改卡。模型列表请求跟随主渠道（直连时发往主渠道自己的地址）。按 key 计费的渠道由网关直连：该渠道是会话路由时，每次请求从 CCSwitch 只读取出这张卡的 `base_url`、key（`experimental_bearer_token`，否则 `OPENAI_API_KEY`）和静态请求头，去掉原生登录、账号和其他凭据类请求头后发往这张卡自己的地址，拒绝重定向；卡的身份摘要变了就拒绝转发，需要重新选择。只有 Copilot、xAI 等由 CCSwitch 管登录的卡仍使用 Stack 前缀。

安装后在 Codex CLI 的 `/hooks` 中审阅并信任 ModelTrace Guard Autoswitch。v0.4 新增同步启动 hook，定义变更后须按原生机制重新审阅；智能体不能代改信任。可用 `node scripts/guard.mjs doctor` 检查打包文件；`doctor --fork true` 另检查原生 fork、hook 与清理能力，会创建临时分支但不生成探针。存在多个运行时时可用 `MODELTRACE_CODEX_PATH` 选择正确可执行文件，不通过换账户绕过检查。

安装、connect 和网关自启都不会自动监测全部任务。当前已接入主渠道的 thread 执行 use 才进入主要流程；重复 use 不重开已停策略、不清 halt。个人初始路线与成功切入 Official 的路线不排后续周期探针；普通诊断须用户另行明确请求。不同 `CODEX_HOME` 的配置与数据相互独立，不能让原版监测器同时监测同一 thread。

## 原生采样与通知

探针由 Codex 自身生成，消耗对应推理额度，评分使用插件附带的离线指纹库。后台从任务已保存历史创建冻结基准；临时 fork 只回答一次数字数组，受信任 hook 禁止其工具调用。它不继承执行主任务的目标，不改变主任务消息；原始数组留在本地采样存储，不注入主任务。

不要在原任务手写、复制或提交探针数字，不要用普通 fork 工具、子代理或手写供应商 API 请求替代失败的执行器。无效、超时、中断、压缩、配置变化或缺少路由证据都是检测缺口，不是模型不一致证据。普通检查正常完成时静默保存，不逐个轮询或等待；异常才进入对应管理流程。

异步告警在 Codex 下一个安全边界送达，空闲任务不会因此自动开新轮。同步 `PreToolUse` 拦截受支持的后续工作工具，不能保证取消已运行的命令或所有托管路径。智能体须先说明异常再确认已告知，不能静默确认。待用户选择期间保持原工作暂停。

基准只包含已保存历史，不含尚未落盘的内存；轮次校验不是全文校验。采样后按所属任务、轮次和持久化后代检查清理基准；被修改或产生其他持久化后代的基准保留并报告阻塞。临时基准可能短暂出现在任务列表中，不应用于工作。不得删除无关任务解决清理问题。

## 独立上游监测模式

用户明确只需普通监测时，可另用 `guard.mjs start`；此路径保留上游异常后固定快照复测 N 次的规则，默认 N=3，全部有效复测不一致后 halt。它不自动切路由，也不能替代本插件的本次批准流程。

```sh
node scripts/guard.mjs start --tool-min 16 --tool-max 32 --retry-count 3 --languages zh,en
node scripts/guard.mjs configure --retry-count 5
node scripts/guard.mjs status
node scripts/guard.mjs dashboard
node scripts/guard.mjs stop
```

默认间隔为 16–32 次观察到的工作工具完成，不按时间调度，没有每轮或任务累计探针上限；重试数量支持 1–100，`--pending-seconds` 默认 180，仅表示探针发出至完成的期限。`--expected auto` 跟随任务元数据，缺少标签和库中未收录标签分别报告，不计为不一致。语言支持 zh/en/ja/ko/fr/de/es/pt/ru/ar。

上游模式的首次异常及全部复测使用同一冻结基准；复测不继承前一个探针。先告知再 `acknowledge`，仅异常期间使用返回的 `wait --confirmation ID`。达到 halt 后停止工作，普通 `resume --halt ID` 必须有用户明确恢复请求；`stop`、配置或提醒确认不解除 halt。本插件的异常请求则使用上文的 approve/decline 流程。

## 数据、清理和校准

默认数据位于 `${CODEX_HOME:-~/.codex}/modeltrace-guard-autoswitch`，历史、样本与已确认提醒在 `_history` 中，清理记录在 `_fork_cleanup` 中。仪表盘需要另行启动；关闭页面不停止监测。页面能力 URL 不能公开，浏览器通知需要授权且页面保持连接，存在提醒不代表已核验送达。`dashboard-stop` 只关闭网页服务。

指纹库、评分器与样式的来源和 SHA-256 见 `assets/provenance.json`，运行时不自动下载或扩展。结果是闭集候选内的指纹相似度，未收录模型也可能被归入最相近候选。同上下文和多语言误报率没有独立校准，重复结果可能相关。fork 输出不能证明主任务此前请求的后端身份。

源码根的 `npm test`、`npm run build`、`MODELTRACE_PYTHON=python3 npm run check` 分别执行测试、打包和分发/评分一致性检查；parity 需要所选 Python 已安装 NumPy。`scripts/evaluate-calibration.mjs` 可读取用户提供的独立 holdout 数据，不能用模拟测试代替真实归因准确率验证。
