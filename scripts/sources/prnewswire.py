"""ISM 官方新聞稿抓取（經由 PR Newswire）。

沿用 us-macro-guide 已驗證的做法：ISM 官網（ismworld.org）整站在
reCAPTCHA 牆後面，但每月的 Report On Business 新聞稿全文會同步發到
PR Newswire，免費、無驗證碼、句式每月固定，分項數字齊全。

跟 us-macro-guide 的差異：這裡的 CARDS 涵蓋兩份報告的「全部」分項
（製造業 10 項、服務業 10 項），不是只挑幾張常看的卡——這個網頁的
用途就是拆項分析，所以連沒有計入 PMI 複合指數的分項（物價、待辦訂單、
新出口訂單、進口、存貨感受…）也要抓，並在 mapping.json 用 in_composite
欄位標示哪些有算進官方複合指數。
"""
from __future__ import annotations

import os
import re
import time

from common import get_text

ORG = "https://www.prnewswire.com/news/institute-for-supply-management/"
ORG_PAGES = 3
SOURCE_LABEL = "ISM 官方新聞稿（PR Newswire）"

SUBINDEX_DEPTH = int(os.environ.get("PRN_SUBINDEX_DEPTH", "24"))

MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june",
     "july", "august", "september", "october", "november", "december"], 1)}

SLUG = re.compile(
    r"/news-releases/(manufacturing|services)-pmi-at-"
    r"(\d{1,3}(?:-\d)?)-([a-z]+)-(\d{4})-[a-z0-9-]*\.html")

# 卡片 → (報告別, 內文分項標籤)。標籤為 None 代表總指數，直接取自網址。
CARDS: dict[str, tuple[str, str | None]] = {
    # ---- 製造業：5 項計入 PMI 複合指數 ----
    "ism_manufacturing_pmi":         ("manufacturing", None),
    "ism_mfg_new_orders":            ("manufacturing", "New Orders Index"),
    "ism_mfg_production":            ("manufacturing", "Production Index"),
    "ism_manufacturing_employment":  ("manufacturing", "Employment Index"),
    "ism_mfg_supplier_deliveries":   ("manufacturing", "Supplier Deliveries Index"),
    "ism_mfg_inventories":           ("manufacturing", "Inventories Index"),
    # ---- 製造業：不計入複合指數，僅供參考 ----
    "ism_mfg_customers_inventories": ("manufacturing", "Customers' Inventories Index"),
    "ism_mfg_prices_paid":           ("manufacturing", "Prices Index"),
    "ism_mfg_backlog":               ("manufacturing", "Backlog of Orders Index"),
    "ism_mfg_new_export_orders":     ("manufacturing", "New Export Orders Index"),
    "ism_mfg_imports":               ("manufacturing", "Imports Index"),

    # ---- 服務業：4 項計入 PMI 複合指數 ----
    "ism_services_pmi":              ("services", None),
    "ism_svc_business_activity":     ("services", "Business Activity Index"),
    "ism_svc_new_orders":            ("services", "New Orders Index"),
    "ism_services_employment":       ("services", "Employment Index"),
    "ism_svc_supplier_deliveries":   ("services", "Supplier Deliveries Index"),
    # ---- 服務業：不計入複合指數，僅供參考 ----
    "ism_svc_inventories":           ("services", "Inventories Index"),
    "ism_services_prices_paid":      ("services", "Prices Index"),
    "ism_svc_backlog":               ("services", "Backlog of Orders Index"),
    "ism_svc_new_export_orders":     ("services", "New Export Orders Index"),
    "ism_svc_imports":               ("services", "Imports Index"),
    "ism_svc_inventory_sentiment":   ("services", "Inventory Sentiment Index"),
}

NUM = re.compile(r"(\d{1,3}(?:\.\d)?)\s*(?:%|percent\b(?!age))", re.I)
QUALIFIER = re.compile(
    r"(?:above|below|over|under|than|near|nearly|around|approximately)\s+\Z", re.I)


