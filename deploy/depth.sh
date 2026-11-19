#!/bin/sh
# Mobile list depth and homepage-entry funnels from all Caddy access logs, including rotations.
# Live: sh deploy/depth.sh [--since YYYY-MM-DD] [--until YYYY-MM-DD]
# Offline, the same Python stage: sh deploy/depth.sh --stdin [date options] < sample.jsonl
set -e
cd "$(dirname "$0")/.."

analyze() {
  python3 -c '
import argparse, json, math, re, statistics, sys
from collections import defaultdict
from datetime import date, datetime
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

def calendar_date(value):
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValueError("expected YYYY-MM-DD")
    return date.fromisoformat(value)

parser = argparse.ArgumentParser(description="List depth and homepage-entry visits (Beijing dates, inclusive)")
parser.add_argument("--since", type=calendar_date)
parser.add_argument("--until", type=calendar_date)
args = parser.parse_args()
if args.since and args.until and args.since > args.until:
    parser.error("--until must be on or after --since")

beijing = ZoneInfo("Asia/Shanghai")
depth_days, depth_pages, visits = defaultdict(list), defaultdict(list), defaultdict(list)
depth_views = {}
devices = ("电脑", "手机", "微信")
pages = ("/", "/all", "/topics/*", "/starred")

def user_agent(request):
    headers = request.get("headers", {})
    if not isinstance(headers, dict):
        return ""
    for key, value in headers.items():
        if key.lower() == "user-agent":
            if isinstance(value, list):
                value = value[0] if value else ""
            return value if isinstance(value, str) else ""
    return ""

def page_bucket(path):
    if path in ("/", "/all", "/starred"):
        return path
    if re.fullmatch(r"/topics/[^/]+(?:/page/[1-9][0-9]*)?", path):
        return "/topics/*"
    return None

def device_of(ua):
    if "MicroMessenger" in ua:
        return "微信"
    return "手机" if re.search(r"Mobile|iPhone|Android", ua, re.I) else "电脑"

for line in sys.stdin:
    try:
        entry = json.loads(line)
        if isinstance(entry, dict) and entry.get("_depth_log_read_failed") is True:
            sys.exit("Could not read Caddy access logs")
        if not isinstance(entry, dict) or not isinstance(entry.get("request"), dict):
            continue
        request = entry["request"]
        if isinstance(entry.get("ts"), bool):
            continue
        ts = float(entry["ts"])
        if not math.isfinite(ts):
            continue
        day = datetime.fromtimestamp(ts, beijing).date()
        if (args.since and day < args.since) or (args.until and day > args.until):
            continue
        uri = request.get("uri")
        if not isinstance(uri, str):
            continue
        url = urlsplit(uri)
        if url.path not in ("/_ev", "/_pv"):
            continue
        query = parse_qs(url.query, keep_blank_values=True, max_num_fields=32)
        page = urlsplit(query.get("p", [""])[0])
        if page.scheme or page.netloc or not page.path.startswith("/"):
            continue
        ua = user_agent(request)
        if url.path == "/_ev":
            if query.get("k", [""])[0] != "depth":
                continue
            raw_depth, raw_expands = query.get("d", [""])[0], query.get("x", [""])[0]
            bucket = page_bucket(page.path)
            if bucket is None or not re.fullmatch(r"[0-9]+", raw_depth) or not re.fullmatch(r"[0-9]+", raw_expands):
                continue
            values = (int(raw_depth), int(raw_expands))
            if max(values) > 2**53 - 1:
                continue
            # Each legacy beacon without v remains its own view.
            view_id = query.get("v", [""])[0] or object()
            view = depth_views.setdefault(view_id, {"day": day, "ua": ua, "page": bucket, "d": 0, "x": 0})
            view["d"] = max(view["d"], values[0])
            view["x"] = max(view["x"], values[1])
        else:
            if re.search(r"bot|spider|crawl", ua, re.I):
                continue
            ip = request.get("remote_ip") or request.get("client_ip")
            if not isinstance(ip, str) or not ip:
                continue
            visits[(ip, ua, day)].append((ts, page.path))
    except (ValueError, TypeError, KeyError, OverflowError, OSError):
        continue

for view in depth_views.values():
    values = (view["d"], view["x"])
    device = "微信内" if "MicroMessenger" in view["ua"] else "其他手机"
    depth_days[(view["day"], device)].append(values)
    depth_pages[view["page"]].append(values)

def percent(numerator, denominator):
    return f"{100 * numerator / denominator:.1f}%" if denominator else "0.0%"

def depth_row(label, values):
    count = len(values)
    depths = [d for d, x in values]
    median = f"{statistics.median(depths):g}" if count else "0"
    rates = [percent(sum(d >= threshold for d in depths), count) for threshold in (3, 5, 10)]
    average = f"{sum(x for d, x in values) / count:.2f}" if count else "0.00"
    print("\t".join([label, str(count), median, *rates, average]))

print("深度：北京日期 × 设备")
print("日期\t设备\t浏览数\t深度中位数\td≥3\td≥5\td≥10\t平均展开")
for (day, device), values in sorted(depth_days.items()):
    depth_row(f"{day}\t{device}", values)
print("\n深度：页面（全时段）")
print("页面\t浏览数\t深度中位数\td≥3\td≥5\td≥10\t平均展开")
for page in pages:
    depth_row(page, depth_pages[page])

totals = {device: [0, 0, 0] for device in devices}
daily = defaultdict(lambda: [0, 0, 0])
for (ip, ua, day), events in visits.items():
    events.sort(key=lambda event: event[0])
    if events[0][1] != "/":
        continue
    device = device_of(ua)
    detail = any(path.startswith(("/items/", "/story/")) for ts, path in events[1:])
    for counts in (totals[device], daily[(day, device)]):
        counts[0] += 1
        counts[1] += int(detail)
        counts[2] += int(len(events) == 1)

def funnel_row(label, counts):
    visits, details, singles = counts
    print("\t".join([label, str(visits), percent(details, visits), percent(singles, visits)]))

print("\n漏斗：全时段（首页进入）")
print("设备\t访问数\t进入条目比例\t只看首页比例")
for device in devices:
    funnel_row(device, totals[device])
print("\n漏斗：逐日（北京时间）")
print("日期\t设备\t访问数\t进入条目比例\t只看首页比例")
for day in sorted({key[2] for key in visits}):
    for device in devices:
        funnel_row(f"{day}\t{device}", daily[(day, device)])
' "$@"
}

if [ "${1:-}" = "--stdin" ]; then
  shift
  analyze "$@"
else
  {
    docker compose --profile https exec -T caddy sh -c '
      set -e
      for f in /data/logs/access*; do
        [ -e "$f" ] || continue
        case "$f" in *.gz) gunzip -c "$f" ;; *) cat "$f" ;; esac
      done' || printf '%s\n' '{"_depth_log_read_failed":true}'
  } | analyze "$@"
fi
