from __future__ import annotations

import argparse
import json
import re
import sqlite3
import statistics
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

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
WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
ANOMALY_LIMIT = 30.0
DEFAULT_WINDOW = 90
MAX_WINDOW = 180
PREFIX = "window.MARKET_DEMO = "
SHANGHAI = ZoneInfo("Asia/Shanghai")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="从本地报价库生成 90/180 天行情看板数据")
    parser.add_argument("--db", default="data/price_history.sqlite")
    parser.add_argument("--output", default="data/real/market_data_90d.js")
    parser.add_argument("--days", type=int, default=DEFAULT_WINDOW)
    parser.add_argument("--max-window-days", type=int, default=MAX_WINDOW)
    parser.add_argument("--end-date", help="截止日期，默认库内最新日期")
    return parser.parse_args()


def median(values):
    filtered = [value for value in values if value is not None]
    return round(statistics.median(filtered), 3) if filtered else 0.0


def signed_pct(value):
    return round(value, 3) if value is not None else 0.0


def memory_sort_key(memory):
    numbers = [int(value) for value in re.findall(r"\d+", str(memory))]
    return (numbers[-1] if numbers else 0, numbers[0] if numbers else 0, str(memory))


def load_database(db_path: Path, days: int, end_date: str | None):
    if not db_path.exists():
        raise SystemExit(f"数据库不存在：{db_path}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        snapshot_rows = conn.execute(
            """
            SELECT *
            FROM snapshots
            WHERE row_count > 0 AND quality_status NOT IN ('invalid', 'failed')
            ORDER BY date
            """
        ).fetchall()
        if not snapshot_rows:
            raise SystemExit("数据库中没有可用日快照")
        available_dates = [row["date"] for row in snapshot_rows]
        if end_date:
            available_dates = [value for value in available_dates if value <= end_date]
        if not available_dates:
            raise SystemExit("指定截止日期之前没有数据")
        dates = available_dates[-days:]
        snapshot_meta = {row["date"]: dict(row) for row in snapshot_rows if row["date"] in set(dates)}
        placeholders = ",".join("?" for _ in dates)
        quote_rows = conn.execute(
            f"""
            SELECT date, model_id, model_name, brand, memory_id, memory_name, condition, price
            FROM quotes
            WHERE date IN ({placeholders})
            ORDER BY date, model_id, memory_name, condition
            """,
            dates,
        ).fetchall()
    finally:
        conn.close()

    snapshots: dict[str, dict[tuple[str, str, str], float | None]] = defaultdict(dict)
    model_meta: dict[str, dict] = {}
    memory_names: dict[tuple[str, str], str] = {}
    model_date_rows: dict[str, dict[str, int]] = defaultdict(dict)
    model_pairs: dict[str, set[str]] = defaultdict(set)
    latest_memory_ids: dict[str, set[str]] = defaultdict(set)
    lovely_days: dict[str, set[str]] = defaultdict(set)
    latest_lovely_prices: dict[str, list[float]] = defaultdict(list)
    latest_date = dates[-1]
    for row in quote_rows:
        day = row["date"]
        model_id = str(row["model_id"])
        memory_id = str(row["memory_id"])
        condition = row["condition"]
        price = row["price"]
        snapshots[day][(model_id, memory_id, condition)] = price
        model_meta[model_id] = {
            "model": row["model_name"],
            "brand": row["brand"],
        }
        memory_name = (row["memory_name"] or "").strip()
        if memory_name:
            memory_names[(model_id, memory_id)] = memory_name
        model_pairs[model_id].add(memory_id)
        if day == latest_date:
            latest_memory_ids[model_id].add(memory_id)
        if condition == "靓机" and price and price > 0:
            lovely_days[model_id].add(day)
            if day == latest_date:
                latest_lovely_prices[model_id].append(price)
        model_date_rows[model_id][day] = model_date_rows[model_id].get(day, 0) + 1

    for day in dates:
        for (model_id, memory_id, _condition), price in snapshots[day].items():
            if (model_id, memory_id) not in memory_names:
                memory_names[(model_id, memory_id)] = f"ID {memory_id}"

    return {
        "dates": dates,
        "stored_days": len(available_dates),
        "snapshots": snapshots,
        "snapshot_meta": snapshot_meta,
        "model_meta": model_meta,
        "memory_names": memory_names,
        "model_date_rows": model_date_rows,
        "model_pairs": model_pairs,
        "latest_memory_ids": latest_memory_ids,
        "lovely_days": lovely_days,
        "latest_lovely_prices": latest_lovely_prices,
    }


