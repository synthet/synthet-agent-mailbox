import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { dashboardHtml } from "../dist/dashboard.js";

/** Just enough DOM to run the dashboard script: elements, children, text, class names, events. */
class FakeElement {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.textContent = ""; this.className = ""; this.hidden = false; this.title = ""; this.open = false; }
  get firstChild() { return this.children[0] ?? null; }
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); return child; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] ?? []) fn({ target: this }); }
  get classList() { return { toggle() {} }; }
  getAttribute() { return null; }
  closest() { return null; }
  findAll(tag) { return this.children.flatMap((c) => [...(c.tagName === tag ? [c] : []), ...c.findAll(tag)]); }
}

function runDashboard() {
  const ids = new Map();
  const document = {
    getElementById: (id) => { if (!ids.has(id)) ids.set(id, new FakeElement("div")); return ids.get(id); },
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: () => [],
    querySelector: () => new FakeElement("div"),
  };
  let tick = null;
  let payload = null;
  const fetch = async () => ({ ok: true, json: async () => payload });
  const context = { document, fetch, setInterval: (fn) => { tick = fn; return 1; }, clearInterval() {}, Object, String, Date, Error };
  const script = /<script>([\s\S]*)<\/script>/.exec(dashboardHtml)[1];
  return {
    start(data) { payload = data; vm.runInNewContext(script, context); },
    async refresh(data) { payload = data; tick(); await new Promise((resolve) => setTimeout(resolve, 0)); },
    details: () => ids.get("received").findAll("details"),
  };
}

const longText = (label) => `${label} ${"x".repeat(200)}`;
const snapshot = (texts) => ({
  mode: "peer", journal: true, generated_at: new Date().toISOString(), agent: { id: "Beta" },
  mailbox: { connected: true, candidates: ["peer"] }, wake: { mode: "off" }, agents: { agents: [] },
  remote: null, local: {}, outbox: [], log: "",
  recent: texts.map((text, i) => ({
    status: "new", source: "peer",
    message: { sender: "Alpha", type: "chat", created_at: `2026-11-10T18:0${i}:00.000Z`, conversation_id: `c${i}`, body: { text } },
  })),
});

test("auto-refresh keeps an expanded message open, and a collapsed one closed", async () => {
  const ui = runDashboard();
  const first = snapshot([longText("one"), longText("two")]);
  ui.start(first);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ui.details().length, 2);

  const [one] = ui.details();
  one.open = true; one.dispatch("toggle");
  await ui.refresh(first);
  assert.deepEqual(ui.details().map((d) => d.open), [true, false], "the expanded card survives a refresh");

  // A new message arrives; the expanded one stays open.
  await ui.refresh(snapshot([longText("one"), longText("two"), longText("three")]));
  assert.deepEqual(ui.details().map((d) => d.open), [true, false, false]);

  const [reopened] = ui.details();
  reopened.open = false; reopened.dispatch("toggle");
  await ui.refresh(first);
  assert.deepEqual(ui.details().map((d) => d.open), [false, false], "a card the user collapsed stays collapsed");
});
