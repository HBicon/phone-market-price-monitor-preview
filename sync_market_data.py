from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from openpyxl import load_workbook

CONDITIONS = {"靓机", "小花", "大花", "外爆", "内爆"}
REPORT_ID = "501211"
QUOTE_NAME = "实时竞拍参考价"
PROFILE = "system"
FIELDS = "报价单名称,报价单日期,机型id,机型名称,品牌,内存id,内存,成色名称,价格"
SHANGHAI = ZoneInfo("Asia/Shanghai")


@dataclass
class DayResult:
    date: str
    status: str
    task_id: str | None = None
    file_url: str | None = None
    file_path: str | None = None
    rows: int = 0
    message: str = ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="按日同步 Boss 报价单到本地 SQLite")
    parser.add_argument("--days", type=int, default=90, help="同步窗口，默认 90 天，可扩展到 180 天")
    parser.add_argument("--end-date", help="结束日期，默认今天（Asia/Shanghai）")
    parser.add_argument("--db", default="data/price_history.sqlite", help="SQLite 文件")
    parser.add_argument("--raw-dir", default="data/raw", help="原始 XLSX 保存目录")
    parser.add_argument("--report-id", default=REPORT_ID)
    parser.add_argument("--profile", default=PROFILE, choices=("system", "channel"))
    parser.add_argument("--workers", type=int, default=2, help="并发拉取数，默认 2")
    parser.add_argument("--force", action="store_true", help="覆盖已存在的日期")
    parser.add_argument(
        "--refresh-last",
        type=int,
        default=2,
        help="强制刷新窗口末尾 N 天，用于补取延迟结算或未完整导出的日报，默认 2",
    )
    parser.add_argument("--retries", type=int, default=3)
    return parser.parse_args()


