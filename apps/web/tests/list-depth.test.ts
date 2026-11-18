import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

type Depth = typeof import("../app/lib/list-depth.ts");
let vite: ViteDevServer;
let isListDepthPath: Depth["isListDepthPath"];
let listDepthUrl: Depth["listDepthUrl"];
let startListDepth: Depth["startListDepth"];
let countExpand: typeof import("../app/lib/expanded-state.ts")["countExpand"];
before(async () => {
  vite = await createServer({ configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), appType: "custom",
    server: { middlewareMode: true, ws: false }, ssr: { external: ["react", "react-dom", "react-router"] }, optimizeDeps: { noDiscovery: true } });
  ({ isListDepthPath, listDepthUrl, startListDepth } = await vite.ssrLoadModule("/app/lib/list-depth.ts") as Depth);
  ({ countExpand } = await vite.ssrLoadModule("/app/lib/expanded-state.ts"));
});

test("depth paths include only the list routes, including existing topic pagination", () => {
  for (const path of ["/", "/all", "/starred", "/topics/cognition-neuro", "/topics/cognition-neuro/page/2"]) assert.equal(isListDepthPath(path), true, path);
  for (const path of ["/topics", "/topics/", "/admin", "/admin/content", "/items/one", "/story/one", "/hot", "/all/search-busy", "/topics/x/unknown"]) assert.equal(isListDepthPath(path), false, path);
});

test("depth URLs round-trip the full path and query without adding identity fields", () => {
  const page = "/all?q=睡眠&tag=CBT%2BI&track=academic";
  const url = new URL(listDepthUrl(page, 10, 2, 375, "view-one"), "https://example.com");
  assert.equal(url.pathname, "/_ev");
  assert.equal(url.searchParams.get("p"), page);
  assert.deepEqual([...url.searchParams.keys()], ["k", "v", "p", "d", "x", "w"]);
  assert.equal(url.searchParams.get("k"), "depth");
  assert.equal(url.searchParams.get("v"), "view-one");
  assert.equal(url.searchParams.get("d"), "10");
  assert.equal(url.searchParams.get("x"), "2");
  assert.equal(url.searchParams.get("w"), "375");
  assert.ok(url.search.includes("%2Fall%3Fq%3D%E7%9D%A1%E7%9C%A0%26tag%3DCBT%252BI"));
});

test("a zero-depth visit still generates a beacon URL", () => {
  assert.equal(listDepthUrl("/", 0, 0, 375, "zero-view"), "/_ev?k=depth&v=zero-view&p=%2F&d=0&x=0&w=375");
});

