from __future__ import annotations

import json
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime
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
    "苹果": "AP", "华为": "HW", "小米": "MI", "OPPO": "OP",
    "vivo": "VI", "荣耀": "HO", "三星": "SS", "一加": "ON",
}
WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
ANOMALY_LIMIT = 30.0


def median(values):
    return round(statistics.median(values), 3) if values else 0.0


def quantile(values, ratio):
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * ratio
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def round_price(value):
    return int(round(value))


def load_day(path: Path):
    workbook = load_workbook(path, read_only=False, data_only=True)
    sheet = workbook.active
    meta = {}
    snapshot = {}
    quality = {
        "rows": 0,
        "missingMemory": 0,
        "duplicates": 0,
        "zeroQuotes": 0,
        "date": None,
    }
    duplicate_keys = []
    for row in sheet.iter_rows(min_row=2, values_only=True):
        if not row or row[0] is None:
            continue
        quality["rows"] += 1
        date_value = str(row[1])[:10]
        if date_value and date_value != "None":
            quality["date"] = date_value
        model_id = int(row[2])
        name = str(row[3]).strip()
        brand = str(row[4]).strip()
        memory = row[6]
        condition = str(row[7]).strip()
        price = float(row[8] or 0)
        meta[model_id] = {"model": name, "brand": brand}
        if memory is None or not str(memory).strip():
            quality["missingMemory"] += 1
            continue
        memory = str(memory).strip()
        if condition not in CONDITIONS:
            continue
        key = (model_id, memory, condition)
        if key in snapshot:
            quality["duplicates"] += 1
            duplicate_keys.append(key)
        if price <= 0:
            quality["zeroQuotes"] += 1
            snapshot[key] = price
            continue
        snapshot[key] = price
    quality["uniqueKeys"] = len(snapshot)
    quality["validKeys"] = sum(1 for value in snapshot.values() if value > 0)
    quality["zeroKeys"] = sum(1 for value in snapshot.values() if value <= 0)
    quality["coverage"] = round(quality["validKeys"] / quality["uniqueKeys"] * 100, 1) if quality["uniqueKeys"] else 0
    return quality["date"], meta, snapshot, quality


