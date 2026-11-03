(() => {
  "use strict";

  const data = window.MARKET_DEMO;
  if (!data) return;

  const CONDITIONS = ["靓机", "小花", "大花", "外爆", "内爆"];
  const CONDITION_COLORS = {
    靓机: "#171a16",
    小花: "#e85d3f",
    大花: "#c7962e",
    外爆: "#5d7772",
    内爆: "#53658a",
  };
  const numberFormat = new Intl.NumberFormat("zh-CN");
  const state = {
    condition: "全部",
    period: 30,
    brand: "all",
    tableCondition: "all",
    sort: "impact",
    query: "",
    pageSize: 8,
    visibleCount: 8,
    drawerMoverId: null,
    drawerCondition: null,
  };
  let toastTimer = null;
  let resizeFrame = null;

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const num = (value) => numberFormat.format(Number(value || 0));
  const fixed = (value, digits = 2) => Number(value || 0).toFixed(digits);

  const escapeHtml = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    })[character]);

  const signedPercent = (value, digits = 2) => {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    const current = Number(value);
    const sign = current > 0 ? "+" : current < 0 ? "−" : "";
    return `${sign}${Math.abs(current).toFixed(digits)}%`;
  };

  const signedMoney = (value) => {
    if (value === null || value === undefined) return "—";
    const current = Math.round(Number(value));
    if (!current) return "¥0";
    return `${current > 0 ? "+" : "−"}¥${num(Math.abs(current))}`;
  };

  const directionClass = (value) => (Number(value) > 0 ? "up-text" : Number(value) < 0 ? "down-text" : "");
  const directionName = (value) => (Number(value) > 0 ? "is-positive" : Number(value) < 0 ? "is-negative" : "is-neutral");
  const formatDate = (value) => value.slice(5).replace("-", ".");
  const conditionColor = (name) => CONDITION_COLORS[name] || "#73776e";

  function percentChange(current, previous) {
    if (!current || !previous) return null;
    return Number((((current / previous) - 1) * 100).toFixed(2));
  }

  function sparkline(values, color, width = 82, height = 26) {
    if (!values || values.length < 2) return "";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(max - min, 0.01);
    const stepX = width / (values.length - 1);
    const points = values.map((value, index) => {
      const x = index * stepX;
      const y = 2 + ((max - value) / range) * (height - 4);
      return [x, y];
    });
    const path = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
    const area = `${path} L${width},${height} L0,${height} Z`;
    const gradientId = `spark-${Math.random().toString(36).slice(2, 9)}`;
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".22"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${gradientId})"/>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${points.at(-1)[0]}" cy="${points.at(-1)[1]}" r="2" fill="${color}" stroke="var(--card)" stroke-width="1.2"/>
    </svg>`;
  }

  function setDirectionalText(element, value, suffix = "%") {
    if (!element) return;
    element.textContent = suffix === "%" ? signedPercent(value) : `${signedPercent(value)}${suffix}`;
    element.classList.remove("is-up", "is-down", "is-warn", "up-text", "down-text");
    if (Number(value) > 0) element.classList.add("is-up", "up-text");
    else if (Number(value) < 0) element.classList.add("is-down", "down-text");
    else element.classList.add("is-warn");
  }

  function showToast(message) {
    const toast = $("#toast");
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
  }

  function populateMeta() {
    const { meta, quality, market } = data;
    $("#heroModelCount").textContent = num(meta.models);
    $("#heroValidSkus").textContent = num(meta.validSkus);
    $("#heroCoverage").textContent = `${fixed(meta.coverage, 1)}%`;
    $("#sideValidSkus").textContent = num(meta.validSkus);
    $("#sideCoverage").textContent = `${fixed(meta.coverage, 1)}%`;
    $("#sideCoverageBar").style.width = `${meta.coverage}%`;
    $("#validSkus").textContent = num(meta.validSkus);
    $("#zeroQuotes").textContent = num(meta.zeroQuotes);
    $("#coverageRingText").textContent = `${Math.round(meta.coverage)}%`;
    $("#coverageRing").style.background = `conic-gradient(var(--ink) 0 ${meta.coverage}%, var(--paper-deep) ${meta.coverage}% 100%)`;
    $("#anomalyCount").textContent = num(market.anomalies);
    $("#anomalyDelta").textContent = `+${Math.round(((market.anomalies / market.anomalyBaseline) - 1) * 100)}%`;
    $("#upCount").textContent = num(market.up);
    $("#downCount").textContent = num(market.down);
    $("#flatCount").textContent = num(market.flat);
    $("#upDownRatio").textContent = fixed(market.up / market.down, 2);
    const total = market.up + market.down + market.flat;
    $("#upBar").style.width = `${(market.up / total) * 100}%`;
    $("#flatBar").style.width = `${(market.flat / total) * 100}%`;
    $("#downBar").style.width = `${(market.down / total) * 100}%`;
    $("#footerDemoNote").textContent = meta.demoNote;
    $("#tapeTime").textContent = `UPDATED ${meta.updatedAt}`;

    const qualityValues = $$(".quality-metrics > div");
    if (qualityValues[0]) {
      qualityValues[0].querySelector("strong").textContent = "100%";
      qualityValues[0].querySelector("small").textContent = `${num(quality.skus)} / ${num(quality.skus)}`;
    }
    if (qualityValues[1]) {
      qualityValues[1].querySelector("strong").textContent = `${fixed(quality.matchedRate, 1)}%`;
    }
    if (qualityValues[2]) {
      qualityValues[2].querySelector("strong").textContent = num(quality.duplicateRows);
    }
    if (qualityValues[3]) {
      qualityValues[3].querySelector("strong").textContent = num(quality.zeroQuotes);
    }
  }

  function populateTape() {
    const items = [
      `<span>市场 ${fixed(data.market.index, 2)}</span><span class="${directionClass(data.market.change)}">${signedPercent(data.market.change)}</span>`,
      ...data.brands.map(
        (brand) => `<strong>${escapeHtml(brand.name)}</strong><span class="${directionClass(brand.change)}">${signedPercent(brand.change)}</span>`,
      ),
    ];
    const markup = items
      .map((content) => `<div class="tape-item">${content}</div>`)
      .join("");
    $("#marketTape").innerHTML = markup + markup;
  }

  function currentMarketSeries() {
    if (state.condition === "全部") {
      return { values: data.market.series, index: data.market.index, change: data.market.change };
    }
    const condition = data.conditions.find((item) => item.name === state.condition);
    return condition
      ? { ...condition, values: condition.series }
      : { values: data.market.series, index: data.market.index, change: data.market.change };
  }

  function updateMetricSummary() {
    const active = currentMarketSeries();
    const label = state.condition === "全部" ? "市场基准指数" : `${state.condition}指数`;
    $("#metricIndexLabel").textContent = label;
    $("#marketIndex").textContent = fixed(active.index, 2);
    setDirectionalText($("#marketChange"), active.change, "%");
    $("#marketSpark").innerHTML = sparkline(
      active.values.slice(-12),
      state.condition === "全部" ? "#c8ef6a" : conditionColor(state.condition),
      88,
      25,
    );
  }

  function chartConfig() {
    const pointCount = state.period + 1;
    const labels = data.timeline.slice(-pointCount);
    const series = data.conditions
      .filter((condition) => state.condition === "全部" || condition.name === state.condition)
      .map((condition) => ({
        name: condition.name,
        color: condition.color,
        skus: condition.skus,
        values: condition.series.slice(-pointCount),
        change: condition.change,
      }));

    let summarySeries;
    let summaryLabel;
    if (state.condition === "全部") {
      summarySeries = data.market.series.slice(-pointCount);
      summaryLabel = "全市场";
    } else {
      summarySeries = series[0].values;
      summaryLabel = state.condition;
    }
    const periodChange = percentChange(summarySeries.at(-1), summarySeries[0]);
    return { labels, series, summarySeries, summaryLabel, periodChange };
  }

  function renderMarketChart() {
    const container = $("#marketChart");
    if (!container) return;
    const config = chartConfig();
    const styles = getComputedStyle(container);
    const width = Math.max(300, container.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight));
    const height = Math.max(230, container.clientHeight);
    const margin = { top: 20, right: 14, bottom: 29, left: 43 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const allValues = config.series.flatMap((item) => item.values);
    let min = Math.min(...allValues);
    let max = Math.max(...allValues);
    const range = Math.max(max - min, 0.45);
    min -= range * 0.18;
    max += range * 0.18;
    const pointCount = config.labels.length;
    const x = (index) => margin.left + (index / (pointCount - 1)) * plotWidth;
    const y = (value) => margin.top + ((max - value) / (max - min)) * plotHeight;

    let gridMarkup = "";
    for (let index = 0; index <= 4; index += 1) {
      const yPosition = margin.top + (index / 4) * plotHeight;
      const value = max - (index / 4) * (max - min);
      gridMarkup += `<line class="chart-grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${yPosition}" y2="${yPosition}"/>
        <text class="chart-axis-text" x="${margin.left - 10}" y="${yPosition + 3}" text-anchor="end">${value.toFixed(1)}</text>`;
    }

    const tickIndexes = [...new Set([0, Math.round((pointCount - 1) / 3), Math.round(((pointCount - 1) * 2) / 3), pointCount - 1])];
    const xLabels = tickIndexes
      .map((index) => {
        const anchor = index === 0 ? "start" : index === pointCount - 1 ? "end" : "middle";
        return `<text class="chart-x-label" x="${x(index)}" y="${height - 8}" text-anchor="${anchor}">${formatDate(config.labels[index])}</text>`;
      })
      .join("");

    const lineMarkup = config.series
      .map((item) => {
        const path = item.values
          .map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`)
          .join(" ");
        const isMuted = state.condition !== "全部";
        return `<g class="chart-series" data-series="${escapeHtml(item.name)}">
          <path class="chart-line ${isMuted ? "is-focused" : ""}" d="${path}" stroke="${item.color}"/>
          <circle class="chart-end-dot" cx="${x(pointCount - 1)}" cy="${y(item.values.at(-1))}" r="3.1" fill="${item.color}"/>
        </g>`;
      })
      .join("");

    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="成色价格指数趋势图">
      ${gridMarkup}${xLabels}${lineMarkup}
      <g class="chart-cursor" visibility="hidden"><line class="chart-cursor-line" y1="${margin.top}" y2="${margin.top + plotHeight}"/><g class="chart-cursor-dots"></g></g>
      <rect class="chart-hover-area" x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" fill="transparent"/>
    </svg><div class="chart-tooltip" hidden></div>`;

    const tooltip = $(".chart-tooltip", container);
    const cursor = $(".chart-cursor", container);
    const cursorLine = $(".chart-cursor-line", container);
    const cursorDots = $(".chart-cursor-dots", container);
    const hoverArea = $(".chart-hover-area", container);
    const leftPadding = parseFloat(styles.paddingLeft);

    hoverArea.addEventListener("pointermove", (event) => {
      const rect = container.getBoundingClientRect();
      const localX = event.clientX - rect.left - leftPadding;
      const plotX = Math.min(plotWidth, Math.max(0, localX - margin.left));
      const index = Math.round((plotX / plotWidth) * (pointCount - 1));
      const cursorX = x(index);
      cursor.setAttribute("visibility", "visible");
      cursorLine.setAttribute("x1", cursorX);
      cursorLine.setAttribute("x2", cursorX);
      cursorDots.innerHTML = config.series
        .map(
          (item) =>
            `<circle class="chart-cursor-dot" cx="${cursorX}" cy="${y(item.values[index])}" r="3.2" fill="${item.color}"/>`,
        )
        .join("");
      tooltip.hidden = false;
      tooltip.innerHTML = `<div class="tooltip-date">${config.labels[index]} · ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(`${config.labels[index]}T12:00:00`).getDay()]}</div>${config.series
        .map(
          (item) => `<div class="tooltip-row"><span><i style="background:${item.color}"></i>${escapeHtml(item.name)}</span><strong>${item.values[index].toFixed(2)}</strong></div>`,
        )
        .join("")}`;
      const approximateY = y(Math.max(...config.series.map((item) => item.values[index])));
      tooltip.style.left = `${leftPadding + cursorX}px`;
      tooltip.style.top = `${Math.max(38, approximateY)}px`;
      tooltip.classList.toggle("is-flipped", cursorX > plotWidth * 0.68);
      tooltip.classList.toggle("is-below", approximateY < 93);
    });

    hoverArea.addEventListener("pointerleave", () => {
      cursor.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
    });

    const active = currentMarketSeries();
    $("#chartSummaryLabel").textContent = `${config.summaryLabel} · ${state.period}天`;
    $("#chartSummaryValue").textContent = fixed(active.index, 2);
    const deltaElement = $("#chartSummaryDelta");
    deltaElement.textContent = signedPercent(config.periodChange);
    deltaElement.className = directionClass(config.periodChange);

    if (state.condition === "全部") {
      const sortedConditions = [...data.conditions].sort((a, b) => a.change - b.change);
      const weakest = sortedConditions[0];
      const strongest = sortedConditions.at(-1);
      $("#chartSummaryNote").textContent = `${weakest.name}跌幅居前，${strongest.name}报价${strongest.change >= 0 ? "逆势回升" : "相对抗跌"}。`;
    } else {
      const activeCondition = data.conditions.find((item) => item.name === state.condition);
      $("#chartSummaryNote").textContent = `${activeCondition.name}样本 ${num(activeCondition.skus)} 个，今日较上一交易日${activeCondition.change >= 0 ? "上行" : "回落"}。`;
    }
  }

  function renderLegend() {
    const legend = $("#chartLegend");
    legend.innerHTML = data.conditions
      .map(
        (condition) => `<button class="legend-item ${state.condition === condition.name ? "is-active" : ""}" type="button" data-condition-legend="${condition.name}" style="--legend-color:${condition.color}">
          <i></i><span>${condition.name}</span><strong>${condition.index.toFixed(2)}</strong>
        </button>`,
      )
      .join("");
  }

  function renderSignals() {
    const appleMover = data.movers.find((mover) => mover.brand === "苹果" && mover.change1d < 0) || data.movers[0];
    const honor = data.brands.find((brand) => brand.name === "荣耀") || [...data.brands].sort((a, b) => a.change - b.change)[0];
    const weakestCondition = [...data.conditions].sort((a, b) => a.change - b.change)[0];
    const strongestCondition = [...data.conditions].sort((a, b) => b.change - a.change)[0];
    const spread = Number((weakestCondition.change - strongestCondition.change).toFixed(2));

    $("#signalList").innerHTML = `
      <div class="signal-item" data-mover-id="${appleMover.id}" tabindex="0" role="button" aria-label="查看 ${escapeHtml(appleMover.model)} 详情">
        <span class="signal-index">01</span>
        <div class="signal-main">
          <div class="signal-tagline"><span>MODEL / 单款异动</span><span class="severity">高</span></div>
          <strong>${escapeHtml(appleMover.model)} · ${escapeHtml(appleMover.memory)}</strong>
          <p>${escapeHtml(appleMover.condition)}单日价格跌至 30 日波动区间下沿，成交量待确认。</p>
        </div>
        <span class="signal-delta ${directionClass(appleMover.change1d)}">${signedPercent(appleMover.change1d)}</span>
      </div>
      <div class="signal-item" data-brand-filter="${escapeHtml(honor.name)}" tabindex="0" role="button" aria-label="筛选 ${escapeHtml(honor.name)} 品牌">
        <span class="signal-index">02</span>
        <div class="signal-main">
          <div class="signal-tagline"><span>BRAND / 品牌风险</span><span class="severity is-watch">关注</span></div>
          <strong>${escapeHtml(honor.name)}品牌连续走弱</strong>
          <p>品牌指数 ${honor.index.toFixed(2)}，小花与大花成色同步承压。</p>
        </div>
        <span class="signal-delta ${directionClass(honor.change)}">${signedPercent(honor.change)}</span>
      </div>
      <div class="signal-item">
        <span class="signal-index">03</span>
        <div class="signal-main">
          <div class="signal-tagline"><span>CONDITION / 成色结构</span><span class="severity is-observe">观察</span></div>
          <strong>成色价差继续分化</strong>
          <p>${weakestCondition.name}与${strongestCondition.name}单日走势相差 ${Math.abs(spread).toFixed(2)}pp。</p>
        </div>
        <span class="signal-delta down-text">${spread > 0 ? "+" : "−"}${Math.abs(spread).toFixed(2)}pp</span>
      </div>`;
  }

  function renderHeatmap() {
    const headers = CONDITIONS
      .map((condition) => `<div class="heat-cell heat-head ${state.condition === condition ? "is-active" : ""}">${condition}</div>`)
      .join("");
    const rows = data.brands
      .map(
        (brand) => `<div class="heat-brand ${state.brand === brand.name ? "is-active" : ""}" data-brand-filter="${escapeHtml(brand.name)}" tabindex="0" role="button" aria-label="筛选 ${escapeHtml(brand.name)} 品牌">
          <span class="brand-monogram">${brand.short}</span><span>${escapeHtml(brand.name)}</span>
        </div>${CONDITIONS.map((condition) => {
          const value = brand.conditions[condition].change;
          const ratio = Math.min(1, Math.abs(value) / 1.45);
          const alpha = 0.055 + ratio * 0.35;
          const background = value > 0 ? `rgba(217,79,53,${alpha})` : value < 0 ? `rgba(20,118,95,${alpha})` : "rgba(233,228,215,.6)";
          const color = ratio > 0.7 ? "#fffaf4" : value > 0 ? "#642014" : value < 0 ? "#084a3c" : "var(--muted)";
          return `<div class="heat-cell ${directionName(value)}" data-heat-brand="${escapeHtml(brand.name)}" data-heat-condition="${condition}" tabindex="0" role="button" aria-label="筛选 ${escapeHtml(brand.name)} ${condition}" style="background:${background};color:${color}" title="点击筛选 ${escapeHtml(brand.name)} · ${condition} ${signedPercent(value)}">${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}</div>`;
        }).join("")}`,
      )
      .join("");
    $("#brandHeatmap").innerHTML = `<div class="heat-corner">品牌 / 成色</div>${headers}${rows}`;
  }

  function renderBrandRanking() {
    const selectedCondition = state.condition;
    const activeChange = (brand) =>
      selectedCondition === "全部" ? brand.change : brand.conditions[selectedCondition].change;
    const activeIndex = (brand) =>
      selectedCondition === "全部" ? brand.index : brand.conditions[selectedCondition].index;
    const rankedBrands = [...data.brands].sort((a, b) => activeChange(b) - activeChange(a));
    const maxChange = Math.max(...rankedBrands.map((brand) => Math.abs(activeChange(brand))), 0.1);
    $("#brandRankingTitle").textContent = selectedCondition === "全部" ? "品牌日涨跌排行" : `品牌日涨跌 · ${selectedCondition}`;
    $("#brandRanking").innerHTML = rankedBrands
      .map((brand, index) => {
        const daily = activeChange(brand);
        const width = Math.max(4, Math.min(50, (Math.abs(daily) / maxChange) * 50));
        const total = Math.max(1, brand.up + brand.down + brand.flat);
        const upShare = (brand.up / total) * 100;
        const downShare = (brand.down / total) * 100;
        return `<div class="brand-row ${state.brand === brand.name ? "is-active" : ""}" data-brand-filter="${escapeHtml(brand.name)}" tabindex="0" role="button" aria-label="筛选 ${escapeHtml(brand.name)} 品牌">
          <span class="brand-rank">${String(index + 1).padStart(2, "0")}</span>
          <span class="brand-monogram">${brand.short}</span>
          <span class="brand-row-name"><strong>${escapeHtml(brand.name)}</strong><small>${num(brand.models)} 款机型</small></span>
          <span class="brand-row-index">${activeIndex(brand).toFixed(2)}</span>
          <span class="brand-row-change ${directionClass(daily)}">${signedPercent(daily)}</span>
          <div class="brand-meter">
            <div class="brand-bar-track"><span class="${daily >= 0 ? "is-positive" : "is-negative"}" style="width:${width}%"></span></div>
            ${selectedCondition === "全部" ? `<div class="brand-share"><i class="share-up" style="width:${upShare}%"></i><i class="share-down" style="width:${downShare}%"></i></div>` : ""}
          </div>
        </div>`;
      })
      .join("");
    $(".ranking-panel .ranking-foot").innerHTML = selectedCondition === "全部"
      ? `<span><i class="legend-square up-bg"></i>上涨 SKU 占比</span><span><i class="legend-square down-bg"></i>下跌 SKU 占比</span>`
      : `<span><i class="legend-square up-bg"></i>${selectedCondition}日涨跌幅</span><span>同品牌 · 同成色可比样本</span>`;
  }

  function populateBrandFilter() {
    const select = $("#brandFilter");
    select.innerHTML = `<option value="all">全部品牌</option>${data.brands
      .map((brand) => `<option value="${escapeHtml(brand.name)}">${escapeHtml(brand.name)}</option>`)
      .join("")}`;
  }

  function filteredMovers() {
    const query = state.query.trim().toLowerCase();
    let rows = data.movers.filter((mover) => {
      const matchesQuery = !query || `${mover.model} ${mover.brand} ${mover.memory}`.toLowerCase().includes(query);
      const matchesBrand = state.brand === "all" || mover.brand === state.brand;
      const matchesCondition = state.tableCondition === "all" || mover.condition === state.tableCondition;
      return matchesQuery && matchesBrand && matchesCondition;
    });

    rows = [...rows];
    if (state.sort === "up") rows.sort((a, b) => b.change1d - a.change1d);
    else if (state.sort === "down") rows.sort((a, b) => a.change1d - b.change1d);
    else if (state.sort === "price") rows.sort((a, b) => b.price - a.price);
    else rows.sort((a, b) => Math.abs(b.change1d) * Math.log10(b.price + 10) - Math.abs(a.change1d) * Math.log10(a.price + 10));
    return rows;
  }

  function statusForMover(mover) {
    const absolute = Math.abs(mover.change1d);
    if (absolute >= 3) return { text: "大幅异动", className: "is-alert" };
    if (absolute >= 1.5) return { text: "持续观察", className: "is-watch" };
    return { text: "价格平稳", className: "is-calm" };
  }

  function renderTable() {
    const rows = filteredMovers();
    const visible = rows.slice(0, state.visibleCount);
    const table = $(".table-wrap table");
    const emptyState = $("#emptyState");
    const loadMore = $("#loadMore");

    if (!visible.length) {
      $("#modelRows").innerHTML = "";
      table.hidden = true;
      emptyState.hidden = false;
      loadMore.hidden = true;
      $("#resultCount").textContent = "0 个异动 SKU";
    } else {
      table.hidden = false;
      emptyState.hidden = true;
      $("#modelRows").innerHTML = visible
        .map((mover) => {
          const status = statusForMover(mover);
          return `<tr data-mover-id="${mover.id}" tabindex="0" aria-label="查看 ${escapeHtml(mover.model)} ${escapeHtml(mover.condition)} 详情">
            <td><div class="model-cell"><span class="model-badge">${mover.brandShort}</span><div><strong>${escapeHtml(mover.model)}</strong><small>MODEL ID · ${escapeHtml(mover.modelId)}</small></div></div></td>
            <td><span class="brand-text">${escapeHtml(mover.brand)}</span></td>
            <td><span class="memory-pill">${escapeHtml(mover.memory)}</span></td>
            <td><span class="condition-badge"><i style="background:${conditionColor(mover.condition)}"></i>${escapeHtml(mover.condition)}</span></td>
            <td class="align-right"><span class="price-value">¥${num(mover.price)}</span></td>
            <td class="align-right"><div class="delta-cell"><span class="delta-main ${directionClass(mover.change1d)}">${signedPercent(mover.change1d)}</span><span class="delta-sub">${signedMoney(mover.changeAmount)}</span></div></td>
            <td class="align-right hide-tablet"><span class="${directionClass(mover.change7d)}">${signedPercent(mover.change7d)}</span></td>
            <td class="spark-col hide-tablet"><div class="spark-cell">${sparkline(mover.spark, conditionColor(mover.condition), 75, 24)}</div></td>
            <td class="align-right hide-tablet"><span class="status-badge ${status.className}">${status.text}</span></td>
            <td class="chevron-col"><span class="row-chevron"><svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></svg></span></td>
          </tr>`;
        })
        .join("");
      loadMore.hidden = rows.length <= state.visibleCount;
      $("#resultCount").textContent = `显示 1–${visible.length} / ${rows.length} 个异动 SKU`;
    }

    const hasFilter = state.brand !== "all" || state.tableCondition !== "all" || state.query.trim() !== "";
    $("#clearFilters").hidden = !hasFilter;
  }

  function syncFilterUi() {
    $$(".condition-pill").forEach((pill) => pill.classList.toggle("is-active", pill.dataset.condition === state.condition));
    $$(".period-switch button").forEach((button) => button.classList.toggle("is-active", Number(button.dataset.period) === state.period));
    $("#brandFilter").value = state.brand;
    $("#conditionFilter").value = state.tableCondition;
    $("#sortFilter").value = state.sort;
  }

  function syncActiveBrand() {
    $$("[data-brand-filter]").forEach((element) => {
      if (element.classList.contains("brand-row") || element.classList.contains("heat-brand")) {
        element.classList.toggle("is-active", element.dataset.brandFilter === state.brand);
      }
    });
  }

  function setCondition(condition, options = {}) {
    state.condition = condition;
    state.tableCondition = condition === "全部" ? "all" : condition;
    state.visibleCount = state.pageSize;
    syncFilterUi();
    updateMetricSummary();
    renderMarketChart();
    renderLegend();
    renderHeatmap();
    renderBrandRanking();
    renderTable();
    if (options.notify) showToast(`已切换至${condition === "全部" ? "全部成色" : condition}`);
  }

  function setBrand(brand, options = {}) {
    state.brand = brand;
    state.visibleCount = state.pageSize;
    syncFilterUi();
    syncActiveBrand();
    renderTable();
    if (options.scroll) $("#models").scrollIntoView({ behavior: "smooth", block: "start" });
    if (options.notify) showToast(`已筛选 ${brand} 品牌`);
  }

  function resetFilters() {
    state.brand = "all";
    state.query = "";
    state.tableCondition = "all";
    state.condition = "全部";
    state.visibleCount = state.pageSize;
    $("#modelSearch").value = "";
    syncFilterUi();
    syncActiveBrand();
    updateMetricSummary();
    renderMarketChart();
    renderLegend();
    renderTable();
    showToast("筛选条件已清空");
  }

  function csvCell(value) {
    const text = String(value ?? "").replace(/"/g, '""');
    return `"${text}"`;
  }

  function exportCsv() {
    const rows = filteredMovers();
    if (!rows.length) {
      showToast("当前筛选结果为空，无法导出");
      return;
    }
    const headers = ["业务日期", "机型ID", "机型", "品牌", "内存", "成色", "今日价", "昨日价", "日涨跌幅", "7日涨跌幅", "30日涨跌幅"];
    const body = rows.map((mover) => [
      data.meta.businessDate,
      mover.modelId,
      mover.model,
      mover.brand,
      mover.memory,
      mover.condition,
      mover.price,
      mover.prevPrice,
      `${mover.change1d}%`,
      `${mover.change7d}%`,
      `${mover.change30d}%`,
    ]);
    const csv = `\uFEFF${[headers, ...body].map((line) => line.map(csvCell).join(",")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `手机市场行情_${data.meta.businessDate.replaceAll("-", "")}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${rows.length} 条演示数据`);
  }

  function openDrawer(moverId) {
    const mover = data.movers.find((item) => item.id === moverId);
    if (!mover) return;
    state.drawerMoverId = mover.id;
    state.drawerCondition = mover.condition;
    $("#drawerTitle").textContent = mover.model;
    $("#drawerBrand").textContent = mover.brand;
    $("#drawerMemory").textContent = mover.memory;
    renderDrawer();
    const backdrop = $("#drawerBackdrop");
    const drawer = $("#detailDrawer");
    backdrop.hidden = false;
    drawer.setAttribute("aria-hidden", "false");
    document.body.classList.add("drawer-open");
    requestAnimationFrame(() => {
      backdrop.classList.add("is-visible");
      drawer.classList.add("is-open");
    });
    window.setTimeout(() => $("#drawerClose").focus(), 80);
  }

  function closeDrawer() {
    const backdrop = $("#drawerBackdrop");
    const drawer = $("#detailDrawer");
    backdrop.classList.remove("is-visible");
    drawer.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
    document.body.classList.remove("drawer-open");
    window.setTimeout(() => {
      backdrop.hidden = true;
      state.drawerMoverId = null;
    }, 260);
  }

  function renderDrawer() {
    const mover = data.movers.find((item) => item.id === state.drawerMoverId);
    if (!mover) return;
    const condition = state.drawerCondition;
    const price = mover.conditions[condition];
    const history = mover.conditionHistory[condition] || [];
    const dailyChange = history.length > 1 ? percentChange(history.at(-1), history.at(-2)) : null;
    const changeAmount = history.length > 1 ? history.at(-1) - history.at(-2) : 0;

    $("#drawerCondition").textContent = `${condition} · 当前价`;
    $("#drawerPrice").textContent = price ? `¥${num(price)}` : "—";
    const delta = $("#drawerChange");
    delta.textContent = dailyChange === null ? "—" : `${signedPercent(dailyChange)} / ${signedMoney(changeAmount)}`;
    delta.className = `price-delta ${directionClass(dailyChange)}`;

    $("#drawerConditionTabs").innerHTML = CONDITIONS.map(
      (item) => `<button type="button" data-drawer-condition="${item}" class="${item === condition ? "is-active" : ""}" ${mover.conditions[item] ? "" : "disabled"}>${item}</button>`,
    ).join("");

    const validPrices = CONDITIONS.map((item) => mover.conditions[item]).filter(Boolean);
    const maxPrice = Math.max(...validPrices, 1);
    $("#conditionLadder").innerHTML = CONDITIONS.map((item) => {
      const itemPrice = mover.conditions[item];
      return `<div class="ladder-row">
        <span class="ladder-name"><i style="background:${conditionColor(item)}"></i>${item}</span>
        <span class="ladder-bar"><span style="width:${itemPrice ? Math.max(5, (itemPrice / maxPrice) * 100) : 0}%;background:${conditionColor(item)}"></span></span>
        <span class="ladder-price">${itemPrice ? `¥${num(itemPrice)}` : "暂无报价"}</span>
      </div>`;
    }).join("");

    const change7d = history.length > 8 ? percentChange(history.at(-1), history.at(-8)) : null;
    const change30d = history.length > 1 ? percentChange(history.at(-1), history[0]) : null;
    $("#drawer7d").textContent = signedPercent(change7d);
    $("#drawer7d").className = directionClass(change7d);
    $("#drawer30d").textContent = signedPercent(change30d);
    $("#drawer30d").className = directionClass(change30d);
    $("#drawerMatched").textContent = `${mover.matchedDays} / 31 天`;

    drawDrawerChart(history, conditionColor(condition));
  }

  function drawDrawerChart(values, color) {
    const container = $("#drawerChart");
    if (!values.length) {
      container.innerHTML = `<div class="empty-state"><strong>暂无可比价格</strong><span>该成色在近 30 天没有有效报价。</span></div>`;
      return;
    }
    const width = Math.max(260, container.clientWidth);
    const height = Math.max(170, container.clientHeight);
    const margin = { top: 13, right: 9, bottom: 24, left: 35 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const labels = data.timeline.slice(-values.length);
    let min = Math.min(...values);
    let max = Math.max(...values);
    const range = Math.max(max - min, 1);
    min -= range * 0.18;
    max += range * 0.18;
    const x = (index) => margin.left + (index / Math.max(1, values.length - 1)) * plotWidth;
    const y = (value) => margin.top + ((max - value) / (max - min)) * plotHeight;
    const path = values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    const area = `${path} L${x(values.length - 1)},${margin.top + plotHeight} L${x(0)},${margin.top + plotHeight} Z`;
    let grid = "";
    for (let index = 0; index <= 3; index += 1) {
      const yPosition = margin.top + (index / 3) * plotHeight;
      const value = max - (index / 3) * (max - min);
      grid += `<line class="chart-grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${yPosition}" y2="${yPosition}"/><text class="chart-axis-text" x="${margin.left - 8}" y="${yPosition + 3}" text-anchor="end">${Math.round(value)}</text>`;
    }
    const gradientId = `drawer-area-${Math.random().toString(36).slice(2, 9)}`;
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="近30日价格走势">
      <defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".18"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      ${grid}<path d="${area}" fill="url(#${gradientId})"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(values.length - 1)}" cy="${y(values.at(-1))}" r="3.5" fill="${color}" stroke="var(--card)" stroke-width="2"/>
      <text class="chart-x-label" x="${margin.left}" y="${height - 6}" text-anchor="start">${formatDate(labels[0])}</text>
      <text class="chart-x-label" x="${width - margin.right}" y="${height - 6}" text-anchor="end">${formatDate(labels.at(-1))}</text>
    </svg>`;
  }

  function openMethods() {
    const dialog = $("#methodDialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeMethods() {
    const dialog = $("#methodDialog");
    if (dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  }

  function setActiveNavigation(sectionId) {
    $$(".side-link, .mobile-nav button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.scroll === sectionId);
    });
  }

  function scrollToSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveNavigation(sectionId);
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const conditionPill = event.target.closest(".condition-pill");
      if (conditionPill) {
        setCondition(conditionPill.dataset.condition, { notify: true });
        return;
      }

      const legendButton = event.target.closest("[data-condition-legend]");
      if (legendButton) {
        const next = state.condition === legendButton.dataset.conditionLegend ? "全部" : legendButton.dataset.conditionLegend;
        setCondition(next);
        return;
      }

      const periodButton = event.target.closest("[data-period]");
      if (periodButton) {
        state.period = Number(periodButton.dataset.period);
        syncFilterUi();
        renderMarketChart();
        return;
      }

      const brandTarget = event.target.closest("[data-brand-filter]");
      if (brandTarget) {
        setBrand(brandTarget.dataset.brandFilter, { scroll: brandTarget.closest(".signal-item") !== null, notify: true });
        return;
      }

      const heatTarget = event.target.closest("[data-heat-brand]");
      if (heatTarget) {
        const brand = heatTarget.dataset.heatBrand;
        const condition = heatTarget.dataset.heatCondition;
        setCondition(condition);
        setBrand(brand, { scroll: true });
        showToast(`已筛选 ${brand} · ${condition}`);
        return;
      }

      const moverTarget = event.target.closest("[data-mover-id]");
      if (moverTarget) {
        openDrawer(moverTarget.dataset.moverId);
        return;
      }

      const scrollTarget = event.target.closest("[data-scroll]");
      if (scrollTarget) {
        scrollToSection(scrollTarget.dataset.scroll);
        return;
      }

      const sectionTarget = event.target.closest("[data-scroll-target]");
      if (sectionTarget) {
        scrollToSection(sectionTarget.dataset.scrollTarget);
        return;
      }

      if (event.target.closest("[data-search-trigger]")) {
        scrollToSection("models");
        window.setTimeout(() => $("#modelSearch").focus(), 420);
        return;
      }

      if (event.target.closest("[data-date-button]")) {
        showToast("当前原型仅提供 11 月 2 日快照，日期切换将在正式版接入");
        return;
      }

      if (event.target.closest("[data-export]")) {
        exportCsv();
        return;
      }

      if (event.target.closest("[data-method-open]")) {
        openMethods();
        return;
      }

      if (event.target.closest("[data-method-close]")) {
        closeMethods();
      }
    });

    $("#modelSearch").addEventListener("input", (event) => {
      state.query = event.target.value;
      state.visibleCount = state.pageSize;
      renderTable();
    });

    $("#brandFilter").addEventListener("change", (event) => {
      setBrand(event.target.value, { notify: true });
    });

    $("#conditionFilter").addEventListener("change", (event) => {
      setCondition(event.target.value === "all" ? "全部" : event.target.value, { notify: true });
    });

    $("#sortFilter").addEventListener("change", (event) => {
      state.sort = event.target.value;
      state.visibleCount = state.pageSize;
      renderTable();
    });

    $("#clearFilters").addEventListener("click", resetFilters);

    $("#loadMore").addEventListener("click", () => {
      state.visibleCount += state.pageSize;
      renderTable();
    });

    $("#modelRows").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest("tr[data-mover-id]");
      if (!row) return;
      event.preventDefault();
      openDrawer(row.dataset.moverId);
    });

    $("#signalList").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const item = event.target.closest(".signal-item");
      if (!item) return;
      event.preventDefault();
      item.click();
    });

    $("#drawerClose").addEventListener("click", closeDrawer);
    $("#drawerBackdrop").addEventListener("click", closeDrawer);

    $("#drawerConditionTabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-drawer-condition]");
      if (!button || button.disabled) return;
      state.drawerCondition = button.dataset.drawerCondition;
      renderDrawer();
    });

    $("#conditionLadder").addEventListener("click", (event) => {
      const row = event.target.closest(".ladder-row");
      if (!row) return;
      const name = row.querySelector(".ladder-name")?.textContent.trim();
      const mover = data.movers.find((item) => item.id === state.drawerMoverId);
      if (name && mover?.conditions[name]) {
        state.drawerCondition = name;
        renderDrawer();
      }
    });

    $("#methodDialog").addEventListener("click", (event) => {
      if (event.target === $("#methodDialog")) closeMethods();
    });

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        scrollToSection("models");
        window.setTimeout(() => $("#modelSearch").focus(), 380);
      }
      if (event.key === "Escape") {
        if ($("#detailDrawer").classList.contains("is-open")) closeDrawer();
        else if ($("#methodDialog").open) closeMethods();
      }
    });

    const sections = ["overview", "brands", "models", "quality"];
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible) setActiveNavigation(visible.target.id);
      },
      { rootMargin: "-20% 0px -55% 0px", threshold: [0.05, 0.3, 0.6] },
    );
    sections.forEach((sectionId) => {
      const section = document.getElementById(sectionId);
      if (section) observer.observe(section);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        renderMarketChart();
        if (state.drawerMoverId) renderDrawer();
      });
    });
    resizeObserver.observe($("#marketChart"));
    if ($("#detailDrawer").classList.contains("is-open")) resizeObserver.observe($("#drawerChart"));
  }

  function init() {
    populateMeta();
    populateTape();
    populateBrandFilter();
    updateMetricSummary();
    renderMarketChart();
    renderLegend();
    renderSignals();
    renderHeatmap();
    renderBrandRanking();
    syncFilterUi();
    renderTable();
    bindEvents();
  }

  init();
})();
