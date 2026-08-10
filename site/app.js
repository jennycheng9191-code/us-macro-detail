/* 美國總經數據分項分析 — 共用渲染邏輯。
 *
 * 每個指標分頁只是一個薄殼（設定 window.PAGE_INDICATOR 後載入本檔），
 * 所有渲染邏輯集中在這裡：之後加新指標只需要新增一個 HTML 分頁＋在
 * data/indicators.json 加一筆，不用改這支檔案。
 */
(function () {
  "use strict";

  const NAV_ORDER = [
    ["gdp", "GDP"], ["cpi", "CPI"], ["pce", "PCE"], ["nfp", "NFP"],
    ["ism_mfg", "ISM製造業"], ["ism_svc", "ISM服務業"], ["retail_sales", "零售銷售"],
  ];

  // 貢獻度加總型指標：這些分項的貢獻度加總＝headline，適合疊圖比較。
  // 目前只做 GDP 原型；其餘指標（單位不一致或尚未驗證）先不套用。
  const STACK_CONFIG = {
    gdp: {
      headlineId: "gdp_headline",
      unit: "pp",
      trendPeriods: 20, // 近5年（20季）
      axisStyle: "quarter", // 季頻資料：X軸標Q1-Q4，年份只在Q1標一次
      parts: [
        { id: "gdp_pce_contrib", label: "消費(PCE)", color: "var(--s1)" },
        { id: "gdp_investment_contrib", label: "投資", color: "var(--s2)" },
        { id: "gdp_netexports_contrib", label: "淨出口", color: "var(--s3)" },
        { id: "gdp_government_contrib", label: "政府支出", color: "var(--s4)" },
      ],
    },
    nfp: {
      headlineId: "nfp_headline",
      unit: "k",
      // 只追蹤7大產業別，BLS實際有~13個主要產業別，缺漏的（金融/資訊/批發貿易/
      // 運輸倉儲/公用事業/礦業等）用殘差補上，讓堆疊總和永遠精確等於headline
      parts: [
        { id: "nfp_government", label: "政府", color: "var(--s1)" },
        { id: "nfp_education_health", label: "教育醫療", color: "var(--s2)" },
        { id: "nfp_prof_business", label: "專業商業服務", color: "var(--s3)" },
        { id: "nfp_retail", label: "零售業", color: "var(--s4)" },
        { id: "nfp_manufacturing", label: "製造業", color: "var(--s5)" },
        { id: "nfp_construction", label: "營建業", color: "var(--s6)" },
        { id: "nfp_leisure_hospitality", label: "休閒餐旅", color: "var(--s7)" },
      ],
      residual: {
        label: "其他產業＊",
        color: "var(--other)",
        footnote: "＊其他產業＝headline－7大追蹤產業加總，未涵蓋金融／資訊／批發貿易／運輸倉儲／公用事業等分類",
      },
    },
  };

  // 同單位可疊圖型指標：分項不是貢獻度、不會加總＝headline，是同單位（%YoY）的
  // 獨立數列，適合多線疊圖比較走勢。只挑「量級相近、市場最關注」的少數幾條線疊圖
  // （例如CPI的能源分項波動-6.8%~+23%，混進去會把座標軸壓垮，所以不疊，只留在
  // 下方當期直條圖比較）；當期直條圖則涵蓋全部分項，方便一次看完所有拆項。
  const OVERLAY_CONFIG = {
    cpi: {
      unit: "pct",
      lineIds: ["cpi_headline", "cpi_core", "cpi_supercore"],
      lineLabels: { cpi_headline: "總CPI", cpi_core: "核心CPI", cpi_supercore: "Super Core" },
    },
    pce: {
      unit: "pct",
      lineIds: ["pce_headline", "pce_core", "pce_core_services_ex_housing"],
      lineLabels: { pce_headline: "總PCE", pce_core: "核心PCE", pce_core_services_ex_housing: "Super Core" },
    },
    // ISM兩份報告的分項全部同單位（0-100擴散指數），但物價/待辦訂單等非計入複合指數
    // 的分項波動遠大於headline，疊圖會壓縮headline，所以只挑跟headline振幅相近、
    // 又是官方複合指數組成項的新訂單／就業；物價等其餘分項留在下方直條圖
    ism_mfg: {
      unit: "idx",
      lineIds: ["ism_manufacturing_pmi", "ism_mfg_new_orders", "ism_manufacturing_employment"],
      lineLabels: { ism_manufacturing_pmi: "綜合PMI", ism_mfg_new_orders: "新訂單", ism_manufacturing_employment: "就業" },
    },
    ism_svc: {
      unit: "idx",
      lineIds: ["ism_services_pmi", "ism_svc_new_orders", "ism_services_employment"],
      lineLabels: { ism_services_pmi: "綜合PMI", ism_svc_new_orders: "新訂單", ism_services_employment: "就業" },
    },
    // 只有4個分項，振幅跟headline相近，挑電商（市場最常引用的結構性趨勢）當第三條線
    retail_sales: {
      unit: "pct",
      lineIds: ["retail_headline", "retail_core", "retail_ecommerce"],
      lineLabels: { retail_headline: "總零售", retail_core: "核心零售", retail_ecommerce: "電商" },
    },
  };

  const Q_LABEL = { "01": "Q1", "04": "Q2", "07": "Q3", "10": "Q4" };
  function quarterLabel(dateStr) {
    if (!dateStr || dateStr.length < 7) return dateStr;
    const mm = dateStr.slice(5, 7);
    const q = Q_LABEL[mm];
    return q ? `${dateStr.slice(0, 4)} ${q}` : dateStr;
  }

  function fmtStackValue(v, unit) {
    const s = v >= 0 ? "+" : "";
    if (unit === "k") return `${s}${Math.round(v)}k`;
    if (unit === "pct") return `${v.toFixed(1)}%`;
    if (unit === "idx") return v.toFixed(1);
    return `${s}${v.toFixed(2)}pp`;
  }

  // 季頻標Q1-Q4（年份只在Q1標一次）；月頻只在每年1月標年份。共用給堆疊圖跟疊圖。
  function buildAxisLabels(dates, xOf, H, axisStyle) {
    let svg = "";
    if (axisStyle === "quarter") {
      for (let i = 0; i < dates.length; i++) {
        const mm = dates[i].slice(5, 7);
        svg += `<text class="axis-label" x="${xOf(i).toFixed(1)}" y="${H - 20}" text-anchor="middle">${Q_LABEL[mm] || ""}</text>`;
        if (mm === "01") {
          svg += `<text class="axis-label axis-year" x="${xOf(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${dates[i].slice(0, 4)}</text>`;
        }
      }
    } else {
      for (let i = 0; i < dates.length; i++) {
        if (dates[i].slice(5, 7) === "01") {
          svg += `<text class="axis-label" x="${xOf(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${dates[i].slice(0, 4)}</text>`;
        }
      }
    }
    return svg;
  }

  // 橫向長條列的共用渲染：GDP/NFP的堆疊型分項、CPI/PCE/ISM的疊圖型分項都用這個畫「當期比較」。
  // ISM是0-100擴散指數，50才是擴張/緊縮分界，不是0，所以基準線依單位決定。
  function renderBarCompareRows(rows, unit) {
    const baseline = unit === "idx" ? 50 : 0;
    const maxAbs = Math.max(...rows.map((r) => Math.abs(r.value - baseline)), 0.1);
    return rows.map((r) => {
      const d = r.value - baseline;
      const pct = (Math.abs(d) / maxAbs) * 50; // 左右各佔軌道一半
      const left = d >= 0 ? 50 : 50 - pct;
      return `<div class="bar-compare-row">
        <div class="label"><span class="sw" style="background:${r.color}"></span>${r.label}</div>
        <div class="track">
          <div class="zero" style="left:50%"></div>
          <div class="bar" style="left:${left}%;width:${pct}%;background:${r.color}"></div>
        </div>
        <div class="value">${fmtStackValue(r.value, unit)}</div>
      </div>`;
    }).join("");
  }

  function fmtBuildTime(t) {
    return t ? `上次自動更新：${t}` : "";
  }

  function sparkline(history, w, h) {
    if (!history || history.length < 2) return "";
    const vals = history.map((p) => p.value);
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    const pad = 2;
    const pts = vals.map((v, i) => {
      const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const rising = vals[vals.length - 1] >= vals[0];
    const color = rising ? "var(--up)" : "var(--down)";
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
  }

  function statusDot(status) {
    return `<span class="dot ${status}"></span>`;
  }

  function ensureTooltip() {
    let el = document.getElementById("chart-tooltip");
    if (!el) {
      el = document.createElement("div");
      el.id = "chart-tooltip";
      el.className = "chart-tooltip";
      document.body.appendChild(el);
    }
    return el;
  }

  // 堆疊長條（各分項貢獻度）＋headline總指數折線疊圖。
  // 只適用於「分項貢獻度加總＝headline」的指標（見 STACK_CONFIG）。
  function buildTrendChart(g, items, cfg) {
    const itemMap = {};
    for (const it of items) itemMap[it.id] = it;
    const n0 = itemMap[cfg.headlineId];
    const parts0 = cfg.parts.map((p) => ({ ...p, item: itemMap[p.id] })).filter((p) => p.item);
    if (!n0 || parts0.length === 0) return "";

    // 只取最近 trendPeriods 期，避免極端離群期（如2020疫後反彈季）把座標軸壓垮
    const clip = cfg.trendPeriods ? -cfg.trendPeriods : undefined;
    const headline = { ...n0, history: n0.history.slice(clip) };
    const parts = parts0.map((p) => ({ ...p, item: { ...p.item, history: p.item.history.slice(clip) } }));

    // 追蹤分項沒有涵蓋全部組成（如NFP只選7大產業別）時，用殘差補上，
    // 讓堆疊總和永遠精確等於headline，不會出現長條頂端對不上折線的情況
    if (cfg.residual) {
      const residualHistory = headline.history.map((h, i) => {
        const sum = parts.reduce((acc, p) => acc + ((p.item.history[i] && p.item.history[i].value) || 0), 0);
        return { date: h.date, value: h.value - sum };
      });
      parts.push({ id: "__residual", label: cfg.residual.label, color: cfg.residual.color, item: { history: residualHistory } });
    }

    const dates = headline.history.map((h) => h.date);
    const n = dates.length;
    if (n < 2) return "";

    // 逐期計算：正貢獻疊上去、負貢獻疊下去，固定分項順序，headline另外畫折線。
    const perCol = dates.map((date, i) => {
      let pos = 0, neg = 0;
      const segs = [];
      for (const p of parts) {
        const v = (p.item.history[i] && p.item.history[i].value) || 0;
        if (v >= 0) { segs.push({ ...p, from: pos, to: pos + v, v }); pos += v; }
        else { segs.push({ ...p, from: neg + v, to: neg, v }); neg += v; }
      }
      const hv = (headline.history[i] && headline.history[i].value);
      return { date, segs, pos, neg, headline: hv };
    });

    let domainMin = 0, domainMax = 0;
    for (const c of perCol) {
      domainMin = Math.min(domainMin, c.neg, c.headline);
      domainMax = Math.max(domainMax, c.pos, c.headline);
    }
    const pad = (domainMax - domainMin) * 0.15 || 1;
    domainMin -= pad; domainMax += pad;

    const W = 1000, H = 260;
    const ML = 34, MR = 10, MT = 14, MB = cfg.axisStyle === "quarter" ? 34 : 22;
    const plotW = W - ML - MR, plotH = H - MT - MB;
    const slot = plotW / n;
    const barW = Math.max(2, Math.min(22, slot - 4));

    const yOf = (v) => MT + plotH - ((v - domainMin) / (domainMax - domainMin)) * plotH;
    const xOf = (i) => ML + i * slot + slot / 2;
    const y0 = yOf(0);

    // 零基準線 + 一條上緣格線
    let gridSvg = `<line class="baseline" x1="${ML}" y1="${y0.toFixed(1)}" x2="${W - MR}" y2="${y0.toFixed(1)}"/>`;
    gridSvg += `<line class="gridline" x1="${ML}" y1="${MT}" x2="${W - MR}" y2="${MT}"/>`;

    let barsSvg = "";
    for (let i = 0; i < n; i++) {
      const c = perCol[i];
      const cx = xOf(i);
      for (const s of c.segs) {
        if (s.v === 0) continue;
        const yTop = yOf(Math.max(s.from, s.to));
        const yBot = yOf(Math.min(s.from, s.to));
        const h = Math.max(1, yBot - yTop - 1);
        barsSvg += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2.5" style="fill:${s.color}"/>`;
      }
    }

    const linePts = perCol.map((c, i) => `${xOf(i).toFixed(1)},${yOf(c.headline).toFixed(1)}`).join(" ");
    const lastPt = perCol[n - 1];
    const lineSvg = `<polyline points="${linePts}" fill="none" style="stroke:var(--text)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${xOf(n - 1).toFixed(1)}" cy="${yOf(lastPt.headline).toFixed(1)}" r="4" style="fill:var(--text)" stroke="var(--card)" stroke-width="2"/>`;

    const axisSvg = buildAxisLabels(dates, xOf, H, cfg.axisStyle);

    let hitSvg = "";
    for (let i = 0; i < n; i++) {
      hitSvg += `<rect class="hit-col" data-idx="${i}" x="${(ML + i * slot).toFixed(1)}" y="${MT}" width="${slot.toFixed(1)}" height="${plotH}"/>`;
    }

    const legendHtml = `<div class="trend-legend">` +
      parts.map((p) => `<span class="item"><span class="swatch" style="background:${p.color}"></span>${p.label}</span>`).join("") +
      `<span class="item"><span class="line-swatch"></span>${headline.name}（總計）</span>` +
      `</div>`;

    const svgId = `trend-${g.__id}`;
    const tooltipData = perCol.map((c) => ({
      date: c.date,
      rows: c.segs.map((s) => ({ label: s.label, vFmt: fmtStackValue(s.v, cfg.unit), color: s.color })),
      totalFmt: fmtStackValue(c.headline, cfg.unit),
    }));

    // 資料掛在 window 上供事件委派讀取（每頁只會有一張趨勢圖，不用擔心命名衝突）
    window.__trendTooltipData = window.__trendTooltipData || {};
    window.__trendTooltipData[svgId] = tooltipData;

    return `<div class="trend-chart-wrap">
      <div class="trend-chart-head">
        <div class="title">走勢比較：分項堆疊＋${headline.name}</div>
        <div class="hint">滑鼠移到長條上看各期細節</div>
      </div>
      ${legendHtml}
      <svg id="${svgId}" class="trend-chart-svg" viewBox="0 0 ${W} ${H}" data-tooltip-key="${svgId}">
        ${gridSvg}${barsSvg}${lineSvg}${axisSvg}${hitSvg}
      </svg>
      ${cfg.residual && cfg.residual.footnote ? `<div class="chart-footnote">${cfg.residual.footnote}</div>` : ""}
    </div>`;
  }

  function wireTrendTooltip(svgEl) {
    if (!svgEl) return;
    const key = svgEl.getAttribute("data-tooltip-key");
    const data = (window.__trendTooltipData || {})[key];
    if (!data) return;
    const tip = ensureTooltip();
    svgEl.addEventListener("mousemove", (e) => {
      const target = e.target.closest(".hit-col");
      if (!target) { tip.style.display = "none"; return; }
      const idx = Number(target.getAttribute("data-idx"));
      const d = data[idx];
      if (!d) return;
      const rows = d.rows.map((r) =>
        `<div class="t-row"><span class="k"><span class="sw" style="background:${r.color}"></span>${r.label}</span><span class="v">${r.vFmt}</span></div>`
      ).join("");
      const totalRow = d.totalFmt ? `<div class="t-row total"><span class="k">總計</span><span class="v">${d.totalFmt}</span></div>` : "";
      tip.innerHTML = `<div class="t-title">${d.date}</div>${rows}${totalRow}`;
      tip.style.display = "block";
      tip.style.left = `${e.clientX + 14}px`;
      tip.style.top = `${e.clientY + 14}px`;
    });
    svgEl.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }

  // 當期比較直條圖：同一組貢獻度分項在最新一期的橫向長條比較，順序照卡片既有順序。
  function buildCurrentBarChart(g, items, cfg) {
    const itemMap = {};
    for (const it of items) itemMap[it.id] = it;
    const headline = itemMap[cfg.headlineId];
    const parts = cfg.parts.map((p) => ({ ...p, item: itemMap[p.id] })).filter((p) => p.item);
    if (parts.length === 0) return "";

    if (cfg.residual && headline) {
      const sum = parts.reduce((acc, p) => acc + p.item.value, 0);
      parts.push({ id: "__residual", label: cfg.residual.label, color: cfg.residual.color, item: { value: headline.value - sum } });
    }

    const rows = renderBarCompareRows(parts.map((p) => ({ label: p.label, color: p.color, value: p.item.value })), cfg.unit);

    return `<div class="bar-compare">
      <div class="title">當期比較（${parts[0].item.asof || ""}）</div>
      ${rows}
    </div>`;
  }

  // 多線疊圖：同單位的少數幾條線（headline/core/supercore等）直接疊在同一張時間序列上比較。
  function buildOverlayChart(g, items, cfg) {
    const itemMap = {};
    for (const it of items) itemMap[it.id] = it;
    const lines0 = cfg.lineIds
      .map((id, idx) => ({ id, label: cfg.lineLabels[id], color: `var(--s${idx + 1})`, item: itemMap[id] }))
      .filter((l) => l.item);
    if (lines0.length === 0) return "";

    const clip = cfg.trendPeriods ? -cfg.trendPeriods : undefined;
    const lines = lines0.map((l) => ({ ...l, item: { ...l.item, history: l.item.history.slice(clip) } }));

    const dates = lines[0].item.history.map((h) => h.date);
    const n = dates.length;
    if (n < 2) return "";

    let domainMin = Infinity, domainMax = -Infinity;
    for (const l of lines) {
      for (const h of l.item.history) {
        domainMin = Math.min(domainMin, h.value);
        domainMax = Math.max(domainMax, h.value);
      }
    }
    const pad = (domainMax - domainMin) * 0.15 || 1;
    domainMin -= pad; domainMax += pad;

    const W = 1000, H = 260;
    const ML = 34, MR = 60, MT = 14, MB = cfg.axisStyle === "quarter" ? 34 : 22;
    const plotW = W - ML - MR, plotH = H - MT - MB;

    const yOf = (v) => MT + plotH - ((v - domainMin) / (domainMax - domainMin)) * plotH;
    const xOf = (i) => ML + (n === 1 ? 0 : (i / (n - 1)) * plotW);

    let gridSvg = `<line class="gridline" x1="${ML}" y1="${MT}" x2="${W - MR}" y2="${MT}"/>`;
    gridSvg += `<line class="gridline" x1="${ML}" y1="${(MT + plotH).toFixed(1)}" x2="${W - MR}" y2="${(MT + plotH).toFixed(1)}"/>`;

    let linesSvg = "";
    // 收集終點標籤位置，太靠近時垂直錯開，避免疊字看不清楚
    const endLabels = lines.map((l) => {
      const lastVal = l.item.history[n - 1].value;
      return { color: l.color, y: yOf(lastVal), text: fmtStackValue(lastVal, cfg.unit) };
    }).sort((a, b) => a.y - b.y);
    for (let i = 1; i < endLabels.length; i++) {
      if (endLabels[i].y - endLabels[i - 1].y < 14) endLabels[i].y = endLabels[i - 1].y + 14;
    }

    for (const l of lines) {
      const pts = l.item.history.map((h, i) => `${xOf(i).toFixed(1)},${yOf(h.value).toFixed(1)}`).join(" ");
      linesSvg += `<polyline points="${pts}" fill="none" style="stroke:${l.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      const lastVal = l.item.history[n - 1].value;
      linesSvg += `<circle cx="${xOf(n - 1).toFixed(1)}" cy="${yOf(lastVal).toFixed(1)}" r="4" style="fill:${l.color}" stroke="var(--card)" stroke-width="2"/>`;
    }
    lines.forEach((l, idx) => {
      const lastVal = l.item.history[n - 1].value;
      const label = endLabels.find((e) => e.color === l.color) || { y: yOf(lastVal) };
      linesSvg += `<text class="end-label" x="${(xOf(n - 1) + 10).toFixed(1)}" y="${(label.y + 4).toFixed(1)}">${fmtStackValue(lastVal, cfg.unit)}</text>`;
    });

    const axisSvg = buildAxisLabels(dates, xOf, H, cfg.axisStyle);

    let hitSvg = "";
    const hitW = n > 1 ? plotW / (n - 1) : plotW;
    for (let i = 0; i < n; i++) {
      hitSvg += `<rect class="hit-col" data-idx="${i}" x="${(xOf(i) - hitW / 2).toFixed(1)}" y="${MT}" width="${hitW.toFixed(1)}" height="${plotH}"/>`;
    }

    const legendHtml = `<div class="trend-legend">` +
      lines.map((l) => `<span class="item"><span class="swatch" style="background:${l.color}"></span>${l.label}</span>`).join("") +
      `</div>`;

    const svgId = `trend-${g.__id}`;
    const tooltipData = dates.map((date, i) => ({
      date,
      rows: lines.map((l) => ({ label: l.label, vFmt: fmtStackValue(l.item.history[i].value, cfg.unit), color: l.color })),
    }));
    window.__trendTooltipData = window.__trendTooltipData || {};
    window.__trendTooltipData[svgId] = tooltipData;

    return `<div class="trend-chart-wrap">
      <div class="trend-chart-head">
        <div class="title">走勢比較</div>
        <div class="hint">滑鼠移到線上看各期細節</div>
      </div>
      ${legendHtml}
      <svg id="${svgId}" class="trend-chart-svg" viewBox="0 0 ${W} ${H}" data-tooltip-key="${svgId}">
        ${gridSvg}${linesSvg}${axisSvg}${hitSvg}
      </svg>
    </div>`;
  }

  // 疊圖型指標的當期比較：涵蓋全部分項，疊圖裡有畫的線用對應色，其餘用中性灰色。
  function buildOverlayBarChart(g, items, cfg) {
    if (items.length === 0) return "";
    const lineColor = {};
    cfg.lineIds.forEach((id, idx) => { lineColor[id] = `var(--s${idx + 1})`; });
    const rows = renderBarCompareRows(
      items.map((it) => {
        const base = cfg.lineLabels[it.id] || it.name;
        const label = it.weight != null ? `${base}(${Math.round(it.weight)}%)` : base;
        return { label, color: lineColor[it.id] || "var(--other)", value: it.value };
      }),
      cfg.unit
    );
    return `<div class="bar-compare">
      <div class="title">當期比較（${items[0].asof || ""}）</div>
      ${rows}
    </div>`;
  }

  function buildNav(activeId) {
    return `<nav class="tabs">` +
      NAV_ORDER.map(([id, label]) =>
        `<a href="${id}.html" class="${id === activeId ? "active" : ""}">${label}</a>`
      ).join("") +
      `<a href="index.html" class="${activeId === "" ? "active" : ""}">首頁</a>` +
      `</nav>`;
  }

  function buildHeader(meta) {
    return `<header class="top">
      <div class="brand"><a href="index.html">美國總經數據分項分析</a></div>
      <div class="meta">${fmtBuildTime(meta.build_time)}</div>
    </header>`;
  }

  function itemCard(item, opts) {
    opts = opts || {};
    const badge = item.in_composite === true
      ? `<span class="badge in">計入複合指數</span>`
      : item.in_composite === false
      ? `<span class="badge out">僅供參考</span>`
      : "";
    return `<div class="card">
      <div class="row1">
        <div class="name">${statusDot(item.status)}${item.name}</div>
        ${badge}
      </div>
      <div class="value">${item.value_fmt}</div>
      ${sparkline(item.history, 200, 36)}
      <div class="note">${item.note || ""}</div>
      <div class="asof">${item.asof || "—"}</div>
    </div>`;
  }

  function renderIndexPage(data) {
    const root = document.getElementById("app");
    const cards = NAV_ORDER.map(([id, label]) => {
      const g = data.indicators[id];
      if (!g) return "";
      const headline = Object.values(g.items).find((it) => it.role === "headline") ||
                        Object.values(g.items)[0];
      return `<a class="index-card" href="${id}.html">
        <div class="name">${label}　<span style="color:var(--text3);font-size:12px">${g.org} · ${g.freq === "Q" ? "季頻" : "月頻"}</span></div>
        <div class="value">${headline ? headline.value_fmt : "—"}</div>
        <div class="asof">${headline ? headline.asof : ""}</div>
      </a>`;
    }).join("");

    root.innerHTML = `
      ${buildHeader(data)}
      <main>
        <div class="page-head">
          <h1>美國總經數據分項分析</h1>
          <div class="sub">GDP／CPI／PCE／NFP／ISM製造業／ISM服務業／零售銷售，拆到組成項目與貢獻度，每日自動更新。
            另見總覽式手冊 <a href="https://jennycheng9191-code.github.io/us-macro-guide/" target="_blank" rel="noopener">us-macro-guide</a>。</div>
        </div>
        <div class="index-grid">${cards}</div>
      </main>
      <footer class="site">資料來源：BEA／BLS／Census／ISM官方新聞稿。所有序列每日透過GitHub Actions自動抓取，抓取失敗時保留上一版數值並標示燈號，不顯示錯誤數字。</footer>
    `;
  }

  function renderIndicatorPage(data, indicatorId) {
    const root = document.getElementById("app");
    const g = data.indicators[indicatorId];
    if (!g) {
      root.innerHTML = `${buildHeader(data)}${buildNav(indicatorId)}<main><div class="loading">找不到這個指標的資料</div></main>`;
      return;
    }

    g.__id = indicatorId;
    const items = Object.entries(g.items).map(([id, it]) => ({ id, ...it }));
    const headlineItems = items.filter((it) => it.role === "headline");
    const componentItems = items.filter((it) => it.role !== "headline");

    const stackCfg = STACK_CONFIG[indicatorId];
    const overlayCfg = OVERLAY_CONFIG[indicatorId];
    let trendChartHtml = "", barCompareHtml = "";
    if (stackCfg) {
      trendChartHtml = buildTrendChart(g, items, stackCfg);
      barCompareHtml = buildCurrentBarChart(g, items, stackCfg);
    } else if (overlayCfg) {
      trendChartHtml = buildOverlayChart(g, items, overlayCfg);
      barCompareHtml = buildOverlayBarChart(g, items, overlayCfg);
    }

    // 卡片上的 sparkline／日期顯示跟走勢比較圖同步：季頻指標只看近N期、日期改標Q1-Q4
    if (stackCfg && stackCfg.axisStyle === "quarter" && stackCfg.trendPeriods) {
      for (const it of items) {
        if (it.history) it.history = it.history.slice(-stackCfg.trendPeriods);
        if (it.asof) it.asof = quarterLabel(it.asof);
      }
    }

    const headlineHtml = headlineItems.map((it) => `
      <div class="headline-tile">
        <div class="name">${statusDot(it.status)}${it.name}</div>
        <div class="value">${it.value_fmt}</div>
        <div class="note">${it.note || ""}</div>
        <div class="asof">${it.asof || "—"}</div>
      </div>`).join("");

    // 依 group 欄位分組（例如 NFP 的 industry / wages，GDP 的 consumption）
    const groups = {};
    const groupOrder = [];
    for (const it of componentItems) {
      const key = it.group || "";
      if (!(key in groups)) { groups[key] = []; groupOrder.push(key); }
      groups[key].push(it);
    }

    const groupLabels = {
      "": "拆項", "consumption": "消費細項", "industry": "產業別新增就業",
      "wages": "薪資與工時",
    };

    let bodyHtml = "";
    for (const key of groupOrder) {
      const label = groupLabels[key] || key;
      bodyHtml += `<div class="group-title">${label}</div>
        <div class="card-grid">${groups[key].map((it) => itemCard(it)).join("")}</div>`;
    }

    const hasComposite = componentItems.some((it) => it.in_composite !== undefined && it.in_composite !== null);
    const legend = hasComposite
      ? `<div class="legend">綠色「計入複合指數」代表該分項有算進官方PMI複合指數；灰色「僅供參考」的分項ISM有調查但不計入複合指數計算。</div>`
      : "";

    root.innerHTML = `
      ${buildHeader(data)}
      ${buildNav(indicatorId)}
      <main>
        <div class="page-head">
          <h1>${g.name_full}</h1>
          <div class="sub">來源：${g.org}　·　${g.freq === "Q" ? "季頻" : "月頻"}　·　<a href="${g.url}" target="_blank" rel="noopener">官方頁面</a></div>
        </div>
        <div class="headline-row">${headlineHtml}</div>
        ${trendChartHtml}
        ${barCompareHtml}
        ${legend}
        ${bodyHtml}
      </main>
      <footer class="site">資料來源：${g.org}官方API／新聞稿。抓取失敗時保留上一版數值並標示燈號，不顯示錯誤數字。</footer>
    `;

    if (trendChartHtml) wireTrendTooltip(document.getElementById(`trend-${indicatorId}`));
  }

  function boot() {
    const root = document.getElementById("app");
    root.innerHTML = `<div class="loading">載入中…</div>`;
    fetch("data/latest.json", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        const pageId = window.PAGE_INDICATOR || "";
        if (pageId === "") renderIndexPage(data);
        else renderIndicatorPage(data, pageId);
      })
      .catch((e) => {
        root.innerHTML = `<div class="loading">資料載入失敗：${e}</div>`;
      });
  }

  // app.js 一律由 gate.js 解鎖後動態插入 <script> 載入，這時 DOMContentLoaded
  // 早就觸發過了，所以直接呼叫 boot()，不能再靠監聽 DOMContentLoaded。
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
