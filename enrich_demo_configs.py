from __future__ import annotations

import hashlib
import json
import math
import re
import sys
from pathlib import Path

CONDITIONS = ["靓机", "小花", "大花", "外爆", "内爆"]
PREFIX = "window.MARKET_DEMO = "
STORAGE_LADDER = [32, 64, 128, 256, 512, 1024]
RAM_LADDER = [4, 6, 8, 12, 16, 24]


def load_payload(path: Path):
    raw = path.read_text(encoding="utf-8").strip()
    if not raw.startswith(PREFIX) or not raw.endswith(";"):
        raise SystemExit("数据文件格式不符合 window.MARKET_DEMO = {...};")
    return json.loads(raw[len(PREFIX):-1])


def parse_memory(memory: str):
    match = re.fullmatch(r"(?:(\d+)G?\+)?(\d+)(G|T)", str(memory).strip())
    if not match:
        return None, None
    ram = int(match.group(1)) if match.group(1) else None
    storage = int(match.group(2)) * (1024 if match.group(3) == "T" else 1)
    return ram, storage


def format_storage(storage: int) -> str:
    return "1T" if storage >= 1024 else f"{storage}G"


def format_memory(ram: int | None, storage: int) -> str:
    return f"{ram}G+{format_storage(storage)}" if ram else format_storage(storage)


def closest_ladder(ladder, value: int, count: int):
    ordered = sorted(set(ladder + [value]))
    base = ordered.index(value)
    start = max(0, min(len(ordered) - count, base - (count - 1) // 2))
    return ordered[start:start + count]


def candidate_memories(primary: str, config_count: int):
    count = max(1, int(config_count or 1))
    ram, storage = parse_memory(primary)
    if storage is None:
        return [primary]
    if ram is None:
        return [format_memory(None, value) for value in closest_ladder(STORAGE_LADDER, storage, min(count, len(STORAGE_LADDER)))]

    options = []
    for candidate_ram in RAM_LADDER:
        for candidate_storage in STORAGE_LADDER:
            score = abs(math.log2(candidate_storage / storage)) + abs(candidate_ram - ram) / max(ram, 1) * 0.9
            options.append((score, candidate_storage, candidate_ram))
    options.sort()
    selected = []
    used = set()
    for _, candidate_storage, candidate_ram in options:
        memory = format_memory(candidate_ram, candidate_storage)
        if memory in used:
            continue
        used.add(memory)
        selected.append(memory)
        if len(selected) == count:
            break
    primary_formatted = format_memory(ram, storage)
    if primary not in selected:
        selected[-1] = primary
    elif primary_formatted not in selected:
        selected[-1] = primary
    return sorted(set(selected), key=memory_sort_key)


def memory_sort_key(memory: str):
    ram, storage = parse_memory(memory)
    return (storage or 0, ram or 0, memory)


def deterministic_jitter(model_key: str, memory: str, condition: str, day_index: int) -> float:
    digest = hashlib.sha256(f"{model_key}|{memory}|{condition}|{day_index}".encode("utf-8")).hexdigest()
    bucket = int(digest[:8], 16) % 2001 - 1000
    return bucket / 100000


def config_factor(primary: str, memory: str) -> float:
    primary_ram, primary_storage = parse_memory(primary)
    ram, storage = parse_memory(memory)
    if primary_storage is None or storage is None:
        return 1.0
    storage_factor = (storage / primary_storage) ** 0.24
    ram_factor = (ram / primary_ram) ** 0.08 if primary_ram and ram else 1.0
    return max(0.62, min(1.4, storage_factor * ram_factor))


def enrich_model(model):
    primary = model.get("mainMemory") or next(iter(model.get("conditions", {})), "")
    memories = candidate_memories(primary, model.get("configCount", 1))
    if not memories:
        memories = [primary]
    configs = {}
    for memory in sorted(memories, key=memory_sort_key):
        if memory == primary:
            configs[memory] = {condition: list(model["conditions"].get(condition, [])) for condition in CONDITIONS}
            continue
        factor = config_factor(primary, memory)
        memory_config = {}
        for condition in CONDITIONS:
            history = model["conditions"].get(condition, [])
            memory_config[condition] = [
                max(1, round(value * factor * (1 + deterministic_jitter(model["id"], memory, condition, index))))
                if value is not None else None
                for index, value in enumerate(history)
            ]
        configs[memory] = memory_config
    if primary not in configs:
        configs[primary] = {condition: list(model["conditions"].get(condition, [])) for condition in CONDITIONS}
    model["configs"] = configs


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("assets/data.js")
    force = "--force" in sys.argv[2:]
    payload = load_payload(path)
    if not payload.get("meta", {}).get("publicDemo"):
        raise SystemExit("仅为公网脱敏演示数据补配置；真实数据请使用 generate_data.py 生成真实多内存配置。")
    if payload.get("meta", {}).get("configDataMode") == "synthetic-demo" and not force:
        print("当前数据已包含演示配置矩阵，无需重复处理。")
        return
    for model in payload["models"]:
        enrich_model(model)
    payload["meta"]["configDataMode"] = "synthetic-demo"
    payload["meta"]["configNote"] = "当前演示按主配置行情扩展内存阶梯，用于评审报价交互；接入真实多内存报价后将自动替换。"
    payload["meta"]["targetModels"] = 1000
    path.write_text(PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    configs = sum(len(model.get("configs", {})) for model in payload["models"])
    synthetic = sum(1 for model in payload["models"] if len(model.get("configs", {})) > 1)
    print(f"已补全演示配置矩阵：机型 {len(payload['models'])}；配置 {configs}；多配置机型 {synthetic}；文件 {path}")


if __name__ == "__main__":
    main()
