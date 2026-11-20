/* Cahier Tasks: the board, ported from Tack's board, card face, card panel and date picker
 * (lou-bou/tack web/src). One board; its lists are the modules. Plain DOM, no framework. */
import {
  DEFAULT_DUE_TIME, DEFAULT_START_TIME, PRIORITIES, PRIORITY_LABELS, addDays, byPosition, dropPosition,
  dueState, formatChip, formatDate, formatDateValue, formatMonth, formatTimestamp, isPlanned, monthStart,
  monthWeeks, newId, nextPlan, parseTime, positionAt, positionAtEnd, presetDate, startAfterDue, todayString,
} from "./core.mjs";
import { TaskStore } from "./store.mjs";

const root = document.getElementById("tasks");
const MODULES = JSON.parse(root.dataset.modules || "[]");  // [{slug, code, title}]
const store = new TaskStore();

// ---- icons (Lucide, ISC) ---------------------------------------------------------------------
const PATHS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  text: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  urgent: '<path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/>',
  high: '<path d="m18 15-6-6-6 6"/>',
  medium: '<line x1="5" x2="19" y1="9" y2="9"/><line x1="5" x2="19" y1="15" y2="15"/>',
  low: '<path d="m6 9 6 6 6-6"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
  select: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  cloudOff: '<path d="m2 2 20 20"/><path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193"/><path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07"/>',
  cloudUp: '<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  left: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  right: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>',
};
function icon(name, cls = "") {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.75");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("class", "i " + cls);
  s.innerHTML = PATHS[name];  // constant markup only, never user text
  return s;
}

/** Builds an element. Text children are always text nodes, so user content can't become markup. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

// ---- view state ------------------------------------------------------------------------------

const ui = {
  now: Date.now(),
  composing: null,        // list id with the add-card box open
  draft: "",
  editingList: null,      // list id whose name is being edited
  panel: new URLSearchParams(location.search).get("card"),
  picking: null,          // "start" | "due" while the date picker is open
  pickMonth: null,
  pickTime: null,         // {on, text}
  selecting: false,
  selected: new Set(),
  lingering: new Set(),   // ticked cards playing their done animation before hiding
  justTicked: new Set(),
  menu: null,             // list id whose menu is open
};
setInterval(() => { ui.now = Date.now(); render(); }, 60000);

// ---- data helpers (Tack lib/boards.ts, data/actions.ts) --------------------------------------

function boardView() {
  const boards = [...store.rows.boards.values()].filter((b) => !b.deletedAt).sort(byPosition);
  const board = boards[0];
  if (!board) return null;
  const lists = [...store.rows.lists.values()].filter((l) => l.boardId === board.id && !l.deletedAt).sort(byPosition);
  const byList = new Map(lists.map((l) => [l.id, []]));
  for (const c of store.rows.cards.values()) {
    if (c.deletedAt || c.boardId !== board.id) continue;
    const group = byList.get(c.listId);
    if (group) group.push(c);
  }
  return { board, lists: lists.map((list) => ({ list, cards: byList.get(list.id).sort(byPosition) })) };
}

const stamp = () => {
  const now = new Date().toISOString();
  return { createdAt: now, updatedAt: now, deletedAt: null };
};
const liveCards = (listId) => [...store.rows.cards.values()].filter((c) => c.listId === listId && !c.deletedAt).sort(byPosition);
const allCards = (listId) => [...store.rows.cards.values()].filter((c) => c.listId === listId).sort(byPosition);

function createBoard() {
  const id = newId();
  store.insert("boards", id, { name: "Masters", emoji: "📊", color: "blue", showCompleted: false, position: positionAtEnd([]), ...stamp() });
  let last = null;
  for (const m of MODULES) {
    const pos = positionAt(last ? [last] : [], last ? 1 : 0);
    store.insert("lists", newId(), { boardId: id, name: m.code, module: m.slug, position: pos, ...stamp() });
    last = { id: "", position: pos };
  }
}
function createList(boardId, name) {
  const lists = [...store.rows.lists.values()].filter((l) => l.boardId === boardId).sort(byPosition);
  const m = MODULES.find((x) => x.code.toLowerCase() === name.toLowerCase() || x.slug === name.toLowerCase());
  store.insert("lists", newId(), { boardId, name, module: m ? m.slug : null, position: positionAtEnd(lists), ...stamp() });
}
function createCard(boardId, listId, title) {
  store.insert("cards", newId(), {
    boardId, listId, position: positionAtEnd(allCards(listId)), title, description: "", start: null, due: null,
    priority: "none", completed: false, completedAt: null, plannedFor: null, ...stamp(),
  });
}
const updateCard = (id, fields) => store.update("cards", id, fields);
const setCompleted = (id, completed) => updateCard(id, { completed, completedAt: completed ? new Date().toISOString() : null });

/** Plans cards for a day, or takes them off with null. Returns what each had before, for Undo. */
function setPlanned(ids, day) {
  const before = new Map();
  for (const id of ids) {
    const card = store.rows.cards.get(id);
    if (!card) continue;
    const current = card.plannedFor ?? null;
    before.set(id, current);
    const next = nextPlan(current, day);
    if (next !== current) updateCard(id, { plannedFor: next });
  }
  return before;
}
function plan(ids, on) {
  if (!ids.length) return;
  const before = setPlanned(ids, on ? todayString(Date.now()) : null);
  const n = ids.length === 1 ? "1 card" : `${ids.length} cards`;
  toast(on ? `${n} planned for today` : `${n} taken off Today`, "Undo", () => {
    for (const [id, plannedFor] of before) updateCard(id, { plannedFor });
  });
}

