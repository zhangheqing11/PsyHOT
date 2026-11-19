import assert from "node:assert/strict";
import { after, test } from "node:test";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function reader() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } } });
  return values;
}

// Import after defining no browser globals: module loading must also be safe during SSR.
const state = await import("../app/lib/expanded-state.ts");

test("expansion survives rereading while an explicit collapse removes it", () => {
  reader();
  state.setExpanded("article-one", true);
  state.setExpanded("article-two", true);
  state.setExpanded("article-one", true);
  assert.deepEqual(state.getExpandedIds(), ["article-one", "article-two"]);
  state.setExpanded("article-one", false);
  assert.deepEqual(state.getExpandedIds(), ["article-two"]);
});

test("only the 200 most recently expanded distinct ids are retained", () => {
  const values = reader();
  for (let i = 0; i < 200; i++) state.setExpanded(`item-${i}`, true);
  state.setExpanded("item-0", true);
  state.setExpanded("item-200", true);
  const ids = state.getExpandedIds();
  assert.equal(ids.length, 200);
  assert.deepEqual(ids.slice(0, 3), ["item-200", "item-0", "item-199"]);
  assert.ok(!ids.includes("item-1"));
  assert.equal(JSON.parse(values.get(state.EXPANDED_KEY)!).length, 200);
});

test("oversized stored lists are bounded when read", () => {
  const values = reader();
  const ids = Array.from({ length: 250 }, (_, i) => `stored-${i}`);
  values.set(state.EXPANDED_KEY, JSON.stringify(ids));
  assert.deepEqual(state.getExpandedIds(), ids.slice(0, 200));
});

test("broken JSON and non-array data fall back to an empty list and remain writable", () => {
  const values = reader();
  for (const raw of ["{broken", "null", "42", '"text"', '{"ids":["old"]}']) {
    values.set(state.EXPANDED_KEY, raw);
    assert.deepEqual(state.getExpandedIds(), []);
    state.setExpanded("new", true);
    assert.deepEqual(state.getExpandedIds(), ["new"]);
  }
});

test("stored ids are validated and deduplicated; invalid writes are ignored", () => {
  const values = reader();
  values.set(state.EXPANDED_KEY, JSON.stringify(["valid", null, 1, {}, "valid", "", "with spaces", "x".repeat(81), "valid-two"]));
  assert.deepEqual(state.getExpandedIds(), ["valid", "valid-two"]);
  state.setExpanded("with spaces", true);
  state.setExpanded("", false);
  assert.deepEqual(state.getExpandedIds(), ["valid", "valid-two"]);
});

test("storage read, write and access failures never prevent card interaction", () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { sessionStorage: {
    getItem: () => { throw new Error("read denied"); },
    setItem: () => { throw new Error("quota exceeded"); },
  } } });
  assert.deepEqual(state.getExpandedIds(), []);
  assert.doesNotThrow(() => state.setExpanded("valid", true));
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    get sessionStorage() { throw new Error("access denied"); },
  } });
  assert.deepEqual(state.getExpandedIds(), []);
  assert.doesNotThrow(() => state.setExpanded("valid", false));
});

test("server rendering needs no window or storage", () => {
  Reflect.deleteProperty(globalThis, "window");
  assert.deepEqual(state.getExpandedIds(), []);
  assert.doesNotThrow(() => state.setExpanded("server", true));
});