def _plain(html: str) -> str:
    html = re.sub(r"(?is)<(script|style|svg|noscript)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?s)<[^>]+>", " ", html)
    html = (html.replace("&nbsp;", " ").replace("&amp;", "&").replace("&reg;", "")
                .replace("&#x27;", "'").replace("&rsquo;", "'").replace("&mdash;", "—"))
    return re.sub(r"\s+", " ", html)


_index_cache: dict[str, list[dict]] | None = None


def _index() -> dict[str, list[dict]]:
    """回傳 {報告別: [{asof, value, url}]}，由新到舊。"""
    global _index_cache
    if _index_cache is not None:
        return _index_cache

    seen: dict[tuple[str, str], dict] = {}
    for page in range(1, ORG_PAGES + 1):
        try:
            html = get_text(f"{ORG}?page={page}&pagesize=100")
        except Exception:                                   # noqa: BLE001
            continue
        for mo in SLUG.finditer(html):
            kind, raw, month, year = mo.groups()
            mi = MONTHS.get(month)
            if not mi:
                continue
            asof = f"{year}-{mi:02d}-01"
            key = (kind, asof)
            if key not in seen:
                seen[key] = {"asof": asof, "value": float(raw.replace("-", ".")),
                             "url": "https://www.prnewswire.com" + mo.group(0)}

    out: dict[str, list[dict]] = {"manufacturing": [], "services": []}
    for (kind, _), rel in seen.items():
        out[kind].append(rel)
    for kind in out:
        out[kind].sort(key=lambda r: r["asof"], reverse=True)
    _index_cache = out
    return out


_body_cache: dict[str, str] = {}


def _body(url: str) -> str:
    if url not in _body_cache:
        try:
            _body_cache[url] = _plain(get_text(url))
            time.sleep(0.3)
        except Exception:                                   # noqa: BLE001
            _body_cache[url] = ""
    return _body_cache[url]


def _subindex(text: str, label: str) -> float | None:
    """取標籤之後第一個「N percent」，跳過 QUALIFIER 那種門檻描述。"""
    window = 220
    for mo in re.finditer(re.escape(label), text, re.I):
        seg = text[mo.end():mo.end() + window]
        for hit in NUM.finditer(seg):
            if QUALIFIER.search(seg[:hit.start()]):
                continue
            return float(hit.group(1))
    return None


def _asof_label(asof: str) -> str:
    names = [m.capitalize() for m in MONTHS]
    return f"{asof[:4]} {names[int(asof[5:7]) - 1]}"


def fetch(card_id: str, m: dict) -> dict:
    spec = CARDS.get(card_id)
    if not spec:
        return {"ok": False, "reason": f"prnewswire 未定義卡片 {card_id}"}
    kind, label = spec

    releases = _index().get(kind, [])
    if not releases:
        return {"ok": False, "reason": "PR Newswire 的 ISM 發布索引未取得任何報告"}

    latest = releases[0]

    if label is None:
        history = [{"date": r["asof"], "value": r["value"]}
                   for r in reversed(releases[:24])]
        value = latest["value"]
    else:
        history = []
        for r in releases[:SUBINDEX_DEPTH]:
            if (v := _subindex(_body(r["url"]), label)) is not None:
                history.append({"date": r["asof"], "value": v})
        history.sort(key=lambda h: h["date"])
        if not history or history[-1]["date"] != latest["asof"]:
            return {"ok": False,
                    "reason": f"最新一期新聞稿未解析出「{label}」讀值"}
        value = history[-1]["value"]

    return {
        "ok": True,
        "value": value,
        "asof": latest["asof"],
        "asof_label": _asof_label(latest["asof"]),
        "history": history,
        "raw_latest": value,
        "freq": "M",
        "extras": {},
        "also": {},
        "source_label": SOURCE_LABEL,
        "source_kind": "prnewswire",
        "evidence": [latest["url"]],
    }