// ---- toast (Tack Toast: bottom centre, 5 s, Undo) --------------------------------------------

const toasts = h("div", { class: "tk-toasts", role: "status", "aria-live": "polite" });
document.body.append(toasts);
function toast(text, action, onAction) {
  const el = h("div", { class: "tk-toast" }, h("span", {}, text));
  if (action) el.append(h("button", { type: "button", onclick: () => { onAction(); el.remove(); } }, action));
  toasts.replaceChildren(el);
  setTimeout(() => el.remove(), 5000);
}

// ---- ticking (Tack lib/completion.ts) --------------------------------------------------------

function toggle(card, willHide) {
  const completing = !card.completed;
  if (completing) ui.justTicked.add(card.id); else ui.justTicked.delete(card.id);
  setCompleted(card.id, completing);
  if (!completing || !willHide) return;
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    ui.lingering.add(card.id);
    setTimeout(() => { ui.lingering.delete(card.id); render(); }, 450);
  }
  toast("Card completed", "Undo", () => setCompleted(card.id, false));
}

// ---- rendering -------------------------------------------------------------------------------

let scheduled = false;
function render() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; draw(); });
}

function priorityIcon(p) {
  if (p === "none") return null;
  const label = `${PRIORITY_LABELS[p]} priority`;
  return h("span", { class: `tk-pri p-${p}`, role: "img", "aria-label": label, title: label }, icon(p));
}

function dateChip(card) {
  const text = formatChip(card.start, card.due);
  if (!text) return null;
  const state = dueState(card, ui.now);
  return h("span", { class: `tk-chip ${state}` },
    state === "overdue" ? icon("flag") : null, state === "dueSoon" ? icon("clock") : null,
    state === "completed" ? icon("check") : null, text,
    state === "overdue" ? h("span", { class: "tk-chip-word" }, "Overdue") : null);
}

function cardFace(card, showCompleted, unsent) {
  const meta = h("div", { class: "tk-meta" },
    isPlanned(card, ui.now) ? h("span", { class: "tk-planned", role: "img", "aria-label": "Planned for today" }, icon("sun")) : null,
    priorityIcon(card.priority), dateChip(card),
    card.description ? h("span", { class: "tk-desc", role: "img", "aria-label": "Has description" }, icon("text")) : null,
    unsent.has(card.id) ? h("span", { class: "tk-desc", role: "img", "aria-label": "Saved on this device", title: "Saved on this device" }, icon("cloudUp")) : null);
  if (ui.selecting) {
    const on = ui.selected.has(card.id);
    const pick = () => { if (on) ui.selected.delete(card.id); else ui.selected.add(card.id); render(); };
    return h("article", { class: `tk-card selecting${on ? " selected" : ""}`, "data-card": card.id },
      h("button", { type: "button", role: "checkbox", "aria-checked": String(on), "aria-label": `Select ${card.title}`, class: "tk-check", onclick: pick },
        h("span", { class: "tk-box sel" }, on ? icon("check") : null)),
      h("div", { class: "tk-content" },
        h("button", { type: "button", class: "tk-title", tabindex: "-1", onclick: pick }, h("span", { class: "tk-title-text", dir: "auto" }, card.title)),
        meta));
  }
  const classes = ["tk-card"];
  if (card.completed) classes.push("completed");
  if (card.completed && ui.justTicked.has(card.id)) classes.push("just-ticked");
  return h("article", { class: classes.join(" "), "data-card": card.id },
    h("button", {
      type: "button", role: "checkbox", "aria-checked": String(card.completed), "aria-label": `Complete ${card.title}`,
      class: "tk-check", onclick: () => toggle(card, !showCompleted),
    }, h("span", { class: "tk-box" }, card.completed ? icon("check") : null)),
    h("div", { class: "tk-content" },
      h("button", { type: "button", class: "tk-title", onclick: () => openPanel(card.id) }, h("span", { class: "tk-title-text", dir: "auto" }, card.title)),
      meta));
}