def date_range(end_date: date, days: int) -> list[str]:
    if days < 1:
        raise SystemExit("--days 必须大于 0")
    return [(end_date - timedelta(days=offset)).isoformat() for offset in range(days - 1, -1, -1)]


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS snapshots (
          date TEXT PRIMARY KEY,
          report_id TEXT NOT NULL,
          profile TEXT NOT NULL,
          quote_name TEXT NOT NULL,
          source_file TEXT,
          download_url TEXT,
          task_id TEXT,
          row_count INTEGER NOT NULL DEFAULT 0,
          unique_keys INTEGER NOT NULL DEFAULT 0,
          valid_count INTEGER NOT NULL DEFAULT 0,
          zero_count INTEGER NOT NULL DEFAULT 0,
          missing_price_count INTEGER NOT NULL DEFAULT 0,
          duplicate_count INTEGER NOT NULL DEFAULT 0,
          duplicate_conflict_count INTEGER NOT NULL DEFAULT 0,
          model_count INTEGER NOT NULL DEFAULT 0,
          config_count INTEGER NOT NULL DEFAULT 0,
          brand_count INTEGER NOT NULL DEFAULT 0,
          coverage REAL NOT NULL DEFAULT 0,
          quality_status TEXT NOT NULL DEFAULT 'pending',
          quality_note TEXT,
          imported_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS quotes (
          date TEXT NOT NULL,
          model_id TEXT NOT NULL,
          model_name TEXT NOT NULL,
          brand TEXT NOT NULL,
          memory_id TEXT NOT NULL,
          memory_name TEXT,
          condition TEXT NOT NULL,
          price REAL,
          PRIMARY KEY (date, model_id, memory_id, condition)
        );

        CREATE INDEX IF NOT EXISTS idx_quotes_model_date
          ON quotes (model_id, date);
        CREATE INDEX IF NOT EXISTS idx_quotes_date_condition
          ON quotes (date, condition);

        CREATE TABLE IF NOT EXISTS sync_runs (
          run_at TEXT NOT NULL,
          requested_days INTEGER NOT NULL,
          end_date TEXT NOT NULL,
          report_id TEXT NOT NULL,
          profile TEXT NOT NULL,
          success_days INTEGER NOT NULL,
          failed_days INTEGER NOT NULL,
          total_rows INTEGER NOT NULL,
          note TEXT
        );
        """
    )
    return conn


def existing_dates(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        "SELECT date FROM snapshots WHERE row_count > 0 AND quality_status NOT IN ('invalid', 'failed')"
    ).fetchall()
    return {row[0] for row in rows}


def run_cli(day: str, report_id: str, profile: str, timeout: int = 180) -> dict:
    params = json.dumps({"报价单名称": QUOTE_NAME, "报价单日期": day}, ensure_ascii=False)
    command = [
        "shanhs-boss-cli",
        "report",
        "query",
        report_id,
        "--profile",
        profile,
        "--params",
        params,
        "--fields",
        FIELDS,
        "--timeout",
        str(timeout * 1000),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout + 20)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"CLI 返回失败：{detail[:800]}")
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"CLI 输出不是 JSON：{completed.stdout[:800]}") from error
    if payload.get("error"):
        raise RuntimeError(f"CLI 错误：{payload['error']}")
    if payload.get("status") != "EXPORT_FINISH" or not payload.get("fileUrl"):
        raise RuntimeError(f"导出未完成：{payload}")
    return payload


def download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    safe_url = urllib.parse.quote(url, safe=":/?&=%#")
    temporary = target.with_suffix(target.suffix + ".part")
    request = urllib.request.Request(safe_url, headers={"User-Agent": "price-pulse-sync/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
    temporary.replace(target)
    if target.stat().st_size < 1024:
        raise RuntimeError(f"下载文件异常，大小 {target.stat().st_size} 字节")


def normalize_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def normalize_date(value) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = normalize_text(value)
    return text[:10]


def parse_price(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"价格不是数值：{value!r}") from error
    if not math.isfinite(number):
        raise ValueError(f"价格不是有限数值：{value!r}")
    return number


def import_workbook(conn: sqlite3.Connection, workbook_path: Path, expected_date: str) -> dict:
    # The Boss export writes an incorrect worksheet dimension; openpyxl's
    # read-only iterator then stops after the header, so load the full sheet.
    workbook = load_workbook(workbook_path, read_only=False, data_only=True)
    try:
        sheet = workbook.active
        rows = sheet.iter_rows(values_only=True)
        header = next(rows, None)
        if not header:
            raise ValueError("报价单为空")
        columns = {normalize_text(name): index for index, name in enumerate(header)}
        price_key = "应用价格（修正）" if "应用价格（修正）" in columns else "价格"
        required = ["报价单名称", "报价单日期", "机型id", "机型名称", "品牌", "内存id", "成色名称", price_key]
        missing = [name for name in required if name not in columns]
        if missing:
            raise ValueError(f"缺少字段：{', '.join(missing)}")

        snapshot: dict[tuple[str, str, str], dict] = {}
        quality = {
            "rows": 0,
            "zero_count": 0,
            "missing_price_count": 0,
            "duplicate_count": 0,
            "duplicate_conflict_count": 0,
            "missing_memory_name": 0,
        }
        dates = set()
        quote_names = set()
        for raw in rows:
            if raw is None or all(value is None or value == "" for value in raw):
                continue
            quality["rows"] += 1
            day = normalize_date(raw[columns["报价单日期"]])
            if day != expected_date:
                raise ValueError(f"报价单日期 {day} 与请求日期 {expected_date} 不一致")
            dates.add(day)
            quote_names.add(normalize_text(raw[columns["报价单名称"]]))
            model_id = normalize_text(raw[columns["机型id"]])
            memory_id = normalize_text(raw[columns["内存id"]])
            condition = normalize_text(raw[columns["成色名称"]])
            if not model_id or not memory_id or condition not in CONDITIONS:
                raise ValueError(f"存在无效 SKU：机型={model_id!r} 内存={memory_id!r} 成色={condition!r}")
            model_name = normalize_text(raw[columns["机型名称"]])
            brand = normalize_text(raw[columns["品牌"]])
            memory_name = normalize_text(raw[columns["内存"]]) if "内存" in columns else ""
            if not memory_name:
                quality["missing_memory_name"] += 1
            price = parse_price(raw[columns[price_key]])
            if price is None:
                quality["missing_price_count"] += 1
            elif price == 0:
                quality["zero_count"] += 1
            key = (model_id, memory_id, condition)
            record = {
                "date": day,
                "model_id": model_id,
                "model_name": model_name,
                "brand": brand,
                "memory_id": memory_id,
                "memory_name": memory_name,
                "condition": condition,
                "price": price,
            }
            if key in snapshot:
                quality["duplicate_count"] += 1
                previous = snapshot[key]
                if (
                    previous["price"] != record["price"]
                    or previous["model_name"] != record["model_name"]
                    or previous["brand"] != record["brand"]
                ):
                    quality["duplicate_conflict_count"] += 1
                snapshot[key] = record
            else:
                snapshot[key] = record

        if dates != {expected_date}:
            raise ValueError(f"报价单日期集合异常：{sorted(dates)}")
        if quote_names != {QUOTE_NAME}:
            raise ValueError(f"报价单名称异常：{sorted(quote_names)}")
        if not snapshot:
            raise ValueError("没有可导入记录")

        records = list(snapshot.values())
        valid_count = sum(1 for record in records if record["price"] is not None and record["price"] > 0)
        unique_keys = len(records)
        coverage = round(valid_count / unique_keys * 100, 1) if unique_keys else 0.0
        models = {record["model_id"] for record in records}
        configs = {(record["model_id"], record["memory_id"]) for record in records}
        brands = {record["brand"] for record in records if record["brand"]}

        with conn:
            conn.execute("DELETE FROM quotes WHERE date = ?", (expected_date,))
            conn.executemany(
                """
                INSERT INTO quotes
                  (date, model_id, model_name, brand, memory_id, memory_name, condition, price)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        record["date"],
                        record["model_id"],
                        record["model_name"],
                        record["brand"],
                        record["memory_id"],
                        record["memory_name"],
                        record["condition"],
                        record["price"],
                    )
                    for record in records
                ],
            )
        return {
            **quality,
            "unique_keys": unique_keys,
            "valid_count": valid_count,
            "coverage": coverage,
            "model_count": len(models),
            "config_count": len(configs),
            "brand_count": len(brands),
        }
    finally:
        workbook.close()


