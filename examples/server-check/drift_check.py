#!/usr/bin/env python3
"""渠道降智 / 掉包检测示例，给服务端接入参考。

原理和插件相同：让模型"直接挑出约 300 个 1 到 355 的整数"。不同模型挑数的分布有稳定差异，
拿结果和指纹库比对，看最像哪个模型，再和渠道声称的模型对照。指纹库、评分算法和判定口径都直接复用
仓库里已有的实现，本脚本不改动它们。

  offline  用仓库里已有的参考数据按题留出做模拟，不发请求、不花钱
  live     给一个或多个渠道各发 3 道题，判断背后的模型和声称的是否一致
  enroll   给库里没有的模型（例如 gpt-6.1-terra）采 36 条参考，生成扩展指纹库

只依赖 numpy。密钥只从环境变量读，不进命令行参数、不写进输出文件。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO))

from bank_builder import build_bank, fit_robust_artifacts, read_rows  # noqa: E402
from challenge_suite import fingerprint_suite  # noqa: E402
from enrollment import append_rows, make_row, request_completion  # noqa: E402
from fingerprint import (  # noqa: E402
    analyze_global_outputs,
    generate_challenges,
    parse_numbers,
    robust_score_numbers,
    softmax,
)

BUILTIN_BANK = REPO / "data" / "unified_bank.json"
BUILTIN_REFERENCES = (
    ("gpt", "GPT", REPO / "data" / "gpt_reference.jsonl"),
    ("claude", "Claude", REPO / "data" / "claude_reference.jsonl"),
)
GROUPS_FILE = REPO / "codex-plugin" / "modeltrace-guard" / "assets" / "confusable-groups.json"
OUT = HERE / "out"
EXTRA_REFERENCES = OUT / "extra_reference.jsonl"
EXTENDED_BANK = OUT / "bank.json"

# 服务端关心的 GPT 5.6 到 6.1 这一段；采集过的新模型会自动加进来。
FOCUS_MODELS = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-6.1-sol",
]
PROBES = 3
MAX_PROBES = 6

VERDICTS = {
    "compatible": "一致",
    "difference_signal": "疑似掉包",
    "inconclusive": "说不准",
    "unknown_expected_model": "库里没有该模型",
    "failed": "没测成",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def default_bank_path() -> Path:
    return EXTENDED_BANK if EXTENDED_BANK.exists() else BUILTIN_BANK


def load_groups(bank_path: Path, bank: dict, strict: bool) -> list[dict]:
    """插件登记的混淆组（gpt-6.1-sol 与 gpt-6-astra）。

    混淆组只对验证过的那份库有效：库是内置库，或是在内置库上只加了新模型的扩展库。
    """
    if strict or not GROUPS_FILE.exists():
        return []
    data = load_json(GROUPS_FILE)
    base = bank.get("extension", {}).get("base_bank_sha256") or sha256(bank_path)
    if base != data["bankSha256"]:
        return []
    model_ids = {model["id"] for model in bank["models"]}
    return [group for group in data["groups"] if set(group["models"]) <= model_ids]


def group_weight(results: list[dict], group: dict | None) -> float:
    return sum(item["probability"] for item in results if group and item["model"] in group["models"])


def classify(results: list[dict], expected: str, groups: list[dict], plugin_rule: bool = False) -> dict:
    """判定口径照搬插件 scripts/state.mjs 的 classifySample，去掉跨次累计的 repeated_difference。

    只多一条（plugin_rule=True 时关掉）：第一名落在一个不含声称模型的混淆组里时，按组内合计权重判掉包。
    插件判一致时已经按组合计；判掉包时却只看第一名，组内两个模型各分一半就永远到不了 0.8，
    真被换成了 gpt-6.1-sol / gpt-6-astra 也只能判"说不准"。
    """
    top = results[0]
    candidate = next((item for item in results if item["model"] == expected), None)
    group_hit = None
    if candidate is None:
        outcome = "unknown_expected_model"
    elif top["model"] == expected and top["probability"] >= 0.5:
        outcome = "compatible"
    else:
        outcome = "inconclusive"
        group = next(
            (item for item in groups if expected in item["models"] and top["model"] in item["models"]),
            None,
        )
        lead = top["probability"]
        if not plugin_rule:
            top_group = next(
                (item for item in groups if top["model"] in item["models"] and expected not in item["models"]),
                None,
            )
            lead = group_weight(results, top_group) if top_group else lead
        if group and group_weight(results, group) >= group["minimumGroupWeight"]:
            outcome = "compatible"
            group_hit = group["id"]
        elif (
            top["model"] != expected
            and lead >= 0.8
            and candidate["probability"] <= 0.15
            and lead - candidate["probability"] >= 0.65
        ):
            outcome = "difference_signal"
    return {
        "outcome": outcome,
        "prediction": top["model"],
        "top_weight": top["probability"],
        "expected_weight": candidate["probability"] if candidate else None,
        "confusable_group": group_hit,
    }


def reference_rows(extra: Path | None) -> list[dict]:
    rows = []
    for family, label, path in BUILTIN_REFERENCES:
        rows += [{**row, "family_id": family, "family_name": label} for row in read_rows(path)]
    if extra and extra.exists():
        for row in read_rows(extra):
            family = row.get("family_id") or row["source"].split("-")[0]
            rows.append({**row, "family_id": family, "family_name": row.get("family_name") or family})
    return rows


# ---------------------------------------------------------------- offline


def closed_set(rows: list[dict], robust: dict, model_ids: list[str], beta: float) -> list[dict]:
    """与 fingerprint.analyze_outputs 相同的打分，只是换成按折重训的库。"""
    bank = {"robust": robust}
    scores = [robust_score_numbers(row["numbers"], bank)["fused"] for row in rows]
    combined = [sum(score[index] for score in scores) / len(scores) for index in range(len(model_ids))]
    probabilities = softmax([beta * value for value in combined])
    results = [{"model": model, "probability": p} for model, p in zip(model_ids, probabilities)]
    return sorted(results, key=lambda item: item["probability"], reverse=True)


def run_offline(
    rows: list[dict],
    focus: list[str],
    actuals: list[str],
    outsiders: list[str],
    betas: dict,
    groups: list[dict],
    plugin_rule: bool,
) -> dict:
    model_ids = list(dict.fromkeys(row["source"] for row in rows))
    conditions = sorted({row["condition_id"] for row in rows})
    inside = {1: defaultdict(Counter), 3: defaultdict(Counter)}
    misses = {1: defaultdict(Counter), 3: defaultdict(Counter)}

    # 库内换模型：每次留出一种环境的 3 道题，用其余 33 道题重训，再拿留出的回答去冒充。
    for condition in conditions:
        held = {row["challenge_id"] for row in rows if row["condition_id"] == condition}
        robust = fit_robust_artifacts([row for row in rows if row["challenge_id"] not in held], model_ids)
        for actual in actuals:
            answers = [row for row in rows if row["source"] == actual and row["challenge_id"] in held]
            probe_sets = {1: [[answer] for answer in answers], 3: [answers] if len(answers) == PROBES else []}
            for k, sets in probe_sets.items():
                for probe_set in sets:
                    results = closed_set(probe_set, robust, model_ids, betas[k])
                    for claimed in focus:
                        verdict = classify(results, claimed, groups, plugin_rule)
                        inside[k][(actual, claimed)][verdict["outcome"]] += 1
                        if actual != claimed and verdict["outcome"] == "compatible":
                            misses[k][claimed][actual] += 1

    # 库外模型冒充：整个模型从库里拿掉，模拟渠道换成了库里没有的模型。
    outside = defaultdict(Counter)
    outside_misses = defaultdict(Counter)
    for outsider in outsiders:
        ids = [model for model in model_ids if model != outsider]
        robust = fit_robust_artifacts([row for row in rows if row["source"] != outsider], ids)
        for condition in conditions:
            answers = [row for row in rows if row["source"] == outsider and row["condition_id"] == condition]
            if len(answers) != PROBES:
                continue
            results = closed_set(answers, robust, ids, betas[3])
            for claimed in focus:
                verdict = classify(results, claimed, groups, plugin_rule)
                outside[(outsider, claimed)][verdict["outcome"]] += 1
                if verdict["outcome"] == "compatible":
                    outside_misses[claimed][outsider] += 1

    return {"inside": inside, "misses": misses, "outside": outside, "outside_misses": outside_misses}


def pct(part: int, total: int) -> str:
    return f"{part}/{total}（{part / total:.0%}）" if total else "-"


def offline_report(
    result: dict,
    focus: list[str],
    actuals: list[str],
    outsiders: list[str],
    groups: list[dict],
    plugin_rule: bool,
) -> str:
    if not groups:
        rule = "未启用混淆组。"
    elif plugin_rule:
        rule = "`gpt-6.1-sol` 与 `gpt-6-astra` 按插件登记的混淆组算一致，判掉包仍只看第一名（与插件完全相同）。"
    else:
        rule = (
            "`gpt-6.1-sol` 与 `gpt-6-astra` 按插件登记的混淆组算一致；"
            "比插件多一条：第一名落在混淆组里时，按组内合计权重判掉包。"
        )
    lines = ["# 降智 / 掉包检测离线对比", ""]
    lines.append(
        f"生成于 {now_iso()}。按题留出：每次拿掉一种环境的 3 道题重训指纹库，再用这 3 道题的回答冒充别的模型，"
        f"训练集里从没见过被测的回答。实际给的模型取库里的 {'、'.join(actuals)}。判定口径：{rule}"
    )
    lines.append("")

    def summary(k: int) -> list[str]:
        table = [
            "| 渠道声称 | 真货判一致 | 换成其他模型：抓到 | 说不准 | 漏判（判成一致） | 漏判的是谁 |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for claimed in focus:
            genuine = result["inside"][k][(claimed, claimed)]
            fake = Counter()
            for actual in actuals:
                if actual != claimed:
                    fake.update(result["inside"][k][(actual, claimed)])
            total = sum(fake.values())
            missed = result["misses"][k][claimed]
            who = "、".join(f"{model}×{count}" for model, count in missed.most_common()) or "无"
            table.append(
                f"| {claimed} | {pct(genuine['compatible'], sum(genuine.values()))} "
                f"| {pct(fake['difference_signal'], total)} | {pct(fake['inconclusive'], total)} "
                f"| {pct(fake['compatible'], total)} | {who} |"
            )
        return table

    lines += ["## 3 道题一起判（live 的默认做法）", ""] + summary(3) + [""]
    lines += ["## 只用 1 道题判（插件后台抽查的做法）", ""] + summary(1) + [""]

    if outsiders:
        lines += [
            "## 换成库里没有的模型",
            "",
            "把一个模型整个从库里拿掉，再用它的回答冒充下面的模型，每个模型 12 组、每组 3 道题。"
            f"参与冒充的库外模型：{'、'.join(outsiders)}。",
            "",
            "| 渠道声称 | 抓到 | 说不准 | 漏判（判成一致） | 漏判的是谁 |",
            "| --- | --- | --- | --- | --- |",
        ]
        for claimed in focus:
            tally = Counter()
            for outsider in outsiders:
                tally.update(result["outside"][(outsider, claimed)])
            total = sum(tally.values())
            missed = result["outside_misses"][claimed]
            who = "、".join(f"{model}×{count}" for model, count in missed.most_common()) or "无"
            lines.append(
                f"| {claimed} | {pct(tally['difference_signal'], total)} | {pct(tally['inconclusive'], total)} "
                f"| {pct(tally['compatible'], total)} | {who} |"
            )
        lines.append("")

    lines += [
        "## 明细：实际给的模型 × 渠道声称（3 道题，共 12 组）",
        "",
        "对角线是真货判一致的组数；其余格子是 `抓到/说不准/漏判`。",
        "",
        "| 实际 \\ 声称 | " + " | ".join(focus) + " |",
        "| --- |" + " --- |" * len(focus),
    ]
    for actual in actuals:
        cells = []
        for claimed in focus:
            tally = result["inside"][3][(actual, claimed)]
            if actual == claimed:
                cells.append(f"**{tally['compatible']}**")
            else:
                cells.append(f"{tally['difference_signal']}/{tally['inconclusive']}/{tally['compatible']}")
        lines.append(f"| {actual} | " + " | ".join(cells) + " |")
    lines.append("")
    return "\n".join(lines)


def cmd_offline(args: argparse.Namespace) -> int:
    rows = reference_rows(args.extra)
    builtin = {row["source"] for row in reference_rows(None)}
    model_ids = list(dict.fromkeys(row["source"] for row in rows))
    extra_models = [model for model in model_ids if model not in builtin]
    focus = args.models or FOCUS_MODELS + extra_models
    # 降智常见的是拿老模型冒充新模型，所以库里的 GPT 都算作可能被换上来的模型。
    actuals = args.actuals or list(
        dict.fromkeys(focus + [row["source"] for row in rows if row["family_id"] == "gpt"])
    )
    unknown = [model for model in focus + actuals if model not in model_ids]
    if unknown:
        print(f"库里没有这些模型：{'、'.join(unknown)}", file=sys.stderr)
        return 2
    outsiders = [] if args.no_outsiders else (args.outsiders or [m for m in model_ids if m not in focus])

    bank_path = EXTENDED_BANK if extra_models and EXTENDED_BANK.exists() else BUILTIN_BANK
    bank = load_json(bank_path)
    betas = {k: float(bank["calibration"][str(k)]["beta"]) for k in (1, 3)}
    groups = load_groups(bank_path, bank, args.strict)

    started = time.monotonic()
    result = run_offline(rows, focus, actuals, outsiders, betas, groups, args.plugin_rule)
    report = offline_report(result, focus, actuals, outsiders, groups, args.plugin_rule)
    OUT.mkdir(exist_ok=True)
    name = "offline-report-plugin-rule" if args.plugin_rule else "offline-report"
    (OUT / f"{name}.md").write_text(report, encoding="utf-8")
    raw = {
        "generated_at": now_iso(),
        "bank": str(bank_path.relative_to(REPO)),
        "focus": focus,
        "actuals": actuals,
        "outsiders": outsiders,
        "confusable_groups": [group["id"] for group in groups],
        "plugin_rule": args.plugin_rule,
        "inside": {
            str(k): [
                {"actual": actual, "claimed": claimed, **counts}
                for (actual, claimed), counts in table.items()
            ]
            for k, table in result["inside"].items()
        },
        "outside": [
            {"outsider": outsider, "claimed": claimed, **counts}
            for (outsider, claimed), counts in result["outside"].items()
        ],
    }
    (OUT / f"{name}.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(report)
    print(f"用时 {time.monotonic() - started:.1f} 秒，报告已写到 {OUT / f'{name}.md'}", file=sys.stderr)
    return 0


# ---------------------------------------------------------------- live


def load_channels(args: argparse.Namespace) -> list[dict]:
    if args.channels:
        data = load_json(Path(args.channels))
        channels = data["channels"] if isinstance(data, dict) else data
    else:
        if not (args.base_url and args.model and args.key_env):
            raise SystemExit("单个渠道要给 --base-url、--model 和 --key-env；多个渠道用 --channels")
        channels = [
            {
                "name": args.name,
                "base_url": args.base_url,
                "model": args.model,
                "expect": args.expect,
                "key_env": args.key_env,
                "format": args.format,
            }
        ]
    for channel in channels:
        missing = [key for key in ("base_url", "model", "key_env") if not channel.get(key)]
        if missing:
            raise SystemExit(f"渠道 {channel.get('name') or channel} 缺少 {'、'.join(missing)}")
        channel["name"] = channel.get("name") or channel["model"]
        channel["expect"] = channel.get("expect") or channel["model"]
    return channels


def probe(channel: dict, api_key: str, challenge: dict) -> dict:
    text = request_completion(
        base_url=channel["base_url"],
        api_key=api_key,
        api_model=channel["model"],
        prompt=challenge["prompt"],
        temperature=channel.get("temperature"),
        api_format=channel.get("format") or "openai",
    )
    parsed = len(parse_numbers(text))
    minimum = max(80, math.ceil(challenge["expected_count"] * 0.55))
    if parsed < minimum:
        raise RuntimeError(f"有效数字不足：{parsed}/{minimum}")
    return {"text": text, "expected_count": challenge["expected_count"], "parsed_numbers": parsed}


def check_channel(channel: dict, bank: dict, groups: list[dict], plugin_rule: bool = False) -> dict:
    """给一个渠道发 3 道题并判定。服务端接入时直接调这个函数即可。"""
    report = {
        "name": channel["name"],
        "host": urlparse(channel["base_url"]).hostname,
        "model": channel["model"],
        "expect": channel["expect"],
        "checked_at": now_iso(),
    }
    api_key = os.environ.get(channel["key_env"], "")
    if not api_key:
        return {**report, "verdict": "failed", "errors": [f"环境变量 {channel['key_env']} 没有设置"]}

    started = time.monotonic()
    pending = generate_challenges(MAX_PROBES)
    outputs, errors = [], []
    while len(outputs) < PROBES and pending:
        batch = [pending.pop(0) for _ in range(min(PROBES - len(outputs), len(pending)))]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = [pool.submit(probe, channel, api_key, challenge) for challenge in batch]
            for future in futures:
                try:
                    outputs.append(future.result())
                except Exception as error:  # noqa: BLE001 - 单题失败只记下来，换下一题
                    errors.append(str(error))
    report.update({"probes": len(outputs), "errors": errors, "seconds": round(time.monotonic() - started, 1)})
    if not outputs:
        return {**report, "verdict": "failed"}

    analysis = analyze_global_outputs(outputs, bank)
    verdict = classify(analysis["results"], channel["expect"], groups, plugin_rule)
    singles = [
        classify(analyze_global_outputs([output], bank)["results"], channel["expect"], groups, plugin_rule)["outcome"]
        for output in outputs
    ]
    return {
        **report,
        "verdict": verdict["outcome"],
        "prediction": verdict["prediction"],
        "top_weight": round(verdict["top_weight"], 4),
        "expected_weight": None if verdict["expected_weight"] is None else round(verdict["expected_weight"], 4),
        "confusable_group": verdict["confusable_group"],
        "family": analysis["family_prediction_name"],
        "top": [
            {"model": item["model"], "probability": round(item["probability"], 4)}
            for item in analysis["results"][:3]
        ],
        "single_probe_verdicts": singles,
        "outputs": outputs,
    }


def slug(text: str) -> str:
    return re.sub(r"[^\w.-]+", "-", text).strip("-")[:48] or "channel"


def live_table(reports: list[dict]) -> str:
    lines = [
        "| 渠道 | 声称 | 结论 | 最像 | 声称模型的权重 | 单题结论 | 有效题数 | 用时 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for item in reports:
        verdict = VERDICTS[item["verdict"]]
        if item.get("confusable_group"):
            verdict += "（混淆组）"
        prediction = f"{item['prediction']}（{item['top_weight']:.2f}）" if item.get("prediction") else "-"
        expected = "-" if item.get("expected_weight") is None else f"{item['expected_weight']:.2f}"
        singles = " / ".join(VERDICTS[outcome] for outcome in item.get("single_probe_verdicts", [])) or "-"
        lines.append(
            f"| {item['name']} | {item['expect']} | {verdict} | {prediction} | {expected} | {singles} "
            f"| {item.get('probes', 0)}/{PROBES} | {item.get('seconds', '-')} 秒 |"
        )
    errors = [(item["name"], error) for item in reports for error in item.get("errors", [])]
    if errors:
        lines += ["", "出错的题："] + [f"- {name}：{error}" for name, error in errors]
    return "\n".join(lines)


def cmd_live(args: argparse.Namespace) -> int:
    bank_path = Path(args.bank) if args.bank else default_bank_path()
    bank = load_json(bank_path)
    groups = load_groups(bank_path, bank, args.strict)
    channels = load_channels(args)
    known = {model["id"] for model in bank["models"]}
    print(f"指纹库：{bank_path}（{len(known)} 个模型）", file=sys.stderr)
    for channel in channels:
        if channel["expect"] not in known:
            print(f"注意：库里没有 {channel['expect']}，{channel['name']} 只能看最像谁，给不出一致与否", file=sys.stderr)

    reports: list[dict | None] = [None] * len(channels)
    with ThreadPoolExecutor(max_workers=max(1, args.parallel)) as pool:
        futures = {pool.submit(check_channel, channel, bank, groups, args.plugin_rule): index for index, channel in enumerate(channels)}
        for future in as_completed(futures):
            index = futures[future]
            reports[index] = future.result()
            print(f"{channels[index]['name']}：{VERDICTS[reports[index]['verdict']]}", file=sys.stderr)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    folder = OUT / "live"
    folder.mkdir(parents=True, exist_ok=True)
    for index, item in enumerate(reports, start=1):
        (folder / f"{stamp}-{index:02d}-{slug(item['name'])}.json").write_text(
            json.dumps(item, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    if args.json:
        for item in reports:
            print(json.dumps({key: value for key, value in item.items() if key != "outputs"}, ensure_ascii=False))
    else:
        print(live_table(reports))
    print(f"原始回答已存到 {folder}", file=sys.stderr)

    verdicts = {item["verdict"] for item in reports}
    if "difference_signal" in verdicts:
        return 1
    return 0 if verdicts == {"compatible"} else 2


# ---------------------------------------------------------------- enroll


def rebuild_extended_bank() -> dict:
    rows = reference_rows(EXTRA_REFERENCES)
    builtin_bank = load_json(BUILTIN_BANK)
    bank = build_bank(rows, builtin_bank["calibration"])
    builtin_models = {model["id"] for model in builtin_bank["models"]}
    bank["extension"] = {
        "base_bank_sha256": sha256(BUILTIN_BANK),
        "extra_models": [model["id"] for model in bank["models"] if model["id"] not in builtin_models],
        "extra_references": str(EXTRA_REFERENCES.relative_to(REPO)),
    }
    EXTENDED_BANK.write_text(json.dumps(bank, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return bank


def cmd_enroll(args: argparse.Namespace) -> int:
    suite = fingerprint_suite()
    if not 3 <= args.samples <= len(suite):
        raise SystemExit(f"--samples 要在 3 到 {len(suite)} 之间")
    selected = [suite[int(index * len(suite) / args.samples)] for index in range(args.samples)]
    print(
        f"将向 {urlparse(args.base_url).hostname} 的 {args.model} 发 {len(selected)} 道题（每题失败最多再试 1 次），"
        f"结果记为「{args.label}」，写到 {EXTRA_REFERENCES}，再生成扩展库 {EXTENDED_BANK}。",
        file=sys.stderr,
    )
    if not args.yes:
        print("确认要采集就加 --yes 再跑一次。", file=sys.stderr)
        return 0
    api_key = os.environ.get(args.key_env, "")
    if not api_key:
        raise SystemExit(f"环境变量 {args.key_env} 没有设置")

    family = args.family or args.label.split("-")[0]
    channel = {"base_url": args.base_url, "model": args.model, "format": args.format, "temperature": None}

    def collect(task: dict) -> tuple[dict | None, list[str]]:
        prompt = task["prompt"]
        if task["user_prefix"]:
            prompt = task["user_prefix"] + "\n\nFinal task:\n" + prompt
        task_errors = []
        for _ in range(2):
            try:
                text = request_completion(
                    channel["base_url"], api_key, channel["model"], prompt, None, channel["format"], task["system"]
                )
            except Exception as error:  # noqa: BLE001
                task_errors.append(f"{task['challenge_id']}：{error}")
                continue
            row = make_row(
                model_label=args.label,
                text=text,
                condition=task["condition"],
                challenge_id=task["challenge_id"],
                expected_count=task["expected_count"],
                temperature="provider_default",
                bank_id="server-check",
                wrapper_transport=task["transport"],
                provider="api",
                prompt=prompt,
                base_prompt=task["prompt"],
                system_prompt=task["system"],
                user_prefix=task["user_prefix"],
            )
            if row["strict_valid"]:
                row.update(
                    family_id=family,
                    family_name=args.family_name or family,
                    api_model=args.model,
                    api_host=urlparse(args.base_url).hostname,
                    config_id="server-check-enroll",
                )
                return row, task_errors
            task_errors.append(f"{task['challenge_id']} 有效数字不足：{row['parsed_count']}/{row['strict_threshold']}")
        return None, task_errors

    rows, errors = [], []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [pool.submit(collect, task) for task in selected]
        for done, future in enumerate(as_completed(futures), start=1):
            row, task_errors = future.result()
            errors += task_errors
            if row is not None:
                rows.append(row)
            print(f"\r已完成 {done}/{len(selected)}，有效 {len(rows)}", end="", file=sys.stderr)
    print(file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    if not rows:
        print("一条有效回答都没拿到，没有改动指纹库。", file=sys.stderr)
        return 2

    OUT.mkdir(exist_ok=True)
    rows.sort(key=lambda row: row["challenge_id"])
    append_rows(rows, EXTRA_REFERENCES)
    print("正在重建扩展库（含交叉验证，约 1 到 2 分钟）……", file=sys.stderr)
    bank = rebuild_extended_bank()
    calibration = bank["calibration"]
    print(
        f"已收录 {args.label} {len(rows)}/{len(selected)} 条。扩展库共 {len(bank['models'])} 个模型，"
        f"交叉验证准确率：单题 {calibration['1']['cv_accuracy']:.1%}，3 题 {calibration['3']['cv_accuracy']:.1%}。"
    )
    print("之后 live 和 offline 会自动用扩展库。", file=sys.stderr)
    return 0


# ---------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description="渠道降智 / 掉包检测示例")
    sub = parser.add_subparsers(dest="command", required=True)

    offline = sub.add_parser("offline", help="用已有参考数据做留出模拟，不发请求")
    offline.add_argument("--models", nargs="+", help="要对比的模型，默认 GPT 5.6 到 6.1 加上采集过的新模型")
    offline.add_argument("--actuals", nargs="+", help="可能被换上来的库内模型，默认是对比范围加上库里全部 GPT")
    offline.add_argument("--outsiders", nargs="+", help="模拟库外冒充用的模型，默认是对比范围以外的全部模型")
    offline.add_argument("--no-outsiders", action="store_true", help="不跑库外冒充")
    offline.add_argument("--extra", type=Path, default=EXTRA_REFERENCES, help="采集过的新模型参考数据")
    offline.add_argument("--strict", action="store_true", help="不用混淆组")
    offline.add_argument("--plugin-rule", action="store_true", help="判掉包完全按插件口径，不按混淆组合计")
    offline.set_defaults(func=cmd_offline)

    live = sub.add_parser("live", help="给真实渠道发题并判定")
    live.add_argument("--channels", help="渠道清单 JSON，格式见 channels.example.json")
    live.add_argument("--name")
    live.add_argument("--base-url")
    live.add_argument("--model", help="请求时填的模型名")
    live.add_argument("--expect", help="指纹库里对应的模型，默认同 --model")
    live.add_argument("--key-env", help="存放密钥的环境变量名")
    live.add_argument("--format", default="openai", choices=["openai", "anthropic", "auto"])
    live.add_argument("--bank", help="指纹库，默认有扩展库就用扩展库")
    live.add_argument("--parallel", type=int, default=4, help="同时测几个渠道")
    live.add_argument("--strict", action="store_true", help="不用混淆组")
    live.add_argument("--plugin-rule", action="store_true", help="判掉包完全按插件口径，不按混淆组合计")
    live.add_argument("--json", action="store_true", help="每个渠道输出一行 JSON")
    live.set_defaults(func=cmd_live)

    enroll = sub.add_parser("enroll", help="给库里没有的模型采参考")
    enroll.add_argument("--base-url", required=True)
    enroll.add_argument("--model", required=True, help="请求时填的模型名")
    enroll.add_argument("--label", required=True, help="在库里的名字，例如 gpt-6.1-terra")
    enroll.add_argument("--key-env", required=True)
    enroll.add_argument("--format", default="openai", choices=["openai", "anthropic", "auto"])
    enroll.add_argument("--samples", type=int, default=36)
    enroll.add_argument("--workers", type=int, default=2)
    enroll.add_argument("--family", help="模型家族 id，默认取 label 第一个 - 之前的部分")
    enroll.add_argument("--family-name", help="家族显示名，例如 GPT")
    enroll.add_argument("--yes", action="store_true", help="确认发请求")
    enroll.set_defaults(func=cmd_enroll)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
