"""Census MARTS Timeseries API（零售銷售月報）。

MPCSM（月增率，季調）本身已經是 % 變化，不需要再套 common.transform()——
跟 FRED/BLS/BEA 那些「拿到指數再自己算年增/月增」的來源不同。

另有 fetch_derived()：Census 沒有發布「控制組」這個組合序列（現有的
44Y72/44W72/44Z72 分別是排除汽車、排除汽車＋汽油、排除汽油，都不是控制組），
所以改用官方季調金額（SM）逐項相減後自算月增率。
"""
from __future__ import annotations

import os

from common import get_json

BASE = "https://api.census.gov/data/timeseries/eits/marts"
_cache: dict[str, list[dict]] = {}


def _key() -> str:
    k = os.environ.get("CENSUS_API_KEY", "").strip()
    if not k:
        raise RuntimeError("缺少 CENSUS_API_KEY")
    return k


def observations(category_code: str, data_type_code: str, seasonally_adj: str = "yes",
                  years_back: int = 6) -> list[dict]:
    """回傳由舊到新的 [{date, value}]。"""
    ck = f"{category_code}:{data_type_code}:{seasonally_adj}"
    if ck in _cache:
        return _cache[ck]
    from datetime import date
    start_year = date.today().year - years_back
    rows = get_json(BASE, {
        "get": "cell_value,data_type_code,seasonally_adj",
        "for": "us:*",
        "time": f"from {start_year}-01",
        "category_code": category_code,
        "key": _key(),
    })
    obs = []
    if isinstance(rows, list) and len(rows) > 1:
        header = rows[0]
        i_val = header.index("cell_value")
        i_type = header.index("data_type_code")
        i_sa = header.index("seasonally_adj")
        i_time = header.index("time")
        for row in rows[1:]:
            if row[i_type] != data_type_code or row[i_sa] != seasonally_adj:
                continue
            try:
                v = float(row[i_val])
            except (TypeError, ValueError):
                continue
            obs.append({"date": f"{row[i_time]}-01", "value": v})
    obs.sort(key=lambda o: o["date"])
    _cache[ck] = obs
    return obs


def fetch_derived(card_id: str, m: dict) -> dict:
    """base 類別金額扣掉 minus 類別金額後自算月增率（目前用於零售銷售控制組）。

    只取三者日期都齊備的月份，避免某一類別當月尚未更新時算出假的跳動。
    """
    sa = m.get("seasonally_adj", "yes")
    dtc = m.get("data_type_code", "SM")
    base = {o["date"]: o["value"] for o in observations(m["base_category"], dtc, sa)}
    minus = [{o["date"]: o["value"] for o in observations(c, dtc, sa)}
             for c in m["minus_categories"]]
    dates = sorted(d for d in base if all(d in mm for mm in minus))
    if len(dates) < 2:
        return {"ok": False, "reason": "Census 控制組：可用月份不足，無法計算月增率"}

    levels = [(d, base[d] - sum(mm[d] for mm in minus)) for d in dates]
    hist = [{"date": d, "value": round((v / prev_v - 1) * 100, 2)}
            for (_, prev_v), (d, v) in zip(levels, levels[1:]) if prev_v]
    if not hist:
        return {"ok": False, "reason": "Census 控制組：金額為零或缺漏，無法計算月增率"}

    latest = hist[-1]
    minus_label = "－".join(m["minus_categories"])
    return {
        "ok": True,
        "value": latest["value"],
        "asof": latest["date"],
        "history": hist[-24:],
        "raw_latest": levels[-1][1],
        "freq": "M",
        "extras": {"level_musd": levels[-1][1]},
        "also": {},
        "source_label": f"Census MARTS {m['base_category']}－{minus_label}（依官方季調金額自算）",
    }


def fetch(card_id: str, m: dict) -> dict:
    obs = observations(m["category_code"], m["data_type_code"], m.get("seasonally_adj", "yes"))
    if not obs:
        return {"ok": False, "reason": f"Census category {m['category_code']} 無可用觀測值"}
    latest = obs[-1]
    return {
        "ok": True,
        "value": latest["value"],
        "asof": latest["date"],
        "history": obs[-24:],
        "raw_latest": latest["value"],
        "freq": "M",
        "extras": {},
        "also": {},
        "source_label": f"Census MARTS {m['category_code']}",
    }