def scope_metrics(dates, snapshots, model_meta, top100_ids=None):
    market_series = [100.0]
    condition_series = {condition: [100.0] for condition in CONDITIONS}
    brand_series = defaultdict(lambda: [100.0])
    first_snapshot = {
        key: value
        for key, value in snapshots[dates[0]].items()
        if top100_ids is None or key[0] in top100_ids
    }
    first_valid = {key: value for key, value in first_snapshot.items() if value > 0}
    stats = [{
        "date": dates[0],
        "index": 100.0,
        "change": 0.0,
        "week": 0.0,
        "up": 0,
        "down": 0,
        "flat": 0,
        "anomalies": 0,
        "normal": 0,
        "matched": 0,
        "matchedRate": 0.0,
        "newSkus": 0,
        "exitSkus": 0,
        "models": len({key[0] for key in first_valid}),
        "skus": len(first_valid),
        "rawSkus": len(first_snapshot),
        "zeroSkus": len(first_snapshot) - len(first_valid),
        "coverage": round(len(first_valid) / max(1, len(first_snapshot)) * 100, 1),
        "conditions": {},
        "brands": {},
    }]
    for date in dates:
        for condition in CONDITIONS:
            condition_series[condition].append(100.0)
    # Remove the extra seeded point for day zero.
    for condition in CONDITIONS:
        condition_series[condition] = condition_series[condition][:1]
    for brand in sorted({meta["brand"] for meta in model_meta.values()}):
        brand_series[brand] = brand_series[brand][:1]

    condition_stats = {
        condition: [{
            "date": dates[0], "index": 100.0, "change": 0.0,
            "normal": 0, "up": 0, "down": 0,
        }]
        for condition in CONDITIONS
    }
    brand_stats = {
        brand: [{
            "date": dates[0], "index": 100.0, "change": 0.0,
            "normal": 0, "anomalies": 0, "up": 0, "down": 0, "flat": 0,
            "conditions": {
                condition: {"change": 0.0, "normal": 0, "anomalies": 0}
                for condition in CONDITIONS
            },
        }]
        for brand in brand_series
    }
    stats[0]["conditions"] = {
        condition: {
            "date": dates[0], "index": 100.0, "change": 0.0,
            "normal": 0, "up": 0, "down": 0, "flat": 0,
            "anomalies": 0, "matched": 0,
        }
        for condition in CONDITIONS
    }
    stats[0]["brands"] = {brand: brand_stats[brand][0] for brand in brand_stats}

    for date_index in range(1, len(dates)):
        previous_date = dates[date_index - 1]
        current_date = dates[date_index]
        previous = snapshots[previous_date]
        current = snapshots[current_date]
        eligible_previous = {key: value for key, value in previous.items() if value > 0 and (top100_ids is None or key[0] in top100_ids)}
        eligible_current = {key: value for key, value in current.items() if value > 0 and (top100_ids is None or key[0] in top100_ids)}
        common = [key for key in eligible_current.keys() & eligible_previous.keys()]
        returns = {key: (eligible_current[key] / eligible_previous[key] - 1) * 100 for key in common}
        normal = {key: value for key, value in returns.items() if value != 0 and abs(value) <= ANOMALY_LIMIT}
        anomaly = {key: value for key, value in returns.items() if abs(value) > ANOMALY_LIMIT}
        normal_values = list(normal.values())
        market_change = median(normal_values)
        market_series.append(round(market_series[-1] * (1 + market_change / 100), 2))

        condition_data = {}
        for condition in CONDITIONS:
            values = [value for key, value in normal.items() if key[2] == condition]
            change = median(values)
            condition_series[condition].append(round(condition_series[condition][-1] * (1 + change / 100), 2))
            condition_returns = [value for key, value in returns.items() if key[2] == condition]
            condition_data[condition] = {
                "date": current_date,
                "index": condition_series[condition][-1],
                "change": change,
                "normal": len(values),
                "up": sum(value > 0 for value in condition_returns),
                "down": sum(value < 0 for value in condition_returns),
                "flat": sum(value == 0 for value in condition_returns),
                "anomalies": sum(abs(value) > ANOMALY_LIMIT for value in condition_returns),
                "matched": len(condition_returns),
            }
            condition_stats[condition].append(condition_data[condition])

        brands_today = set(meta["brand"] for meta in model_meta.values())
        for brand in sorted(brands_today):
            values = [value for key, value in normal.items() if model_meta[key[0]]["brand"] == brand]
            change = median(values)
            brand_series[brand].append(round(brand_series[brand][-1] * (1 + change / 100), 2))
            brand_returns = [value for key, value in returns.items() if model_meta[key[0]]["brand"] == brand]
            brand_conditions = {}
            for condition in CONDITIONS:
                condition_values = [value for key, value in normal.items() if model_meta[key[0]]["brand"] == brand and key[2] == condition]
                condition_returns = [value for key, value in returns.items() if model_meta[key[0]]["brand"] == brand and key[2] == condition]
                brand_conditions[condition] = {
                    "change": median(condition_values),
                    "normal": len(condition_values),
                    "anomalies": sum(abs(value) > ANOMALY_LIMIT for value in condition_returns),
                }
            brand_stats[brand].append({
                "date": current_date,
                "index": brand_series[brand][-1],
                "change": change,
                "normal": len(values),
                "anomalies": sum(abs(value) > ANOMALY_LIMIT for value in brand_returns),
                "up": sum(value > 0 for value in brand_returns),
                "down": sum(value < 0 for value in brand_returns),
                "flat": sum(value == 0 for value in brand_returns),
                "conditions": brand_conditions,
            })

        models_today = len({key[0] for key in eligible_current})
        current_scope = {
            key: value
            for key, value in current.items()
            if top100_ids is None or key[0] in top100_ids
        }
        stats.append({
            "date": current_date,
            "index": market_series[-1],
            "change": market_change,
            "week": round(market_series[-1] - 100, 2),
            "up": sum(value > 0 for value in returns.values()),
            "down": sum(value < 0 for value in returns.values()),
            "flat": sum(value == 0 for value in returns.values()),
            "anomalies": len(anomaly),
            "normal": len(normal),
            "matched": len(common),
            "matchedRate": round(len(common) / max(1, min(len(eligible_previous), len(eligible_current))) * 100, 1),
            "newSkus": len(eligible_current.keys() - eligible_previous.keys()),
            "exitSkus": len(eligible_previous.keys() - eligible_current.keys()),
            "models": models_today,
            "skus": len(eligible_current),
            "rawSkus": len(current_scope),
            "zeroSkus": len(current_scope) - len(eligible_current),
            "coverage": round(len(eligible_current) / max(1, len(current_scope)) * 100, 1),
            "conditions": condition_data,
            "brands": {brand: brand_stats[brand][-1] for brand in brand_stats},
        })

    return {
        "indexSeries": market_series,
        "stats": stats,
        "conditions": {
            condition: {
                "indexSeries": condition_series[condition],
                "stats": condition_stats[condition],
            }
            for condition in CONDITIONS
        },
        "brands": {
            brand: {
                "indexSeries": brand_series[brand],
                "stats": brand_stats[brand],
            }
            for brand in brand_series
        },
    }