function listColumn(view, { list, cards }) {
  const showCompleted = view.board.showCompleted;
  const visible = cards.filter((c) => showCompleted || !c.completed || ui.lingering.has(c.id));
  const count = visible.filter((c) => !ui.lingering.has(c.id)).length;
  const unsent = store.unsent();
  const module = MODULES.find((m) => m.slug === list.module);

  let name;
  if (ui.editingList === list.id) {
    name = h("input", { class: "tk-name-input", "aria-label": "List name", value: list.name, enterkeyhint: "done" });
    const save = () => {
      const v = name.value.trim();
      ui.editingList = null;
      if (v && v !== list.name) store.update("lists", list.id, { name: v });
      render();
    };
    name.addEventListener("blur", save);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
      if (e.key === "Escape") { ui.editingList = null; render(); }
    });
    requestAnimationFrame(() => { name.focus(); name.select(); });
  } else {
    name = h("button", { type: "button", class: "tk-name", onclick: () => { ui.editingList = list.id; render(); } }, list.name);
  }

  const lists = view.lists.map((l) => l.list);
  const at = lists.findIndex((l) => l.id === list.id);
  const moveList = (dir) => {
    const others = lists.filter((l) => l.id !== list.id);
    store.update("lists", list.id, { position: positionAt(others, at + dir) });
    ui.menu = null;
  };
  const menu = ui.menu === list.id ? h("div", { class: "tk-menu", role: "menu" },
    h("button", { type: "button", role: "menuitem", disabled: at === 0, onclick: () => moveList(-1) }, icon("left"), "Move left"),
    h("button", { type: "button", role: "menuitem", disabled: at === lists.length - 1, onclick: () => moveList(1) }, icon("right"), "Move right"),
    module ? h("a", { role: "menuitem", href: `/${module.slug}/` }, icon("book"), `Open ${module.code}`) : null,
    h("button", {
      type: "button", role: "menuitem", class: "danger",
      onclick: () => {
        ui.menu = null;
        store.update("lists", list.id, { deletedAt: new Date().toISOString() });
        toast("List deleted", "Undo", () => store.update("lists", list.id, { deletedAt: null }));
      },
    }, icon("trash"), "Delete")) : null;

  const ul = h("ul", { class: "tk-cards", "data-list-cards": list.id },
    visible.map((c) => h("li", { "data-card-id": c.id, class: ui.lingering.has(c.id) ? "leaving" : "" }, cardFace(c, showCompleted, unsent))));

  let footer;
  if (ui.composing === list.id) {
    const field = h("textarea", { class: "tk-compose-field", "aria-label": "Card title", placeholder: "Card title", rows: "2", enterkeyhint: "done" });
    field.value = ui.draft;
    const add = () => {
      const t = field.value.replace(/\s+/g, " ").trim();
      if (t) createCard(view.board.id, list.id, t);
      ui.draft = "";
      field.value = "";
      field.focus();
      requestAnimationFrame(() => { const u = document.querySelector(`[data-list-cards="${list.id}"]`); if (u) u.scrollTop = u.scrollHeight; });
    };
    field.addEventListener("input", () => { ui.draft = field.value; });
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); add(); }
      if (e.key === "Escape") { ui.composing = null; ui.draft = ""; render(); }
    });
    footer = h("form", { class: "tk-composer", onsubmit: (e) => { e.preventDefault(); add(); } },
      field,
      h("div", { class: "tk-compose-actions" },
        h("button", { type: "submit", class: "btn sm" }, "Add"),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => { ui.composing = null; ui.draft = ""; render(); } }, icon("x"))));
    requestAnimationFrame(() => { if (document.activeElement !== field) field.focus(); });
  } else {
    footer = h("button", { type: "button", class: "tk-add", onclick: () => { ui.composing = list.id; ui.draft = ""; render(); } }, icon("plus"), "Add card");
  }

  return h("section", { class: "tk-column", "aria-label": list.name, "data-list": list.id },
    h("header", { class: "tk-col-head" }, name,
      h("span", { class: "tk-count" }, String(count)),
      h("button", { type: "button", class: "icon-btn tk-menu-btn", "aria-label": `Menu for ${list.name}`, "aria-expanded": String(ui.menu === list.id),
        onclick: (e) => { e.stopPropagation(); ui.menu = ui.menu === list.id ? null : list.id; render(); } }, icon("more")),
      menu),
    ul, footer);
}

function addList(boardId) {
  const input = h("input", { class: "tk-input", "aria-label": "List name", placeholder: "Add list", enterkeyhint: "done" });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) { createList(boardId, input.value.trim()); input.value = ""; }
    if (e.key === "Escape") input.blur();
  });
  return h("div", { class: "tk-add-list", "data-list-slot": "" }, input);
}

