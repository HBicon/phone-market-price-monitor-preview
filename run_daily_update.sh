#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/Users/hz/.nvm/versions/node/v24.19.0/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT_DIR="/Users/hz/Documents/ChatGPT/产品PRD/REQ-20261103-001-手机市场行情监控看板"
LOG_DIR="$PROJECT_DIR/data/logs"
mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR"

BUSINESS_DATE="${BUSINESS_DATE:-$(date -v-1d +%Y-%m-%d)}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/daily-$STAMP.log"
SUCCESS_MARKER="$LOG_DIR/published-$BUSINESS_DATE.ok"
CURRENT_HOUR=$((10#$(date +%H)))
FORCE_REFRESH="${1:-}"

business_has_data() {
  local database="$PROJECT_DIR/data/price_history.sqlite"
  local count
  [[ -f "$database" ]] || return 1
  count="$(sqlite3 "$database" "SELECT COUNT(*) FROM snapshots WHERE date = '$BUSINESS_DATE' AND row_count > 0 AND valid_count > 0 AND quality_status NOT IN ('failed', 'invalid');" 2>/dev/null || printf '0')"
  [[ "${count:-0}" -gt 0 ]]
}

business_publish_completed() {
  business_has_data && [[ -f "$SUCCESS_MARKER" ]]
}

{
  echo "[$(date '+%F %T %Z')] 开始更新，业务日期 $BUSINESS_DATE"
  # 06:00 / 07:00 是补跑窗口：数据已入库且当日发布成功时才跳过。
  if [[ "$FORCE_REFRESH" != "--force" ]] && (( CURRENT_HOUR >= 6 )) && business_publish_completed; then
    echo "业务日期 $BUSINESS_DATE 已有有效快照且发布完成，跳过本次补跑"
    exit 0
  fi
  # 05:00 拉取前一日已结算业务日；最近 3 个业务日强制重拉，补齐延迟结算批次。
  # 历史 180 天通过每日增量累积，不在每次任务中重复请求不存在的早期日期。
  python3 sync_market_data.py --days 4 --end-date "$BUSINESS_DATE" --refresh-last 3 --workers 2
  python3 build_dashboard_data.py --days 180 --db data/price_history.sqlite --output data/real/market_data_180d.js
  python3 prepare_public_data.py data/real/market_data_180d.js assets/data.js
  # 每日变更静态资源版本号，避免浏览器继续使用上一天的 data.js 缓存。
  sed -E -i '' "s/\\?v=[0-9A-Za-z-]+/\\?v=${STAMP}/g" index.html

  if git diff --quiet -- assets/data.js index.html app.js styles.css; then
    echo "数据与展示文件无变化，跳过提交"
    business_has_data || { echo "业务日期 $BUSINESS_DATE 仍无有效数据"; exit 1; }
    touch "$SUCCESS_MARKER"
    exit 0
  fi

  git add assets/data.js index.html app.js styles.css sync_market_data.py build_dashboard_data.py prepare_public_data.py
  git commit -m "data: 更新 $BUSINESS_DATE 行情快照"
  git push origin main
  echo "[$(date '+%F %T %Z')] 已推送，等待 GitHub Pages 发布"

  RUN_ID=""
  PAGES_OK=0
  for attempt in {1..40}; do
    RUN_ID="$(gh run list --workflow=pages.yml --branch=main --limit=1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
    if [[ -n "$RUN_ID" ]]; then
      STATUS="$(gh run view "$RUN_ID" --json status,conclusion --jq '.status + ":" + (.conclusion // "")')"
      echo "Pages run $RUN_ID：$STATUS"
      [[ "$STATUS" == "completed:success" ]] && { PAGES_OK=1; break; }
      [[ "$STATUS" == completed:* ]] && { echo "Pages 发布失败：$STATUS"; exit 1; }
    fi
    sleep 15
  done
  [[ "$PAGES_OK" -eq 1 ]] || { echo "未确认 GitHub Pages 发布成功"; exit 1; }
  touch "$SUCCESS_MARKER"
  echo "[$(date '+%F %T %Z')] 更新完成"
} 2>&1 | tee -a "$LOG_FILE"
