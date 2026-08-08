"""兩道關卡 —— 資料上架前的把關。

設計原則：壞掉時的行為是「保留上期值並亮黃燈」，不是「顯示錯的數字」。
沿用 us-macro-guide 的既有慣例，但拿掉新聞來源交叉驗證關卡——這裡的
ISM 走 PR Newswire 官方新聞稿全文，屬第一手來源，不是二手轉述，不需要
CNBC/AP 雙來源互相背書。

  關卡 1  合理範圍   值必須落在該拆項的歷史合理區間內（mapping.json 的 sanity）
  關卡 2  變動幅度   與上期的變動不得超過歷史變動標準差的 3 倍

另外檢查資料新鮮度：超過 stale_days 未更新即亮黃燈。
"""
from __future__ import annotations

import statistics

from common import age_from_period_end

GREEN, YELLOW, GRAY = "green", "yellow", "gray"


def _gate_range(value: float, sanity: dict | None) -> str | None:
    if not sanity or value is None:
        return None
    lo, hi = sanity.get("min"), sanity.get("max")
    if lo is not None and value < lo:
        return f"低於合理下限 {lo}"
    if hi is not None and value > hi:
        return f"高於合理上限 {hi}"
    return None


def _gate_jump(value: float, history: list[dict]) -> str | None:
    if len(history) < 6 or value is None:
        return None
    vals = [h["value"] for h in history]
    diffs = [b - a for a, b in zip(vals, vals[1:])]
    if len(diffs) < 5:
        return None
    try:
        sd = statistics.pstdev(diffs[:-1]) if len(diffs) > 5 else statistics.pstdev(diffs)
    except statistics.StatisticsError:
        return None
    if sd <= 0:
        return None
    change = abs(value - vals[-2]) if len(vals) >= 2 else 0
    if change > 3 * sd:
        return f"單期變動 {change:.2f} 超過歷史波動的 3 倍（{3 * sd:.2f}）"
    return None


def check(res: dict, m: dict) -> dict:
    """回傳 {status, notes[]}。"""
    notes: list[str] = []

    if not res.get("ok"):
        return {"status": GRAY, "notes": [res.get("reason", "未取得")]}

    value = res.get("value")
    if value is None:
        return {"status": GRAY, "notes": ["來源回傳空值"]}

    status = GREEN

    if (n := _gate_range(value, m.get("sanity"))):
        return {"status": GRAY, "notes": [f"關卡1 未過：{n}（不採用，保留上期值）"]}

    if (n := _gate_jump(value, res.get("history") or [])):
        status = YELLOW
        notes.append(f"關卡2：{n}")

    asof = res.get("asof") or ""
    if asof:
        age = age_from_period_end(asof, res.get("freq", "M"))
        limit = m.get("stale_days")
        if limit and age > limit:
            status = YELLOW
            notes.append(f"期別結束後已 {age} 天仍未更新（正常應在 {limit} 天內）")
        res["age_days"] = age
    else:
        status = YELLOW
        notes.append("來源未提供明確期別")

    return {"status": status, "notes": notes}