def save_snapshot(
    conn: sqlite3.Connection,
    day: str,
    task: dict,
    source_file: Path,
    stats: dict,
    report_id: str,
    profile: str,
) -> None:
    now = datetime.now(SHANGHAI).isoformat(timespec="seconds")
    with conn:
        conn.execute(
            """
            INSERT INTO snapshots (
              date, report_id, profile, quote_name, source_file, download_url, task_id,
              row_count, unique_keys, valid_count, zero_count, missing_price_count,
              duplicate_count, duplicate_conflict_count, model_count, config_count,
              brand_count, coverage, quality_status, quality_note, imported_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET
              report_id=excluded.report_id,
              profile=excluded.profile,
              quote_name=excluded.quote_name,
              source_file=excluded.source_file,
              download_url=excluded.download_url,
              task_id=excluded.task_id,
              row_count=excluded.row_count,
              unique_keys=excluded.unique_keys,
              valid_count=excluded.valid_count,
              zero_count=excluded.zero_count,
              missing_price_count=excluded.missing_price_count,
              duplicate_count=excluded.duplicate_count,
              duplicate_conflict_count=excluded.duplicate_conflict_count,
              model_count=excluded.model_count,
              config_count=excluded.config_count,
              brand_count=excluded.brand_count,
              coverage=excluded.coverage,
              quality_status=excluded.quality_status,
              quality_note=excluded.quality_note,
              imported_at=excluded.imported_at
            """,
            (
                day,
                report_id,
                profile,
                QUOTE_NAME,
                str(source_file),
                task["fileUrl"],
                str(task.get("taskId", "")),
                stats["rows"],
                stats["unique_keys"],
                stats["valid_count"],
                stats["zero_count"],
                stats["missing_price_count"],
                stats["duplicate_count"],
                stats["duplicate_conflict_count"],
                stats["model_count"],
                stats["config_count"],
                stats["brand_count"],
                stats["coverage"],
                "invalid" if stats["duplicate_conflict_count"] else "pending",
                f"内存展示名缺失 {stats['missing_memory_name']} 条" if stats["missing_memory_name"] else None,
                now,
            ),
        )


def sync_day(day: str, args: argparse.Namespace, db_path: Path, raw_dir: Path) -> DayResult:
    last_error = ""
    for attempt in range(1, args.retries + 1):
        try:
            task = run_cli(day, args.report_id, args.profile)
            target = raw_dir / f"{day}.xlsx"
            download(task["fileUrl"], target)
            conn = connect(db_path)
            try:
                stats = import_workbook(conn, target, day)
                save_snapshot(conn, day, task, target, stats, args.report_id, args.profile)
            finally:
                conn.close()
            return DayResult(
                date=day,
                status="ok",
                task_id=str(task.get("taskId", "")),
                file_url=task["fileUrl"],
                file_path=str(target),
                rows=stats["rows"],
                message=f"有价 {stats['valid_count']}/{stats['unique_keys']}，机型 {stats['model_count']}",
            )
        except Exception as error:  # noqa: BLE001 - CLI/network failures must be reported per day.
            last_error = str(error)
            if attempt < args.retries:
                time.sleep(2 * attempt)
    return DayResult(date=day, status="failed", message=last_error)


