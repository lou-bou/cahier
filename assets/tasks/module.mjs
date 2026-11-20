/* Cahier Tasks on a course page: the cards of the board list linked to this module (its `module`
 * field), in board order, ticked the same way as on the board. It reads the same device copy as
 * /tasks/ (store.mjs), so it works offline and syncs like the board. A <details> hides it; the choice
 * is remembered per course. */
import { byPosition, isPlanned } from "./core.mjs";
import { TaskStore } from "./store.mjs";
import { dateChip, h, icon, priorityIcon, toast } from "./ui.mjs";

const host = document.getElementById("module-tasks");
const slug = host.dataset.module;
const code = host.dataset.code || slug.toUpperCase();
const KEY = `cahier-module-tasks:${slug}`;
const store = new TaskStore();
const lingering = new Set();
const justTicked = new Set();
let now = Date.now();
setInterval(() => { now = Date.now(); render(); }, 60000);

const details = host.querySelector("details");
const body = host.querySelector(".mt-body");
const count = host.querySelector(".mt-count");
try { if (localStorage.getItem(KEY) === "closed") details.open = false; } catch (e) {}
details.addEventListener("toggle", () => {
  try { localStorage.setItem(KEY, details.open ? "open" : "closed"); } catch (e) {}
});

/** The board's lists for this module and their live cards, in board order. */
function view() {
  const board = [...store.rows.boards.values()].filter((b) => !b.deletedAt).sort(byPosition)[0];
  if (!board) return null;
  const lists = [...store.rows.lists.values()]
    .filter((l) => l.boardId === board.id && !l.deletedAt && l.module === slug).sort(byPosition);
  if (!lists.length) return { board, lists, cards: [] };
  const ids = new Set(lists.map((l) => l.id));
  const order = new Map(lists.map((l, i) => [l.id, i]));
  const cards = [...store.rows.cards.values()]
    .filter((c) => ids.has(c.listId) && !c.deletedAt && (board.showCompleted || !c.completed || lingering.has(c.id)))
    .sort((a, b) => order.get(a.listId) - order.get(b.listId) || byPosition(a, b));
  return { board, lists, cards };
}

function toggle(card, willHide) {
  const completing = !card.completed;
  if (completing) justTicked.add(card.id); else justTicked.delete(card.id);
  store.update("cards", card.id, { completed: completing, completedAt: completing ? new Date().toISOString() : null });
  if (!completing || !willHide) return;
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    lingering.add(card.id);
    setTimeout(() => { lingering.delete(card.id); render(); }, 450);
  }
  toast("Task completed", "Undo", () => store.update("cards", card.id, { completed: false, completedAt: null }));
}

function row(card, showCompleted, unsent) {
  const classes = ["tk-card"];
  if (card.completed) classes.push("completed");
  if (card.completed && justTicked.has(card.id)) classes.push("just-ticked");
  return h("li", { class: lingering.has(card.id) ? "leaving" : "" },
    h("article", { class: classes.join(" ") },
      h("button", { type: "button", role: "checkbox", "aria-checked": String(card.completed), "aria-label": `Complete ${card.title}`,
        class: "tk-check", onclick: () => toggle(card, !showCompleted) },
      h("span", { class: "tk-box" }, card.completed ? icon("check") : null)),
      h("div", { class: "tk-content" },
        h("a", { class: "tk-title", href: `/tasks/?card=${encodeURIComponent(card.id)}` }, h("span", { class: "tk-title-text", dir: "auto" }, card.title)),
        h("div", { class: "tk-meta" },
          isPlanned(card, now) ? h("span", { class: "tk-planned", role: "img", "aria-label": "Planned for today" }, icon("sun")) : null,
          priorityIcon(card.priority), dateChip(card, now),
          card.description ? h("span", { class: "tk-desc", role: "img", "aria-label": "Has description" }, icon("text")) : null,
          unsent.has(card.id) ? h("span", { class: "tk-desc", role: "img", "aria-label": "Saved on this device", title: "Saved on this device" }, icon("cloudUp")) : null))));
}

let scheduled = false;
function render() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; draw(); });
}

function draw() {
  const v = view();
  if (!v) {
    // Nothing on this device yet: say so only once a sync has had its chance.
    host.hidden = store.firstSync || store.meta.status !== "connecting";
    body.replaceChildren(h("p", { class: "none" }, "Loading tasks…"));
    return;
  }
  if (!v.lists.length) { host.hidden = true; return; }
  host.hidden = false;
  const open = v.cards.filter((c) => !c.completed && !lingering.has(c.id)).length;
  count.textContent = open === 1 ? "1 open" : `${open} open`;
  const unsent = store.unsent();
  body.replaceChildren(
    v.cards.length
      ? h("ul", { class: "mt-list" }, v.cards.map((c) => row(c, v.board.showCompleted, unsent)))
      : h("p", { class: "none" }, `No open tasks for ${code}.`),
    h("a", { class: "mt-board", href: "/tasks/" }, "Open the Tasks board"));
}

store.subscribe(render);
store.open().then(() => { render(); store.start(); });