function syncPill() {
  const s = store.meta.status;
  if (s === "offline") return h("span", { class: "tk-pill" }, icon("cloudOff"), "Offline · changes will sync");
  if (s === "expired") return h("a", { class: "tk-pill", href: location.href }, icon("cloudOff"), "Sign in again to sync");
  if (s === "outdated") return h("button", { type: "button", class: "tk-pill", onclick: () => location.reload() }, "Update the page to sync");
  return null;
}

let lastPanelKey = "";
const boardHost = h("div", { class: "tk-board" });
const panelHost = h("div", { class: "tk-panel-host" });
root.replaceChildren(boardHost, panelHost);
// While a list name or the add-list field is being typed in, the board waits, then catches up.
let held = false;
root.addEventListener("focusout", () => { if (held) { held = false; render(); } });

function draw() {
  const view = boardView();
  const active = document.activeElement;
  const typing = active && boardHost.contains(active) &&
    (active.matches(".tk-add-list input") || (active.matches(".tk-name-input") && ui.editingList !== null));
  if (typing) { held = true; drawPanel(view); return; }
  const scroller = boardHost.querySelector(".tk-lists");
  const keep = {
    left: scroller ? scroller.scrollLeft : 0,
    cols: new Map([...boardHost.querySelectorAll("[data-list-cards]")].map((u) => [u.dataset.listCards, u.scrollTop])),
  };

  if (!view) {
    boardHost.replaceChildren(h("div", { class: "tk-empty" },
      store.firstSync || store.meta.status !== "connecting"
        ? [h("p", {}, store.meta.status === "online" ? "No task board yet." : "No task board on this device yet."),
          store.meta.status === "online" ? h("button", { type: "button", class: "btn", onclick: createBoard }, "Create the board, one list per module") : null]
        : h("p", {}, "Loading…")));
    panelHost.replaceChildren();
    return;
  }

  const anySelectedPlanned = [...ui.selected].some((id) => (store.rows.cards.get(id) || {}).plannedFor);
  const head = h("header", { class: "tk-head" },
    h("h1", {}, view.board.emoji ? `${view.board.emoji} ${view.board.name}` : view.board.name),
    syncPill(),
    h("div", { class: "tk-actions" },
      h("button", { type: "button", class: "tk-toggle", "aria-pressed": String(ui.selecting), title: "Select cards",
        onclick: () => { ui.selecting = !ui.selecting; ui.selected.clear(); render(); } }, icon("select"), h("span", { class: "tk-toggle-label" }, "Select")),
      h("button", { type: "button", class: "tk-toggle", "aria-pressed": String(view.board.showCompleted), title: "Show completed",
        onclick: () => store.update("boards", view.board.id, { showCompleted: !view.board.showCompleted }) },
        icon(view.board.showCompleted ? "eye" : "eyeOff"), h("span", { class: "tk-toggle-label" }, "Show completed"))));

  const strip = h("nav", { class: "tk-strip", "aria-label": "Lists" },
    view.lists.map(({ list }, i) => h("button", { type: "button", "data-strip": list.id,
      onclick: () => { const c = boardHost.querySelectorAll(".tk-column")[i]; if (c) c.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); } }, list.name)));

  const lists = h("div", { class: "tk-lists" }, view.lists.map((l) => listColumn(view, l)), addList(view.board.id));

  const parts = [head, strip, lists];
  if (ui.selecting) {
    parts.push(h("div", { class: "tk-selbar" },
      h("span", {}, ui.selected.size === 1 ? "1 selected" : `${ui.selected.size} selected`),
      h("button", { type: "button", class: "pbtn", onclick: () => { ui.selecting = false; ui.selected.clear(); render(); } }, "Cancel"),
      anySelectedPlanned ? h("button", { type: "button", class: "pbtn", onclick: () => { plan([...ui.selected], false); ui.selecting = false; ui.selected.clear(); render(); } }, "Remove from today") : null,
      h("button", { type: "button", class: "btn sm", disabled: ui.selected.size === 0, onclick: () => { plan([...ui.selected], true); ui.selecting = false; ui.selected.clear(); render(); } }, icon("sun"), "Plan for today")));
  }
  boardHost.replaceChildren(...parts);
  drawPanel(view);

  lists.scrollLeft = keep.left;
  for (const u of boardHost.querySelectorAll("[data-list-cards]")) u.scrollTop = keep.cols.get(u.dataset.listCards) || 0;
  markStrip();
  lists.addEventListener("scroll", markStrip, { passive: true });
}

/** The panel is rebuilt only when what it shows changed, and never while it's being typed in. */
function drawPanel(view) {
  root.classList.toggle("with-panel", !!ui.panel);
  if (!ui.panel || !view) { panelHost.replaceChildren(); lastPanelKey = ""; return; }
  const card = store.rows.cards.get(ui.panel);
  const key = JSON.stringify([ui.panel, card, ui.picking, ui.pickMonth, ui.pickTime, ui.now, view.board.name, view.board.showCompleted,
    view.lists.map((l) => [l.list.id, l.list.name, l.cards.map((c) => c.id + c.position + c.completed)])]);
  const active = document.activeElement;
  const typing = active && panelHost.contains(active) && active.matches("textarea, input:not([type=checkbox])");
  if (key === lastPanelKey || typing) return;
  lastPanelKey = key;
  const scrollTop = (panelHost.querySelector(".tk-panel-body") || {}).scrollTop || 0;
  panelHost.replaceChildren(cardPanel(card, view));
  const body = panelHost.querySelector(".tk-panel-body");
  if (body) body.scrollTop = scrollTop;
}