def refresh_quality(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT date, row_count, duplicate_conflict_count
        FROM snapshots
        WHERE row_count > 0
        ORDER BY date
        """
    ).fetchall()
    if not rows:
        return
    records = [(row[0], int(row[1]), int(row[2])) for row in rows]
    updates = []
    for index, (day, row_count, conflicts) in enumerate(records):
        if conflicts:
            updates.append((day, "invalid", f"同日同 SKU 存在 {conflicts} 条冲突价格"))
            continue
        neighbors = []
        for distance in range(1, 8):
            for candidate_index in (index - distance, index + distance):
                if 0 <= candidate_index < len(records):
                    candidate_rows = records[candidate_index][1]
                    if candidate_rows > 0:
                        neighbors.append(candidate_rows)
        # Use the highest nearby coverage instead of the neighborhood median.
        # Consecutive half-sized exports would otherwise look "complete".
        baseline = max(neighbors) if neighbors else row_count
        ratio = row_count / baseline if baseline else 1.0
        if ratio < 0.75:
            status = "partial"
            note = f"仅 {row_count:,} 行，为近期最高覆盖 {baseline:,.0f} 行的 {ratio:.0%}；缺失 SKU 不按降价处理"
        elif ratio < 0.9:
            status = "warning"
            note = f"{row_count:,} 行，为近期最高覆盖 {baseline:,.0f} 行的 {ratio:.0%}，建议复核"
        else:
            status = "complete"
            note = None
        updates.append((day, status, note))
    with conn:
        conn.executemany(
            "UPDATE snapshots SET quality_status = ?, quality_note = ? WHERE date = ?",
            [(status, note, day) for day, status, note in updates],
        )


def print_summary(conn: sqlite3.Connection, days: int, results: list[DayResult], started: float) -> None:
    rows = conn.execute(
        """
        SELECT date, row_count, valid_count, quality_status, quality_note
        FROM snapshots
        ORDER BY date DESC
        LIMIT ?
        """,
        (days,),
    ).fetchall()
    status_counts: dict[str, int] = {}
    for row in rows:
        status_counts[row[3]] = status_counts.get(row[3], 0) + 1
    failures = [result for result in results if result.status == "failed"]
    partial = [row for row in rows if row[3] in ("partial", "warning", "invalid")]
    output = {
        "elapsedSeconds": round(time.monotonic() - started, 1),
        "requestedDays": days,
        "importedThisRun": sum(1 for result in results if result.status == "ok"),
        "failedThisRun": len(failures),
        "storedSnapshots": len(rows),
        "statusCounts": status_counts,
        "latestDate": rows[0][0] if rows else None,
        "latestRows": rows[0][1] if rows else 0,
        "partialDates": [
            {"date": row[0], "rows": row[1], "status": row[3], "note": row[4]}
            for row in reversed(partial)
        ],
        "failures": [{"date": result.date, "message": result.message} for result in failures],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    if failures:
        sys.exit(1)


def main() -> None:
    started = time.monotonic()
    args = parse_args()
    end_date = date.fromisoformat(args.end_date) if args.end_date else datetime.now(SHANGHAI).date()
    days = date_range(end_date, args.days)
    db_path = Path(args.db).expanduser().resolve()
    raw_dir = Path(args.raw_dir).expanduser().resolve()
    conn = connect(db_path)
    try:
        existing = existing_dates(conn)
    finally:
        conn.close()
    refresh_last = max(0, min(args.refresh_last, len(days)))
    refresh_days = set(days[-refresh_last:]) if refresh_last else set()
    pending = days if args.force else [day for day in days if day not in existing or day in refresh_days]
    print(
        json.dumps(
            {
                "reportId": args.report_id,
                "profile": args.profile,
                "environment": "production",
                "days": args.days,
                "dateFrom": days[0],
                "dateTo": days[-1],
                "alreadyStored": len(days) - len(pending),
                "toFetch": len(pending),
                "database": str(db_path),
                "workers": args.workers,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )

    results: list[DayResult] = []
    if pending:
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
            futures = {
                executor.submit(sync_day, day, args, db_path, raw_dir): day
                for day in pending
            }
            for future in as_completed(futures):
                result = future.result()
                results.append(result)
                print(
                    json.dumps(
                        {
                            "date": result.date,
                            "status": result.status,
                            "rows": result.rows,
                            "message": result.message,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )

    conn = connect(db_path)
    try:
        refresh_quality(conn)
        run_at = datetime.now(SHANGHAI).isoformat(timespec="seconds")
        with conn:
            conn.execute(
                """
                INSERT INTO sync_runs
                  (run_at, requested_days, end_date, report_id, profile,
                   success_days, failed_days, total_rows, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run_at,
                    args.days,
                    end_date.isoformat(),
                    args.report_id,
                    args.profile,
                    sum(1 for result in results if result.status == "ok"),
                    sum(1 for result in results if result.status == "failed"),
                    sum(result.rows for result in results),
                    "incremental" if pending else "no-op",
                ),
            )
        print_summary(conn, args.days, results, started)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
