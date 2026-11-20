#!/bin/zsh
set -euo pipefail

export PATH="/opt/homebrew/bin:/Users/hz/.nvm/versions/node/v24.19.0/bin:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT_DIR="/Users/hz/Documents/ChatGPT/产品PRD/REQ-20261103-001-手机市场行情监控看板"
LOG_DIR="$PROJECT_DIR/data/logs"
mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR"

BUSINESS_DATE="$(date -v-1d +%Y-%m-%d)"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/daily-$STAMP.log"

{
  echo "[$(date '+%F %T %Z')] 开始更新，业务日期 $BUSINESS_DATE"
  # 05:00 拉取前一日已结算业务日；最近 3 个业务日强制重拉，补齐延迟结算批次。
  # 历史 180 天通过每日增量累积，不在每次任务中重复请求不存在的早期日期。
  python3 sync_market_data.py --days 4 --end-date "$BUSINESS_DATE" --refresh-last 3 --workers 2
  python3 build_dashboard_data.py --days 180 --db data/price_history.sqlite --output data/real/market_data_180d.js
  python3 prepare_public_data.py data/real/market_data_180d.js assets/data.js

  if git diff --quiet -- assets/data.js index.html app.js styles.css; then
    echo "数据与展示文件无变化，跳过提交"
    exit 0
  fi

  git add assets/data.js index.html app.js styles.css sync_market_data.py build_dashboard_data.py prepare_public_data.py
  git commit -m "data: 更新 $BUSINESS_DATE 行情快照"
  git push origin main
  echo "[$(date '+%F %T %Z')] 已推送，等待 GitHub Pages 发布"

  RUN_ID=""
  for attempt in {1..40}; do
    RUN_ID="$(gh run list --workflow=pages.yml --branch=main --limit=1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
    if [[ -n "$RUN_ID" ]]; then
      STATUS="$(gh run view "$RUN_ID" --json status,conclusion --jq '.status + ":" + (.conclusion // "")')"
      echo "Pages run $RUN_ID：$STATUS"
      [[ "$STATUS" == "completed:success" ]] && break
      [[ "$STATUS" == completed:* ]] && { echo "Pages 发布失败：$STATUS"; exit 1; }
    fi
    sleep 15
  done
  echo "[$(date '+%F %T %Z')] 更新完成"
} 2>&1 | tee -a "$LOG_FILE"
