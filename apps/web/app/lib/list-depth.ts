// Anonymous list-reading totals. A random view id joins repeat reports within this visit only;
// it is never stored or reused across pages.
import { useLayoutEffect } from "react";
import { useLocation } from "react-router";
import { EXPAND_EVENT } from "./expanded-state";

export function isListDepthPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/all" || pathname === "/starred" || /^\/topics\/[^/]+(?:\/page\/[1-9]\d*)?$/.test(pathname);
}

export function listDepthUrl(page: string, depth: number, expands: number, width: number, visitId: string): string {
  return `/_ev?${new URLSearchParams({ k: "depth", v: visitId, p: page, d: String(depth), x: String(expands), w: String(width) })}`;
}

/** One pathname + search visit. Its disposer flushes this captured URL before the next visit starts. */
export function startListDepth(page: string): () => void {
  if (typeof window === "undefined" || !isListDepthPath(page.split("?")[0]) || navigator.doNotTrack === "1"
    || !window.matchMedia || typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const visitId = window.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);
  const mobile = window.matchMedia("(max-width: 960px)");
  const body = document.body;
  const selector = "[data-item-id]";
  let depth = 0, expands = 0, stopped = false;
  let sent: { depth: number; expands: number } | null = null;
  let order = new Map<Element, number>();
  let intersection: IntersectionObserver | null = null;
  let mutation: MutationObserver | null = null;

  function record(entries: IntersectionObserverEntry[]) {
    if (stopped || !mobile.matches || navigator.doNotTrack === "1") return;
    for (const entry of entries) {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) depth = Math.max(depth, order.get(entry.target) ?? 0);
    }
  }
  function observeNew(candidates: Iterable<Element>) {
    const added = [...candidates].filter((card) => !order.has(card) && body.contains(card));
    if (!added.length || !intersection) return;
    const current = [...order.keys()].filter((card) => {
      if (body.contains(card)) return true;
      intersection!.unobserve(card);
      return false;
    });
    // Mutation records can name overlapping subtrees or arrive out of document order.
    const cards = [...new Set([...current, ...added])].sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1);
    order = new Map(cards.map((card, index) => [card, index + 1]));
    for (const card of added) intersection.observe(card);
  }
  function disconnect() {
    intersection?.disconnect();
    mutation?.disconnect();
    intersection = mutation = null;
    order.clear();
  }
  function onMediaChange() {
    disconnect();
    if (stopped || !mobile.matches || navigator.doNotTrack === "1") return;
    intersection = new IntersectionObserver(record, { threshold: 0.5 });
    observeNew(body.querySelectorAll(selector));
    mutation = new MutationObserver((records) => {
      if (stopped || !intersection) return;
      const added = new Set<Element>();
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const element = node as Element;
        if (element.matches(selector)) added.add(element);
        for (const card of element.querySelectorAll(selector)) added.add(card);
      }
      observeNew(added);
    });
    mutation.observe(body, { childList: true, subtree: true });
  }
  function flush() {
    if (stopped || !mobile.matches || navigator.doNotTrack === "1") return;
    if (intersection) record(intersection.takeRecords());
    if (sent && depth <= sent.depth && expands <= sent.expands) return;
    try {
      if (navigator.sendBeacon?.(listDepthUrl(page, depth, expands, window.innerWidth, visitId))) sent = { depth, expands };
    } catch { /* telemetry must never interrupt reading or navigation */ }
  }
  const onExpand = () => { if (!stopped && mobile.matches && navigator.doNotTrack !== "1") expands++; };
  const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
  window.addEventListener(EXPAND_EVENT, onExpand);
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", onVisibility);
  mobile.addEventListener?.("change", onMediaChange);
  onMediaChange();
  return () => {
    flush();
    stopped = true;
    disconnect();
    window.removeEventListener(EXPAND_EVENT, onExpand);
    window.removeEventListener("pagehide", flush);
    document.removeEventListener("visibilitychange", onVisibility);
    mobile.removeEventListener?.("change", onMediaChange);
  };
}

export function useListDepth() {
  const { pathname, search } = useLocation();
  useLayoutEffect(() => startListDepth(pathname + search), [pathname, search]);
}