def build_models(dates, snapshots, model_meta, top100_ids, top100_rank):
    models = []
    for model_id, meta in sorted(model_meta.items()):
        memories = sorted({key[1] for key in snapshots[dates[-1]] if key[0] == model_id})
        if not memories:
            memories = sorted({key[1] for date in dates for key in snapshots[date] if key[0] == model_id})
        if not memories:
            continue
        best_memory = None
        best_score = None
        for memory in memories:
            latest_valid = sum(1 for condition in CONDITIONS if snapshots[dates[-1]].get((model_id, memory, condition), 0) > 0)
            coverage = sum(1 for date in dates for condition in CONDITIONS if snapshots[date].get((model_id, memory, condition), 0) > 0)
            latest_price = max([snapshots[dates[-1]].get((model_id, memory, condition), 0) for condition in CONDITIONS] or [0])
            score = (latest_valid, coverage, latest_price)
            if best_score is None or score > best_score:
                best_score = score
                best_memory = memory
        history = {}
        latest_prices = {}
        coverage = 0
        for condition in CONDITIONS:
            condition_history = []
            for date in dates:
                value = snapshots[date].get((model_id, best_memory, condition), 0)
                condition_history.append(round_price(value) if value > 0 else None)
            history[condition] = condition_history
            latest = condition_history[-1]
            if latest is not None:
                latest_prices[condition] = latest
                coverage = max(coverage, sum(value is not None for value in condition_history))
        primary = "靓机" if latest_prices.get("靓机") else next((condition for condition in CONDITIONS if condition in latest_prices), CONDITIONS[0])
        primary_history = history[primary]
        coverage_days = sum(value is not None for value in primary_history)
        latest_price = next((value for value in reversed(primary_history) if value is not None), 0)
        previous_price = None
        for index in range(len(dates) - 2, -1, -1):
            if primary_history[index] is not None:
                previous_price = primary_history[index]
                break
        earliest_price = next((value for value in primary_history if value is not None), None)
        config_count = len({key[1] for date in dates for key in snapshots[date] if key[0] == model_id})
        sku_count = len({key for date in dates for key in snapshots[date] if key[0] == model_id})
        models.append({
            "id": f"model-{model_id}",
            "modelId": model_id,
            "model": meta["model"],
            "brand": meta["brand"],
            "brandShort": BRAND_SHORT.get(meta["brand"], "MO"),
            "mainMemory": best_memory,
            "configCount": config_count,
            "skuCount": sku_count,
            "primaryCondition": primary,
            "latestPrice": latest_price,
            "prevPrice": previous_price,
            "earliestPrice": earliest_price,
            "coverageDays": coverage_days,
            "inTop100": model_id in top100_ids,
            "top100Rank": top100_rank.get(model_id),
            "conditions": history,
        })
    return models