/** Which list a phone is showing, underlined in the strip. */
function markStrip() {
  const el = boardHost.querySelector(".tk-lists");
  if (!el) return;
  const center = el.scrollLeft + el.clientWidth / 2;
  let best = null, dist = Infinity;
  for (const c of el.querySelectorAll(".tk-column")) {
    const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - center);
    if (d < dist) { dist = d; best = c.dataset.list; }
  }
  for (const b of root.querySelectorAll("[data-strip]")) b.classList.toggle("on", b.dataset.strip === best);
}

// ---- card panel (Tack panel/CardPanel.tsx) ---------------------------------------------------

function openPanel(id) {
  ui.panel = id;
  ui.picking = null;
  const url = new URL(location.href);
  url.searchParams.set("card", id);
  history.pushState({ card: id }, "", url);
  render();
  requestAnimationFrame(() => { const p = root.querySelector(".tk-panel"); if (p) p.focus({ preventScroll: true }); });
}
function closePanel(push = true) {
  const id = ui.panel;
  ui.panel = null;
  ui.picking = null;
  if (push) {
    const url = new URL(location.href);
    url.searchParams.delete("card");
    history.pushState({}, "", url);
  }
  render();
  requestAnimationFrame(() => { const b = root.querySelector(`[data-card="${CSS.escape(id || "")}"] .tk-title`); if (b) b.focus({ preventScroll: true }); });
}
addEventListener("popstate", () => { ui.panel = new URLSearchParams(location.search).get("card"); ui.picking = null; render(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (ui.picking) { ui.picking = null; render(); return; }
  if (ui.menu) { ui.menu = null; render(); return; }
  if (ui.panel) closePanel();
});
document.addEventListener("click", (e) => { if (ui.menu && !e.target.closest(".tk-menu")) { ui.menu = null; render(); } });

function cardPanel(card, view) {
  const close = h("button", { type: "button", class: "icon-btn", "aria-label": "Close card", onclick: () => closePanel() }, icon("x"));
  const bar = h("div", { class: "tk-panel-bar" }, h("span", { class: "tk-grabber", "aria-hidden": "true" }), close);
  // Swipe down closes it on phones.
  let startY = null;
  bar.addEventListener("touchstart", (e) => { startY = e.touches[0].clientY; }, { passive: true });
  bar.addEventListener("touchmove", (e) => { const dy = Math.max(0, e.touches[0].clientY - startY); bar.parentElement.style.transform = `translateY(${dy}px)`; }, { passive: true });
  bar.addEventListener("touchend", (e) => {
    const dy = e.changedTouches[0].clientY - startY;
    bar.parentElement.style.transform = "";
    if (dy > 100) closePanel();
  });
  if (!card || card.deletedAt) {
    return h("div", { class: "tk-panel-wrap" }, h("aside", { class: "tk-panel", "aria-label": "Card", tabindex: "-1" }, bar,
      h("p", { class: "tk-missing" }, store.firstSync ? "This card doesn't exist or was deleted." : "Loading…")));
  }

  const lists = view.lists.map((l) => l.list);
  const siblings = liveCards(card.listId);
  const visible = siblings.filter((c) => c.id === card.id || view.board.showCompleted || !c.completed);
  const at = visible.findIndex((c) => c.id === card.id);
  const others = siblings.filter((c) => c.id !== card.id);
  const move = (dir) => {
    const ids = visible.map((c) => c.id);
    ids.splice(at, 1);
    ids.splice(at + dir, 0, card.id);
    updateCard(card.id, { position: dropPosition(others, ids, card.id) });
  };

  const title = h("textarea", { class: "tk-panel-title", "aria-label": "Card title", rows: "1", enterkeyhint: "done", dir: "auto" });
  title.value = card.title;
  const grow = () => { title.style.height = "auto"; title.style.height = `${title.scrollHeight}px`; };
  requestAnimationFrame(grow);
  title.addEventListener("input", () => {
    const text = title.value.replace(/\s*\n\s*/g, " ");
    if (text !== title.value) title.value = text;
    grow();
    if (text.trim()) updateCard(card.id, { title: text.trim() });
  });
  title.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } });
  title.addEventListener("blur", () => { if (!title.value.trim()) title.value = card.title; render(); });

  const listSelect = h("select", { class: "tk-select", "aria-label": "List" }, lists.map((l) => h("option", { value: l.id, selected: l.id === card.listId }, l.name)));
  listSelect.addEventListener("change", () => updateCard(card.id, { listId: listSelect.value, position: positionAtEnd(liveCards(listSelect.value)) }));

  const priority = h("div", { class: "tk-seg", role: "radiogroup", "aria-label": "Priority" },
    PRIORITIES.map((p) => h("button", { type: "button", role: "radio", "aria-checked": String(card.priority === p), onclick: () => updateCard(card.id, { priority: p }) },
      p === "none" ? null : icon(p), PRIORITY_LABELS[p] === "No priority" ? "None" : PRIORITY_LABELS[p])));

  const dateButton = (label, value, isDue, which) => {
    const state = isDue ? dueState(card, ui.now) : "none";
    return h("button", { type: "button", class: `tk-date ${state}`, onclick: () => { ui.picking = which; ui.pickMonth = monthStart((value || {}).date || todayString(ui.now)); ui.pickTime = { on: !!(value && value.time), text: (value && value.time) || (which === "due" ? DEFAULT_DUE_TIME : DEFAULT_START_TIME) }; render(); } },
      h("span", { class: "tk-date-label" }, label),
      h("span", { class: "tk-date-value" }, state === "overdue" ? icon("flag") : null, state === "dueSoon" ? icon("clock") : null, state === "completed" ? icon("check") : null,
        value ? formatDateValue(value) : "Not set"));
  };
  const planned = isPlanned(card, ui.now);

  const desc = h("textarea", { class: "tk-desc-field", "aria-label": "Description (Markdown)", placeholder: "Add a description (Markdown)", rows: "6", dir: "auto" });
  desc.value = card.description;
  let descTimer = null;
  desc.addEventListener("input", () => { clearTimeout(descTimer); descTimer = setTimeout(() => updateCard(card.id, { description: desc.value }), 400); });
  desc.addEventListener("blur", () => { clearTimeout(descTimer); if (desc.value !== card.description) updateCard(card.id, { description: desc.value }); render(); });

  const aside = h("aside", { class: "tk-panel", "aria-label": "Card", tabindex: "-1" }, bar,
    h("div", { class: "tk-panel-body" },
      h("div", { class: "tk-panel-head" },
        h("button", { type: "button", role: "checkbox", "aria-checked": String(card.completed), "aria-label": `Complete ${card.title}`, class: "tk-check",
          onclick: () => setCompleted(card.id, !card.completed) }, h("span", { class: "tk-box" }, card.completed ? icon("check") : null)),
        title),
      h("div", { class: "tk-crumb" }, h("span", {}, view.board.emoji ? `${view.board.emoji} ${view.board.name}` : view.board.name), h("span", { "aria-hidden": "true" }, "/"), listSelect),
      h("section", { class: "tk-section" }, h("h3", {}, "Priority"), priority),
      h("section", { class: "tk-section" }, h("h3", {}, "Dates"),
        h("div", { class: "tk-dates" }, dateButton("Start", card.start, false, "start"), dateButton("Due", card.due, true, "due")),
        h("button", { type: "button", class: "pbtn tk-plan", "aria-pressed": String(planned), onclick: () => plan([card.id], !planned) }, icon("sun"), planned ? "Remove from today" : "Plan for today")),
      h("section", { class: "tk-section" }, h("h3", {}, "Description"), desc),
      h("footer", { class: "tk-panel-foot" },
        h("div", { class: "tk-times" }, h("span", {}, `Created ${formatTimestamp(card.createdAt)}`), h("span", {}, `Updated ${formatTimestamp(card.updatedAt)}`)),
        h("div", { class: "tk-foot-actions" },
          h("button", { type: "button", class: "pbtn", disabled: at <= 0, onclick: () => move(-1) }, icon("up"), "Move up"),
          h("button", { type: "button", class: "pbtn", disabled: at < 0 || at >= visible.length - 1, onclick: () => move(1) }, icon("down"), "Move down"),
          h("button", { type: "button", class: "pbtn danger", onclick: () => {
            store.update("cards", card.id, { deletedAt: new Date().toISOString() });
            closePanel();
            toast("Card deleted", "Undo", () => store.update("cards", card.id, { deletedAt: null }));
          } }, icon("trash"), "Delete")))),
    ui.picking ? datePicker(card) : null);
  return h("div", { class: "tk-panel-wrap" }, aside);
}

