(() => {
  "use strict";

  const data = window.MARKET_DEMO;
  if (!data) return;

  const CONDITIONS = ["靓机", "小花", "大花", "外爆", "内爆"];
  const THREE_TIER_CONDITIONS = ["靓机", "小花", "大花"];
  const CONDITION_COLORS = Object.fromEntries(data.conditions.map((item) => [item.name, item.color]));
  const SORT_LABELS = {
    impact: "按有效波动排序",
    up: "按有效涨幅排序",
    down: "按有效跌幅排序",
    anomaly: "异常跳价优先",
    price: "按价格从高到低",
    rank: "按重点池排序",
  };
  const CHANGE_BIN_DEFS = [
    { label: "≤−10%", match: (value) => value <= -10, direction: "down" },
    { label: "−10~−5%", match: (value) => value > -10 && value <= -5, direction: "down" },
    { label: "−5~−2%", match: (value) => value > -5 && value <= -2, direction: "down" },
    { label: "−2~0%", match: (value) => value > -2 && value < 0, direction: "down" },
    { label: "0%", match: (value) => value === 0, direction: "flat" },
    { label: "0~2%", match: (value) => value > 0 && value <= 2, direction: "up" },
    { label: "2~5%", match: (value) => value > 2 && value <= 5, direction: "up" },
    { label: "5~10%", match: (value) => value > 5 && value <= 10, direction: "up" },
    { label: ">10%", match: (value) => value > 10, direction: "up" },
  ];
  const PRICE_BAND_DEFS = [
    { label: "¥500 以下", short: "<500", min: 0, max: 500 },
    { label: "¥500–999", short: "500–1K", min: 500, max: 1000 },
    { label: "¥1,000–1,999", short: "1K–2K", min: 1000, max: 2000 },
    { label: "¥2,000–2,999", short: "2K–3K", min: 2000, max: 3000 },
    { label: "¥3,000–4,999", short: "3K–5K", min: 3000, max: 5000 },
    { label: "¥5,000 以上", short: "≥5K", min: 5000, max: Infinity },
  ];
  const SAMPLE_LIMIT = 5;
  const TARGET_MODELS = Number(data.meta.targetModels || 1000);
  const WATCHLIST_KEY = "price-pulse.watchlist.v1";
  const OPS_STORAGE_PREFIX = "price-pulse.ops.";
  const numberFormat = new Intl.NumberFormat("zh-CN");
  const state = {
    dateIndex: data.dates.length - 1,
    scope: "all",
    condition: "全部",
    brand: "all",
    sort: "impact",
    query: "",
    pageSize: 20,
    visibleCount: 20,
    drawerModelId: null,
    drawerMemory: null,
    drawerCondition: null,
  };
  let toastTimer = null;
  let sparkCounter = 0;

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const num = (value) => numberFormat.format(Number(value || 0));
  const fixed = (value, digits = 2) => Number(value || 0).toFixed(digits);
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
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
  const signedIndexPoint = (value, digits = 2) => {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    const current = Number(value);
    const sign = current > 0 ? "+" : current < 0 ? "−" : "";
    return `${sign}${Math.abs(current).toFixed(digits)}点`;
  };
  const directionClass = (value) => (Number(value) > 0 ? "up-text" : Number(value) < 0 ? "down-text" : "");
  const directionName = (value) => (Number(value) > 0 ? "is-positive" : Number(value) < 0 ? "is-negative" : "is-neutral");
  const conditionColor = (name) => CONDITION_COLORS[name] || "#73776e";
  const conditionLabel = (name = state.condition) => (name === "全部" ? "全成色" : name);
  const scopeLabel = (scope = state.scope) => (scope === "all" ? "全量" : "TOP100");
  const currentDate = () => data.dates[state.dateIndex];
  const currentQuality = () => currentDate().quality;
  const previousDate = () => (state.dateIndex > 0 ? data.dates[state.dateIndex - 1] : null);
  const shortDate = (value) => value.slice(5).replace("-", ".");
  const longDate = (value) => value.replaceAll("-", ".");
  const percentChange = (current, previous) => {
    if (!current || !previous) return null;
    return Number((((current / previous) - 1) * 100).toFixed(2));
  };
  const median = (values) => {
    if (!values.length) return null;
    const ordered = [...values].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  };
  const quantile = (values, ratio) => {
    if (!values.length) return null;
    const ordered = [...values].sort((a, b) => a - b);
    const position = (ordered.length - 1) * ratio;
    const low = Math.floor(position);
    const high = Math.min(low + 1, ordered.length - 1);
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low);
  };
  const defaultVisibleCount = () => (state.scope === "top100" ? data.meta.top100 : state.pageSize);

  function setDirection(element, value, digits = 2) {
    if (!element) return;
    element.textContent = signedPercent(value, digits);
    element.classList.remove("up-text", "down-text", "is-up", "is-down", "is-warn");
    if (Number(value) > 0) element.classList.add("up-text", "is-up");
    else if (Number(value) < 0) element.classList.add("down-text", "is-down");
  }

  function showToast(message) {
    const toast = $("#toast");
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
  }

  function sparkline(values, color, width = 82, height = 26) {
    const points = values.map((value, index) => ({ value, index })).filter((item) => item.value !== null && item.value !== undefined);
    if (!points.length) return `<span class="spark-empty">—</span>`;
    const min = Math.min(...points.map((item) => item.value));
    const max = Math.max(...points.map((item) => item.value));
    const range = Math.max(max - min, 1);
    const stepX = width / Math.max(1, values.length - 1);
    const x = (index) => index * stepX;
    const y = (value) => 2 + ((max - value) / range) * (height - 4);
    let path = "";
    let drawing = false;
    points.forEach((item) => {
      path += `${drawing ? "L" : "M"}${x(item.index).toFixed(2)},${y(item.value).toFixed(2)} `;
      drawing = true;
      if (item.index < values.length - 1 && (values[item.index + 1] === null || values[item.index + 1] === undefined)) drawing = false;
    });
    const last = points.at(-1);
    const gradientId = `spark-${++sparkCounter}`;
    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".2"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
      <path d="${path}L${x(last.index).toFixed(2)},${height} L${x(points[0].index).toFixed(2)},${height} Z" fill="url(#${gradientId})"/>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${x(last.index).toFixed(2)}" cy="${y(last.value).toFixed(2)}" r="2.1" fill="${color}" stroke="var(--card)" stroke-width="1.2"/>
    </svg>`;
  }

  function modelById(id) {
    return data.models.find((model) => model.id === id);
  }

  function inScope(model, scope = state.scope) {
    return scope === "all" || model.inTop100;
  }

  function priceAt(model, condition, index) {
    const history = model.conditions[condition];
    return history && history[index] !== null && history[index] !== undefined ? history[index] : null;
  }

  function rowCondition(model, index = state.dateIndex) {
    if (state.condition !== "全部") return priceAt(model, state.condition, index) === null ? null : state.condition;
    if (priceAt(model, model.primaryCondition, index) !== null) return model.primaryCondition;
    return CONDITIONS.find((condition) => priceAt(model, condition, index) !== null) || null;
  }

  function buildConditionRow(model, condition, index = state.dateIndex) {
    const history = model.conditions[condition];
    if (!history) return null;
    const price = priceAt(model, condition, index);
    if (price === null) return null;
    const previousPrice = index > 0 ? priceAt(model, condition, index - 1) : null;
    const change = previousPrice ? Number((((price / previousPrice) - 1) * 100).toFixed(2)) : null;
    const changeAmount = previousPrice ? price - previousPrice : null;
    const firstIndex = history.slice(0, index + 1).findIndex((value) => value !== null);
    const firstPrice = firstIndex >= 0 ? history[firstIndex] : null;
    const windowChange = firstPrice && index > firstIndex ? percentChange(price, firstPrice) : index === firstIndex ? 0 : null;
    const coverageDays = history.slice(0, index + 1).filter((value) => value !== null).length;
    const fullCoverage = history.filter((value) => value !== null).length;
    const isAnomaly = change !== null && Math.abs(change) > data.meta.anomalyLimit;
    const impact = change === null ? 0 : Math.abs(change) * Math.log10(price + 10);
    return {
      ...model,
      condition,
      price,
      previousPrice,
      change,
      changeAmount,
      windowChange,
      windowDays: firstIndex >= 0 ? index - firstIndex : 0,
      coverageDays,
      fullCoverage,
      history,
      isAnomaly,
      impact,
    };
  }

  function buildModelRow(model, index = state.dateIndex) {
    const condition = rowCondition(model, index);
    return condition ? buildConditionRow(model, condition, index) : null;
  }

  function allModelRows(index = state.dateIndex) {
    return data.models.map((model) => buildModelRow(model, index)).filter(Boolean);
  }

  function modelMemories(model) {
    const memories = Object.keys(model.configs || {});
    return memories.length ? memories : [model.mainMemory];
  }

  function configFor(model, memory = state.drawerMemory) {
    return model.configs?.[memory] || model.conditions;
  }

  function configPriceAt(model, memory, condition, index) {
    const history = configFor(model, memory)?.[condition];
    return history && history[index] !== null && history[index] !== undefined ? history[index] : null;
  }

  function quoteStats(history, index) {
    const values = [];
    let previous = null;
    history.forEach((value, dayIndex) => {
      if (dayIndex > index || value === null) {
        previous = value === null ? null : previous;
        return;
      }
      const change = previous ? percentChange(value, previous) : null;
      if (change === null || Math.abs(change) <= data.meta.anomalyLimit) values.push(value);
      previous = value;
    });
    const low = quantile(values, 0.25);
    const high = quantile(values, 0.75);
    return {
      values,
      median: median(values),
      low,
      high,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      sample: values.length,
    };
  }

  function hasSameThreeTierSeries(model) {
    const series = THREE_TIER_CONDITIONS.map((condition) => model.conditions?.[condition] || []);
    if (series.some((values) => !values.length) || !series[0].some((value) => value !== null && value !== undefined)) return false;
    const reference = series[0];
    return series.every((values) => values.length === reference.length && values.every((value, index) => (value ?? null) === (reference[index] ?? null)));
  }

  function skuKey(model, memory, condition) {
    return `${model.id}|${memory}|${condition}`;
  }

  function readWatchlist() {
    try {
      return new Set(JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]"));
    } catch {
      return new Set();
    }
  }

  function writeWatchlist(set) {
    try {
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify([...set]));
    } catch {
      // Local storage is optional in privacy-restricted browsers.
    }
  }

  function isWatched(model, memory, condition) {
    return readWatchlist().has(skuKey(model, memory, condition));
  }

  function toggleSkuWatch() {
    const selection = drawerSelection();
    if (!selection) return;
    const { model, memory, condition } = selection;
    const watchlist = readWatchlist();
    const key = skuKey(model, memory, condition);
    const wasWatched = watchlist.has(key);
    if (wasWatched) watchlist.delete(key);
    else watchlist.add(key);
    writeWatchlist(watchlist);
    renderDrawer();
    showToast(wasWatched ? "已取消关注该 SKU" : "已关注该 SKU");
  }

  function filteredModelRows() {
    const query = state.query.trim().toLowerCase();
    let rows = allModelRows().filter((row) => {
      if (!inScope(row)) return false;
      if (state.brand !== "all" && row.brand !== state.brand) return false;
      if (state.condition !== "全部" && row.condition !== state.condition) return false;
      if (!query) return true;
      return `${row.model} ${row.brand} ${row.brandShort} ${row.modelId} ${row.mainMemory} ${row.condition} ${modelMemories(row).join(" ")}`.toLowerCase().includes(query);
    });
    rows = [...rows];
    const validFirst = (a, b) => Number(a.isAnomaly) - Number(b.isAnomaly);
    if (state.sort === "up") rows.sort((a, b) => validFirst(a, b) || (b.change ?? -Infinity) - (a.change ?? -Infinity));
    else if (state.sort === "down") rows.sort((a, b) => validFirst(a, b) || (a.change ?? Infinity) - (b.change ?? Infinity));
    else if (state.sort === "anomaly") rows.sort((a, b) => Number(b.isAnomaly) - Number(a.isAnomaly) || b.impact - a.impact);
    else if (state.sort === "price") rows.sort((a, b) => b.price - a.price);
    else if (state.sort === "rank") rows.sort((a, b) => (a.top100Rank ?? 9999) - (b.top100Rank ?? 9999) || b.price - a.price);
    else rows.sort((a, b) => validFirst(a, b) || b.impact - a.impact || b.price - a.price);
    return rows;
  }

  function statusForRow(row) {
    if (row.isAnomaly) return { text: "异常跳价", className: "is-alert" };
    if (row.change === null) return { text: "无可比", className: "is-calm" };
    if (Math.abs(row.change) >= 5) return { text: "重点异动", className: "is-alert" };
    if (Math.abs(row.change) >= 2) return { text: "持续观察", className: "is-watch" };
    return { text: "价格平稳", className: "is-calm" };
  }

  function statsFor(scope, index = state.dateIndex) {
    const scopeData = data.market[scope] || data.market.all;
    return scopeData.stats[index] || scopeData.stats.at(-1);
  }

  function conditionStatsFor(scope, condition, index = state.dateIndex) {
    if (condition === "全部") return statsFor(scope, index);
    const conditionData = data.conditions.find((item) => item.name === condition);
    if (!conditionData) return statsFor(scope, index);
    const series = scope === "all" ? conditionData.stats : conditionData.top100Stats;
    return series[index] || series.at(-1);
  }

  function seriesFor(scope, condition) {
    if (condition === "全部") return (data.market[scope] || data.market.all).indexSeries;
    const conditionData = data.conditions.find((item) => item.name === condition);
    if (!conditionData) return data.market[scope].indexSeries;
    return scope === "all" ? conditionData.indexSeries : conditionData.top100IndexSeries;
  }

  function brandStatsFor(brand, scope = state.scope, index = state.dateIndex) {
    const record = typeof brand === "string" ? data.brands.find((item) => item.name === brand) : brand;
    if (!record) return null;
    const series = scope === "all" ? record.stats : record.top100Stats;
    return series[index] || series.at(-1);
  }

  function brandDailyValue(brand, scope = state.scope, index = state.dateIndex) {
    const stats = brandStatsFor(brand, scope, index);
    if (!stats) return { change: null, normal: 0, index: null };
    if (state.condition === "全部") return { change: stats.change, normal: stats.normal, index: stats.index, stats };
    const conditionStats = stats.conditions?.[state.condition] || { change: 0, normal: 0 };
    return { change: conditionStats.change, normal: conditionStats.normal, index: null, stats };
  }

  function brandModelCount(brand, scope = state.scope) {
    return data.models.filter((model) => model.brand === brand && inScope(model, scope)).length;
  }

  function continuousModels(scope = state.scope) {
    return data.models.filter((model) => inScope(model, scope) && model.conditions["靓机"].every((value) => value !== null)).length;
  }

  function analysisRows(index = state.dateIndex) {
    const models = data.models.filter((model) => inScope(model));
    if (state.condition !== "全部") return models.map((model) => buildConditionRow(model, state.condition, index)).filter(Boolean);
    return models.flatMap((model) => CONDITIONS.map((condition) => buildConditionRow(model, condition, index))).filter(Boolean);
  }

  function analysisConditionNote() {
    return state.condition === "全部" ? "五类成色观察" : state.condition;
  }

  function changeDistributionData(rows = analysisRows()) {
    const comparable = rows.filter((row) => row.change !== null);
    const excluded = comparable.filter((row) => row.isAnomaly);
    const valid = comparable.filter((row) => !row.isAnomaly);
    const values = valid.map((row) => row.change);
    const counts = CHANGE_BIN_DEFS.map((definition) => {
      const sample = valid.filter((row) => definition.match(row.change)).length;
      return { ...definition, sample };
    });
    const up = valid.filter((row) => row.change > 0).length;
    const down = valid.filter((row) => row.change < 0).length;
    const flat = valid.filter((row) => row.change === 0).length;
    return {
      rows,
      comparable,
      valid,
      excluded,
      counts,
      up,
      down,
      flat,
      median: median(values),
      downShare: valid.length ? (down / valid.length) * 100 : null,
    };
  }

  function priceBandData(rows = analysisRows()) {
    const priced = rows.filter((row) => row.price !== null && row.price !== undefined && row.price > 0);
    const bands = PRICE_BAND_DEFS.map((definition) => {
      const bandRows = priced.filter((row) => row.price >= definition.min && row.price < definition.max);
      const comparable = bandRows.filter((row) => row.change !== null && !row.isAnomaly);
      const values = comparable.map((row) => row.change);
      return {
        ...definition,
        sample: bandRows.length,
        comparable: comparable.length,
        up: comparable.filter((row) => row.change > 0).length,
        down: comparable.filter((row) => row.change < 0).length,
        flat: comparable.filter((row) => row.change === 0).length,
        excluded: bandRows.filter((row) => row.isAnomaly).length,
        median: median(values),
      };
    });
    return {
      bands,
      priced,
      focus: [...bands].sort((a, b) => b.sample - a.sample)[0] || null,
      weakest: bands.filter((band) => band.comparable >= SAMPLE_LIMIT && band.median !== null).sort((a, b) => a.median - b.median)[0] || null,
    };
  }

  function fixedCohortData(scope = state.scope, condition = state.condition === "全部" ? "靓机" : state.condition) {
    const models = data.models.filter((model) => inScope(model, scope) && model.conditions[condition]?.every((value) => value !== null && value !== undefined));
    const series = [100];
    const changes = [0];
    const samples = [models.length];
    for (let index = 1; index < data.dates.length; index += 1) {
      const daily = [];
      models.forEach((model) => {
        const history = model.conditions[condition];
        const change = percentChange(history[index], history[index - 1]);
        if (change !== null && Math.abs(change) <= data.meta.anomalyLimit) daily.push(change);
      });
      const dailyMedian = median(daily) ?? 0;
      changes.push(Number(dailyMedian.toFixed(2)));
      samples.push(daily.length);
      series.push(Number((series.at(-1) * (1 + dailyMedian / 100)).toFixed(2)));
    }
    const marketSeries = seriesFor(scope, condition);
    const selectedIndex = series[state.dateIndex] ?? null;
    const marketIndex = marketSeries[state.dateIndex] ?? null;
    return {
      models,
      condition,
      series,
      changes,
      samples,
      sample: models.length,
      selectedIndex,
      selectedChange: changes[state.dateIndex] ?? null,
      selectedSample: samples[state.dateIndex] ?? 0,
      cumulative: state.dateIndex === 0 || selectedIndex === null ? null : selectedIndex - 100,
      marketSeries,
      marketIndex,
      difference: selectedIndex === null || marketIndex === null ? null : selectedIndex - marketIndex,
    };
  }

  function brandBreadthFor(brand, scope = state.scope, index = state.dateIndex) {
    if (state.condition === "全部") {
      const stats = brandStatsFor(brand, scope, index);
      const up = Number(stats?.up || 0);
      const down = Number(stats?.down || 0);
      const flat = Number(stats?.flat || 0);
      const sample = up + down + flat;
      return { up, down, flat, sample, normal: Number(stats?.normal || 0), change: stats?.change ?? null, anomalies: Number(stats?.anomalies || 0), downShare: sample ? (down / sample) * 100 : null, source: "全内存 SKU" };
    }
    let up = 0;
    let down = 0;
    let flat = 0;
    let anomalies = 0;
    const changes = [];
    data.models.forEach((model) => {
      if (model.brand !== brand || !inScope(model, scope)) return;
      const current = priceAt(model, state.condition, index);
      const previous = index > 0 ? priceAt(model, state.condition, index - 1) : null;
      if (current === null || previous === null) return;
      const change = percentChange(current, previous);
      if (change === null) return;
      if (change > 0) up += 1;
      else if (change < 0) down += 1;
      else flat += 1;
      if (Math.abs(change) > data.meta.anomalyLimit) anomalies += 1;
      else changes.push(change);
    });
    const sample = up + down + flat;
    return { up, down, flat, sample, normal: changes.length, change: median(changes), anomalies, downShare: sample ? (down / sample) * 100 : null, source: "主配置机型" };
  }

  function briefingData() {
    const stats = conditionStatsFor(state.scope, state.condition);
    const rows = analysisRows();
    const distribution = changeDistributionData(rows);
    const cohort = fixedCohortData();
    const scopeStats = statsFor(state.scope);
    const brandValues = data.brands
      .map((brand) => ({ brand, value: brandDailyValue(brand) }))
      .filter((item) => item.value.normal >= SAMPLE_LIMIT && item.value.change !== null)
      .sort((a, b) => b.value.change - a.value.change);
    const strongest = brandValues[0] || null;
    const weakest = brandValues.at(-1) || null;
    const compared = Number(stats.up || 0) + Number(stats.down || 0) + Number(stats.flat || 0);
    const downShare = compared ? (Number(stats.down || 0) / compared) * 100 : null;
    const anomalies = Number(stats.anomalies || 0);
    const coverage = Number(scopeStats.coverage ?? currentQuality().coverage);
    const weekly = state.dateIndex === 0 ? null : Number(stats.index) - 100;
    const daily = state.dateIndex === 0 ? null : stats.change;
    const focusBand = priceBandData(rows).weakest;
    const focusRows = distribution.valid.filter((row) => row.change !== null).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    const mover = focusRows[0] || null;
    const headline = daily === null
      ? `${scopeLabel()}价格基准建立，等待下一交易日`
      : `${scopeLabel()}日线 ${signedPercent(daily)}，7日累计 ${signedPercent(weekly)}`;
    const brandText = strongest && weakest
      ? `最强 ${strongest.brand.name} ${signedPercent(strongest.value.change)}，最弱 ${weakest.brand.name} ${signedPercent(weakest.value.change)}`
      : "当前品牌可比样本不足，暂不输出强弱结论";
    const summary = `${conditionLabel()}指数 ${fixed(stats.index, 2)}；全内存口径上涨 ${num(stats.up)} / 下跌 ${num(stats.down)} / 持平 ${num(stats.flat)} 个可比 SKU，下跌面 ${downShare === null ? "—" : `${fixed(downShare, 1)}%`}。${brandText}。`;
    const moveText = mover
      ? `${mover.model}（${mover.mainMemory}·${mover.condition}）${signedPercent(mover.change)}`
      : "当前暂无有效单款涨跌";
    const actions = [
      {
        level: "P0",
        title: anomalies ? `先核 ${num(anomalies)} 条异常跳价` : "先守住报价可信度",
        detail: anomalies
          ? `当前有价率 ${fixed(coverage, 1)}%；外发报价前先排除录价、映射或补价错误。`
          : `当前有价率 ${fixed(coverage, 1)}%；异常价为 0，继续复核零价和缺失记录。`,
      },
      {
        level: "P1",
        title: weakest ? `跟进 ${weakest.brand.name} 的相对弱势` : "品牌样本仍待补齐",
        detail: weakest
          ? `日变动 ${signedPercent(weakest.value.change)}，可比样本 ${num(weakest.value.normal)} 条；确认是否由单款或单一配置拉动。`
          : "当前没有达到 5 条可比样本的品牌，暂不形成品牌动作。",
      },
      {
        level: "P2",
        title: focusBand && focusBand.median < 0 ? `${focusBand.label} 价格带承压` : "观察价格带分化",
        detail: focusBand
          ? `${focusBand.label} 价格带中位 ${signedPercent(focusBand.median)}，有效样本 ${num(focusBand.comparable)} 条；固定队列累计 ${signedPercent(cohort.cumulative)}。`
          : `固定队列累计 ${signedPercent(cohort.cumulative)}，等待更多价格带样本。`,
      },
    ];
    const copyText = [
      `【价脉行情简报】${longDate(currentDate().date)}｜${scopeLabel()} · ${conditionLabel()}`,
      `方向：${headline}`,
      `指数：${fixed(stats.index, 2)}；日变动 ${signedPercent(daily)}；7日累计 ${signedPercent(weekly)}`,
      `广度：全内存 SKU 上涨 ${num(stats.up)} / 下跌 ${num(stats.down)} / 持平 ${num(stats.flat)}；下跌面 ${downShare === null ? "—" : `${fixed(downShare, 1)}%`}`,
      `品牌：${brandText}`,
      `异动：${moveText}`,
      `质量：异常跳价 ${num(anomalies)} 条已隔离；报价有价率 ${fixed(coverage, 1)}%`,
      `动作：${actions.map((action) => `${action.level} ${action.title}`).join("；")}`,
      `口径：指数、广度、品牌为全内存 SKU；分布、价格带为主配置 × ${analysisConditionNote()}；固定队列为主配置 × ${cohort.condition}；异常跳价 ±30% 不进入趋势；报价为参考价，非成交价。`,
    ].join("\n");
    return {
      stats,
      distribution,
      cohort,
      strongest,
      weakest,
      compared,
      downShare,
      anomalies,
      coverage,
      weekly,
      daily,
      headline,
      summary,
      actions,
      copyText,
    };
  }

  function top100Movement() {
    if (state.dateIndex === 0) return { up: null, down: null, flat: null, comparable: 0 };
    let up = 0;
    let down = 0;
    let flat = 0;
    data.models.filter((model) => model.inTop100).forEach((model) => {
      const condition = state.condition === "全部" ? "靓机" : state.condition;
      const current = priceAt(model, condition, state.dateIndex);
      const previous = priceAt(model, condition, state.dateIndex - 1);
      if (current === null) {
        flat += 1;
      } else if (previous === null) {
        flat += 1;
      } else if (current > previous) up += 1;
      else if (current < previous) down += 1;
      else flat += 1;
    });
    return { up, down, flat, comparable: up + down + flat };
  }

  function populateDatePicker() {
    const picker = $("#datePicker");
    picker.innerHTML = data.dates
      .map((item, index) => `<option value="${index}">${item.label} · ${item.weekday}</option>`)
      .join("");
    picker.value = String(state.dateIndex);
  }

  function populateBrandFilter() {
    const select = $("#brandFilter");
    select.innerHTML = `<option value="all">全部品牌</option>${data.brands
      .map((brand) => `<option value="${escapeHtml(brand.name)}">${escapeHtml(brand.name)} · ${brand.models}款</option>`)
      .join("")}`;
  }

  function renderDateChrome() {
    const date = currentDate();
    const quality = currentQuality();
    const month = Number(date.date.slice(5, 7));
    $("#dateDay").textContent = date.date.slice(8, 10);
    $("#dateMonth").textContent = `${month}月`;
    $("#dateMeta").textContent = `${date.date.slice(0, 4)} · ${date.weekday}`;
    $("#datePicker").value = String(state.dateIndex);
    $("#heroDateStatus").textContent = `${date.label}行情${state.dateIndex === data.dates.length - 1 ? "已更新" : "快照"}`;
    $("#heroDateRange").textContent = `${longDate(data.meta.dateFrom)}–${shortDate(data.meta.dateTo)} / ${data.meta.updatedAt} CST`;
    $("#heroModelCount").textContent = num(data.meta.totalModels);
    $("#heroTotalSkus").textContent = num(data.meta.totalSkus);
    $("#heroValidSkus").textContent = num(quality.validKeys);
    $("#heroCoverage").textContent = `${fixed(quality.coverage, 1)}%`;
    $("#sideValidSkus").textContent = num(quality.validKeys);
    $("#sideCoverage").textContent = `${fixed(quality.coverage, 1)}%`;
    $("#sideCoverageBar").style.width = `${quality.coverage}%`;
    const sideHeading = $(".live-block .live-heading");
    if (sideHeading) sideHeading.innerHTML = `<span class="live-dot"></span> ${escapeHtml(date.label)}快照已入库`;
    $("#sideDateRange").textContent = `${shortDate(data.meta.dateFrom)}–${shortDate(data.meta.dateTo)} · 7 个自然日报价快照${data.meta.demo ? "；价格为脱敏演示值。" : "。"}`;
    $("#tapeTime").textContent = `UPDATED ${data.meta.updatedAt} · ${shortDate(date.date)}`;
    $("#footerDemoNote").textContent = data.meta.demo
      ? `基于真实 ${longDate(data.meta.dateFrom)}–${shortDate(data.meta.dateTo)} 报价结构脱敏；价格为演示值，仅用于 UI 评审。`
      : `基于 ${longDate(data.meta.dateFrom)}–${shortDate(data.meta.dateTo)} 七份报价单；价格为业务参考价，仅用于内部评审。`;
    $("#demoInline").hidden = !data.meta.demo;
    const methodFooter = $("#methodFooterNote");
    if (methodFooter) methodFooter.textContent = data.meta.demo
      ? "当前为 7 日脱敏演示口径；指数仅反映相对报价变化，不等同成交量或利润。"
      : "当前为 7 日真实报价口径；指数仅反映报价变化，不等同成交量或利润。";
  }

  function renderTape() {
    const stats = statsFor(state.scope);
    const items = [`<strong>${scopeLabel()} INDEX</strong><span>${fixed(stats.index, 2)}</span><span class="${directionClass(stats.change)}">${signedPercent(stats.change)}</span>`];
    data.brands.forEach((brand) => {
      const value = brandDailyValue(brand);
      items.push(`<strong>${escapeHtml(brand.name)}</strong><span class="${value.normal < SAMPLE_LIMIT ? "" : directionClass(value.change)}">${value.normal < SAMPLE_LIMIT ? "样本不足" : signedPercent(value.change)}</span>`);
    });
    const markup = items.map((content) => `<div class="tape-item">${content}</div>`).join("");
    $("#marketTape").innerHTML = markup + markup;
  }

  function renderKpis() {
    const stats = conditionStatsFor(state.scope, state.condition);
    const scopeStats = statsFor(state.scope);
    $("#metricIndexLabel").textContent = `${scopeLabel()}${state.condition === "全部" ? "市场" : ` · ${state.condition}`}指数`;
    $("#marketIndex").textContent = fixed(stats.index, 2);
    setDirection($("#marketChange"), state.dateIndex === 0 ? 0 : stats.change);
    $("#marketSpark").innerHTML = sparkline(seriesFor(state.scope, state.condition).slice(0, state.dateIndex + 1), state.condition === "全部" ? "#c8ef6a" : conditionColor(state.condition), 88, 25);
    $("#metricIndexFoot").textContent = state.dateIndex === 0 ? "基准日 · 暂无前一交易日" : `较 ${previousDate().label} · 剔除 ±${data.meta.anomalyLimit}% 跳价`;

    const up = Number(stats.up || 0);
    const down = Number(stats.down || 0);
    const flat = Number(stats.flat || 0);
    const total = Math.max(1, up + down + flat);
    $("#breadthLabel").textContent = `涨跌结构 · ${state.condition === "全部" ? "SKU" : state.condition}`;
    $("#upCount").textContent = num(up);
    $("#downCount").textContent = num(down);
    $("#flatCount").textContent = num(flat);
    $("#upBar").style.width = `${(up / total) * 100}%`;
    $("#flatBar").style.width = `${(flat / total) * 100}%`;
    $("#downBar").style.width = `${(down / total) * 100}%`;
    $("#upDownRatio").textContent = down ? fixed(up / down, 2) : up ? "∞" : "—";

    const anomalies = Number(stats.anomalies || 0);
    const matched = Number(stats.matched || 0);
    $("#anomalyLabel").textContent = `${scopeLabel()}异常价 · 已隔离`;
    $("#anomalyCount").textContent = num(anomalies);
    $("#anomalyRatio").textContent = matched ? `${fixed((anomalies / matched) * 100, 1)}%` : "—";

    $("#coverageLabel").textContent = state.scope === "all" ? "当日报价覆盖" : "重点池报价覆盖";
    $("#validSkus").textContent = num(scopeStats.skus);
    $("#uniqueSkus").textContent = `/ ${num(scopeStats.rawSkus || scopeStats.skus)}`;
    $("#zeroQuotes").textContent = num(scopeStats.zeroSkus || 0);
    $("#continuousModels").textContent = num(continuousModels());
    const ringValue = scopeStats.coverage ?? currentQuality().coverage;
    $("#coverageRing").style.background = `conic-gradient(var(--ink) 0 ${ringValue}%, var(--paper-deep) ${ringValue}% 100%)`;
    $("#coverageRingText").textContent = `${fixed(ringValue, 0)}%`;
  }

  function renderTop100Band() {
    const movement = top100Movement();
    const stats = conditionStatsFor("top100", state.condition);
    $("#topUp").textContent = movement.up === null ? "—" : num(movement.up);
    $("#topDown").textContent = movement.down === null ? "—" : num(movement.down);
    $("#topFlat").textContent = movement.flat === null ? "—" : num(movement.flat);
    $("#topFlatLabel").textContent = state.condition === "全部" ? "持平" : "持平/无报价";
    $("#topFlat").title = state.dateIndex === 0 ? "基准日暂无日涨跌" : "含价格持平、无当日报价与缺少前一日可比值";
    $("#topIndex").textContent = fixed(stats.index, 2);
    $("#topIndexLabel").textContent = `TOP100 ${conditionLabel()}指数`;
    setDirection($("#topChange"), state.dateIndex === 0 ? 0 : stats.change);
    const week = Number(stats.index) - 100;
    const weekElement = $("#topWeek");
    $("#topWeekLabel").textContent = state.dateIndex === data.dates.length - 1 ? "7日累计" : `${currentDate().short}累计`;
    weekElement.textContent = state.dateIndex === 0 ? "—" : signedPercent(week);
    weekElement.className = directionClass(week);
    const titleNote = $(".top100-title small");
    if (titleNote) titleNote.textContent = "固定重点池 · 选池基于近7日靓机连续有价";
    const action = $(".top100-action");
    action.innerHTML = state.scope === "top100" ? "当前已聚焦 100 款 <span>↓</span>" : "查看全部 100 款 <span>↗</span>";
    $(".top100-band").classList.toggle("is-current", state.scope === "top100");
  }

  function renderBriefing() {
    const brief = briefingData();
    $("#briefScope").textContent = `${scopeLabel()} · ${conditionLabel()} · ${currentDate().short}`;
    $("#briefTitle").textContent = brief.headline;
    $("#briefSummary").textContent = brief.summary;
    const downShare = brief.downShare === null ? "—" : `${fixed(brief.downShare, 1)}%`;
    $("#briefFacts").innerHTML = `
      <div class="brief-fact"><span>7日累计</span><strong class="${directionClass(brief.weekly)}">${signedPercent(brief.weekly)}</strong><small>截至 ${currentDate().short}</small></div>
      <div class="brief-fact"><span>下跌面</span><strong>${downShare}</strong><small>${num(brief.stats.down)} / ${num(brief.compared)} 个全内存 SKU</small></div>
      <div class="brief-fact"><span>固定队列</span><strong>${fixed(brief.cohort.selectedIndex, 2)}</strong><small>${num(brief.cohort.sample)} 款${brief.cohort.condition} · 较指数 ${signedIndexPoint(brief.cohort.difference)}</small></div>`;
    $("#briefActions").innerHTML = brief.actions.map((action) => `<li class="brief-action"><span class="brief-level">${action.level}</span><div><strong>${escapeHtml(action.title)}</strong><p>${escapeHtml(action.detail)}</p></div></li>`).join("");
    $("#briefFootnote").textContent = `口径：指数、广度、品牌为全内存 SKU；分布/价格带为主配置 × ${analysisConditionNote()}；队列为主配置 × ${brief.cohort.condition}；异常 ±${data.meta.anomalyLimit}% 已隔离。`;
  }

  function renderDistribution() {
    const distribution = changeDistributionData();
    const values = distribution.valid.map((row) => row.change);
    const maxCount = Math.max(1, ...distribution.counts.map((item) => item.sample));
    let title = "当日暂无可比涨跌，等待下一交易日";
    if (distribution.median !== null) {
      if (distribution.median > 0.2) title = `涨跌分布偏向上行，中位 ${signedPercent(distribution.median)}`;
      else if (distribution.median < -0.2) title = `下跌样本占 ${fixed(distribution.downShare, 1)}%，中位 ${signedPercent(distribution.median)}`;
      else title = `涨跌以窄幅波动为主，中位 ${signedPercent(distribution.median)}`;
    }
    $("#distributionTitle").textContent = title;
    $("#structureScope").textContent = `主配置 · ${analysisConditionNote()}`;
    $("#distributionMeta").textContent = `${num(distribution.valid.length)} 有效 · ${num(distribution.excluded.length)} 隔离`;
    $("#changeDistribution").innerHTML = distribution.counts.map((item) => {
      const width = (item.sample / maxCount) * 100;
      const share = values.length ? (item.sample / values.length) * 100 : 0;
      return `<div class="dist-row dist-${item.direction}" role="listitem" title="${escapeHtml(item.label)}：${num(item.sample)} 条，占 ${fixed(share, 1)}%"><span class="dist-label">${escapeHtml(item.label)}</span><span class="dist-track" aria-hidden="true"><i style="width:${width}%"></i></span><strong>${num(item.sample)}</strong></div>`;
    }).join("");
    const multiConditionNote = state.condition === "全部" ? "；同一机型可有多成色记录" : "";
    $("#structureFoot").textContent = `主配置 × ${analysisConditionNote()}${multiConditionNote}；日涨跌有效样本 ${num(distribution.valid.length)} 条，异常 ${num(distribution.excluded.length)} 条已隔离。`;
  }

  function renderPriceBands() {
    const bandData = priceBandData();
    const focus = bandData.focus;
    const weakest = bandData.weakest;
    $("#priceBandTitle").textContent = focus
      ? weakest && weakest.median < 0
        ? `${focus.label}样本最集中，${weakest.label} 中位承压`
        : `${focus.label}样本最集中，价格带尚未明显分化`
      : "当前没有可分析的有价样本";
    $("#priceBandMeta").textContent = `${num(bandData.priced.length)} 个有价观察`;
    $("#priceBands").innerHTML = bandData.bands.map((band) => {
      const total = band.comparable;
      const upWidth = total ? (band.up / total) * 100 : 0;
      const flatWidth = total ? (band.flat / total) * 100 : 0;
      const downWidth = total ? (band.down / total) * 100 : 0;
      return `<div class="price-band-item" role="listitem" aria-label="${escapeHtml(band.label)}，${num(band.sample)} 个有价样本，上涨 ${band.up}，下跌 ${band.down}，中位 ${signedPercent(band.median)}">
        <div class="price-band-head"><strong>${escapeHtml(band.label)}</strong><span>${num(band.sample)} 个</span></div>
        <div class="price-band-segments" aria-hidden="true"><i class="is-up" style="width:${upWidth}%"></i><i class="is-flat" style="width:${flatWidth}%"></i><i class="is-down" style="width:${downWidth}%"></i></div>
        <div class="price-band-foot"><span>${band.comparable ? `<b class="up-text">↑${band.up}</b> <b class="down-text">↓${band.down}</b> <b>—${band.flat}</b>` : "暂无可比样本"}</span><strong class="${directionClass(band.median)}">${band.comparable ? signedPercent(band.median) : "—"}</strong></div>
      </div>`;
    }).join("");
  }

  function renderCohortChart(cohort) {
    const container = $("#cohortChart");
    if (!container) return;
    if (!cohort.sample) {
      container.innerHTML = `<div class="cohort-empty"><strong>没有 7 日连续有价队列</strong><span>当前范围与成色下暂无法形成固定样本。</span></div>`;
      return;
    }
    const width = Math.max(280, container.clientWidth || 360);
    const height = 168;
    const margin = { top: 14, right: 10, bottom: 24, left: 34 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const values = [...cohort.series, ...cohort.marketSeries];
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max - min < 0.35) {
      const center = (max + min) / 2;
      min = center - 0.2;
      max = center + 0.2;
    } else {
      min -= (max - min) * 0.12;
      max += (max - min) * 0.12;
    }
    const x = (index) => margin.left + (index / Math.max(1, data.dates.length - 1)) * plotWidth;
    const y = (value) => margin.top + ((max - value) / (max - min)) * plotHeight;
    let grid = "";
    for (let index = 0; index <= 3; index += 1) {
      const yPosition = margin.top + (index / 3) * plotHeight;
      const value = max - (index / 3) * (max - min);
      grid += `<line class="cohort-grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${yPosition}" y2="${yPosition}"/><text class="cohort-axis-text" x="${margin.left - 8}" y="${yPosition + 3}" text-anchor="end">${value.toFixed(1)}</text>`;
    }
    const cohortPath = cohort.series.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    const marketPath = cohort.marketSeries.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    const areaPath = `${cohortPath} L${x(cohort.series.length - 1).toFixed(1)},${(margin.top + plotHeight).toFixed(1)} L${x(0).toFixed(1)},${(margin.top + plotHeight).toFixed(1)} Z`;
    const labels = data.dates.map((date, index) => `<text class="cohort-x-label ${index === state.dateIndex ? "is-selected" : ""}" x="${x(index)}" y="${height - 6}" text-anchor="${index === 0 ? "start" : index === data.dates.length - 1 ? "end" : "middle"}">${formatAxisDate(date.date)}</text>`).join("");
    const dots = cohort.series.map((value, index) => `<circle class="cohort-dot ${index === state.dateIndex ? "is-selected" : ""}" cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="${index === state.dateIndex ? 3.6 : 2.3}"><title>${longDate(data.dates[index].date)}：${fixed(value, 2)}</title></circle>`).join("");
    const selectedX = x(state.dateIndex);
    const gradientId = `cohort-area-${sparkCounter += 1}`;
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false"><defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#c8ef6a" stop-opacity=".22"/><stop offset="100%" stop-color="#c8ef6a" stop-opacity="0"/></linearGradient></defs>${grid}${labels}<path d="${areaPath}" fill="url(#${gradientId})"/><path d="${marketPath}" class="cohort-market-line"/><path d="${cohortPath}" class="cohort-main-line"/>${dots}<line class="cohort-selected-line" x1="${selectedX}" x2="${selectedX}" y1="${margin.top}" y2="${margin.top + plotHeight}"/></svg>`;
    container.setAttribute("aria-label", `固定队列${cohort.condition} ${num(cohort.sample)} 款，${currentDate().short}指数 ${fixed(cohort.selectedIndex, 2)}，同成色市场指数 ${fixed(cohort.marketIndex, 2)}`);
  }

  function renderCohort() {
    const cohort = fixedCohortData();
    $("#cohortBadge").textContent = `${cohort.condition}队列`;
    $("#cohortIndex").textContent = fixed(cohort.selectedIndex, 2);
    const change = $("#cohortChange");
    change.textContent = state.dateIndex === 0 ? "基准日" : `${signedPercent(cohort.selectedChange)} 当日`;
    change.className = directionClass(cohort.selectedChange);
    $("#cohortSample").textContent = `${num(cohort.sample)} 款`;
    $("#cohortSample").title = `当日可比较 ${num(cohort.selectedSample)} 条`;
    const diff = $("#cohortDiff");
    diff.textContent = signedIndexPoint(cohort.difference);
    diff.className = directionClass(cohort.difference);
    $("#cohortFoot").textContent = state.condition === "全部"
      ? `当前为全成色筛选，队列默认取靓机口径；${num(cohort.sample)} 款机型 7 日连续有价，队列不随日期洗牌。`
      : `${num(cohort.sample)} 款机型 7 日连续有价；队列不随日期洗牌，按每日中位涨跌复利计算。`;
    $("#cohortLegend").innerHTML = `<span><i class="cohort-key cohort-key-main"></i>固定队列 <b>${fixed(cohort.selectedIndex, 2)}</b></span><span><i class="cohort-key cohort-key-market"></i>${cohort.condition}市场指数 <b>${fixed(cohort.marketIndex, 2)}</b></span>`;
    renderCohortChart(cohort);
  }

  function opsStorageKey() {
    return `${OPS_STORAGE_PREFIX}${data.meta.businessDate}`;
  }

  function readOpsDone() {
    try {
      return new Set(JSON.parse(localStorage.getItem(opsStorageKey()) || "[]"));
    } catch {
      return new Set();
    }
  }

  function writeOpsDone(done) {
    try {
      localStorage.setItem(opsStorageKey(), JSON.stringify([...done]));
    } catch {
      // Local storage is optional in privacy-restricted browsers.
    }
  }

  function buildOpsTasks() {
    const tasks = [];
    const rows = allModelRows().filter((row) => inScope(row) && (state.condition === "全部" || row.condition === state.condition));
    const anomalyStats = conditionStatsFor(state.scope, state.condition);
    if (anomalyStats.anomalies > 0) {
      tasks.push({
        id: `anomaly-${state.scope}-${state.condition}`,
        severity: "P0",
        tag: "价格核验",
        title: `核验 ${num(anomalyStats.anomalies)} 条异常跳价`,
        detail: `${scopeLabel()} · ${conditionLabel()} · 超过 ±${data.meta.anomalyLimit}% 的报价已隔离，先排除录价或映射错误。`,
        action: "anomaly",
        actionLabel: "筛选异常",
      });
    }

    const mover = rows
      .filter((row) => !row.isAnomaly && row.change !== null && Math.abs(row.change) >= 5)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
    if (mover) {
      tasks.push({
        id: `mover-${mover.id}-${mover.condition}`,
        severity: "P1",
        tag: "机型异动",
        title: `${mover.model} ${signedPercent(mover.change)}`,
        detail: `${mover.brand} · ${mover.mainMemory} · 有效波动 ${Math.abs(mover.change).toFixed(2)}%，覆盖 ${mover.coverageDays}/7 天。`,
        action: "model",
        actionLabel: "查看报价",
        modelId: mover.id,
      });
    }

    const brand = data.brands
      .map((item) => ({ item, value: brandDailyValue(item) }))
      .filter((entry) => entry.value.normal >= SAMPLE_LIMIT && Math.abs(entry.value.change) >= 3)
      .sort((a, b) => Math.abs(b.value.change) - Math.abs(a.value.change))[0];
    if (brand) {
      tasks.push({
        id: `brand-${brand.item.name}-${state.condition}`,
        severity: "P2",
        tag: "品牌脉动",
        title: `${brand.item.name} 品牌日变动 ${signedPercent(brand.value.change)}`,
        detail: `${scopeLabel()} · ${conditionLabel()} · 可比样本 ${num(brand.value.normal)} 条，复核是否由单一配置拉动。`,
        action: "brand",
        actionLabel: "筛选品牌",
        brand: brand.item.name,
      });
    }

    const sameTierModels = data.models.filter((model) => (state.scope === "all" || model.inTop100) && hasSameThreeTierSeries(model));
    if (sameTierModels.length) {
      tasks.push({
        id: `condition-collision-${state.scope}`,
        severity: "P1",
        tag: "成色映射",
        title: `复核 ${num(sameTierModels.length)} 款机型的三档成色同价`,
        detail: `${scopeLabel()} · 靓机/小花/大花完整 7 日序列一致；优先检查成色映射、补价逻辑与源报价，不宜据此判断成色价差。`,
        action: "model",
        actionLabel: "查看首款",
        modelId: sameTierModels[0].id,
      });
    }

    const quality = currentQuality();
    const scopeQuality = statsFor(state.scope);
    const coverage = scopeQuality.coverage ?? quality.coverage;
    const matchedRate = scopeQuality.matchedRate ?? quality.matchedRate;
    const zeroSkus = scopeQuality.zeroSkus ?? quality.zeroQuotes;
    if (coverage < 90 || matchedRate < 85) {
      tasks.push({
        id: `coverage-${currentDate().date}-${state.scope}`,
        severity: "P1",
        tag: "数据缺口",
        title: `补齐 ${num(zeroSkus)} 条无价记录`,
        detail: `${scopeLabel()} · ${currentDate().label} 有价率 ${fixed(coverage, 1)}%，两日匹配 ${fixed(matchedRate, 1)}%。`,
        action: "quality",
        actionLabel: "查看体检",
      });
    }

    const gap = Math.max(0, TARGET_MODELS - Number(data.meta.totalModels || 0));
    if (gap > 0) {
      tasks.push({
        id: "pool-gap",
        severity: "P2",
        tag: "代理解析",
        title: `目标池缺口 ${num(gap)} 款机型`,
        detail: `目标 ${num(TARGET_MODELS)} 款，当前 ${num(data.meta.totalModels)} 款；区分未接入、已下线与无有效报价。`,
        action: "pool",
        actionLabel: "查看口径",
      });
    }
    return tasks;
  }

  function renderOps() {
    const list = $("#opsList");
    if (!list) return;
    const done = readOpsDone();
    const tasks = buildOpsTasks().filter((task) => !done.has(task.id));
    $("#opsPending").textContent = num(tasks.length);
    if (!tasks.length) {
      list.innerHTML = `<div class="ops-empty"><strong>今日触发项已全部核验</strong><span>重置后可重新查看完整清单。</span></div>`;
      return;
    }
    list.innerHTML = tasks.map((task) => `<article class="ops-item ops-${task.severity.toLowerCase()}" data-ops-id="${escapeHtml(task.id)}">
      <div class="ops-item-top"><span class="ops-priority">${task.severity}</span><span class="ops-tag">${escapeHtml(task.tag)}</span><span class="ops-status">待核验</span></div>
      <strong>${escapeHtml(task.title)}</strong>
      <p>${escapeHtml(task.detail)}</p>
      <div class="ops-item-actions"><button type="button" data-ops-action="${task.action}" data-ops-id="${escapeHtml(task.id)}" ${task.modelId ? `data-ops-model="${escapeHtml(task.modelId)}"` : ""} ${task.brand ? `data-ops-brand="${escapeHtml(task.brand)}"` : ""}>${task.actionLabel}</button><button type="button" class="ops-done" data-ops-done="${escapeHtml(task.id)}">标记已核验</button></div>
    </article>`).join("");
  }

  function runOpsAction(button) {
    const action = button.dataset.opsAction;
    if (action === "anomaly") {
      state.sort = "anomaly";
      state.visibleCount = defaultVisibleCount();
      renderTable();
      syncControls();
      scrollToSection("models");
    } else if (action === "model") {
      openDrawer(button.dataset.opsModel);
    } else if (action === "brand") {
      state.brand = button.dataset.opsBrand;
      state.visibleCount = defaultVisibleCount();
      renderAll();
      scrollToSection("models");
    } else if (action === "quality") {
      scrollToSection("quality");
    } else if (action === "pool") {
      openMethods();
    }
  }

  function renderMarketChart() {
    const container = $("#marketChart");
    if (!container) return;
    const styles = getComputedStyle(container);
    const width = Math.max(300, container.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight));
    const height = Math.max(230, container.clientHeight);
    const margin = { top: 22, right: 16, bottom: 29, left: 43 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const labels = data.dates.map((item) => item.date);
    const conditionSeries = data.conditions.map((condition) => ({
      name: condition.name,
      color: condition.color,
      values: state.scope === "all" ? condition.indexSeries : condition.top100IndexSeries,
    }));
    const activeSeries = seriesFor(state.scope, state.condition);
    const values = conditionSeries.flatMap((item) => item.values).concat(activeSeries);
    let min = Math.min(...values);
    let max = Math.max(...values);
    const range = Math.max(max - min, 0.45);
    min -= range * 0.18;
    max += range * 0.18;
    const pointCount = labels.length;
    const x = (index) => margin.left + (index / Math.max(1, pointCount - 1)) * plotWidth;
    const y = (value) => margin.top + ((max - value) / (max - min)) * plotHeight;

    let gridMarkup = "";
    for (let index = 0; index <= 4; index += 1) {
      const yPosition = margin.top + (index / 4) * plotHeight;
      const value = max - (index / 4) * (max - min);
      gridMarkup += `<line class="chart-grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${yPosition}" y2="${yPosition}"/><text class="chart-axis-text" x="${margin.left - 10}" y="${yPosition + 3}" text-anchor="end">${value.toFixed(1)}</text>`;
    }
    const xLabels = labels.map((label, index) => {
      const anchor = index === 0 ? "start" : index === pointCount - 1 ? "end" : "middle";
      return `<text class="chart-x-label ${index === state.dateIndex ? "is-selected" : ""}" x="${x(index)}" y="${height - 8}" text-anchor="${anchor}">${formatAxisDate(label)}</text>`;
    }).join("");
    const lineMarkup = conditionSeries.map((item) => {
      const path = item.values.map((value, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(" ");
      const isFocused = state.condition === item.name;
      const isMuted = state.condition !== "全部" && !isFocused;
      return `<g class="chart-series" data-series="${escapeHtml(item.name)}"><path class="chart-line ${isFocused ? "is-focused" : ""} ${isMuted ? "is-muted" : ""}" d="${path}" stroke="${item.color}"/><circle class="chart-end-dot" cx="${x(pointCount - 1)}" cy="${y(item.values.at(-1))}" r="2.7" fill="${item.color}"/></g>`;
    }).join("");
    const selectedX = x(state.dateIndex);
    const selectedValue = activeSeries[state.dateIndex];
    const selectedMarkup = `<line class="chart-selected-line" x1="${selectedX}" x2="${selectedX}" y1="${margin.top}" y2="${margin.top + plotHeight}"/><circle class="chart-selected-dot" cx="${selectedX}" cy="${y(selectedValue)}" r="4" fill="${state.condition === "全部" ? "#171a16" : conditionColor(state.condition)}"/><g transform="translate(${clamp(selectedX, margin.left + 34, width - margin.right - 34)},${margin.top + 8})"><rect class="chart-selected-label-bg" x="-26" y="-8" width="52" height="16"/><text class="chart-selected-label" x="0" y="2" text-anchor="middle">${currentDate().short}</text></g>`;

    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(scopeLabel())}${escapeHtml(conditionLabel())}价格指数趋势图">${gridMarkup}${xLabels}${lineMarkup}${selectedMarkup}<g class="chart-cursor" visibility="hidden"><line class="chart-cursor-line" y1="${margin.top}" y2="${margin.top + plotHeight}"/><g class="chart-cursor-dots"></g></g><rect class="chart-hover-area" x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" fill="transparent"/></svg><div class="chart-tooltip" hidden></div>`;

    const tooltip = $(".chart-tooltip", container);
    const cursor = $(".chart-cursor", container);
    const cursorLine = $(".chart-cursor-line", container);
    const cursorDots = $(".chart-cursor-dots", container);
    const hoverArea = $(".chart-hover-area", container);
    const leftPadding = parseFloat(styles.paddingLeft);
    hoverArea.addEventListener("pointermove", (event) => {
      const rect = container.getBoundingClientRect();
      const localX = event.clientX - rect.left - leftPadding;
      const plotX = clamp(localX - margin.left, 0, plotWidth);
      const index = Math.round((plotX / plotWidth) * (pointCount - 1));
      const cursorX = x(index);
      cursor.setAttribute("visibility", "visible");
      cursorLine.setAttribute("x1", cursorX);
      cursorLine.setAttribute("x2", cursorX);
      cursorDots.innerHTML = conditionSeries.map((item) => `<circle class="chart-cursor-dot" cx="${cursorX}" cy="${y(item.values[index])}" r="3" fill="${item.color}"/>`).join("");
      tooltip.hidden = false;
      tooltip.innerHTML = `<div class="tooltip-date">${longDate(labels[index])} · ${data.dates[index].weekday}</div>${conditionSeries.map((item) => `<div class="tooltip-row"><span><i style="background:${item.color}"></i>${escapeHtml(item.name)}</span><strong>${item.values[index].toFixed(2)}</strong></div>`).join("")}`;
      const approximateY = y(Math.max(...conditionSeries.map((item) => item.values[index])));
      tooltip.style.left = `${leftPadding + cursorX}px`;
      tooltip.style.top = `${Math.max(38, approximateY)}px`;
      tooltip.classList.toggle("is-flipped", cursorX > plotWidth * 0.68);
      tooltip.classList.toggle("is-below", approximateY < 93);
    });
    hoverArea.addEventListener("pointerleave", () => {
      cursor.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
    });

    const stats = conditionStatsFor(state.scope, state.condition);
    $("#chartTitle").textContent = `${scopeLabel()}${state.condition === "全部" ? "市场指数" : ` · ${state.condition}指数`} · 近7日`;
    $("#chartSummaryLabel").textContent = `${scopeLabel()} · ${conditionLabel()} · ${currentDate().short}`;
    $("#chartSummaryValue").textContent = fixed(stats.index, 2);
    setDirection($("#chartSummaryDelta"), state.dateIndex === 0 ? 0 : stats.change);
    $(".base-date").textContent = `BASE ${longDate(data.meta.dateFrom)} = 100`;
    if (state.dateIndex === 0) {
      $("#chartSummaryNote").textContent = "基准日：五类成色指数统一归一到 100，暂无前一交易日涨跌。";
    } else if (state.condition !== "全部") {
      $("#chartSummaryNote").textContent = `${state.condition}可比样本 ${num(stats.normal)} 条；日涨跌 ${signedPercent(stats.change)}，异常跳价不参与指数。`;
    } else {
      const ranked = data.conditions.map((condition) => ({ name: condition.name, stats: conditionStatsFor(state.scope, condition.name) })).filter((item) => item.stats.normal >= SAMPLE_LIMIT);
      if (ranked.length) {
        ranked.sort((a, b) => a.stats.change - b.stats.change);
        $("#chartSummaryNote").textContent = `${ranked.at(-1).name}${signedPercent(ranked.at(-1).stats.change)}相对最强，${ranked[0].name}${signedPercent(ranked[0].stats.change)}相对最弱；异常跳价已隔离。`;
      } else {
        $("#chartSummaryNote").textContent = "当前范围可比样本不足，暂不输出成色强弱结论。";
      }
    }
  }

  function formatAxisDate(value) {
    return value.slice(5).replace("-", ".");
  }

  function renderLegend() {
    $("#chartLegend").innerHTML = data.conditions.map((condition) => {
      const stats = conditionStatsFor(state.scope, condition.name);
      return `<button class="legend-item ${state.condition === condition.name ? "is-active" : ""}" type="button" data-condition-legend="${condition.name}" style="--legend-color:${condition.color}"><i></i><span>${condition.name}</span><strong>${fixed(stats.index, 2)}</strong></button>`;
    }).join("");
  }

  function renderSignals() {
    const rows = allModelRows().filter((row) => inScope(row) && row.change !== null && !row.isAnomaly);
    rows.sort((a, b) => b.impact - a.impact || b.price - a.price);
    const mover = state.dateIndex > 0 ? rows[0] : null;
    const rankedBrands = data.brands.map((brand) => ({ brand, value: brandDailyValue(brand) })).filter((item) => item.value.normal >= SAMPLE_LIMIT).sort((a, b) => b.value.change - a.value.change);
    const brandSignal = rankedBrands.at(-1) || null;
    const conditionSignals = data.conditions.map((condition) => ({ name: condition.name, stats: conditionStatsFor(state.scope, condition.name) })).filter((item) => item.stats.normal >= SAMPLE_LIMIT).sort((a, b) => b.stats.change - a.stats.change);
    const strongestCondition = conditionSignals[0];
    const weakestCondition = conditionSignals.at(-1);

    const moverMarkup = mover
      ? `<div class="signal-item" data-model-id="${mover.id}" tabindex="0" role="button" aria-label="查看 ${escapeHtml(mover.model)} 详情"><span class="signal-index">01</span><div class="signal-main"><div class="signal-tagline"><span>MODEL / 单款异动</span><span class="severity ${Math.abs(mover.change) >= 3 ? "" : "is-watch"}">${Math.abs(mover.change) >= 3 ? "高" : "关注"}</span></div><strong>${escapeHtml(mover.model)} · ${escapeHtml(mover.mainMemory)}</strong><p>${escapeHtml(mover.condition)}较上一交易日${mover.change >= 0 ? "上涨" : "回落"}；当前价 ¥${num(mover.price)}，${mover.isAnomaly ? "属于异常跳价。" : "已进入趋势样本。"}</p></div><span class="signal-delta ${directionClass(mover.change)}">${signedPercent(mover.change)}</span></div>`
      : `<div class="signal-item"><span class="signal-index">01</span><div class="signal-main"><div class="signal-tagline"><span>MODEL / 单款异动</span><span class="severity is-watch">基准</span></div><strong>${currentDate().label}暂无日涨跌可比</strong><p>首日指数归一，单款机型价格作为后续比较基准。</p></div><span class="signal-delta">—</span></div>`;
    const brandMarkup = brandSignal
      ? `<div class="signal-item" data-brand-filter="${escapeHtml(brandSignal.brand.name)}" tabindex="0" role="button" aria-label="筛选 ${escapeHtml(brandSignal.brand.name)} 品牌"><span class="signal-index">02</span><div class="signal-main"><div class="signal-tagline"><span>BRAND / 品牌波动</span><span class="severity ${brandSignal.value.change < 0 ? "is-watch" : "is-observe"}">${brandSignal.value.change < 0 ? "关注" : "观察"}</span></div><strong>${escapeHtml(brandSignal.brand.name)}${brandSignal.value.change >= 0 ? "报价相对走强" : "报价相对承压"}</strong><p>${conditionLabel()}可比样本 ${num(brandSignal.value.normal)} 条，品牌日涨跌 ${signedPercent(brandSignal.value.change)}。</p></div><span class="signal-delta ${directionClass(brandSignal.value.change)}">${signedPercent(brandSignal.value.change)}</span></div>`
      : `<div class="signal-item"><span class="signal-index">02</span><div class="signal-main"><div class="signal-tagline"><span>BRAND / 品牌波动</span><span class="severity is-observe">观察</span></div><strong>品牌可比样本不足</strong><p>当前范围与成色下没有达到 5 条样本的品牌，暂不排序。</p></div><span class="signal-delta">—</span></div>`;
    const spread = strongestCondition && weakestCondition ? Number((strongestCondition.stats.change - weakestCondition.stats.change).toFixed(2)) : null;
    const conditionMarkup = strongestCondition
      ? `<div class="signal-item"><span class="signal-index">03</span><div class="signal-main"><div class="signal-tagline"><span>CONDITION / 成色结构</span><span class="severity is-observe">观察</span></div><strong>成色之间相差 ${fixed(spread, 2)}pp</strong><p>${strongestCondition.name} ${signedPercent(strongestCondition.stats.change)} 相对最强，${weakestCondition.name} ${signedPercent(weakestCondition.stats.change)} 相对最弱。</p></div><span class="signal-delta ${directionClass(spread)}">${signedPercent(spread)}</span></div>`
      : `<div class="signal-item"><span class="signal-index">03</span><div class="signal-main"><div class="signal-tagline"><span>CONDITION / 成色结构</span><span class="severity is-observe">观察</span></div><strong>成色样本不足</strong><p>当前范围可比样本不足 5 条，暂不输出成色结构结论。</p></div><span class="signal-delta">—</span></div>`;
    $("#signalList").innerHTML = moverMarkup + brandMarkup + conditionMarkup;
  }

  function renderHeatmap() {
    const headers = CONDITIONS.map((condition) => `<div class="heat-cell heat-head ${state.condition === condition ? "is-active" : ""}">${condition}</div>`).join("");
    const rows = data.brands.map((brand) => {
      const brandStats = brandStatsFor(brand);
      return `<div class="heat-brand ${state.brand === brand.name ? "is-active" : ""}" data-brand-filter="${escapeHtml(brand.name)}" tabindex="0" role="button" aria-label="筛选 ${escapeHtml(brand.name)} 品牌"><span class="brand-monogram">${brand.short}</span><span>${escapeHtml(brand.name)}</span></div>${CONDITIONS.map((condition) => {
        const value = brandStats?.conditions?.[condition]?.change ?? 0;
        const normal = brandStats?.conditions?.[condition]?.normal ?? 0;
        if (normal < SAMPLE_LIMIT) {
          return `<div class="heat-cell is-insufficient" data-heat-brand="${escapeHtml(brand.name)}" data-heat-condition="${condition}" tabindex="0" role="button" aria-label="筛选 ${escapeHtml(brand.name)} ${condition}，样本不足" title="${escapeHtml(brand.name)} · ${condition}：可比样本 ${normal} 条，样本不足">不足</div>`;
        }
        const ratio = Math.min(1, Math.abs(value) / 3);
        const alpha = 0.055 + ratio * 0.34;
        const background = value > 0 ? `rgba(217,79,53,${alpha})` : value < 0 ? `rgba(20,118,95,${alpha})` : "rgba(233,228,215,.6)";
        const color = value > 0 ? "#642014" : value < 0 ? "#084a3c" : "var(--muted)";
        return `<div class="heat-cell ${directionName(value)}" data-heat-brand="${escapeHtml(brand.name)}" data-heat-condition="${condition}" tabindex="0" role="button" aria-label="筛选 ${escapeHtml(brand.name)} ${condition}" style="background:${background};color:${color}" title="${escapeHtml(brand.name)} · ${condition}：${signedPercent(value)}，样本 ${normal} 条">${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}</div>`;
      }).join("")}`;
    }).join("");
    $("#brandHeatmap").innerHTML = `<div class="heat-corner">品牌 / 成色</div>${headers}${rows}`;
    $("#heatScopeLabel").textContent = `全内存 SKU · ${scopeLabel()} · ${currentDate().short} · 日涨跌`;
  }

  function renderBrandRanking() {
    const ranked = data.brands.map((brand) => {
      const value = brandDailyValue(brand);
      const breadth = brandBreadthFor(brand.name, state.scope);
      return {
        brand,
        value,
        breadth,
        displayChange: state.condition === "全部" ? value.change : breadth.change,
        comparable: state.condition === "全部" ? value.normal : breadth.normal,
      };
    }).sort((a, b) => {
      const aValid = a.comparable >= SAMPLE_LIMIT;
      const bValid = b.comparable >= SAMPLE_LIMIT;
      if (aValid !== bValid) return aValid ? -1 : 1;
      return b.displayChange - a.displayChange;
    });
    $("#brandRankingTitle").textContent = `${scopeLabel()}品牌涨跌广度${state.condition === "全部" ? "" : ` · ${state.condition}`}`;
    $("#rankingSortLabel").innerHTML = `${currentDate().short} · 日涨跌 <span>↓</span>`;
    $("#brandRanking").innerHTML = ranked.map((item, index) => {
      const { brand, value, breadth, displayChange, comparable } = item;
      const insufficient = comparable < SAMPLE_LIMIT;
      const stats = value.stats || brandStatsFor(brand);
      const total = Math.max(1, breadth.sample);
      const upWidth = (breadth.up / total) * 100;
      const flatWidth = (breadth.flat / total) * 100;
      const downWidth = (breadth.down / total) * 100;
      const detail = insufficient ? "可比样本不足" : `上涨 ${breadth.up}，下跌 ${breadth.down}，持平 ${breadth.flat}，下跌占比 ${fixed(breadth.downShare, 1)}%`;
      return `<div class="brand-row ${state.brand === brand.name ? "is-active" : ""} ${insufficient ? "is-insufficient" : ""}" data-brand-filter="${escapeHtml(brand.name)}" tabindex="0" role="button" aria-label="${escapeHtml(brand.name)}，日变动 ${insufficient ? "样本不足" : signedPercent(displayChange)}；${detail}。筛选品牌" title="${escapeHtml(brand.name)} · ${detail}"><span class="brand-rank">${String(index + 1).padStart(2, "0")}</span><span class="brand-monogram">${brand.short}</span><span class="brand-row-name"><strong>${escapeHtml(brand.name)}</strong><small>${num(brandModelCount(brand.name))} 款 · ${num(breadth.sample)} 条变动</small></span><span class="brand-row-index">${insufficient ? "—" : state.condition === "全部" ? fixed(stats.index, 2) : "—"}</span><span class="brand-row-change ${insufficient ? "" : directionClass(displayChange)}">${insufficient ? "样本不足" : signedPercent(displayChange)}</span><div class="brand-meter" aria-hidden="true"><div class="brand-breadth-bar"><i class="is-up" style="width:${upWidth}%"></i><i class="is-flat" style="width:${flatWidth}%"></i><i class="is-down" style="width:${downWidth}%"></i></div><div class="brand-breadth-meta"><span class="up-text">↑${num(breadth.up)}</span><span class="down-text">↓${num(breadth.down)}</span><span class="brand-flat-count">—${num(breadth.flat)}</span><b>跌 ${breadth.downShare === null ? "—" : `${fixed(breadth.downShare, 0)}%`}</b></div></div></div>`;
    }).join("");
    $(".ranking-panel .ranking-foot").innerHTML = state.condition === "全部"
      ? `<span><i class="legend-square up-bg"></i>上涨 SKU</span><span><i class="legend-square down-bg"></i>下跌 SKU</span><span>全内存 SKU 口径 · 少于 ${SAMPLE_LIMIT} 条不排序</span>`
      : `<span><i class="legend-square up-bg"></i>主配置上涨</span><span><i class="legend-square down-bg"></i>主配置下跌</span><span>${state.condition}机型口径 · 异常价隔离</span>`;
  }

  function renderTable() {
    const rows = filteredModelRows();
    const visible = rows.slice(0, state.visibleCount);
    const table = $(".table-wrap table");
    const emptyState = $("#emptyState");
    const loadMore = $("#loadMore");
    $("#rankHeader").textContent = state.scope === "top100" ? (state.sort === "rank" ? "池内" : "序") : "NO.";
    const windowHeader = $("#windowHeader");
    if (windowHeader) windowHeader.textContent = "期内";

    if (!visible.length) {
      $("#modelRows").innerHTML = "";
      table.hidden = true;
      emptyState.hidden = false;
      loadMore.hidden = true;
      $("#resultCount").textContent = "0 款机型";
    } else {
      table.hidden = false;
      emptyState.hidden = true;
      $("#modelRows").innerHTML = visible.map((row, index) => {
        const status = statusForRow(row);
        const rank = state.scope === "top100" && state.sort === "rank" ? row.top100Rank : index + 1;
        const bars = data.dates.map((date, dayIndex) => `<b class="${row.history[dayIndex] !== null ? "is-on" : ""}"></b>`).join("");
        return `<tr data-model-id="${row.id}" tabindex="0" aria-label="查看 ${escapeHtml(row.model)} ${escapeHtml(row.condition)} 详情"><td><span class="rank-cell ${state.scope === "top100" ? "is-top" : ""}">${rank ? String(rank).padStart(2, "0") : "—"}</span></td><td><div class="model-cell"><span class="model-badge">${row.brandShort}</span><div><strong>${escapeHtml(row.model)}</strong><small>MODEL ID · ${escapeHtml(row.modelId)}</small><span class="mobile-model-meta">${escapeHtml(row.brand)} · ${escapeHtml(row.mainMemory)} · ${escapeHtml(row.condition)}</span></div></div></td><td><span class="brand-text">${escapeHtml(row.brand)}</span></td><td><span class="memory-pill">${escapeHtml(row.mainMemory)}</span></td><td><span class="condition-badge"><i style="background:${conditionColor(row.condition)}"></i>${escapeHtml(row.condition)}</span></td><td class="align-right"><span class="price-value">¥${num(row.price)}</span></td><td class="align-right"><div class="delta-cell"><span class="delta-main ${directionClass(row.change)}">${signedPercent(row.change)}</span><span class="delta-sub">${signedMoney(row.changeAmount)}</span></div></td><td class="align-right hide-tablet"><span class="${directionClass(row.windowChange)}">${signedPercent(row.windowChange)}</span></td><td class="spark-col hide-tablet"><div class="spark-cell">${sparkline(row.history.slice(0, state.dateIndex + 1), conditionColor(row.condition), 75, 24)}</div></td><td class="align-center hide-tablet"><span class="coverage-cell" title="${row.coverageDays}/7 天有价"><i>${bars}</i>${row.coverageDays}/7</span></td><td class="align-right hide-tablet"><span class="status-badge ${status.className}">${status.text}</span></td><td class="chevron-col"><span class="row-chevron"><svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></svg></span></td></tr>`;
      }).join("");
      loadMore.hidden = rows.length <= state.visibleCount;
      $("#resultCount").textContent = `显示 1–${visible.length} / ${rows.length} 款${state.scope === "top100" ? "重点机型" : "全量机型"}`;
    }

    const isTop100 = state.scope === "top100";
    $("#modelPanelKicker").textContent = `MODEL WATCH / ${isTop100 ? "TOP100 重点池" : `${data.meta.totalModels} 款全量`}`;
    $("#modelPanelTitle").textContent = isTop100 ? "TOP100 机型涨跌榜" : "全量机型涨跌榜";
    $("#modelPanelNote").textContent = `${currentDate().label} · ${conditionLabel()} · ${isTop100 ? "固定重点池" : "覆盖全量在榜机型"} · ${SORT_LABELS[state.sort]}；点击行查看 7 日走势。`;
    $("#outlierBadge").innerHTML = `<i></i> ${num(statsFor(state.scope).anomalies)} 条异常价隔离`;
    const hasFilter = state.brand !== "all" || state.condition !== "全部" || state.query.trim() !== "";
    $("#clearFilters").hidden = !hasFilter;
  }

  function renderQuality() {
    const quality = currentQuality();
    const totalMissing = data.dates.reduce((total, item) => total + item.quality.missingMemory, 0);
    const allStats = statsFor("all");
    $("#qualitySummary").textContent = `${currentDate().label}批次 ${num(quality.rows)} 条记录；${num(quality.zeroQuotes)} 条零价、${num(quality.missingMemory)} 条内存缺失单独隔离。`;
    $("#qualityTotalSkus").textContent = num(data.meta.totalSkus);
    $("#qualityMatchRate").textContent = `${fixed(quality.matchedRate, 1)}%`;
    $("#qualityMatchCount").textContent = `${num(quality.matched)} 条可比`;
    $("#qualityMissingMemory").textContent = num(totalMissing);
    $("#qualityAnomalies").textContent = num(allStats.anomalies);
    $("#qualityTimeline").innerHTML = data.dates.map((date, index) => `<button class="quality-day ${index === state.dateIndex ? "is-selected" : ""}" type="button" data-quality-date="${index}" title="查看 ${date.label} 数据"><div class="quality-day-head"><span>${date.short} · ${date.weekday}</span><strong>${num(date.quality.validKeys)}</strong></div><div class="quality-day-bar"><span style="width:${date.quality.coverage}%"></span></div></button>`).join("");
  }

  function syncControls() {
    $$(".scope-button").forEach((button) => {
      const active = button.dataset.scope === state.scope;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $$(".condition-pill").forEach((button) => {
      const active = button.dataset.condition === state.condition;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $("#allScopeCount").textContent = num(data.meta.totalModels);
    $("#brandFilter").value = state.brand;
    $("#sortFilter").value = state.sort;
    $("#clearFilters").hidden = !(state.brand !== "all" || state.condition !== "全部" || state.query.trim() !== "");
  }

  function renderAll() {
    renderDateChrome();
    renderTape();
    renderKpis();
    renderTop100Band();
    renderBriefing();
    renderOps();
    renderMarketChart();
    renderLegend();
    renderSignals();
    renderHeatmap();
    renderDistribution();
    renderPriceBands();
    renderCohort();
    renderBrandRanking();
    renderTable();
    renderQuality();
    syncControls();
    if (state.drawerModelId && $("#detailDrawer").classList.contains("is-open")) renderDrawer();
  }

  function setDate(index) {
    state.dateIndex = clamp(Number(index), 0, data.dates.length - 1);
    state.visibleCount = defaultVisibleCount();
    renderAll();
  }

  function setScope(scope) {
    if (scope !== "all" && scope !== "top100") return;
    state.scope = scope;
    state.visibleCount = defaultVisibleCount();
    renderAll();
  }

  function setCondition(condition, notify = false) {
    state.condition = condition;
    state.visibleCount = defaultVisibleCount();
    renderAll();
    if (notify) showToast(`已切换至${condition === "全部" ? "全成色" : condition}`);
  }

  function toggleBrand(brand, scroll = false) {
    state.brand = state.brand === brand ? "all" : brand;
    state.visibleCount = defaultVisibleCount();
    renderAll();
    if (scroll) $("#models").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetFilters() {
    state.brand = "all";
    state.query = "";
    state.condition = "全部";
    state.sort = "impact";
    state.visibleCount = defaultVisibleCount();
    $("#modelSearch").value = "";
    renderAll();
    showToast("筛选条件已清空");
  }

  function openDrawer(id) {
    const model = modelById(id);
    if (!model) return;
    state.drawerModelId = model.id;
    state.drawerTrigger = document.activeElement;
    state.drawerMemory = modelMemories(model).includes(model.mainMemory) ? model.mainMemory : modelMemories(model)[0];
    state.drawerCondition = state.condition !== "全部" && configPriceAt(model, state.drawerMemory, state.condition, state.dateIndex) !== null ? state.condition : rowCondition(model) || model.primaryCondition;
    $("#drawerTitle").textContent = model.model;
    $("#drawerBrand").textContent = model.brand;
    $("#drawerMemory").textContent = state.drawerMemory;
    $("#drawerDate").textContent = `${longDate(currentDate().date)} · ${currentDate().weekday}`;
    renderDrawer();
    const backdrop = $("#drawerBackdrop");
    const drawer = $("#detailDrawer");
    backdrop.hidden = false;
    drawer.setAttribute("aria-hidden", "false");
    drawer.inert = false;
    setPageInert(true);
    document.body.classList.add("drawer-open");
    void drawer.offsetWidth;
    backdrop.classList.add("is-visible");
    drawer.classList.add("is-open");
    renderDrawer();
    window.setTimeout(() => $("#drawerClose").focus(), 80);
  }

  function closeDrawer() {
    const backdrop = $("#drawerBackdrop");
    const drawer = $("#detailDrawer");
    backdrop.classList.remove("is-visible");
    backdrop.hidden = true;
    drawer.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
    drawer.inert = true;
    setPageInert(false);
    document.body.classList.remove("drawer-open");
    const closedId = state.drawerModelId;
    const trigger = state.drawerTrigger;
    if (state.drawerModelId === closedId) state.drawerModelId = null;
    state.drawerTrigger = null;
    if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  function setPageInert(value) {
    [".sidebar", ".app-shell", ".mobile-nav"].forEach((selector) => {
      const element = document.querySelector(selector);
      if (element) element.inert = value;
    });
  }

  function renderDrawer() {
    const model = modelById(state.drawerModelId);
    if (!model) return;
    const memories = modelMemories(model);
    let memory = memories.includes(state.drawerMemory) ? state.drawerMemory : memories.includes(model.mainMemory) ? model.mainMemory : memories[0];
    let condition = state.drawerCondition;
    if (configPriceAt(model, memory, condition, state.dateIndex) === null) {
      const fallbackMemory = memories.find((item) => configPriceAt(model, item, condition, state.dateIndex) !== null);
      if (fallbackMemory) memory = fallbackMemory;
      condition = CONDITIONS.find((item) => configPriceAt(model, memory, item, state.dateIndex) !== null) || model.primaryCondition;
    }
    state.drawerMemory = memory;
    state.drawerCondition = condition;
    const history = configFor(model, memory)[condition] || [];
    const price = configPriceAt(model, memory, condition, state.dateIndex);
    const previousPrice = state.dateIndex > 0 ? configPriceAt(model, memory, condition, state.dateIndex - 1) : null;
    const dailyChange = price && previousPrice ? percentChange(price, previousPrice) : state.dateIndex === 0 ? 0 : null;
    const changeAmount = price && previousPrice ? price - previousPrice : null;
    const configMode = data.meta.configDataMode === "synthetic-demo" ? "演示配置阶梯" : "真实多内存报价";
    $("#drawerMemory").textContent = `${memory}${memory === model.mainMemory ? " · 主配置" : ""}`;
    $("#drawerConfigMode").textContent = configMode;
    $("#drawerCondition").textContent = `${memory} · ${condition} · 当前价`;
    $("#drawerPrice").textContent = price ? `¥${num(price)}` : "—";
    const delta = $("#drawerChange");
    delta.textContent = dailyChange === null ? "—" : `${signedPercent(dailyChange)} / ${signedMoney(changeAmount)}`;
    delta.className = `price-delta ${directionClass(dailyChange)}`;
    const note = $(".drawer-price-block small");
    if (note) note.textContent = state.dateIndex === 0 ? "基准日 · 暂无前一交易日" : "较上一交易日";
    $("#drawerMemoryOptions").innerHTML = memories.map((item) => `<button type="button" data-drawer-memory="${escapeHtml(item)}" class="${item === memory ? "is-active" : ""}" aria-pressed="${item === memory}"><span>${escapeHtml(item)}</span>${item === model.mainMemory ? "<small>主配置</small>" : ""}</button>`).join("");
    $("#drawerConditionTabs").innerHTML = CONDITIONS.map((item) => `<button type="button" data-drawer-condition="${item}" class="${item === condition ? "is-active" : ""}" aria-pressed="${item === condition}" ${configPriceAt(model, memory, item, state.dateIndex) === null ? "disabled" : ""}>${item}</button>`).join("");

    const stats = quoteStats(history, state.dateIndex);
    $("#quoteReferenceTitle").textContent = `${model.model} · ${memory} · ${condition}`;
    $("#drawerQuoteMedian").textContent = stats.median === null ? "—" : `¥${num(Math.round(stats.median))}`;
    $("#drawerQuoteRange").textContent = stats.low === null ? "—" : `¥${num(Math.round(stats.low))}–¥${num(Math.round(stats.high))}`;
    $("#drawerQuoteSample").textContent = `${stats.sample}/7 天`;
    $("#drawerQuoteDate").textContent = longDate(currentDate().date);
    $("#quoteConfigModeNote").textContent = configMode;
    const position = price && stats.min !== null && stats.max !== null ? (stats.max === stats.min ? "当前价位于窗口高位" : price <= stats.low ? "当前价低于近7日P25" : price >= stats.high ? "当前价高于近7日P75" : "当前价位于近7日区间内") : "暂无可比窗口";
    const volatility = stats.min !== null && stats.max !== null && stats.median ? ((stats.max - stats.min) / stats.median) * 100 : null;
    $("#drawerQuotePosition").textContent = position;
    $("#drawerQuoteVolatility").textContent = volatility === null ? "波动区间不足" : `近7日振幅 ${fixed(volatility, 1)}%`;
    const quoteReference = $("#quoteReference");
    let qualityWarning = $("#drawerQualityWarning", quoteReference);
    if (!qualityWarning) {
      qualityWarning = document.createElement("p");
      qualityWarning.id = "drawerQualityWarning";
      qualityWarning.className = "quote-quality-warning";
      qualityWarning.setAttribute("role", "note");
      $(".quote-risk-line", quoteReference)?.insertAdjacentElement("afterend", qualityWarning);
    }
    const tierPrices = THREE_TIER_CONDITIONS.map((item) => configPriceAt(model, memory, item, state.dateIndex));
    const hasTierCollision = tierPrices.every((value) => value !== null) && new Set(tierPrices).size === 1;
    qualityWarning.hidden = !hasTierCollision;
    qualityWarning.textContent = hasTierCollision ? `数据提醒：${memory} 的靓机、小花、大花当前同价，请复核成色映射或源报价，暂不据此判断成色价差。` : "";
    $("#quoteReference").classList.toggle("is-demo-config", data.meta.configDataMode === "synthetic-demo");
    $("#drawerDataNote").textContent = data.meta.configDataMode === "synthetic-demo" ? "当前报价矩阵为演示配置阶梯；主配置使用真实脱敏行情，其他内存按可见阶梯估算。接入真实多内存报价后自动替换。" : "缺失日不会被按 0 或降价处理；报价参考仅用于议价决策，不替代成交价、库存和毛利核算。";
    const watchButton = $("[data-quote-watch]");
    const watched = isWatched(model, memory, condition);
    if (watchButton) {
      watchButton.textContent = watched ? "已关注 SKU" : "关注 SKU";
      watchButton.setAttribute("aria-pressed", String(watched));
      watchButton.classList.toggle("is-active", watched);
    }

    renderSkuMatrix(model, memory, condition);
    const visibleHistory = history.map((value, index) => (index <= state.dateIndex ? value : null));
    const firstPrice = visibleHistory.find((value) => value !== null);
    const windowChange = firstPrice && price ? percentChange(price, firstPrice) : state.dateIndex === 0 ? 0 : null;
    $("#drawer7d").textContent = signedPercent(windowChange);
    $("#drawer7d").className = directionClass(windowChange);
    const coverageDays = history.filter((value) => value !== null).length;
    $("#drawerCoverage").textContent = `${coverageDays}/7 天`;
    $("#drawerRank").textContent = model.inTop100 ? `TOP ${model.top100Rank}` : "全量";
    drawDrawerChart(visibleHistory, conditionColor(condition), state.dateIndex);
  }

  function renderSkuMatrix(model, selectedMemory, selectedCondition) {
    const container = $("#skuMatrix");
    if (!container) return;
    const memories = modelMemories(model);
    const headers = CONDITIONS.map((condition) => `<th scope="col">${condition}</th>`).join("");
    const body = memories.map((memory) => {
      const cells = CONDITIONS.map((condition) => {
        const value = configPriceAt(model, memory, condition, state.dateIndex);
        const previous = state.dateIndex > 0 ? configPriceAt(model, memory, condition, state.dateIndex - 1) : null;
        const change = value && previous ? percentChange(value, previous) : null;
        const selected = memory === selectedMemory && condition === selectedCondition;
        return `<td><button type="button" class="matrix-cell ${selected ? "is-selected" : ""}" data-matrix-memory="${escapeHtml(memory)}" data-matrix-condition="${condition}" aria-pressed="${selected}" aria-label="${escapeHtml(model.model)} ${escapeHtml(memory)} ${condition} ${value ? `¥${num(value)}` : "暂无报价"}"><span>${value ? `¥${num(value)}` : "—"}</span><small class="${directionClass(change)}">${change === null ? "无日涨跌" : signedPercent(change)}</small></button></td>`;
      }).join("");
      return `<tr class="${memory === selectedMemory ? "is-selected" : ""}"><th scope="row"><button type="button" class="matrix-memory" data-matrix-memory="${escapeHtml(memory)}" aria-pressed="${memory === selectedMemory}" aria-label="切换至 ${escapeHtml(memory)} 内存配置">${escapeHtml(memory)}${memory === model.mainMemory ? "<small>主配置</small>" : ""}</button></th>${cells}</tr>`;
    }).join("");
    container.innerHTML = `<table class="sku-matrix"><caption class="sr-only">${escapeHtml(model.model)} 内存与成色报价矩阵</caption><thead><tr><th scope="col">内存</th>${headers}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function drawerSelection() {
    const model = modelById(state.drawerModelId);
    if (!model) return null;
    const memory = state.drawerMemory || model.mainMemory;
    const condition = state.drawerCondition || model.primaryCondition;
    const price = configPriceAt(model, memory, condition, state.dateIndex);
    const stats = quoteStats(configFor(model, memory)[condition] || [], state.dateIndex);
    return { model, memory, condition, price, stats };
  }

  async function copyText(text, successMessage) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    showToast(successMessage);
  }

  async function copyBriefing() {
    const brief = briefingData();
    await copyText(brief.copyText, "7日行情简报已复制");
  }

  async function copyQuoteSummary() {
    const selection = drawerSelection();
    if (!selection) return;
    const { model, memory, condition, price, stats } = selection;
    const summary = `${model.model} ${memory} ${condition}｜参考价 ${price ? `¥${num(price)}` : "暂无"}｜7日中位 ${stats.median === null ? "暂无" : `¥${num(Math.round(stats.median))}`}｜P25–P75 ${stats.low === null ? "暂无" : `¥${num(Math.round(stats.low))}–¥${num(Math.round(stats.high))}`}｜数据截至 ${currentDate().date}｜行情参考，非成交价`;
    await copyText(summary, "报价摘要已复制");
  }

  function exportSelectedSku() {
    const selection = drawerSelection();
    if (!selection) return;
    const { model, memory, condition } = selection;
    const history = configFor(model, memory);
    const headers = ["业务日期", "机型ID", "机型", "品牌", "内存", ...CONDITIONS];
    const rows = data.dates.map((date, index) => [date.date, model.modelId, model.model, model.brand, memory, ...CONDITIONS.map((item) => history[item]?.[index] ?? "")]);
    const csv = `\uFEFF${[headers, ...rows].map((line) => line.map(csvCell).join(",")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${model.model.replace(/[\\/:*?"<>|]/g, "_")}_${memory}_${condition}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast("已导出当前 SKU 报价明细");
  }

  function drawDrawerChart(values, color, selectedIndex) {
    const container = $("#drawerChart");
    if (!container) return;
    const valid = values.map((value, index) => ({ value, index })).filter((item) => item.value !== null);
    if (!valid.length) {
      container.innerHTML = `<div class="empty-state"><strong>暂无可比价格</strong><span>该成色在所选日期前没有有效报价。</span></div>`;
      return;
    }
    const width = Math.max(280, container.clientWidth || 360);
    const height = Math.max(170, container.clientHeight || 174);
    const margin = { top: 18, right: 12, bottom: 25, left: 38 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    let min = Math.min(...valid.map((item) => item.value));
    let max = Math.max(...valid.map((item) => item.value));
    const range = Math.max(max - min, 1);
    min -= range * 0.16;
    max += range * 0.16;
    const x = (index) => margin.left + (index / Math.max(1, data.dates.length - 1)) * plotWidth;
    const y = (value) => margin.top + ((max - value) / (max - min)) * plotHeight;
    let grid = "";
    for (let index = 0; index <= 3; index += 1) {
      const yPosition = margin.top + (index / 3) * plotHeight;
      const value = max - (index / 3) * (max - min);
      grid += `<line class="chart-grid-line" x1="${margin.left}" x2="${width - margin.right}" y1="${yPosition}" y2="${yPosition}"/><text class="chart-axis-text" x="${margin.left - 8}" y="${yPosition + 3}" text-anchor="end">${Math.round(value)}</text>`;
    }
    let path = "";
    let drawing = false;
    values.forEach((value, index) => {
      if (value === null) {
        drawing = false;
        return;
      }
      path += `${drawing ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)} `;
      drawing = true;
    });
    const dots = valid.map((item) => `<circle cx="${x(item.index).toFixed(1)}" cy="${y(item.value).toFixed(1)}" r="2.4" fill="${color}" stroke="var(--card)" stroke-width="1.5"/>`).join("");
    const selectedX = x(selectedIndex);
    const gradientId = `drawer-area-${sparkCounter += 1}`;
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="所选日期前的价格走势"><defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity=".15"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>${grid}<line class="chart-selected-line" x1="${selectedX}" x2="${selectedX}" y1="${margin.top}" y2="${margin.top + plotHeight}"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>${dots}<text class="chart-x-label" x="${margin.left}" y="${height - 6}" text-anchor="start">${data.dates[0].short}</text><text class="chart-x-label" x="${width - margin.right}" y="${height - 6}" text-anchor="end">${data.dates[selectedIndex].short}</text></svg>`;
  }

  function csvCell(value) {
    const text = String(value ?? "").replace(/"/g, '""');
    return `"${text}"`;
  }

  function exportCsv() {
    const rows = filteredModelRows();
    if (!rows.length) {
      showToast("当前筛选结果为空，无法导出");
      return;
    }
    const headers = ["业务日期", "数据范围", "机型ID", "机型", "品牌", "主内存", "观察成色", "当前价", "前一交易日价", "日涨跌幅", "窗口涨跌幅", "窗口天数"];
    const body = rows.map((row) => [currentDate().date, scopeLabel(), row.modelId, row.model, row.brand, row.mainMemory, row.condition, row.price, row.previousPrice ?? "", `${row.change ?? ""}%`, `${row.windowChange ?? ""}%`, row.windowDays]);
    const csv = `\uFEFF${[headers, ...body].map((line) => line.map(csvCell).join(",")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `手机市场行情_${currentDate().date.replaceAll("-", "")}_${state.scope}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast(`已导出 ${rows.length} 条机型行情`);
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
    $$(".side-link, .mobile-nav button").forEach((button) => button.classList.toggle("is-active", button.dataset.scroll === sectionId));
  }

  function scrollToSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveNavigation(sectionId);
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const opsDone = event.target.closest("[data-ops-done]");
      if (opsDone) {
        const done = readOpsDone();
        done.add(opsDone.dataset.opsDone);
        writeOpsDone(done);
        renderOps();
        showToast("已标记核验，待办数量已更新");
        return;
      }
      const opsAction = event.target.closest("[data-ops-action]");
      if (opsAction) {
        runOpsAction(opsAction);
        return;
      }
      const scopeButton = event.target.closest("[data-scope]");
      if (scopeButton) {
        setScope(scopeButton.dataset.scope);
        return;
      }
      if (event.target.closest("[data-scope-select]")) {
        setScope(event.target.closest("[data-scope-select]").dataset.scopeSelect);
        scrollToSection("models");
        return;
      }
      const conditionButton = event.target.closest(".condition-pill");
      if (conditionButton) {
        setCondition(conditionButton.dataset.condition, true);
        return;
      }
      const legendButton = event.target.closest("[data-condition-legend]");
      if (legendButton) {
        const next = state.condition === legendButton.dataset.conditionLegend ? "全部" : legendButton.dataset.conditionLegend;
        setCondition(next);
        return;
      }
      const qualityDay = event.target.closest("[data-quality-date]");
      if (qualityDay) {
        setDate(Number(qualityDay.dataset.qualityDate));
        return;
      }
      const heatTarget = event.target.closest("[data-heat-brand]");
      if (heatTarget) {
        state.condition = heatTarget.dataset.heatCondition;
        state.brand = heatTarget.dataset.heatBrand;
        state.visibleCount = defaultVisibleCount();
        renderAll();
        scrollToSection("models");
        showToast(`已筛选 ${state.brand} · ${state.condition}`);
        return;
      }
      const brandTarget = event.target.closest("[data-brand-filter]");
      if (brandTarget) {
        toggleBrand(brandTarget.dataset.brandFilter, brandTarget.closest(".signal-item") !== null);
        return;
      }
      const modelRow = event.target.closest("[data-model-id]");
      if (modelRow) {
        openDrawer(modelRow.dataset.modelId);
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
        window.setTimeout(() => $("#modelSearch").focus(), 380);
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
      if (event.target.closest("[data-method-close]")) closeMethods();
    });

    $("#datePicker").addEventListener("change", (event) => setDate(Number(event.target.value)));
    $("#modelSearch").addEventListener("input", (event) => {
      state.query = event.target.value;
      state.visibleCount = defaultVisibleCount();
      renderTable();
      syncControls();
    });
    $("#brandFilter").addEventListener("change", (event) => {
      state.brand = event.target.value;
      state.visibleCount = defaultVisibleCount();
      renderAll();
    });
    $("#sortFilter").addEventListener("change", (event) => {
      state.sort = event.target.value;
      state.visibleCount = defaultVisibleCount();
      renderTable();
    });
    $("#clearFilters").addEventListener("click", resetFilters);
    $("#loadMore").addEventListener("click", () => {
      state.visibleCount += state.pageSize;
      renderTable();
    });
    $("#drawerClose").addEventListener("click", closeDrawer);
    $("#drawerBackdrop").addEventListener("click", closeDrawer);
    $("#drawerConditionTabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-drawer-condition]");
      if (!button || button.disabled) return;
      state.drawerCondition = button.dataset.drawerCondition;
      renderDrawer();
    });
    $("#drawerMemoryOptions").addEventListener("click", (event) => {
      const button = event.target.closest("[data-drawer-memory]");
      if (!button) return;
      state.drawerMemory = button.dataset.drawerMemory;
      renderDrawer();
    });
    $("#skuMatrix").addEventListener("click", (event) => {
      const button = event.target.closest("[data-matrix-memory]");
      if (!button) return;
      const model = modelById(state.drawerModelId);
      if (!model) return;
      state.drawerMemory = button.dataset.matrixMemory;
      if (button.dataset.matrixCondition) state.drawerCondition = button.dataset.matrixCondition;
      renderDrawer();
    });
    $("[data-quote-copy]").addEventListener("click", copyQuoteSummary);
    $("[data-quote-watch]").addEventListener("click", toggleSkuWatch);
    $("[data-quote-export]").addEventListener("click", exportSelectedSku);
    $("[data-brief-copy]").addEventListener("click", copyBriefing);
    $("[data-ops-reset]").addEventListener("click", () => {
      try {
        localStorage.removeItem(opsStorageKey());
      } catch {
        // Local storage is optional in privacy-restricted browsers.
      }
      renderOps();
      showToast("已重置核验状态");
    });
    $("#methodDialog").addEventListener("click", (event) => {
      if (event.target === $("#methodDialog")) closeMethods();
    });
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        scrollToSection("models");
        window.setTimeout(() => $("#modelSearch").focus(), 380);
        return;
      }
      if (event.key === "Escape") {
        if ($("#detailDrawer").classList.contains("is-open")) closeDrawer();
        else if ($("#methodDialog").open) closeMethods();
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target.closest("tr[data-model-id], [data-brand-filter], [data-heat-brand], [data-quality-date]");
      if (!target || target.matches("button, a, input, select")) return;
      event.preventDefault();
      target.click();
    });

    const sections = ["overview", "brands", "models", "ops", "quality"];
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setActiveNavigation(visible.target.id);
    }, { rootMargin: "-20% 0px -55% 0px", threshold: [0.05, 0.3, 0.6] });
    sections.forEach((sectionId) => {
      const section = document.getElementById(sectionId);
      if (section) observer.observe(section);
    });
    let resizeFrame = null;
    window.addEventListener("resize", () => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        renderMarketChart();
        renderCohortChart(fixedCohortData());
        if (state.drawerModelId && $("#detailDrawer").classList.contains("is-open")) renderDrawer();
      });
    });
  }

  function init() {
    populateDatePicker();
    populateBrandFilter();
    renderAll();
    bindEvents();
    requestAnimationFrame(renderMarketChart);
    requestAnimationFrame(() => renderCohortChart(fixedCohortData()));
  }

  init();
})();