def main():
    if len(sys.argv) < 3:
        raise SystemExit("用法: python generate_data.py <data.js> <报价单1.xlsx> <报价单2.xlsx> ...")
    target = Path(sys.argv[1])
    sources = [Path(path) for path in sys.argv[2:]]
    loaded = []
    all_meta = {}
    for path in sources:
        date, meta, snapshot, quality = load_day(path)
        if not date:
            raise SystemExit(f"无法识别日期: {path}")
        loaded.append((date, meta, snapshot, quality))
        all_meta.update(meta)
    loaded.sort(key=lambda item: item[0])
    dates = [item[0] for item in loaded]
    snapshots = {item[0]: item[2] for item in loaded}
    quality = {item[0]: item[3] for item in loaded}

    # 7-day coverage and latest 靓机 price define the focus pool.
    latest_date = dates[-1]
    eligible_top100 = []
    for model_id in all_meta:
        latest_price = max(
            snapshots[latest_date].get((model_id, memory, condition), 0)
            for key_memory in {key[1] for key in snapshots[latest_date] if key[0] == model_id}
            for memory in [key_memory]
            for condition in ["靓机"]
        )
        covered = sum(
            1 for date in dates
            if any(snapshots[date].get((model_id, key[1], "靓机"), 0) > 0 for key in snapshots[date] if key[0] == model_id)
        )
        if latest_price > 0 and covered == len(dates):
            eligible_top100.append((model_id, latest_price))
    eligible_top100.sort(key=lambda item: item[1], reverse=True)
    top100_list = [model_id for model_id, _ in eligible_top100[:100]]
    top100_ids = set(top100_list)
    top100_rank = {model_id: index + 1 for index, model_id in enumerate(top100_list)}

    all_scope = scope_metrics(dates, snapshots, all_meta)
    top_scope = scope_metrics(dates, snapshots, all_meta, top100_ids)
    models = build_models(dates, snapshots, all_meta, top100_ids, top100_rank)

    # Build date labels and quality summaries.
    date_items = []
    previous_keys = None
    for date in dates:
        q = quality[date]
        keys = {key for key, value in snapshots[date].items() if value > 0}
        if previous_keys is None:
            matched_rate = 100.0
            matched = len(keys)
        else:
            matched = len(keys & previous_keys)
            matched_rate = round(matched / max(1, min(len(keys), len(previous_keys))) * 100, 1)
        previous_keys = keys
        date_items.append({
            "date": date,
            "label": f"{int(date[5:7])}月{int(date[8:10])}日",
            "short": date[5:].replace("-", "."),
            "weekday": WEEKDAYS[datetime.strptime(date, "%Y-%m-%d").weekday()],
            "quality": {
                "rows": q["rows"],
                "uniqueKeys": q["uniqueKeys"],
                "validKeys": q["validKeys"],
                "zeroQuotes": q["zeroQuotes"],
                "missingMemory": q["missingMemory"],
                "duplicates": q["duplicates"],
                "coverage": q["coverage"],
                "matched": matched,
                "matchedRate": matched_rate,
                "models": len({key[0] for key in keys}),
                "skus": len(keys),
            },
        })

    latest_quality = date_items[-1]["quality"]
    all_latest = all_scope["stats"][-1]
    top_latest = top_scope["stats"][-1]
    brands = []
    for brand in sorted(all_scope["brands"]):
        latest_brand = all_scope["brands"][brand]["stats"][-1]
        top_brand = top_scope["brands"].get(brand, {}).get("stats", [{}])[-1]
        models_for_brand = [model for model in models if model["brand"] == brand]
        brands.append({
            "id": f"brand-{brand}",
            "name": brand,
            "short": BRAND_SHORT.get(brand, "MO"),
            "models": len(models_for_brand),
            "skus": sum(model["skuCount"] for model in models_for_brand),
            "indexSeries": all_scope["brands"][brand]["indexSeries"],
            "stats": all_scope["brands"][brand]["stats"],
            "top100IndexSeries": top_scope["brands"].get(brand, {}).get("indexSeries", [100.0] * len(dates)),
            "top100Stats": top_scope["brands"].get(brand, {}).get("stats", [{} for _ in dates]),
            "latest": latest_brand,
            "top100Latest": top_brand,
        })

    conditions = []
    for index, condition in enumerate(CONDITIONS):
        condition_data = all_scope["conditions"][condition]
        top_condition = top_scope["conditions"][condition]
        conditions.append({
            "name": condition,
            "short": f"{index + 1:02d}",
            "color": CONDITION_COLORS[condition],
            "indexSeries": condition_data["indexSeries"],
            "stats": condition_data["stats"],
            "top100IndexSeries": top_condition["indexSeries"],
            "top100Stats": top_condition["stats"],
            "skus": sum(1 for key, value in snapshots[latest_date].items() if value > 0 and key[2] == condition),
            "top100Skus": sum(1 for key, value in snapshots[latest_date].items() if value > 0 and key[2] == condition and key[0] in top100_ids),
        })

    top100_models = [model for model in models if model["inTop100"]]
    top100_models.sort(key=lambda model: model["top100Rank"])
    top100_up = sum(
        1 for model in top100_models
        if model["prevPrice"] and model["latestPrice"] > model["prevPrice"]
    )
    top100_down = sum(
        1 for model in top100_models
        if model["prevPrice"] and model["latestPrice"] < model["prevPrice"]
    )
    top100_flat = len(top100_models) - top100_up - top100_down

    payload = {
        "meta": {
            "title": "价脉 Price Pulse · 手机市场行情监控",
            "businessDate": latest_date,
            "dateFrom": dates[0],
            "dateTo": dates[-1],
            "updatedAt": "18:06",
            "source": "实时竞拍参考价",
            "demo": False,
            "note": "基于 2026.10.27–11.02 七份报价单；已剔除内存缺失记录，异常跳价单独标记。",
            "totalModels": len(all_meta),
            "totalSkus": sum(item["validKeys"] for item in quality.values()),
            "totalUniqueKeys": sum(item["uniqueKeys"] for item in quality.values()),
            "latestModels": latest_quality["models"],
            "latestSkus": latest_quality["skus"],
            "top100": 100,
            "top100Definition": "近 7 日靓机连续有价，按最新靓机市场价从高到低取前 100 款。",
            "anomalyLimit": ANOMALY_LIMIT,
        },
        "dates": date_items,
        "market": {
            "all": all_scope,
            "top100": top_scope,
        },
        "brands": brands,
        "conditions": conditions,
        "models": models,
        "top100Ids": top100_list,
        "summary": {
            "all": all_latest,
            "top100": {
                **top_latest,
                "upModels": top100_up,
                "downModels": top100_down,
                "flatModels": top100_flat,
            },
            "latestQuality": latest_quality,
        },
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("window.MARKET_DEMO = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"已生成 {target}")
    print(f"日期 {dates[0]} 至 {dates[-1]}；机型 {len(all_meta)}；TOP100 {len(top100_models)}；SKU 记录 {payload['meta']['totalSkus']}")
    print(f"全量指数 {all_latest['index']}，日涨跌 {all_latest['change']}%；TOP100 指数 {top_latest['index']}，日涨跌 {top_latest['change']}%")


if __name__ == "__main__":
    main()
