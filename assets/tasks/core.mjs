/* Cahier Tasks: the rules, ported from Tack (lou-bou/tack shared/src: dates.ts, selection.ts,
 * hlc.ts, merge.ts, positions.ts, ids.ts) so the board behaves exactly as it did there.
 * Plain JS, no build step. tasks.py holds the same rules for the server. */
import { generateKeyBetween } from "./fractional-indexing.mjs";

export const TIME_ZONE = "Africa/Algiers";
export const PROTOCOL_VERSION = 1;
export const PRIORITIES = ["none", "low", "medium", "high", "urgent"];
export const PRIORITY_LABELS = { none: "No priority", low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };
export const DEFAULT_DUE_TIME = "23:59";
export const DEFAULT_START_TIME = "09:00";
const DAY_MS = 86400000;

const pad = (n, w = 2) => String(n).padStart(w, "0");
function parts(date) {
  const [y, m, d] = date.split("-").map(Number);
  return [y || 0, m || 1, d || 1];
}

// ---- dates (wall-clock time in Algiers, whatever the device's zone) --------------------------

let wallFormat = null;
/** The wall-clock date and time of an instant in TIME_ZONE. */
export function wallClock(ms) {
  wallFormat = wallFormat || new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = {};
  for (const part of wallFormat.formatToParts(ms)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function offsetAt(ms) {
  const w = wallClock(ms);
  const [y, m, d] = parts(w.date);
  const [hh, mm] = w.time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - (ms - (((ms % 60000) + 60000) % 60000));
}

/** Epoch ms of a wall-clock moment in TIME_ZONE. */
export function zonedMs(date, time) {
  const [y, m, d] = parts(date);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh || 0, mm || 0);
  return guess - offsetAt(guess - offsetAt(guess));
}

export function addDays(date, days) {
  const [y, m, d] = parts(date);
  const s = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(s.getUTCFullYear(), 4)}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`;
}

export function daysBetween(from, to) {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}

export function dayOfWeek(date) {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const todayString = (now) => wallClock(now).date;

export function dueMoment(v) {
  return v.time ? zonedMs(v.date, v.time) : zonedMs(addDays(v.date, 1), "00:00") - 1;
}

export const isOverdue = (due, now) => now > dueMoment(due);

/** A timed card is due soon in its last 24 hours, a date-only card on its due day. */
export function isDueSoon(due, now) {
  if (isOverdue(due, now)) return false;
  if (!due.time) return due.date === todayString(now);
  return dueMoment(due) - now <= DAY_MS;
}

export function dueState(card, now) {
  if (card.completed) return "completed";
  if (!card.due) return "none";
  if (isOverdue(card.due, now)) return "overdue";
  if (isDueSoon(card.due, now)) return "dueSoon";
  return "neutral";
}

export function formatDate(date) {
  const [y, m, d] = parts(date);
  return `${pad(d)}/${pad(m)}/${pad(y, 4)}`;
}
export const formatDateValue = (v) => (v.time ? `${formatDate(v.date)} ${v.time}` : formatDate(v.date));
export function formatChip(start, due) {
  if (start && due) return `${formatDateValue(start)} → ${formatDateValue(due)}`;
  const only = due || start;
  return only ? formatDateValue(only) : "";
}
export function formatTimestamp(iso) {
  const w = wallClock(new Date(iso).getTime());
  return `${formatDate(w.date)} ${w.time}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
export function formatMonth(date) {
  const [y, m] = parts(date);
  return `${MONTHS[m - 1]} ${y}`;
}
export function monthStart(date, offset = 0) {
  const [y, m] = parts(date);
  const s = new Date(Date.UTC(y, m - 1 + offset, 1));
  return `${pad(s.getUTCFullYear(), 4)}-${pad(s.getUTCMonth() + 1)}-01`;
}
export function monthWeeks(date) {
  const first = monthStart(date);
  const next = monthStart(date, 1);
  const weeks = [];
  let day = addDays(first, -dayOfWeek(first));
  while (day < next) {
    const start = day;
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
    day = addDays(day, 7);
  }
  return weeks;
}

/** "9:05", "09:05" or "0905". */
export function parseTime(text) {
  const m = /^([01]?\d|2[0-3]):?([0-5]\d)$/.exec(text.trim());
  return m ? `${pad(Number(m[1]))}:${m[2]}` : null;
}

/** "Next week" is the next Sunday; on a Sunday that is 7 days on. */
export function presetDate(preset, now) {
  const today = todayString(now);
  if (preset === "today") return today;
  if (preset === "tomorrow") return addDays(today, 1);
  return addDays(today, 7 - dayOfWeek(today));
}

export function startAfterDue(start, due) {
  if (!start || !due) return false;
  if (start.date !== due.date) return start.date > due.date;
  return !!start.time && !!due.time && start.time > due.time;
}

// ---- Today rules (Tack selection.ts): the board shows the sun icon, Nook shows Today ---------

export function isPlanned(card, now) {
  return !card.completed && !!card.plannedFor && card.plannedFor <= todayString(now);
}

/** Tack's setPlanned: a card already planned for an earlier day keeps that day. */
export function nextPlan(current, day) {
  return day !== null && current !== null && current !== undefined && current <= day ? current : day;
}

// ---- hybrid logical clock (Tack hlc.ts) ------------------------------------------------------

export const HLC_ZERO = "0000000000000:0000:";
export const formatHlc = (ms, counter, node) => `${pad(ms, 13)}:${pad(counter, 4)}:${node}`;
export const hlcMs = (h) => Number(h.slice(0, 13));
export const hlcCounter = (h) => Number(h.slice(14, 18));

export class HlcClock {
  constructor(node, wall = Date.now) {
    this.node = node;
    this.wall = wall;
    this.ms = 0;
    this.counter = 0;
    this.offset = 0;
  }
  now() {
    const wall = this.wall() + this.offset;
    if (wall > this.ms) { this.ms = wall; this.counter = 0; } else this.counter += 1;
    return formatHlc(this.ms, this.counter, this.node);
  }
  observe(h) {
    const ms = hlcMs(h), counter = hlcCounter(h);
    if (ms > this.ms || (ms === this.ms && counter > this.counter)) { this.ms = ms; this.counter = counter; }
  }
  /** Corrects for a wrong device clock, using the server's time from its latest response. */
  syncWall(serverMs) { this.offset = serverMs - this.wall(); }
}

// ---- positions (Tack positions.ts) -----------------------------------------------------------

export function positionBetween(before, after, random = Math.random) {
  let lo = before, hi = after;
  let key = generateKeyBetween(lo, hi);
  for (let i = 0; i < 4; i += 1) {
    if (random() < 0.5) { lo = key; key = generateKeyBetween(key, hi); }
    else { hi = key; key = generateKeyBetween(lo, key); }
  }
  return key;
}

export function byPosition(a, b) {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function positionAt(sorted, index) {
  const before = sorted[index - 1] ? sorted[index - 1].position : null;
  let next = index;
  while (before !== null && sorted[next] !== undefined && sorted[next].position <= before) next += 1;
  return positionBetween(before, sorted[next] ? sorted[next].position : null);
}

export const positionAtEnd = (sorted) => positionAt(sorted, sorted.length);

/** Where an item dropped among only the visible ones goes, so hidden ones keep their place. */
export function dropPosition(siblings, visibleOrder, movedId) {
  const at = visibleOrder.indexOf(movedId);
  const indexOf = (id) => siblings.findIndex((s) => s.id === id);
  const next = indexOf(visibleOrder[at + 1]);
  if (next >= 0) return positionAt(siblings, next);
  const previous = indexOf(visibleOrder[at - 1]);
  if (previous >= 0) return positionAt(siblings, previous + 1);
  return positionAtEnd(siblings);
}

// ---- ids (Tack ids.ts: UUIDv7, time-ordered, made offline) -----------------------------------

export function newId(now = Date.now()) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
