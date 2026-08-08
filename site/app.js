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

    const items = Object.entries(g.items).map(([id, it]) => ({ id, ...it }));
    const headlineItems = items.filter((it) => it.role === "headline");
    const componentItems = items.filter((it) => it.role !== "headline");

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
        ${legend}
        ${bodyHtml}
      </main>
      <footer class="site">資料來源：${g.org}官方API／新聞稿。抓取失敗時保留上一版數值並標示燈號，不顯示錯誤數字。</footer>
    `;
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

  document.addEventListener("DOMContentLoaded", boot);
})();
