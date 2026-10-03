// One request per page a reader opens, first load and in-site navigation alike, so the access log can
// count page views (deploy/stats.sh). Prefetches never send it, and a navigation served from a prefetch
// still does. Caddy answers /_pv itself (deploy/Caddyfile). Nothing is sent with Do Not Track on, and
// the admin is not counted. The first view carries the external referrer, which later ones lack.
import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

export function usePageViews() {
  const { pathname, search } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (pathname === "/admin" || pathname.startsWith("/admin/")) return;
    if (navigator.doNotTrack === "1") return;
    const params = new URLSearchParams({ p: pathname + search });
    if (first.current && document.referrer) params.set("r", document.referrer);
    first.current = false;
    navigator.sendBeacon?.(`/_pv?${params}`);
  }, [pathname, search]);
}