// ---- date picker (Tack panel/DatePicker.tsx) -------------------------------------------------

function datePicker(card) {
  const which = ui.picking;
  const value = card[which];
  const isValid = (cand) => (which === "start" ? !startAfterDue(cand, card.due) : !startAfterDue(card.start, cand));
  const save = (v) => updateCard(card.id, { [which]: v });
  const today = todayString(ui.now);
  const t = ui.pickTime;
  const time = parseTime(t.text);
  const timeForSave = t.on ? time : null;
  const dayAllowed = (date) => isValid({ date, time: timeForSave });
  const conflict = !!value && t.on && !!time && !isValid({ date: value.date, time });
  const pick = (date) => {
    if (t.on && !time) return;
    save({ date, time: timeForSave });
    ui.picking = null;
    render();
  };
  const month = ui.pickMonth;
  const timeInput = h("input", { class: "tk-input tk-time", inputmode: "numeric", placeholder: "HH:MM", enterkeyhint: "done", value: t.text, "aria-invalid": String(!time || conflict), "aria-label": "Time (24-hour)" });
  timeInput.addEventListener("input", () => {
    ui.pickTime = { on: true, text: timeInput.value };
    const parsed = parseTime(timeInput.value);
    if (value && parsed && isValid({ date: value.date, time: parsed })) save({ date: value.date, time: parsed });
  });
  timeInput.addEventListener("blur", render);
  timeInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && value && time && !conflict) { ui.picking = null; render(); } });
  const toggleTime = h("input", { type: "checkbox", checked: t.on });
  toggleTime.addEventListener("change", () => {
    ui.pickTime = { on: toggleTime.checked, text: t.text };
    if (value) {
      const cand = { date: value.date, time: toggleTime.checked ? time : null };
      if ((!toggleTime.checked || time) && isValid(cand)) save(cand);
    }
    render();
  });
  const presets = [["today", "Today"], ["tomorrow", "Tomorrow"], ["nextWeek", "Next week"]];
  return h("div", { class: "tk-sheet-backdrop", onclick: (e) => { if (e.target === e.currentTarget) { ui.picking = null; render(); } } },
    h("div", { class: "tk-sheet", role: "dialog", "aria-label": which === "due" ? "Due date" : "Start date" },
      h("h2", {}, which === "due" ? "Due date" : "Start date"),
      h("div", { class: "tk-presets" }, presets.map(([k, label]) => {
        const d = presetDate(k, ui.now);
        return h("button", { type: "button", class: "pbtn", disabled: !dayAllowed(d), onclick: () => pick(d) }, label);
      })),
      h("div", { class: "tk-month-bar" },
        h("button", { type: "button", class: "icon-btn", "aria-label": "Previous month", onclick: () => { ui.pickMonth = monthStart(month, -1); render(); } }, icon("chevL")),
        h("span", { "aria-live": "polite" }, formatMonth(month)),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Next month", onclick: () => { ui.pickMonth = monthStart(month, 1); render(); } }, icon("chevR"))),
      h("div", { class: "tk-grid", role: "group", "aria-label": formatMonth(month) },
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => h("span", { class: "tk-wd", "aria-hidden": "true" }, d)),
        monthWeeks(month).flat().map((date) => h("button", {
          type: "button", "aria-label": `${Number(date.slice(8))}, ${formatDate(date)}`, "aria-pressed": String(value && value.date === date),
          class: ["tk-day", date.slice(0, 7) !== month.slice(0, 7) ? "outside" : "", date === today ? "today" : "", value && value.date === date ? "selected" : ""].join(" "),
          disabled: !dayAllowed(date), onclick: () => pick(date),
        }, String(Number(date.slice(8)))))),
      h("label", { class: "tk-time-toggle" }, toggleTime, "Add time"),
      t.on ? h("div", { class: "tk-time-field" }, timeInput,
        !time ? h("span", { class: "tk-problem" }, "Enter a time like 18:30.") : null,
        conflict ? h("span", { class: "tk-problem" }, "Start can't be after due.") : null) : null,
      value ? h("button", { type: "button", class: "pbtn danger", onclick: () => { save(null); ui.picking = null; render(); } }, icon("x"), "Clear date") : null));
}

