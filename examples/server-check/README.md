# 渠道降智 / 掉包检测示例（服务端）

给一个 OpenAI 兼容的渠道发 3 道"挑数"题，判断它背后的模型和声称的是否一致。指纹库、评分算法和判定口径都直接用本仓库插件的，这个目录只是把它们包成服务端好调用的形式，不改插件本身。

只依赖 numpy，Python 3.10 以上。

## 先看结论

用仓库里已有的参考数据做离线模拟（`offline` 子命令，不发请求）。做法是按题留出：每次拿掉一种环境的 3 道题重训指纹库，再用这 3 道题的回答去冒充别的模型，被测的回答训练时没见过。每个模型 12 组、每组 3 道题。完整报告见运行后的 `out/offline-report.md`。

| 渠道声称 | 真货判一致 | 换成库里其他 GPT（含 5.4、5.5） | 说明 |
| --- | --- | --- | --- |
| gpt-5.6-sol / terra / luna、gpt-6-sol、gpt-6-luna | 12/12 | 96 组：抓到 95，说不准 1，漏判 0 | 说不准的那 1 组是 gpt-5.4 |
| gpt-6.1-sol、gpt-6-astra | 12/12 | 96 组：抓到 83，说不准 1，漏判 12 | 漏判的 12 组都是这两个互换 |

- **gpt-6.1-sol 和 gpt-6-astra 分不开。** 两者互换检测不到，插件里已登记为"混淆组"，组内互判算一致。其他换法都能抓到。
- **换成库里没有的模型，只能抓到六成左右。** 拿掉一个模型冒充，抓到 61% 到 63%，说不准 35% 到 37%，漏判 0% 到 4%。所以要盯的模型必须先进库。
- **要 3 道题一起判，别只看 1 道。** 只用 1 道题判时，真货也会被判成别的：gpt-6-sol 36 次里只有 30 次判一致，gpt-5.6-sol 只有 32 次。3 道题一起判没有出现这种情况。

## 怎么跑

都在仓库根目录下执行。

### 1. 离线对比（不花钱）

```sh
python3 examples/server-check/drift_check.py offline
python3 examples/server-check/drift_check.py offline --plugin-rule   # 完全按插件口径，对比用
```

`--models` 换对比范围，`--actuals` 换"可能被换上来的模型"，`--outsiders` 换模拟库外冒充的模型。

### 2. 用模拟中转把 live 流程跑通（不花钱）

```sh
python3 examples/server-check/mock_relay.py &          # 监听 127.0.0.1:18765
MOCK_KEY=x python3 examples/server-check/drift_check.py live --channels examples/server-check/channels.mock.json
```

模拟中转按 URL 里的模型名回参考数据里的真实回答，四个渠道都声称是 gpt-6.1-sol，实际分别是真货、5.6-luna、5.5、6-astra。它回的是训练数据，判得会比真实渠道更准，只用来验证流程。开着代理的机器要让 127.0.0.1 不走代理（`NO_PROXY=127.0.0.1`）。

### 3. 测真实渠道

```sh
cp examples/server-check/channels.example.json examples/server-check/channels.json   # 改成真实渠道
export RELAY_A_KEY=...                                                              # 密钥只放环境变量
python3 examples/server-check/drift_check.py live --channels examples/server-check/channels.json
```

只测一个渠道也可以直接给参数：

```sh
python3 examples/server-check/drift_check.py live \
  --name 中转A --base-url https://relay-a.example.com/v1 --model gpt-6.1-sol --key-env RELAY_A_KEY
```

每个渠道发 3 道题（有题失败就换一道补，最多 6 道），默认同时测 4 个渠道。终端打印对比表，每个渠道的原始回答存到 `out/live/`，不含密钥。`--json` 改成每个渠道输出一行 JSON。

### 4. 给库里没有的模型采参考

库里现在有 GPT 9 个（5.4、5.5、5.6-sol/terra/luna、6-astra/sol/luna、6.1-sol）和 Claude 10 个。要盯库外的模型（例如 gpt-6.1-terra），先从可信的渠道采 36 条参考：

```sh
python3 examples/server-check/drift_check.py enroll \
  --base-url https://可信渠道/v1 --model gpt-6.1-terra --label gpt-6.1-terra \
  --key-env TRUSTED_KEY --family gpt --family-name GPT          # 先看一遍要发多少请求
# 确认后加 --yes 再跑一次
```

