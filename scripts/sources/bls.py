"""BLS 官方公開 API（api.bls.gov）。CPI / NFP 皆走這支。"""
from __future__ import annotations

import os

from common import get_json, transform

BASE = "https://api.bls.gov/publicAPI/v2/timeseries/data"
_obs_cache: dict[str, list[dict]] = {}
_MONTH_PERIODS = {f"M{i:02d}" for i in range(1, 13)}


def observations(series_id: str, years_back: int = 6) -> list[dict]:
    """回傳由舊到新的 [{date, value}]，只取月頻資料。"""
    if series_id in _obs_cache:
        return _obs_cache[series_id]
    from datetime import date
    end_year = date.today().year
    key = os.environ.get("BLS_API_KEY", "").strip()
    params = {"startyear": str(end_year - years_back), "endyear": str(end_year)}
    if key:
        params["registrationkey"] = key
    d = get_json(f"{BASE}/{series_id}", params)
    if d.get("status") != "REQUEST_SUCCEEDED":
        raise RuntimeError(f"BLS API 回報 {d.get('status')}：{'; '.join(d.get('message', []))}")
    series = d.get("Results", {}).get("series", [])
    obs = []
    if series:
        for item in series[0].get("data", []):
            period = item.get("period", "")
            if period not in _MONTH_PERIODS:
                continue
            try:
                val = float(item["value"])
            except (TypeError, ValueError):
                continue
            obs.append({"date": f"{item['year']}-{period[1:]}-01", "value": val})
    obs.sort(key=lambda o: o["date"])
    _obs_cache[series_id] = obs
    return obs


def _series_result(series_id: str, display: str) -> dict:
    obs = observations(series_id)
    if not obs:
        return {"ok": False, "reason": f"BLS 序列 {series_id} 無可用觀測值"}
    ser = transform(obs, display, "M")
    if not ser:
        return {"ok": False, "reason": f"{series_id} 資料長度不足以計算 {display}"}
    return {
        "ok": True,
        "value": ser[-1]["value"],
        "asof": ser[-1]["date"],
        "history": ser[-24:],
        "raw_latest": obs[-1]["value"],
        "freq": "M",
        "source_label": f"BLS API {series_id}",
    }


def fetch(card_id: str, m: dict) -> dict:
    res = _series_result(m["series"], m.get("display", "level"))
    if not res["ok"]:
        return res

    also_src = m.get("also_series", m["series"])
    also: dict[str, float] = {}
    for form in m.get("also", []):
        r = _series_result(also_src, form)
        if r["ok"]:
            also[m.get("also_labels", {}).get(form, form)] = r["value"]
    res["also"] = also
    res["extras"] = {}
    return res