def scope_metrics(dates, snapshots, model_meta, top100_ids=None):
    condition_series = {condition: [100.0] for condition in CONDITIONS}
    brand_series = defaultdict(lambda: [100.0])
    first_snapshot = {
        key: value
        for key, value in snapshots[dates[0]].items()
        if top100_ids is None or key[0] in top100_ids
    }
    first_valid = {key: value for key, value in first_snapshot.items() if value and value > 0}
    brands = sorted({meta["brand"] for meta in model_meta.values()})

    def base_condition():
        return {
            "date": dates[0],
            "index": 100.0,
            "change": 0.0,
            "normal": 0,
            "up": 0,
            "down": 0,
            "flat": 0,
            "anomalies": 0,
            "matched": 0,
        }

    stats = [
        {
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
            "conditions": {condition: base_condition() for condition in CONDITIONS},
            "brands": {},
        }
    ]
    condition_stats = {
        condition: [
            {
                "date": dates[0],
                "index": 100.0,
                "change": 0.0,
                "normal": 0,
                "up": 0,
                "down": 0,
                "flat": 0,
                "anomalies": 0,
                "matched": 0,
            }
        ]
        for condition in CONDITIONS
    }
    brand_stats = {
        brand: [
            {
                "date": dates[0],
                "index": 100.0,
                "change": 0.0,
                "normal": 0,
                "anomalies": 0,
                "up": 0,
                "down": 0,
                "flat": 0,
                "conditions": {
                    condition: {"change": 0.0, "normal": 0, "anomalies": 0}
                    for condition in CONDITIONS
                },
            }
        ]
        for brand in brands
    }
    stats[0]["brands"] = {brand: brand_stats[brand][0] for brand in brands}

    for index in range(1, len(dates)):
        previous_date = dates[index - 1]
        current_date = dates[index]
        previous = {
            key: value
            for key, value in snapshots[previous_date].items()
            if value and value > 0 and (top100_ids is None or key[0] in top100_ids)
        }
        current = {
            key: value
            for key, value in snapshots[current_date].items()
            if value and value > 0 and (top100_ids is None or key[0] in top100_ids)
        }
        common = previous.keys() & current.keys()
        returns = {key: (current[key] / previous[key] - 1) * 100 for key in common}
        normal = {key: value for key, value in returns.items() if value != 0 and abs(value) <= ANOMALY_LIMIT}
        anomalies = {key: value for key, value in returns.items() if abs(value) > ANOMALY_LIMIT}
        market_change = median(normal.values()) if normal else 0.0
        market_index = round(stats[-1]["index"] * (1 + market_change / 100), 2)

        condition_values = {}
        for condition in CONDITIONS:
            values = [value for key, value in normal.items() if key[2] == condition]
            condition_returns = [value for key, value in returns.items() if key[2] == condition]
            change = median(values) if values else 0.0
            condition_series[condition].append(
                round(condition_series[condition][-1] * (1 + change / 100), 2)
            )
            condition_values[condition] = {
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
            condition_stats[condition].append(condition_values[condition])

        for brand in brands:
            values = [value for key, value in normal.items() if model_meta[key[0]]["brand"] == brand]
            brand_returns = [value for key, value in returns.items() if model_meta[key[0]]["brand"] == brand]
            change = median(values) if values else 0.0
            brand_series[brand].append(round(brand_series[brand][-1] * (1 + change / 100), 2))
            brand_conditions = {}
            for condition in CONDITIONS:
                condition_values_for_brand = [
                    value
                    for key, value in normal.items()
                    if model_meta[key[0]]["brand"] == brand and key[2] == condition
                ]
                condition_returns_for_brand = [
                    value
                    for key, value in returns.items()
                    if model_meta[key[0]]["brand"] == brand and key[2] == condition
                ]
                brand_conditions[condition] = {
                    "change": median(condition_values_for_brand) if condition_values_for_brand else 0.0,
                    "normal": len(condition_values_for_brand),
                    "anomalies": sum(abs(value) > ANOMALY_LIMIT for value in condition_returns_for_brand),
                }
            brand_stats[brand].append(
                {
                    "date": current_date,
                    "index": brand_series[brand][-1],
                    "change": change,
                    "normal": len(values),
                    "anomalies": sum(abs(value) > ANOMALY_LIMIT for value in brand_returns),
                    "up": sum(value > 0 for value in brand_returns),
                    "down": sum(value < 0 for value in brand_returns),
                    "flat": sum(value == 0 for value in brand_returns),
                    "conditions": brand_conditions,
                }
            )

        stats.append(
            {
                "date": current_date,
                "index": market_index,
                "change": market_change,
                "week": round(market_index - 100, 2),
                "up": sum(value > 0 for value in returns.values()),
                "down": sum(value < 0 for value in returns.values()),
                "flat": sum(value == 0 for value in returns.values()),
                "anomalies": len(anomalies),
                "normal": len(normal),
                "matched": len(common),
                "matchedRate": round(len(common) / max(1, len(previous), len(current)) * 100, 1),
                "newSkus": len(current.keys() - previous.keys()),
                "exitSkus": len(previous.keys() - current.keys()),
                "models": len({key[0] for key in current}),
                "skus": len(current),
                "rawSkus": len(
                    [
                        key
                        for key in snapshots[current_date]
                        if top100_ids is None or key[0] in top100_ids
                    ]
                ),
                "zeroSkus": len(
                    [
                        key
                        for key, value in snapshots[current_date].items()
                        if (not value or value <= 0) and (top100_ids is None or key[0] in top100_ids)
                    ]
                ),
                "coverage": round(
                    len(current)
                    / max(
                        1,
                        len(
                            [
                                key
                                for key in snapshots[current_date]
                                if top100_ids is None or key[0] in top100_ids
                            ]
                        ),
                    )
                    * 100,
                    1,
                ),
                "conditions": condition_values,
                "brands": {brand: brand_stats[brand][-1] for brand in brands},
            }
        )

    return {
        "indexSeries": [stat["index"] for stat in stats],
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
            for brand in brands
        },
    }


