#!/bin/sh
# One-time cleanup in a disposable Caddy container, tested with caddy:2.11.6-alpine (BusyBox sh).
# Stop the Caddy log writer first, then run from the repository root:
#   docker run --rm --network none -v aihot_caddy:/data \
#     -v "$PWD/deploy/redact-access-logs.sh:/redact-access-logs.sh:ro" \
#     --entrypoint sh caddy:2.11.6-alpine /redact-access-logs.sh
# Restart Caddy afterwards so it opens the replaced access.log, rather than its old inode.
# Only access.log and access-*.log[.gz] are processed; other sites' logs are left alone.
set -eu
set -o pipefail
umask 077

log_dir=/data/logs
[ -d "$log_dir" ] || { echo "Missing log directory: $log_dir" >&2; exit 1; }

temp_dir=
trap '[ -z "$temp_dir" ] || rm -rf -- "$temp_dir"' EXIT
trap 'exit 1' HUP INT TERM

redact() {
  # Cover both URL fields and the URL-encoded p/r values in /_pv beacons.
  sed -E \
    -e 's/([?&]t=)[^&#"[:space:]\\]*/\1REDACTED/g' \
    -e 's/(%3[Ff]|%26)t%3[Dd][^%&"[:space:]\\]*/\1t%3DREDACTED/g'
}

for file in "$log_dir"/access.log "$log_dir"/access-*.log "$log_dir"/access-*.log.gz; do
  [ -f "$file" ] || continue
  if [ -L "$file" ]; then
    echo "Refusing symlink: $file" >&2
    exit 1
  fi
  # A private temporary directory on the same filesystem makes the final rename atomic.
  temp_dir=$(mktemp -d "$log_dir/.redact-access.XXXXXX")
  case "$file" in
    *.gz) gzip -dc "$file" | redact | gzip -c > "$temp_dir/log" ;;
    *) redact < "$file" > "$temp_dir/log" ;;
  esac
  chown "$(stat -c '%u:%g' "$file")" "$temp_dir/log"
  chmod "$(stat -c '%a' "$file")" "$temp_dir/log"
  mv -f "$temp_dir/log" "$file"
  rmdir "$temp_dir"
  temp_dir=
  echo "Redacted: $file"
done
