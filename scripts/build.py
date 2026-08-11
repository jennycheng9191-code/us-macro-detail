"""組裝 data/latest.json —— 網頁唯一讀取的資料檔。

流程：逐指標逐拆項抓取 → 兩道關卡驗證 → 規則判讀 → 寫檔。
任何一個拆項失敗都不中斷整體流程，改為沿用上一版的值並亮燈——
交易用途下，沒有更新遠比更新成錯的安全。

跟 us-macro-guide 的 build.py 最大差異：indicators.json 是「指標→拆項」
兩層結構（GDP 底下有 9 個拆項），不是 47 張卡的扁平列表，所以要多一層迴圈，
輸出的 latest.json 也按指標分組，讓網頁一個分頁對應一個指標物件。
"""
from __future__ import annotations

import sys
import traceback
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE / "sources")]

from common import DATA, load_env, read_json, write_json   # noqa: E402
import rules                                                # noqa: E402
import validate                                             # noqa: E402
from sources import bea, bls, census, prnewswire            # noqa: E402

TPE = timezone(timedelta(hours=8))


def _fetch_one(item_id: str, m: dict) -> dict:
    src = m["source"]
    if src == "bea":
        return bea.fetch(item_id, m)
    if src == "bls":
        return bls.fetch(item_id, m)
    if src == "census":
        return census.fetch(item_id, m)
    if src == "census_derived":
        return census.fetch_derived(item_id, m)
    if src == "prnewswire":
        return prnewswire.fetch(item_id, m)
    if src == "derived":
        return bea.fetch_derived(item_id, m)
    return {"ok": False, "reason": f"未知來源型別 {src}"}


def fmt(value, m: dict) -> str:
    if value is None:
        return "—"
    unit = m.get("unit", "")
    d = 0 if unit == "k" else 1
    s = f"{value:,.{d}f}"
    if unit in ("%", "pp"):
        sign = "+" if value > 0 and unit == "pp" else ""
        return f"{sign}{s}{'%' if unit == '%' else 'pp'}"
    if unit == "k":
        sign = "+" if value > 0 else ""
        return f"{sign}{s}k"
    if unit == "hrs":
        return f"{s}hrs"
    return s


def build_item(item: dict, m: dict, previous: dict, today: str) -> dict:
    item_id = item["id"]
    try:
        res = _fetch_one(item_id, m)
    except Exception as e:                                  # noqa: BLE001
        res = {"ok": False, "reason": f"抓取例外：{e}"}
        print(f"  ! {item['name']}: {e}", file=sys.stderr)
        traceback.print_exc(limit=1, file=sys.stderr)

    verdict = validate.check(res, m)
    status, notes = verdict["status"], list(verdict["notes"])

    if status == "gray" and item_id in previous and previous[item_id].get("value") is not None:
        old = previous[item_id]
        notes.append(f"本次未取得，沿用 {old.get('asof', '—')} 的前值")
        res = {"ok": True, "value": old["value"], "asof": old.get("asof", ""),
               "history": old.get("history", []), "extras": old.get("extras", {}),
               "also": old.get("also", {}), "source_label": old.get("source_label", ""),
               "raw_latest": old.get("value")}
        status = "yellow"

    if status == "gray":
        res = {"ok": False, "asof": "", "history": [], "extras": {}, "also": {},
               "source_label": res.get("source_label", "")}

    note = rules.build_note(item, m, res) if res.get("ok") else ""

    prev = previous.get(item_id, {})
    new_since = prev.get("new_since", "")
    if (m.get("stale_days") or 0) >= 20:
        if (a := res.get("asof")) and prev.get("asof") and a != prev["asof"]:
            new_since = today

    return {
        "name": item.get("name", item_id),
        "value": res.get("value"),
        "value_fmt": fmt(res.get("value"), m) if res.get("ok") else "—",
        "asof": res.get("asof", ""),
        "asof_label": res.get("asof_label", ""),
        "age_days": res.get("age_days"),
        "new_since": new_since,
        "history": res.get("history", []),
        "also": res.get("also", {}),
        "status": status,
        "notes": notes,
        "note": note,
        "source_label": res.get("source_label", ""),
        "unit": m.get("unit", ""),
        "weight": m.get("weight"),
        "role": item.get("role", "component"),
        "group": item.get("group", ""),
        "in_composite": item.get("in_composite"),
    }


def main() -> int:
    load_env()
    indicators = read_json(DATA / "indicators.json", [])
    mapping = read_json(DATA / "mapping.json", {})
    mapping.pop("_doc", None)
    prev_out = read_json(DATA / "latest.json", {})
    today = datetime.now(TPE).strftime("%Y-%m-%d")

    out_indicators: dict[str, dict] = {}
    tally = {"green": 0, "yellow": 0, "gray": 0}

    for group in indicators:
        gid = group["id"]
        previous_items = (prev_out.get("indicators", {}).get(gid, {}) or {}).get("items", {})
        items_out: dict[str, dict] = {}
        print(f"== {group['name']} ==")
        for item in group["items"]:
            iid = item["id"]
            m = mapping.get(iid)
            if not m:
                print(f"  ! {iid} 沒有對應的 mapping，跳過", file=sys.stderr)
                continue
            built = build_item(item, m, previous_items, today)
            items_out[iid] = built
            tally[built["status"]] = tally.get(built["status"], 0) + 1
            flag = {"green": "OK", "yellow": "!!", "gray": "--"}[built["status"]]
            print(f"  [{flag}] {item['name']:<28} {built['value_fmt']:>12}  {built['asof']}")

        out_indicators[gid] = {
            "name": group["name"],
            "name_full": group.get("name_full", group["name"]),
            "freq": group.get("freq", "M"),
            "org": group.get("org", ""),
            "url": group.get("url", ""),
            "items": items_out,
        }

    out = {
        "build_time": datetime.now(TPE).strftime("%Y-%m-%d %H:%M"),
        "summary": tally,
        "indicators": out_indicators,
    }
    write_json(DATA / "latest.json", out)
    print(f"\n完成：綠燈 {tally['green']} / 黃燈 {tally['yellow']} / 未取得 {tally['gray']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
