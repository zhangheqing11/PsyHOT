#!/bin/sh
# Visit report from the Caddy access log (deploy/Caddyfile): visitors and page views per day, pages,
# referrers, browsers and operating systems. Crawlers, static files, API calls and the pages' own data
# requests are left out, so the numbers are people opening pages. Needs goaccess on the server
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
  grep -v -E '"uri":"/(api/|assets/|og/|img/|_\.data|favicon|icon|apple-icon|manifest)|\.data[?"]' |
  goaccess - --log-format=CADDY --ignore-crawlers --tz=Asia/Shanghai --no-progress \
    --html-report-title="PsyHOT 访问统计" -o "$out.html" >/dev/null 2>&1
cat "$out.html"
rm -f "$out" "$out.html"