// ---- drag and drop (Tack lib/boardDrag.ts, simplified to cards) ------------------------------
// Mouse: drag after a few pixels. Touch: long-press (~250 ms) lifts the card; near the screen
// edge it pages to the next list; dropping on a name in the list strip puts it at that list's end.

let drag = null;
let swallowClick = false;

root.addEventListener("pointerdown", (e) => {
  const cardEl = e.target.closest(".tk-card");
  if (!cardEl || ui.selecting || e.button !== 0 || e.target.closest(".tk-check") || cardEl.closest(".tk-panel")) return;
  const id = cardEl.dataset.card;
  const start = { x: e.clientX, y: e.clientY };
  const pending = { id, cardEl, start, pointerId: e.pointerId, touch: e.pointerType !== "mouse", timer: null };
  if (pending.touch) pending.timer = setTimeout(() => lift(pending, start.x, start.y), 250);
  const onMove = (ev) => {
    if (drag) return;
    const moved = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
    if (pending.touch) { if (moved > 8) cancel(); }
    else if (moved > 6) lift(pending, ev.clientX, ev.clientY);
  };
  const cancel = () => {
    clearTimeout(pending.timer);
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", cancel);
    removeEventListener("pointercancel", cancel);
  };
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", cancel);
  addEventListener("pointercancel", cancel);
});

