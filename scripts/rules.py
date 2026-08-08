"""規則式判讀引擎 —— 自動生成每個拆項的「現況判讀」。

只寫規則算得出來的話，跨指標推理、地緣事件干擾這類需要判斷的評論一律
留白，不自動編造。輸出風格對齊 us-macro-guide：一句話、繁體中文、40字內。

跟 us-macro-guide 的差異：那邊用 mapping.json 裡的 "rules": [...] 顯式宣告
每張卡套哪些規則；這裡 67 個拆項太多，改用 item id 的命名規律（ism_ 開頭、
_contrib 結尾…）自動判斷該套用哪條規則，mapping.json 不需要為此新增欄位。
"""
from __future__ import annotations


# ---------------------------------------------------------------- 指標專屬規則

def pmi_50_line(res: dict) -> str | None:
    v = res.get("value")
    if v is None:
        return None
    side = "高於" if v >= 50 else "低於"
    return f"{side} 50 榮枯線"


def sahm_rule(res: dict) -> str | None:
    """失業率：3 個月均值 − 過去 12 個月低點，0.5pp 為衰退訊號門檻。"""
    vals = [h["value"] for h in res.get("history", [])]
    if len(vals) < 15:
        return None
    ma3 = sum(vals[-3:]) / 3
    low12 = min(sum(vals[i - 2:i + 1]) / 3 for i in range(len(vals) - 12, len(vals)))
    gap = ma3 - low12
    if gap >= 0.5:
        return f"Sahm Rule 計數 {gap:.2f}pp，已觸發 0.5pp 衰退訊號門檻"
    return f"Sahm Rule 計數 {gap:.2f}pp，距門檻尚有 {0.5 - gap:.2f}pp"


def nfp_breakeven(res: dict) -> str | None:
    """就業損益兩平區間（人口成長+移民推估）約月增 10–15 萬人。"""
    v = res.get("value")
    if v is None:
        return None
    if v < 100:
        return f"月增 {v:.0f}千人，低於 10–15 萬盈虧平衡區間"
    if v > 150:
        return f"月增 {v:.0f}千人，高於 10–15 萬盈虧平衡區間"
    return f"月增 {v:.0f}千人，落在 10–15 萬盈虧平衡區間內"


def contrib_sign(res: dict, item: dict) -> str | None:
    v = res.get("value")
    if v is None:
        return None
    name = item.get("name", "")
    if v > 0:
        return f"對GDP貢獻 +{v:.2f}pp，屬成長動能"
    if v < 0:
        return f"對GDP貢獻 {v:.2f}pp，拖累整體成長"
    return "對GDP貢獻約略持平"


def near_target_2pct(res: dict) -> str | None:
    v = res.get("value")
    if v is None:
        return None
    gap = v - 2.0
    if abs(gap) <= 0.2:
        return f"年增 {v:.1f}%，已貼近2%通膨目標"
    if gap > 0:
        return f"年增 {v:.1f}%，高於2%目標 {gap:.1f}pp"
    return f"年增 {v:.1f}%，低於2%目標 {-gap:.1f}pp"


def retail_momentum(res: dict) -> str | None:
    v = res.get("value")
    if v is None:
        return None
    if v >= 0.4:
        return f"月增 {v:.1f}%，消費動能強勁"
    if v <= -0.2:
        return f"月增 {v:.1f}%，消費動能疲弱"
    return f"月增 {v:.1f}%，消費動能持穩"


# ---------------------------------------------------------------- 通用規則

def generic(res: dict) -> str | None:
    """所有拆項都適用：連續同向期數 / 相對歷史區間的位置。"""
    vals = [h["value"] for h in res.get("history", [])]
    if len(vals) < 6:
        return None

    diffs = [b - a for a, b in zip(vals, vals[1:])]
    streak, sign = 0, (1 if diffs[-1] > 0 else -1 if diffs[-1] < 0 else 0)
    if sign:
        for d in reversed(diffs):
            if (d > 0) == (sign > 0) and d != 0:
                streak += 1
            else:
                break

    bits = []
    if streak >= 3:
        bits.append(f"連續 {streak} 期{'走升' if sign > 0 else '走降'}")

    v = vals[-1]
    if v >= max(vals):
        bits.append(f"創近 {len(vals)} 期新高")
    elif v <= min(vals):
        bits.append(f"創近 {len(vals)} 期新低")
    else:
        rank = sum(1 for x in vals if x <= v) / len(vals) * 100
        bits.append(f"位於近 {len(vals)} 期的第 {rank:.0f} 百分位")

    return "、".join(bits) if bits else None


# ---------------------------------------------------------------- 分派

_NEAR_TARGET_IDS = {"cpi_headline", "cpi_core", "pce_headline", "pce_core"}


def build_note(item: dict, m: dict, res: dict) -> str:
    """組合出一句判讀。規則算不出來就留白，不編造。"""
    iid = item["id"]
    parts: list[str] = []

    try:
        if iid.startswith("ism_"):
            if (s := pmi_50_line(res)):
                parts.append(s)
        elif iid == "nfp_unemployment_rate":
            if (s := sahm_rule(res)):
                parts.append(s)
        elif iid == "nfp_headline":
            if (s := nfp_breakeven(res)):
                parts.append(s)
        elif iid.endswith("_contrib"):
            if (s := contrib_sign(res, item)):
                parts.append(s)
        elif iid in _NEAR_TARGET_IDS:
            if (s := near_target_2pct(res)):
                parts.append(s)
        elif iid in ("retail_headline", "retail_core"):
            if (s := retail_momentum(res)):
                parts.append(s)
    except Exception:                          # noqa: BLE001
        pass

    try:
        if (g := generic(res)):
            parts.append(g)
    except Exception:                          # noqa: BLE001
        pass

    return "；".join(parts)