def select_top100(loaded):
    dates = loaded["dates"]
    snapshot_meta = loaded["snapshot_meta"]
    model_meta = loaded["model_meta"]
    lovely_days = loaded["lovely_days"]
    latest_lovely_prices = loaded["latest_lovely_prices"]
    complete_dates = [
        day
        for day in dates
        if snapshot_meta[day]["quality_status"] in ("complete", "warning")
    ]
    selection_dates = complete_dates[-7:]
    if len(selection_dates) < 7:
        selection_dates = dates[-7:]
    candidates = []
    for model_id in model_meta:
        latest_prices = latest_lovely_prices.get(model_id, [])
        if not latest_prices:
            continue
        covered = all(day in lovely_days.get(model_id, set()) for day in selection_dates)
        if covered:
            candidates.append((model_id, max(latest_prices)))
    candidates.sort(key=lambda item: (-item[1], item[0]))
    top100_list = [model_id for model_id, _price in candidates[:100]]
    return top100_list, {model_id: index + 1 for index, model_id in enumerate(top100_list)}, selection_dates


def build_models(loaded, top100_ids, top100_rank):
    dates = loaded["dates"]
    snapshots = loaded["snapshots"]
    model_meta = loaded["model_meta"]
    memory_names = loaded["memory_names"]
    model_pairs = loaded["model_pairs"]
    latest_memory_ids = loaded["latest_memory_ids"]
    models = []
    latest_date = dates[-1]
    for model_id, meta in sorted(model_meta.items()):
        pairs = [(model_id, memory_id) for memory_id in sorted(model_pairs.get(model_id, set()))]
        if not pairs:
            continue
        labels = {}
        for candidate_model, memory_id in pairs:
            raw_label = memory_names.get((candidate_model, memory_id), f"ID {memory_id}")
            label = raw_label
            if label in labels:
                label = f"{raw_label} · ID{memory_id}"
            labels[(candidate_model, memory_id)] = label

        latest_pairs = [
            (model_id, memory_id)
            for memory_id in sorted(latest_memory_ids.get(model_id, set()))
        ]
        selection_pairs = latest_pairs or pairs
        best_pair = None
        best_score = None
        for pair in selection_pairs:
            memory_id = pair[1]
            latest_valid = sum(
                1
                for condition in CONDITIONS
                if (model_id, memory_id, condition) in snapshots[latest_date]
                and (snapshots[latest_date][(model_id, memory_id, condition)] or 0) > 0
            )
            coverage = sum(
                1
                for day in dates
                for condition in CONDITIONS
                if (snapshots[day].get((model_id, memory_id, condition)) or 0) > 0
            )
            latest_price = max(
                [
                    snapshots[latest_date].get((model_id, memory_id, condition), 0) or 0
                    for condition in CONDITIONS
                ]
                or [0]
            )
            score = (latest_valid, coverage, latest_price)
            if best_score is None or score > best_score:
                best_score = score
                best_pair = pair
        best_memory_id = best_pair[1]
        main_memory = labels[best_pair]

        configs = {}
        for pair in sorted(pairs, key=lambda pair: memory_sort_key(labels[pair])):
            memory_id = pair[1]
            history = {}
            for condition in CONDITIONS:
                values = []
                for day in dates:
                    value = snapshots[day].get((model_id, memory_id, condition))
                    values.append(round(value) if value and value > 0 else None)
                history[condition] = values
            configs[labels[pair]] = history

        history = {}
        latest_prices = {}
        for condition in CONDITIONS:
            values = []
            for day in dates:
                value = snapshots[day].get((model_id, best_memory_id, condition))
                values.append(round(value) if value and value > 0 else None)
            history[condition] = values
            latest = next((value for value in reversed(values) if value is not None), None)
            if latest is not None:
                latest_prices[condition] = latest
        primary = "靓机" if latest_prices.get("靓机") is not None else next(
            (condition for condition in CONDITIONS if condition in latest_prices),
            CONDITIONS[0],
        )
        primary_history = history[primary]
        latest_price = next((value for value in reversed(primary_history) if value is not None), 0)
        previous_price = next(
            (
                primary_history[index]
                for index in range(len(primary_history) - 2, -1, -1)
                if primary_history[index] is not None
            ),
            None,
        )
        earliest_price = next((value for value in primary_history if value is not None), None)
        models.append(
            {
                "id": f"model-{model_id}",
                "modelId": model_id,
                "model": meta["model"],
                "brand": meta["brand"],
                "brandShort": BRAND_SHORT.get(meta["brand"], "MO"),
                "mainMemory": main_memory,
                "configCount": len(pairs),
                "skuCount": len(pairs) * len(CONDITIONS),
                "primaryCondition": primary,
                "latestPrice": latest_price,
                "prevPrice": previous_price,
                "earliestPrice": earliest_price,
                "coverageDays": sum(value is not None for value in primary_history),
                "inTop100": model_id in top100_ids,
                "top100Rank": top100_rank.get(model_id),
                "conditions": history,
                "configs": configs,
            }
        )
    return models