function lift(pending, x, y) {
  clearTimeout(pending.timer);
  const rect = pending.cardEl.getBoundingClientRect();
  const ghost = pending.cardEl.cloneNode(true);
  ghost.classList.add("tk-ghost");
  ghost.style.width = `${rect.width}px`;
  document.body.append(ghost);
  const slot = pending.cardEl.closest("li");
  slot.classList.add("tk-placeholder");
  drag = { id: pending.id, ghost, slot, dx: x - rect.left, dy: y - rect.top, lastPage: 0, stripTarget: null };
  if (navigator.vibrate) navigator.vibrate(10);
  moveGhost(x, y);
  addEventListener("pointermove", onDragMove);
  addEventListener("pointerup", onDrop, { once: true });
  addEventListener("pointercancel", onCancel, { once: true });
  addEventListener("touchmove", stopScroll, { passive: false });
}
const stopScroll = (e) => { if (drag) e.preventDefault(); };

function moveGhost(x, y) {
  drag.ghost.style.transform = `translate(${x - drag.dx}px, ${y - drag.dy}px) rotate(2deg) scale(1.03)`;
}

function onDragMove(e) {
  if (!drag) return;
  moveGhost(e.clientX, e.clientY);
  const under = document.elementsFromPoint(e.clientX, e.clientY).filter((el) => !drag.ghost.contains(el));
  const strip = under.map((el) => el.closest && el.closest("[data-strip]")).find(Boolean);
  for (const b of root.querySelectorAll("[data-strip]")) b.classList.toggle("drop", b === strip);
  drag.stripTarget = strip ? strip.dataset.strip : null;
  const column = under.map((el) => el.closest && el.closest(".tk-column")).find(Boolean);
  if (column && !strip) {
    const ul = column.querySelector(".tk-cards");
    const items = [...ul.children].filter((li) => li !== drag.slot);
    const before = items.find((li) => { const r = li.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (before) ul.insertBefore(drag.slot, before); else ul.append(drag.slot);
  }
  // Phones page a whole list at a time from the screen edge.
  const scroller = root.querySelector(".tk-lists");
  if (matchMedia("(max-width:700px)").matches && Date.now() - drag.lastPage > 700) {
    const edge = 28;
    const dir = e.clientX < edge ? -1 : e.clientX > innerWidth - edge ? 1 : 0;
    if (dir) {
      drag.lastPage = Date.now();
      scroller.scrollBy({ left: dir * scroller.clientWidth * 0.88, behavior: "smooth" });
    }
  }
}

function endDrag() {
  removeEventListener("pointermove", onDragMove);
  removeEventListener("touchmove", stopScroll);
  for (const b of root.querySelectorAll("[data-strip].drop")) b.classList.remove("drop");
  drag.ghost.remove();
  drag.slot.classList.remove("tk-placeholder");
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 0);
}
function onCancel() { if (!drag) return; endDrag(); drag = null; render(); }

function onDrop() {
  if (!drag) return;
  const { id, slot, stripTarget } = drag;
  endDrag();
  drag = null;
  const card = store.rows.cards.get(id);
  if (!card) return render();
  if (stripTarget) {
    if (stripTarget !== card.listId) {
      updateCard(id, { listId: stripTarget, position: positionAtEnd(allCards(stripTarget).filter((c) => c.id !== id)) });
      toast(`Moved to ${(store.rows.lists.get(stripTarget) || {}).name || "list"}`);
    }
    return render();
  }
  const ul = slot.closest("[data-list-cards]");
  if (!ul) return render();
  const listId = ul.dataset.listCards;
  const order = [...ul.querySelectorAll("[data-card-id]")].map((li) => li.dataset.cardId);
  const siblings = allCards(listId).filter((c) => c.id !== id);
  const ids = order.filter((x) => x !== id);
  const at = order.indexOf(id);
  const visibleOrder = [...ids.slice(0, at), id, ...ids.slice(at)];
  const oldOrder = allCards(card.listId).map((c) => c.id);
  const unchanged = listId === card.listId && JSON.stringify(visibleOrder) === JSON.stringify(oldOrder.filter((x) => order.includes(x)));
  if (!unchanged) {
    updateCard(id, { listId, position: dropPosition(siblings, visibleOrder, id) });
    if (listId !== card.listId) toast(`Moved to ${(store.rows.lists.get(listId) || {}).name || "list"}`);
  }
  render();
}
root.addEventListener("click", (e) => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); } }, true);

// ---- start -----------------------------------------------------------------------------------

store.subscribe(render);
store.open().then(() => {
  render();
  store.start();
  document.documentElement.setAttribute("data-hub-ready", "");
});
