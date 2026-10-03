#!/bin/sh
# Visit report from the Caddy access log (deploy/Caddyfile): visitors and page views per day, pages,
# referrers, browsers and operating systems. It counts the page-view beacon (/_pv, sent by the site
# for every page a reader opens, apps/web/app/lib/page-views.ts), so prefetches, crawlers that run no
# script, static files and API calls are not counted. Needs goaccess and python3 on the server
# (apt install goaccess). Prints an HTML report:
#   ssh <server> 'cd psyhot && sh deploy/stats.sh' > report.html
set -e
cd "$(dirname "$0")/.."
out=$(mktemp)
docker compose --profile https exec -T caddy sh -c '
  for f in /data/logs/access*; do
    [ -e "$f" ] || continue
    case "$f" in *.gz) gunzip -c "$f" ;; *) cat "$f" ;; esac
  done' |
  python3 -c '
import json, sys
from urllib.parse import parse_qs, urlsplit
# Each beacon becomes a GET of the page it reports, with the external referrer of a first view.
for line in sys.stdin:
    try:
        entry = json.loads(line)
    except ValueError:
        continue
    req = entry.get("request", {})
    url = urlsplit(req.get("uri", ""))
    if url.path != "/_pv":
        continue
    query = parse_qs(url.query)
    page = query.get("p", [""])[0]
    if not page.startswith("/"):
        continue
    req["uri"], req["method"] = page, "GET"
    headers = req.setdefault("headers", {})
    headers.pop("Referer", None)
    if query.get("r"):
        headers["Referer"] = [query["r"][0]]
    entry["status"] = 200
    print(json.dumps(entry))
' |
  goaccess - --log-format=CADDY --ignore-crawlers --tz=Asia/Shanghai --no-progress \
    --html-report-title="PsyHOT 访问统计" -o "$out.html" >/dev/null 2>&1
cat "$out.html"
rm -f "$out" "$out.html"
