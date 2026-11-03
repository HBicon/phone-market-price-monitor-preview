from __future__ import annotations

import json
import math
import random
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

from openpyxl import load_workbook


CONDITIONS = ["靓机", "小花", "大花", "外爆", "内爆"]
CONDITION_COLORS = {
    "靓机": "#171A17",
    "小花": "#E85D3F",
    "大花": "#C7962E",
    "外爆": "#5D7772",
    "内爆": "#53658A",
}
BRAND_SHORT = {
    "苹果": "AP",
    "华为": "HW",
    "小米": "MI",
    "OPPO": "OP",
    "vivo": "VI",
    "荣耀": "HO",
    "三星": "SS",
    "一加": "ON",
}


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def round_price(value: float) -> int:
    if value >= 1000:
        return int(round(value / 10) * 10)
    return int(round(value))


def build_series(
    seed: int,
    current_index: float,
    last_change: float,
    volatility: float = 0.28,
) -> list[float]:
    rng = random.Random(seed)
    previous_index = current_index / (1 + last_change / 100)
    target_log_return = math.log(previous_index / 100)
    raw_walk = [0.0]
    for _ in range(29):
        raw_walk.append(raw_walk[-1] + rng.gauss(0, volatility / 100))
    bridge = [
        raw_walk[index] - (index / 29) * raw_walk[29]
        + (index / 29) * target_log_return
        for index in range(30)
    ]
    values = [100 * math.exp(value) for value in bridge]
    values.append(current_index)
    return [round(value, 2) for value in values]


def build_price_history(seed: int, current_price: float, change_1d: float) -> list[int]:
    rng = random.Random(seed)
    changes = [rng.gauss(0, 0.55) for _ in range(29)]
    changes.append(change_1d)
    prices = [float(current_price)]
    for change in reversed(changes):
        prices.append(prices[-1] / (1 + change / 100))
    return [round_price(v) for v in reversed(prices)]