const globals = ["window", "document", "navigator", "Node", "IntersectionObserver", "MutationObserver"] as const;
const originals = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
after(async () => {
  for (const key of globals) {
    const descriptor = originals.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await vite?.close();
});

let nextVisit = 0;
function browser({ mobile = true, dnt = "0" } = {}) {
  class Element {
    nodeType = 1;
    children: Element[] = [];
    scans = 0;
    readonly card: boolean;
    constructor(card = false) { this.card = card; }
    matches() { return this.card; }
    querySelectorAll(): Element[] {
      this.scans++;
      return this.children.flatMap((child) => [ ...(child.card ? [child] : []), ...child.querySelectorAll() ]);
    }
    contains(node: Element): boolean { return this === node || this.children.some((child) => child.contains(node)); }
    compareDocumentPosition(other: Element) {
      const order = body.queryOrder();
      return order.indexOf(this) < order.indexOf(other) ? 4 : 2;
    }
  }
  const body = Object.assign(new Element(), {
    queryOrder(this: Element): Element[] {
      const visit = (node: Element): Element[] => node.children.flatMap((child) => [child, ...visit(child)]);
      return visit(this);
    },
  });
  const cards = [new Element(true), new Element(true), new Element(true)];
  body.children = cards.slice();
  const media = Object.assign(new EventTarget(), { matches: mobile });
  const win = Object.assign(new EventTarget(), { innerWidth: mobile ? 375 : 1440,
    crypto: { randomUUID: () => `${(++nextVisit).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000` },
    matchMedia: (query: string) => {
    assert.equal(query, "(max-width: 960px)");
    return media;
  } });
  const doc = Object.assign(new EventTarget(), { body, visibilityState: "visible" });
  const beacons: URLSearchParams[] = [];
  const nav = { doNotTrack: dnt, sendBeacon: (url: string) => { beacons.push(new URL(url, "https://example.com").searchParams); return true; } };
  type Entry = { target: Element; isIntersecting: boolean; intersectionRatio: number };
  const intersections: Intersection[] = [];
  class Intersection {
    observed = new Set<Element>();
    pending: Entry[] = [];
    disconnected = false;
    readonly callback: (entries: Entry[]) => void;
    constructor(callback: (entries: Entry[]) => void, options: { threshold: number }) {
      this.callback = callback;
      assert.equal(options.threshold, 0.5);
      intersections.push(this);
    }
    observe(node: Element) { this.observed.add(node); }
    unobserve(node: Element) { this.observed.delete(node); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
    takeRecords() { return this.pending.splice(0); }
    emit(node: Element, ratio: number) { this.callback([{ target: node, isIntersecting: ratio > 0, intersectionRatio: ratio }]); }
  }
  const mutations: Mutation[] = [];
  class Mutation {
    disconnected = false;
    readonly callback: (records: Array<{ addedNodes: Element[] }>) => void;
    constructor(callback: (records: Array<{ addedNodes: Element[] }>) => void) { this.callback = callback; mutations.push(this); }
    observe(target: Element, options: MutationObserverInit) {
      assert.equal(target, body);
      assert.deepEqual(options, { childList: true, subtree: true });
    }
    disconnect() { this.disconnected = true; }
    add(...nodes: Element[]) { this.callback([{ addedNodes: nodes }]); }
  }
  for (const [key, value] of Object.entries({ window: win, document: doc, navigator: nav, Node: { DOCUMENT_POSITION_PRECEDING: 2 }, IntersectionObserver: Intersection, MutationObserver: Mutation })) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  return { body, cards, win, doc, nav, media, beacons, intersections, mutations, Element,
    hidden() { doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange")); },
    visible() { doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); },
    resize(matches: boolean) { media.matches = matches; win.innerWidth = matches ? 375 : 1440; media.dispatchEvent(new Event("change")); },
  };
}

test("Do Not Track and excluded routes create no observers or beacons", () => {
  for (const [path, dnt] of [["/", "1"], ["/admin", "0"], ["/topics", "0"]]) {
    const b = browser({ dnt });
    const stop = startListDepth(path);
    countExpand();
    b.hidden();
    stop();
    assert.equal(b.intersections.length, 0);
    assert.equal(b.beacons.length, 0);
  }
});

test("desktop tracking stays inactive and follows changes to the mobile breakpoint", () => {
  const b = browser({ mobile: false });
  const stop = startListDepth("/");
  countExpand();
  b.hidden();
  assert.equal(b.intersections.length, 0);
  assert.equal(b.beacons.length, 0);
  b.visible();
  b.resize(true);
  b.intersections[0].emit(b.cards[1], 0.5);
  countExpand();
  b.resize(false);
  countExpand();
  b.hidden();
  assert.equal(b.beacons.length, 0);
  assert.equal(b.intersections[0].disconnected, true);
  b.resize(true);
  stop();
  assert.equal(b.beacons[0].get("d"), "2");
  assert.equal(b.beacons[0].get("x"), "1");
  assert.equal(b.beacons[0].get("w"), "375");
});

test("depth is the largest DOM ordinal to cross 50%, not the number of visible cards", () => {
  const b = browser();
  const stop = startListDepth("/all?q=sleep");
  const io = b.intersections[0];
  io.emit(b.cards[2], 0.49);
  io.emit(b.cards[0], 1);
  io.emit(b.cards[2], 0.5);
  io.emit(b.cards[1], 1);
  assert.equal(b.beacons.length, 0, "reading never sends a beacon immediately");
  b.hidden();
  assert.equal(b.beacons[0].get("d"), "3");
  assert.equal(b.beacons[0].get("p"), "/all?q=sleep");
  stop();
});

test("new card subtrees are observed once in DOM order without rescanning the document", () => {
  const b = browser();
  const stop = startListDepth("/");
  const fourth = new b.Element(true), fifth = new b.Element(true), wrapper = new b.Element();
  wrapper.children = [fourth, fifth];
  b.body.children.push(wrapper);
  b.mutations[0].add(fifth, wrapper);
  b.mutations[0].add(new b.Element());
  assert.equal(b.body.scans, 1);
  assert.equal(b.intersections[0].observed.size, 5);
  b.intersections[0].emit(fifth, 0.5);
  stop();
  assert.equal(b.beacons[0].get("d"), "5");
});

test("hidden, pagehide and cleanup deduplicate; resumed reading sends only increased totals", () => {
  const b = browser();
  const stop = startListDepth("/");
  b.hidden();
  b.win.dispatchEvent(new Event("pagehide"));
  assert.equal(b.beacons.length, 1);
  assert.equal(b.beacons[0].get("d"), "0");
  b.visible();
  b.hidden();
  assert.equal(b.beacons.length, 1);
  b.visible();
  countExpand();
  countExpand();
  b.hidden();
  assert.equal(b.beacons.length, 2);
  assert.equal(b.beacons[1].get("x"), "2");
  b.visible();
  b.intersections[0].emit(b.cards[2], 1);
  stop();
  assert.equal(b.beacons.length, 3);
  assert.equal(b.beacons[2].get("d"), "3");
  assert.equal(b.beacons[2].get("x"), "2");
  assert.ok(b.beacons[0].get("v"));
  assert.equal(new Set(b.beacons.map((beacon) => beacon.get("v"))).size, 1, "every report from this visit shares its id");
  assert.ok(b.intersections.every((io) => io.disconnected));
  assert.ok(b.mutations.every((mo) => mo.disconnected));
  countExpand();
  b.hidden();
  assert.equal(b.beacons.length, 3);
});

test("route cleanup flushes the captured old URL and pending intersections before a fresh page starts", () => {
  const b = browser();
  const stopOld = startListDepth("/all?q=old");
  b.intersections[0].pending.push({ target: b.cards[1], isIntersecting: true, intersectionRatio: 0.5 });
  countExpand();
  stopOld();
  assert.equal(b.beacons[0].get("p"), "/all?q=old");
  assert.equal(b.beacons[0].get("d"), "2");
  const stopNew = startListDepth("/all?q=new");
  b.intersections[0].emit(b.cards[2], 1);
  b.hidden();
  assert.equal(b.beacons[1].get("p"), "/all?q=new");
  assert.equal(b.beacons[1].get("d"), "0");
  assert.equal(b.beacons[1].get("x"), "0");
  assert.ok(b.beacons[1].get("v"));
  assert.notEqual(b.beacons[0].get("v"), b.beacons[1].get("v"), "a route change starts a new visit id");
  stopNew();
  assert.equal(b.beacons.length, 2);
});

test("unavailable observers or beacon errors do not disrupt the page", () => {
  const b = browser();
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
  const unsupported = startListDepth("/");
  assert.doesNotThrow(unsupported);
  assert.equal(b.beacons.length, 0);
  const available = browser();
  available.nav.sendBeacon = () => { throw new Error("beacon denied"); };
  const stop = startListDepth("/");
  assert.doesNotThrow(() => available.hidden());
  assert.doesNotThrow(stop);
});

test("a refused beacon can retry at the next exit signal and then deduplicates", () => {
  const b = browser();
  const send = b.nav.sendBeacon;
  let attempts = 0;
  b.nav.sendBeacon = (url) => ++attempts === 1 ? false : send(url);
  const stop = startListDepth("/");
  b.hidden();
  assert.equal(b.beacons.length, 0);
  b.win.dispatchEvent(new Event("pagehide"));
  assert.equal(b.beacons.length, 1);
  stop();
  assert.equal(attempts, 2);
});

test("without randomUUID a fresh visit uses the random fallback without browser storage", (t) => {
  const b = browser();
  Reflect.deleteProperty(b.win, "crypto");
  t.mock.method(Math, "random", () => 0.123456789);
  for (const key of ["localStorage", "sessionStorage"]) Object.defineProperty(b.win, key, {
    get() { throw new Error("storage must not be used for visit ids"); },
  });
  const stop = startListDepth("/");
  b.hidden();
  assert.equal(b.beacons[0].get("v"), (0.123456789).toString(36).slice(2, 10));
  stop();
});
