from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

CONDITIONS = ["靓机", "小花", "大花", "外爆", "内爆"]
PREFIX = "window.MARKET_DEMO = "


def model_factor(model_id: str) -> float:
    digest = hashlib.sha256(model_id.encode("utf-8")).hexdigest()
    bucket = int(digest[:8], 16) % 1000
    if bucket < 500:
        return 0.72 + (bucket / 500) * 0.20
    return 1.08 + ((bucket - 500) / 500) * 0.20


def load_payload(path: Path):
    raw = path.read_text(encoding="utf-8").strip()
    if not raw.startswith(PREFIX) or not raw.endswith(";"):
        raise SystemExit("数据文件格式不符合 window.MARKET_DEMO = {...};")
    return json.loads(raw[len(PREFIX):-1])


def transform_payload(payload):
    if payload.get("meta", {}).get("publicDemo"):
        raise SystemExit("该文件已经是公网脱敏数据，请勿重复处理。")
    models = payload["models"]
    counters = {}
    for index, model in enumerate(sorted(models, key=lambda item: (item["brand"], item["model"], str(item["modelId"]))), start=1):
        short = model.get("brandShort", "MO")
        counters[short] = counters.get(short, 0) + 1
        public_id = f"{short}-{counters[short]:04d}"
        model["id"] = f"model-{public_id.lower()}"
        model["modelId"] = public_id

    for model in models:
        factor = model_factor(str(model["modelId"]) + model["model"])
        rounded = {}
        for condition in CONDITIONS:
            history = model["conditions"].get(condition, [])
            rounded[condition] = [
                max(1, round(value * factor)) if value is not None else None
                for value in history
            ]
        model["conditions"] = rounded
        if model.get("configs"):
            model["configs"] = {
                memory: {
                    condition: [
                        max(1, round(value * factor)) if value is not None else None
                        for value in history
                    ]
                    for condition, history in conditions.items()
                }
                for memory, conditions in model["configs"].items()
            }
        primary = model.get("primaryCondition", "靓机")
        latest = next((value for value in reversed(rounded.get(primary, [])) if value is not None), 0)
        previous = next((value for value in reversed(rounded.get(primary, [])[:-1]) if value is not None), 0)
        earliest = next((value for value in rounded.get(primary, []) if value is not None), 0)
        model["latestPrice"] = latest
        model["prevPrice"] = previous or None
        model["earliestPrice"] = earliest or None

    payload["top100Ids"] = [model["id"] for model in models if model.get("inTop100")]
    payload["meta"]["source"] = "脱敏演示报价"
    payload["meta"]["demo"] = True
    payload["meta"]["note"] = "基于真实 7 日报价结构脱敏生成；价格绝对值已做不可逆比例变换，保留日涨跌结构与异常隔离逻辑，仅用于 UI 评审。"
    payload["meta"]["publicDemo"] = True
    payload["meta"].setdefault("targetModels", 1000)
    payload["meta"].setdefault("configDataMode", "actual")
    payload["meta"].setdefault("configNote", "机型详情按真实内存配置展示 7 日行情与成色矩阵。")
    return payload


def main():
    if len(sys.argv) not in (2, 3):
        raise SystemExit("用法: python3 prepare_public_data.py <data.js> [public-data.js]")
    source = Path(sys.argv[1])
    target = Path(sys.argv[2]) if len(sys.argv) == 3 else source
    payload = transform_payload(load_payload(source))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"已生成公网脱敏数据 {target}")
    print(f"机型 {payload['meta']['totalModels']}；TOP100 {payload['meta']['top100']}；演示模式 {payload['meta']['demo']}")


if __name__ == "__main__":
    main()
