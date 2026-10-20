# ModelTrace Guard Autoswitch

独立 fork `0.3.0`，上游作者 xqy2006，fork 维护者 ChenCJ-io，保留 MIT。完整安装入口为仓库根 [INSTALL.md](../../INSTALL.md)，主要使用流程见 [README](../../README.md)。

## 主配置、异常询问和本次切换

默认使用用户配置的主服务，例如 API2 copy。安装插件、保存主备和 `enable` 都不授权切换。通过网关成功使用主配置并显式开启监测后，首次有效指纹不一致立即暂停并进入 `awaiting_approval`；此时不隐式复测、不请求备用。

所有命令在本插件目录执行：

```sh
node scripts/autoswitch.mjs inspect
node scripts/autoswitch.mjs configure --primary-name "API2 copy" --backup-name "Doro"
node scripts/autoswitch.mjs gateway-start
node scripts/autoswitch.mjs launch
# 当前会话已成功通过网关使用主配置后：
node scripts/autoswitch.mjs enable --session SESSION_UUID
node scripts/autoswitch.mjs status --session SESSION_UUID
```

名称先完全匹配，未命中时允许唯一的不区分大小写匹配；重名时从 `inspect` 选 ID，使用 `configure --primary-provider ID --backup-provider ID`，不能混用 name/ID。配置须在网关停止时更新；新配置 ID 不会自动迁移旧路由会话。

所有 `launch`/`enable` 都要求当前 CLI 的原生 ChatGPT 登录和 `openai` 契约。认证检查会为自己的 app-server 进程显式选用 `openai`，避免 CCSwitch 全局 `custom` 配置掩盖原生认证状态；它不会代为登录。若此时仍是 `account: null`，必须先在对应原生 Codex 配置中完成 ChatGPT 登录，不能复制其他配置的凭据或声称已真实接入。

`launch` 启动独立的原生 CLI，新会话默认主配置；`launch --provider-name NAME` 可明确选择其他有效配置开始，不授权未来切换。它不会热修改已有 Desktop 或其他 CLI 窗口。`launch --resume UUID` 只尝试在新 CLI 继续同一 thread，成功后在该 CLI 内工作；原窗口连接不变，旧认证和加密历史不保证兼容。已有 thread 路由也不会被启动参数覆盖。

异常报告包含预期模型、指纹候选、时间及强弱信号；指纹不等于后端身份或降智证据。`acknowledge` 只是确认已告知，不是用户批准。目标操作如下：

```sh
# 仅准备本次目标，不发送请求：
node scripts/guard.mjs propose-switch --request REQUEST_ID --target-name "Doro"
# 只有用户对本次目标明确同意后：
node scripts/guard.mjs approve-switch --request REQUEST_ID --target-provider TARGET_ID
node scripts/guard.mjs wait-switch --request REQUEST_ID
# 用户拒绝切换、选择继续当前路由：
node scripts/guard.mjs decline-switch --request REQUEST_ID
```

每次 `propose-switch` 都创建新请求；后续 approve/wait/decline 必须读取并使用返回的新 ID。“同意切到 Doro”已经包含本次明确选择，解析到唯一配置后可执行批准，不反复询问。默认备用、历史授权、沉默或超时均不能代替本次同意；目标身份或配置改变需重新选择并同意。`propose-switch` 不提供目标时使用默认备用，也可用 `--target-provider ID` 消除重名歧义；默认备用已是当前配置时，须让用户另选目标，不能自动回主。

批准后才运行目标路由的原生 canary，真实 `completed` 回执与兼容指纹全部通过才切换并解除本次暂停；失败保持 halt。失败收尾后，用户明确改选目标时可从当前失败请求创建新 proposal，使用新 ID 记录对新目标的本次同意；已经说清的同意不重复询问，不能继承旧批准。Official 成功后停止探针，第三方目标成功后继续监测，下一次异常再次询问。拒绝待批准的切换会保留当前路由、恢复任务与普通间隔监测。不会自动回主。

`disable --session UUID` 停止监测，保留路由、已有 halt 和证据。`gateway-stop` 停止代理，依赖它的会话请求随后会失败，直到重新启动；`gateway-status` 用于查看服务状态。

## 运行环境和边界

需要支持原生快照 fork、临时任务删除、同步工具拦截和异步 hooks 的 Codex App Server。完整网关流程推荐 Node.js 24.5+；22.x 至少为 22.21，25+ 也支持，以满足 zstd 与官方 HTTPS 的原生 `proxyEnv` 要求。普通独立监测仍可使用 Node.js 18+。配置检查依赖提供 `sha3()` 的 `sqlite3` CLI，通过只读 SQL 获取身份和配置摘要，不导出密钥。

主配置及第三方目标须加入 CCSwitch 4.0.15 Stack，保留公司默认。Official 仅支持无 managed account 的当前 CLI 原生 ChatGPT 登录，网关转发到固定官方 HTTPS 地址。网关会接收认证头，不读取凭据存储、不解析或保存 token，也不修改 CCSwitch 数据库。独立 web search/images 端点尚不支持；加密历史不一定能跨路由使用。

安装后在 Codex CLI 的 `/hooks` 中审阅并信任 ModelTrace Guard Autoswitch。hook 定义变更后须按原生机制重新审阅；智能体不能代改信任。可用 `node scripts/guard.mjs doctor` 检查打包文件；`doctor --fork true` 另检查原生 fork、hook 与清理能力，会创建临时分支但不生成探针。存在多个运行时时可用 `MODELTRACE_CODEX_PATH` 选择正确可执行文件，不通过换账户绕过检查。

安装到一个 CLI 配置不会自动监测其所有任务。只有接网关并为当前 thread `enable` 才进入本插件主要流程。不同 `CODEX_HOME` 的配置与数据相互独立；不能让原版监测器同时监测同一 thread。

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