def pct(current: float, previous: float | None) -> float | None:
    if previous in (None, 0) or current in (None, 0):
        return None
    return round((current / previous - 1) * 100, 2)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("用法: python generate_data.py <报价单.xlsx> <data.js>")

    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    workbook = load_workbook(source, read_only=True, data_only=True)
    sheet = workbook.active

    raw_rows = []
    models = set()
    model_brand = {}
    brand_models = defaultdict(set)
    valid_by_brand = Counter()
    valid_by_condition = Counter()
    zero_quotes = 0

    for row in sheet.iter_rows(min_row=2, values_only=True):
        model_id, model_name, brand, memory, condition, raw_price = (
            row[2],
            row[3],
            row[4],
            row[6],
            row[7],
            row[8],
        )
        if not model_id or condition not in CONDITIONS:
            continue
        price = float(raw_price or 0)
        models.add(model_id)
        model_brand[model_id] = (model_name, brand)
        brand_models[brand].add(model_id)
        if price <= 0:
            zero_quotes += 1
            continue
        valid_by_brand[brand] += 1
        valid_by_condition[condition] += 1
        raw_rows.append((model_id, model_name, brand, memory, condition, price))

    groups = defaultdict(dict)
    for model_id, model_name, brand, memory, condition, price in raw_rows:
        groups[(model_id, model_name, brand, memory)][condition] = price

    sample_groups = []
    for brand in BRAND_SHORT:
        candidates = [
            (key, values)
            for key, values in groups.items()
            if key[2] == brand and sum(v > 0 for v in values.values()) >= 2
        ]
        candidates.sort(key=lambda item: max(item[1].values()), reverse=True)
        sample_groups.extend(candidates[:34])

    rng = random.Random(20261102)
    movers = []
    for index, ((model_id, model_name, brand, memory), raw_conditions) in enumerate(sample_groups):
        condition_map = {}
        for condition in CONDITIONS:
            raw_price = raw_conditions.get(condition, 0)
            if raw_price <= 0:
                condition_map[condition] = None
                continue
            jitter = 0.965 + rng.random() * 0.055
            condition_map[condition] = round_price(raw_price * jitter)

        valid_conditions = [c for c in CONDITIONS if condition_map[c]]
        desired_cycle = ["靓机", "靓机", "小花", "靓机", "大花", "靓机", "外爆", "靓机", "内爆", "小花"]
        desired = desired_cycle[index % len(desired_cycle)]
        primary = desired if condition_map.get(desired) else ("靓机" if condition_map.get("靓机") else valid_conditions[0])
        price = condition_map[primary]

        direction_bias = rng.choice([-1, -1, 1, 1, 1, 0])
        magnitude = rng.uniform(0.15, 2.8)
        if index % 13 == 0:
            magnitude = rng.uniform(2.9, 4.3)
        simulated_change = round(direction_bias * magnitude, 2)
        history = build_price_history(23100 + index, price, simulated_change)
        prev_price = history[-2]
        change_1d = pct(price, prev_price)
        d7 = pct(price, history[-8])
        d30 = pct(price, history[0])
        condition_history = {}
        for offset, condition in enumerate(CONDITIONS):
            value = condition_map[condition]
            condition_history[condition] = (
                history
                if condition == primary
                else build_price_history(55200 + index * 7 + offset, value, simulated_change * (1 + offset * 0.08))
                if value
                else []
            )

        movers.append(
            {
                "id": f"sku-{index + 1:03d}",
                "modelId": model_id,
                "model": model_name,
                "brand": brand,
                "brandShort": BRAND_SHORT[brand],
                "memory": memory,
                "condition": primary,
                "price": price,
                "prevPrice": prev_price,
                "change1d": change_1d,
                "changeAmount": price - prev_price,
                "change7d": d7,
                "change30d": d30,
                "spark": history[-12:],
                "conditions": condition_map,
                "conditionHistory": condition_history,
                "matchedDays": 31 - (index % 3),
            }
        )

    movers.sort(key=lambda item: abs(item["change1d"]) * (1 + math.log10(item["price"])), reverse=True)

    today = date(2026, 11, 2)
    timeline = [(today - timedelta(days=30 - i)).isoformat() for i in range(31)]
    condition_changes = {"靓机": -0.18, "小花": -0.46, "大花": -0.64, "外爆": 0.31, "内爆": -0.09}
    condition_indexes = {"靓机": 98.42, "小花": 97.86, "大花": 97.31, "外爆": 101.62, "内爆": 98.91}
    conditions = []
    for position, condition in enumerate(CONDITIONS):
        series = build_series(
            4100 + position,
            condition_indexes[condition],
            condition_changes[condition],
        )
        conditions.append(
            {
                "name": condition,
                "short": f"{position + 1:02d}",
                "color": CONDITION_COLORS[condition],
                "change": condition_changes[condition],
                "index": series[-1],
                "skus": valid_by_condition[condition],
                "series": series,
            }
        )

    market_series = []
    for day_index in range(31):
        weighted_index = sum(
            conditions[pos]["series"][day_index] * valid_by_condition[condition]
            for pos, condition in enumerate(CONDITIONS)
        ) / sum(valid_by_condition.values())
        market_series.append(round(weighted_index, 2))
    market_change = round((market_series[-1] / market_series[-2] - 1) * 100, 2)

    brand_series_seed = {
        "苹果": (98.9, -0.88, 0.34),
        "华为": (100.86, 0.37, 0.24),
        "小米": (101.11, 0.52, 0.31),
        "OPPO": (99.58, -0.3, 0.27),
        "vivo": (100.35, 0.08, 0.23),
        "荣耀": (98.66, -0.98, 0.36),
        "三星": (99.24, -0.6, 0.42),
        "一加": (100.14, 0.02, 0.29),
    }
    brand_conditions_override = {
        "苹果": [-0.62, -1.14, -1.47, 0.18, -0.31],
        "华为": [0.54, 0.28, 0.12, 0.41, 0.67],
        "小米": [0.82, 0.64, 0.39, -0.12, 0.28],
        "OPPO": [-0.11, -0.38, -0.57, 0.14, -0.26],
        "vivo": [0.21, 0.08, -0.16, 0.09, 0.32],
        "荣耀": [-0.96, -1.26, -1.12, -0.38, -0.51],
        "三星": [-0.48, -0.72, -0.83, -0.14, -0.36],
        "一加": [0.24, -0.16, -0.09, 0.05, 0.18],
    }

    brands = []
    brand_order = sorted(brand_models, key=lambda b: len(brand_models[b]), reverse=True)
    for index, brand in enumerate(brand_order):
        current_index, daily, volatility = brand_series_seed[brand]
        series = build_series(12000 + index, current_index, daily, volatility / 3.5)
        values = brand_conditions_override[brand]
        brand_conditions = {
            condition: {"change": values[pos], "index": round(100 * (1 + values[pos] / 100 * 0.8), 2)}
            for pos, condition in enumerate(CONDITIONS)
        }
        weighted = round(sum(values[i] * valid_by_condition[c] for i, c in enumerate(CONDITIONS)) / 9765, 2)
        up_share = clamp(0.48 + weighted * 0.08, 0.22, 0.75)
        brand_total = valid_by_brand[brand]
        upward = int(round(brand_total * up_share))
        downward = int(round(brand_total * max(0.16, 0.86 - up_share)))
        flat = max(0, brand_total - upward - downward)
        brands.append(
            {
                "id": f"brand-{index}",
                "name": brand,
                "short": BRAND_SHORT[brand],
                "models": len(brand_models[brand]),
                "skus": brand_total,
                "index": series[-1],
                "change": weighted,
                "series": series,
                "up": upward,
                "down": downward,
                "flat": flat,
                "conditions": brand_conditions,
            }
        )

    brands.sort(key=lambda item: item["change"], reverse=True)
    total_valid = sum(valid_by_condition.values())
    up_count = 4512
    down_count = 3846
    flat_count = total_valid - up_count - down_count

    payload = {
        "meta": {
            "title": "手机市场行情监控",
            "businessDate": "2026-11-02",
            "businessDateLabel": "11月2日",
            "weekday": "周一",
            "updatedAt": "15:41",
            "batch": "DEMO-1102",
            "source": "实时竞拍参考价",
            "demo": True,
            "demoNote": "价格基于 11 月 2 日报价单结构生成，已做轻微扰动；趋势为演示数据。",
            "models": len(models),
            "skus": len(raw_rows) + zero_quotes,
            "validSkus": total_valid,
            "zeroQuotes": zero_quotes,
            "coverage": round(total_valid / (len(raw_rows) + zero_quotes) * 100, 1),
        },
        "market": {
            "index": market_series[-1],
            "change": market_change,
            "series": market_series,
            "up": up_count,
            "down": down_count,
            "flat": flat_count,
            "anomalies": len(movers),
            "anomalyBaseline": 209,
        },
        "timeline": timeline,
        "conditions": conditions,
        "brands": brands,
        "movers": movers,
        "quality": {
            "models": len(models),
            "skus": 13020,
            "validSkus": total_valid,
            "zeroQuotes": zero_quotes,
            "duplicateRows": 0,
            "missingRows": 0,
            "topIn": 72,
            "topOut": 54,
            "matchedRate": 96.4,
            "coverage": round(total_valid / 13020 * 100, 1),
        },
    }

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        "window.MARKET_DEMO = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(f"已生成 {target}，机型 {len(models)} 个，SKU {total_valid + zero_quotes} 条。")


if __name__ == "__main__":
    main()
