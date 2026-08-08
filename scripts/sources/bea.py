"""BEA API（apps.bea.gov）。GDP 貢獻度（NIPA）與 PCE 價格指數（NIUnderlyingDetail）皆走這支。

用 Year=ALL 一次抓整個表格的完整歷史，同一 (dataset, table) 組合在同一次
build 只打一次 API，再依 LineNumber 篩出各拆項自己的序列——47 卡專案裡
FRED/BLS 都是「一序列一支 API」，BEA 的表格是「一次回傳整張表所有行」，
拆項越多越划算。
"""
from __future__ import annotations

import os

from common import get_json, transform

BASE = "https://apps.bea.gov/api/data/"
_table_cache: dict[tuple[str, str, str], list[dict]] = {}


def _key() -> str:
    k = os.environ.get("BEA_API_KEY", "").strip()
    if not k:
        raise RuntimeError("缺少 BEA_API_KEY")
    return k


def _period_to_iso(period: str) -> str | None:
    """'2026Q2' -> '2026-04-01'，'2026M06' -> '2026-06-01'。月度表偶爾夾雜
    M13(全年平均) 之類的特殊期別，回傳 None 讓呼叫端過濾掉。"""
    year = period[:4]
    if "Q" in period:
        q = int(period[5:6])
        if q not in (1, 2, 3, 4):
            return None
        return f"{year}-{(q - 1) * 3 + 1:02d}-01"
    if "M" in period:
        mo = int(period[5:7])
        if not (1 <= mo <= 12):
            return None
        return f"{year}-{mo:02d}-01"
    return None


def _table(dataset: str, table: str, freq: str) -> list[dict]:
    """回傳整張表格的所有 row，未依 LineNumber 篩選。"""
    ck = (dataset, table, freq)
    if ck in _table_cache:
        return _table_cache[ck]
    d = get_json(BASE, {
        "UserID": _key(), "method": "GetData", "datasetname": dataset,
        "TableName": table, "Frequency": freq, "Year": "ALL",
        "ResultFormat": "JSON",
    })
    err = d.get("BEAAPI", {}).get("Results", {}).get("Error")
    if err:
        raise RuntimeError(f"BEA API 錯誤：{err.get('APIErrorDescription', err)}")
    rows = d.get("BEAAPI", {}).get("Results", {}).get("Data", [])
    _table_cache[ck] = rows
    return rows


def observations(dataset: str, table: str, line: int, freq: str = "M") -> list[dict]:
    """回傳指定 LineNumber 的 [{date, value}]，由舊到新。"""
    rows = _table(dataset, table, freq)
    by_date: dict[str, float] = {}
    for r in rows:
        if int(r.get("LineNumber", -1)) != line:
            continue
        iso = _period_to_iso(r["TimePeriod"])
        if iso is None:
            continue
        try:
            by_date[iso] = float(r["DataValue"].replace(",", ""))
        except (KeyError, ValueError):
            continue
    return [{"date": k, "value": by_date[k]} for k in sorted(by_date)]


def _series_result(dataset: str, table: str, line: int, freq: str, display: str) -> dict:
    obs = observations(dataset, table, line, freq)
    if not obs:
        return {"ok": False, "reason": f"BEA {dataset}/{table} line {line} 無可用觀測值"}
    ser = transform(obs, display, freq)
    if not ser:
        return {"ok": False, "reason": f"line {line} 資料長度不足以計算 {display}"}
    return {
        "ok": True,
        "value": ser[-1]["value"],
        "asof": ser[-1]["date"],
        "history": ser[-24:],
        "raw_latest": obs[-1]["value"],
        "freq": freq,
        "source_label": f"BEA {dataset} {table} L{line}",
    }


def fetch(card_id: str, m: dict) -> dict:
    res = _series_result(m["dataset"], m["table"], m["line"], m.get("freq", "M"),
                          m.get("display", "level"))
    if not res["ok"]:
        return res

    also: dict[str, float] = {}
    for form in m.get("also", []):
        r = _series_result(m["dataset"], m["table"], m["line"], m.get("freq", "M"), form)
        if r["ok"]:
            also[m.get("also_labels", {}).get(form, form)] = r["value"]
    res["also"] = also
    res["extras"] = {}
    return res


# ---------------------------------------------------------- 衍生：核心服務排除房租(近似)

def _weighted_ex_component_index(m: dict) -> list[dict]:
    """用名目支出權重做 Laspeyres 近似，算出「A 排除 B」的價格年增/月增序列。

    A=服務排除能源(line376)，B=房租(line153)。BEA 沒有直接公布這個組合指數
    （連鎖式價格指數不能像 GDP 貢獻度那樣直接相減），這是業界慣用的近似法：
    用 t-1 期的名目支出當權重，反推「扣掉房租後」的價格變動率。
    """
    ca, cb = m["component_a"], m["component_b"]
    price_a = observations(m.get("dataset", "NIUnderlyingDetail"), ca["price_table"], ca["price_line"], "M")
    price_b = observations(m.get("dataset", "NIUnderlyingDetail"), cb["price_table"], cb["price_line"], "M")
    weight_a = observations(m.get("dataset", "NIUnderlyingDetail"), ca["weight_table"], ca["weight_line"], "M")
    weight_b = observations(m.get("dataset", "NIUnderlyingDetail"), cb["weight_table"], cb["weight_line"], "M")

    pa = {o["date"]: o["value"] for o in price_a}
    pb = {o["date"]: o["value"] for o in price_b}
    wa = {o["date"]: o["value"] for o in weight_a}
    wb = {o["date"]: o["value"] for o in weight_b}
    dates = sorted(set(pa) & set(pb) & set(wa) & set(wb))

    out: list[dict] = []
    for i in range(1, len(dates)):
        d0, d1 = dates[i - 1], dates[i]
        if pa[d0] == 0 or pb[d0] == 0:
            continue
        chg_a = pa[d1] / pa[d0] - 1
        chg_b = pb[d1] / pb[d0] - 1
        w_a, w_b = wa[d0], wb[d0]
        denom = w_a - w_b
        if denom == 0:
            continue
        # 這裡先算出「排除子項後」的合成指數(以 d0 為基期=1.0)，
        # 再交給 common.transform() 算 yoy/mom，跟其他 BEA 序列共用同一套邏輯。
        chg = (w_a * chg_a - w_b * chg_b) / denom
        base = out[-1]["value"] if out else 1.0
        out.append({"date": d1, "value": base * (1 + chg)})
    return out


def fetch_derived(card_id: str, m: dict) -> dict:
    if m.get("method") != "weighted_ex_component":
        return {"ok": False, "reason": f"未知的 derived method: {m.get('method')}"}
    idx = _weighted_ex_component_index(m)
    if len(idx) < 13:
        return {"ok": False, "reason": "核心服務排除房租的合成指數資料長度不足"}
    ser = transform(idx, m.get("display", "yoy"), "M")
    if not ser:
        return {"ok": False, "reason": "核心服務排除房租 yoy 計算失敗"}
    also: dict[str, float] = {}
    for form in m.get("also", []):
        r = transform(idx, form, "M")
        if r:
            also[form] = r[-1]["value"]
    return {
        "ok": True,
        "value": ser[-1]["value"],
        "asof": ser[-1]["date"],
        "history": ser[-24:],
        "raw_latest": idx[-1]["value"],
        "freq": "M",
        "extras": {},
        "also": also,
        "source_label": "derived：BEA名目權重反推（非BEA官方直接數字）",
    }