采到的数据写进 `out/extra_reference.jsonl`，生成扩展库 `out/bank.json`，之后 `live` 和 `offline` 自动用扩展库。采集源必须可信，采错了整个库都会被带偏。采完先跑一遍 `offline`，看新模型和库里已有的模型能不能分开。新模型如果和已有模型分不开，库的整体校准也会变差。

## 结论怎么读

| 结论 | 意思 | 建议 |
| --- | --- | --- |
| 一致 | 最像声称的模型，或落在声称模型的混淆组里（表里标"混淆组"） | 正常 |
| 疑似掉包 | 明显更像另一个模型：第一名（混淆组按合计）权重至少 0.8，声称模型不到 0.15 | 告警，换个时间复测一次再处理 |
| 说不准 | 两头都不够 | 再测一轮；连续说不准也值得人工看 |
| 库里没有该模型 | 声称的模型不在库里 | 只能看"最像谁"，要判一致与否得先采集 |
| 没测成 | 请求失败或回答不合格 | 看"出错的题" |

退出码：全部一致返回 0，有疑似掉包返回 1，其他情况（说不准、没测成、库里没有）返回 2，方便放进定时任务。

## 服务端接入

最省事的是定时跑 `live --json`，按退出码和 JSON 告警。要嵌进自己的服务，直接调 `check_channel`（把本目录加进 `sys.path`，它会自己找到仓库根目录的评分代码）：

```python
from drift_check import check_channel, default_bank_path, load_groups, load_json

bank_path = default_bank_path()
bank = load_json(bank_path)
groups = load_groups(bank_path, bank, strict=False)
report = check_channel(
    {"name": "中转A", "base_url": "https://relay-a.example.com/v1", "model": "gpt-6.1-sol",
     "expect": "gpt-6.1-sol", "key_env": "RELAY_A_KEY"},
    bank, groups,
)
report["verdict"]   # compatible / difference_signal / inconclusive / unknown_expected_model / failed
```

返回里还有 `prediction`（最像谁）、`expected_weight`（声称模型的权重）、`top`（前三名）、`single_probe_verdicts`（每道题单独的结论）、`outputs`（原始回答）。

- **成本**：每次检测 3 个请求，每个请求让模型写约 300 个数。插件采 gpt-6.1-sol 参考时（max 推理强度）平均每条约 2 千输出 token（含推理）。
- **频率**：渠道掉包常见于高峰期，建议每个渠道每天在不同时段测几次，不要固定整点。
- **题目会被认出来吗**：渠道如果专门识别这类挑数题，可以只给它们放真模型。题面每次随机拼，数量也随机，但不能完全排除这种情况，所以结论只当线索。
- **温度**：请求不带 temperature，和参考数据一样用渠道默认值。渠道强行改温度会影响结果。

## 和插件口径的差别

- **多一条判掉包的规则**：第一名落在一个不含声称模型的混淆组里时，按组内合计权重判掉包。插件判一致时已经按组合计，判掉包时却只看第一名，组内两个模型各分一半就到不了 0.8。结果是声称 gpt-5.6-sol、实际给的是 gpt-6.1-sol 这种明显的掉包，按插件口径 12 组里有 8 组只能判"说不准"（换成 gpt-6-astra 是 7 组）。加上这条后，声称 gpt-5.6 三个和 gpt-6-sol、gpt-6-luna 时，"说不准"从 17% 降到 1%，真货误报仍然是 0。加 `--plugin-rule` 可以完全按插件口径。
- **3 道题合起来判**：插件在对话里每次抽查 1 道题，这里每次检测用 3 道题合起来判。
- **不做跨次累计**：插件里同一渠道连续出现差异会升级成 `repeated_difference`，这里每次检测独立出结论，累计交给服务端自己做。

## 限制

- 只能认出库里的模型；gpt-6.1-sol 和 gpt-6-astra 互换检测不到。
- 只测"换没换模型"。同一个模型被调低推理强度算不算、能不能测出来，没有校准过。gpt-6.1-sol 的参考是 max 强度采的，其他模型的强度没有记录。
- 指纹给的是"最像谁"，不能证明渠道内部到底用了哪个模型，不能当作对外追责的证据。
- 离线模拟用的是参考采集时的 12 种提示环境；live 用的是另一套随机中文题面，真实渠道上的准确率需要拿已知真货的渠道实测确认。