def build_payload(args, loaded):
    dates = loaded["dates"]
    snapshots = loaded["snapshots"]
    snapshot_meta = loaded["snapshot_meta"]
    model_meta = loaded["model_meta"]
    top100_list, top100_rank, top100_dates = select_top100(loaded)
    top100_ids = set(top100_list)
    all_scope = scope_metrics(dates, snapshots, model_meta)
    top_scope = scope_metrics(dates, snapshots, model_meta, top100_ids)
    models = build_models(loaded, top100_ids, top100_rank)

    date_items = []
    previous_keys = None
    for day in dates:
        quality = snapshot_meta[day]
        keys = {key for key, value in snapshots[day].items() if value and value > 0}
        if previous_keys is None:
            matched = len(keys)
            matched_rate = 100.0
        else:
            matched = len(keys & previous_keys)
            matched_rate = round(matched / max(1, len(keys), len(previous_keys)) * 100, 1)
        previous_keys = keys
        date_items.append(
            {
                "date": day,
                "label": f"{int(day[5:7])}月{int(day[8:10])}日",
                "short": day[5:].replace("-", "."),
                "weekday": WEEKDAYS[datetime.strptime(day, "%Y-%m-%d").weekday()],
                "quality": {
                    "rows": quality["row_count"],
                    "uniqueKeys": quality["unique_keys"],
                    "validKeys": quality["valid_count"],
                    "zeroQuotes": quality["zero_count"],
                    "missingPrice": quality["missing_price_count"],
                    "missingMemory": 0,
                    "duplicates": quality["duplicate_count"],
                    "coverage": quality["coverage"],
                    "matched": matched,
                    "matchedRate": matched_rate,
                    "models": quality["model_count"],
                    "configs": quality["config_count"],
                    "brands": quality["brand_count"],
                    "skus": quality["valid_count"],
                    "status": quality["quality_status"],
                    "note": quality["quality_note"],
                    "rowCount": quality["row_count"],
                },
            }
        )

    brands = []
    for brand in sorted(all_scope["brands"]):
        latest_brand = all_scope["brands"][brand]["stats"][-1]
        top_brand = top_scope["brands"].get(brand, {}).get("stats", [{}])[-1]
        brand_models = [model for model in models if model["brand"] == brand]
        brands.append(
            {
                "id": f"brand-{brand}",
                "name": brand,
                "short": BRAND_SHORT.get(brand, "MO"),
                "models": len(brand_models),
                "skus": sum(model["skuCount"] for model in brand_models),
                "indexSeries": all_scope["brands"][brand]["indexSeries"],
                "stats": all_scope["brands"][brand]["stats"],
                "top100IndexSeries": top_scope["brands"].get(brand, {}).get(
                    "indexSeries", [100.0] * len(dates)
                ),
                "top100Stats": top_scope["brands"].get(brand, {}).get(
                    "stats", [{} for _ in dates]
                ),
                "latest": latest_brand,
                "top100Latest": top_brand,
            }
        )

    conditions = []
    for index, condition in enumerate(CONDITIONS):
        condition_data = all_scope["conditions"][condition]
        top_condition = top_scope["conditions"][condition]
        conditions.append(
            {
                "name": condition,
                "short": f"{index + 1:02d}",
                "color": CONDITION_COLORS[condition],
                "indexSeries": condition_data["indexSeries"],
                "stats": condition_data["stats"],
                "top100IndexSeries": top_condition["indexSeries"],
                "top100Stats": top_condition["stats"],
                "skus": sum(
                    1
                    for key, value in snapshots[dates[-1]].items()
                    if value and value > 0 and key[2] == condition
                ),
                "top100Skus": sum(
                    1
                    for key, value in snapshots[dates[-1]].items()
                    if value and value > 0 and key[2] == condition and key[0] in top100_ids
                ),
            }
        )

    top100_models = [model for model in models if model["inTop100"]]
    top100_models.sort(key=lambda model: model["top100Rank"])
    top100_up = sum(
        1
        for model in top100_models
        if model["prevPrice"] and model["latestPrice"] > model["prevPrice"]
    )
    top100_down = sum(
        1
        for model in top100_models
        if model["prevPrice"] and model["latestPrice"] < model["prevPrice"]
    )
    top100_flat = len(top100_models) - top100_up - top100_down
    latest_quality = date_items[-1]["quality"]
    status_counts = defaultdict(int)
    for item in date_items:
        status_counts[item["quality"]["status"]] += 1
    partial_dates = [
        {
            "date": item["date"],
            "short": item["short"],
            "status": item["quality"]["status"],
            "rowCount": item["quality"]["rowCount"],
            "note": item["quality"]["note"],
        }
        for item in date_items
        if item["quality"]["status"] in ("partial", "warning", "invalid")
    ]
    generated_at = datetime.now(SHANGHAI).isoformat(timespec="seconds")
    payload = {
        "meta": {
            "title": "价脉 Price Pulse · 手机市场行情监控",
            "businessDate": dates[-1],
            "dateFrom": dates[0],
            "dateTo": dates[-1],
            "updatedAt": generated_at[11:16],
            "generatedAt": generated_at,
            "source": "实时竞拍参考价",
            "sourceReportId": args.report_id if hasattr(args, "report_id") else "501211",
            "sourceProfile": "system",
            "demo": False,
            "note": (
                f"基于 Boss 系统版报表 501211 近 {len(dates)} 个自然日快照；"
                "只比较相邻日同 SKU，覆盖不足日不把缺失当作降价。"
            ),
            "totalModels": len(model_meta),
            "latestModels": latest_quality["models"],
            "latestConfigs": latest_quality["configs"],
            "latestSkus": latest_quality["skus"],
            "totalSkus": sum(item["quality"]["validKeys"] for item in date_items),
            "totalUniqueKeys": sum(item["quality"]["uniqueKeys"] for item in date_items),
            "storedDays": loaded["stored_days"],
            "analysisWindowDays": min(DEFAULT_WINDOW, len(dates)),
            "maxWindowDays": MAX_WINDOW,
            "qualityStatusCounts": dict(status_counts),
            "partialDates": partial_dates,
            "top100": len(top100_models),
            "top100Definition": "近 7 个完整可用日报价中靓机连续有价，按最新靓机市场价降序取前 100 款。",
            "top100SelectionDates": top100_dates,
            "anomalyLimit": ANOMALY_LIMIT,
            "targetModels": 1000,
            "configDataMode": "actual",
            "configNote": "机型详情按真实内存 ID/内存名称展示全部窗口行情与成色矩阵。",
            "memoryNameCoverage": 100.0,
            "uniqueKey": "日期 + 机型ID + 内存ID + 成色",
            "priceField": "应用价格（修正）",
            "publicDemo": False,
        },
        "dates": date_items,
        "market": {"all": all_scope, "top100": top_scope},
        "brands": brands,
        "conditions": conditions,
        "models": models,
        "top100Ids": top100_list,
        "summary": {
            "all": all_scope["stats"][-1],
            "top100": {
                **top_scope["stats"][-1],
                "upModels": top100_up,
                "downModels": top100_down,
                "flatModels": top100_flat,
            },
            "latestQuality": latest_quality,
            "partialDates": partial_dates,
        },
    }
    return payload


def main() -> None:
    args = parse_args()
    args.report_id = "501211"
    db_path = Path(args.db).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()
    loaded = load_database(db_path, args.days, args.end_date)
    dates = loaded["dates"]
    payload = build_payload(args, loaded)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "output": str(output),
                "sizeMB": round(output.stat().st_size / 1024 / 1024, 2),
                "dates": [dates[0], dates[-1]],
                "days": len(dates),
                "models": payload["meta"]["totalModels"],
                "latestModels": payload["meta"]["latestModels"],
                "top100": payload["meta"]["top100"],
                "validSkus": payload["meta"]["totalSkus"],
                "qualityStatusCounts": payload["meta"]["qualityStatusCounts"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
