"""Tasks: the board that moved here from Tack. Python 3 stdlib only.

The data model, the sync protocol and every date rule are ports of Tack's (lou-bou/tack:
shared/src/schema.ts, merge.ts, hlc.ts, dates.ts, selection.ts, server/src/sync.ts), so the
board behaves exactly as it did there and Tack's rows migrate unchanged (deploy/migrate_tack.py).

- Devices keep their own copy and send changes with POST /api/tasks/sync (push), then
  GET /api/tasks/sync?since=<seq> (pull). Each field carries the hybrid logical clock of its last
  write; the higher clock wins, field by field.
- Other apps (Nook) read GET /api/tasks/feed and write PATCH /api/tasks/<id> (the task source
  contract, nook/docs/TASK_SOURCE_API.md). Those writes are stamped with a server clock and go
  through the same merge, so devices pick them up on their next pull.
"""
import json
import os
import re
import threading
import time
from datetime import date as Date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# --- constants (Tack shared/src/constants.ts) --------------------------------------------------

TIME_ZONE = ZoneInfo("Africa/Algiers")
PROTOCOL_VERSION = 1
PRIORITIES = ("none", "low", "medium", "high", "urgent")
BOARD_COLORS = ("neutral", "slate", "blue", "teal", "green", "olive", "amber", "coral", "rose", "violet")
DAY_MS = 86_400_000
MAX_FUTURE_MS = 5 * 60_000
HLC_ZERO = "0000000000000:0000:"
PUSH_LIMIT = 4 << 20  # far above any real batch, but a long Markdown description can be large

SOURCE_KEY = os.environ.get("TASKS_SOURCE_KEY", "cahier")
PUBLIC_URL = os.environ.get("TASKS_PUBLIC_URL", "").rstrip("/")

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
SLUG_RE = re.compile(r"^[\w\-][\w.\-]{0,99}$")
HLC_RE = re.compile(r"^\d{13}:\d{4}:.{0,64}$")

# --- schema (Tack shared/src/schema.ts, minus settings and notifications) ---------------------


def _str(min_len=0):
    return lambda v: isinstance(v, str) and len(v) >= min_len


def _nullable(check):
    return lambda v: v is None or check(v)


def _enum(values):
    return lambda v: v in values


def _bool(v):
    return isinstance(v, bool)


def _iso(v):
    return isinstance(v, str) and bool(ISO_RE.match(v))


def _day(v):
    return isinstance(v, str) and bool(DATE_RE.match(v)) and _real_date(v)


def _real_date(v):
    try:
        Date.fromisoformat(v)
        return True
    except ValueError:
        return False


def _date_value(v):
    if v is None:
        return True
    if not isinstance(v, dict) or set(v) != {"date", "time"}:
        return False
    return _day(v["date"]) and (v["time"] is None or (isinstance(v["time"], str) and bool(TIME_RE.match(v["time"]))))


SCHEMAS = {
    "boards": {
        "name": _str(1), "emoji": _nullable(_str()), "color": _enum(BOARD_COLORS),
        "showCompleted": _bool, "position": _str(1),
        "createdAt": _iso, "updatedAt": _iso, "deletedAt": _nullable(_iso),
    },
    "lists": {
        "boardId": _str(1), "name": _str(1), "position": _str(1),
        # Cahier addition: the course this list holds tasks for, so it can link to it.
        "module": _nullable(lambda v: isinstance(v, str) and bool(SLUG_RE.match(v))),
        "createdAt": _iso, "updatedAt": _iso, "deletedAt": _nullable(_iso),
    },
    "cards": {
        "boardId": _str(1), "listId": _str(1), "position": _str(1), "title": _str(1),
        "description": _str(), "start": _date_value, "due": _date_value,
        "priority": _enum(PRIORITIES), "completed": _bool, "completedAt": _nullable(_iso),
        "plannedFor": _nullable(_day),
        "createdAt": _iso, "updatedAt": _iso, "deletedAt": _nullable(_iso),
    },
}
TABLES = tuple(SCHEMAS)
# Fields added after release: an older client can still create rows (Tack's FIELD_DEFAULTS).
FIELD_DEFAULTS = {"cards": {"plannedFor": None}, "lists": {"module": None}}
BOOLEAN_FIELDS = {"showCompleted", "completed"}
JSON_FIELDS = {"start", "due"}


def init(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS task_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT OR IGNORE INTO task_meta (key, value) VALUES ('seq', 1);
        CREATE TABLE IF NOT EXISTS task_boards (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT, color TEXT NOT NULL,
            showCompleted INTEGER NOT NULL, position TEXT NOT NULL,
            createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, deletedAt TEXT,
            clocks TEXT NOT NULL, seq INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS task_boards_seq ON task_boards (seq);
        CREATE TABLE IF NOT EXISTS task_lists (
            id TEXT PRIMARY KEY, boardId TEXT NOT NULL, name TEXT NOT NULL, position TEXT NOT NULL,
            module TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, deletedAt TEXT,
            clocks TEXT NOT NULL, seq INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS task_lists_seq ON task_lists (seq);
        CREATE TABLE IF NOT EXISTS task_cards (
            id TEXT PRIMARY KEY, boardId TEXT NOT NULL, listId TEXT NOT NULL, position TEXT NOT NULL,
            title TEXT NOT NULL, description TEXT NOT NULL, start TEXT, due TEXT,
            priority TEXT NOT NULL, completed INTEGER NOT NULL, completedAt TEXT, plannedFor TEXT,
            createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, deletedAt TEXT,
            clocks TEXT NOT NULL, seq INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS task_cards_seq ON task_cards (seq);
        CREATE INDEX IF NOT EXISTS task_cards_list ON task_cards (listId);
        """
    )


def table_sql(table):
    return "task_" + table


# --- rows -------------------------------------------------------------------------------------


def from_db(row, columns):
    out = {}
    for key, value in zip(columns, row):
        if key == "seq":
            continue
        if key in BOOLEAN_FIELDS:
            out[key] = value == 1
        elif key in JSON_FIELDS or key == "clocks":
            out[key] = None if value is None else json.loads(value)
        else:
            out[key] = value
    return out


def to_db(field, value):
    if field in BOOLEAN_FIELDS:
        return 1 if value else 0
    if field in JSON_FIELDS:
        return None if value is None else json.dumps(value, separators=(",", ":"))
    return value


def select(conn, table, where="", params=()):
    cur = conn.execute(f"SELECT * FROM {table_sql(table)} {where}", params)
    columns = [d[0] for d in cur.description]
    return [from_db(r, columns) for r in cur.fetchall()]


def read_row(conn, table, row_id):
    rows = select(conn, table, "WHERE id = ?", (row_id,))
    return rows[0] if rows else None


def write_row(conn, table, row, seq):
    fields = list(SCHEMAS[table])
    columns = ["id", *fields, "clocks", "seq"]
    values = [row["id"], *(to_db(f, row.get(f)) for f in fields), json.dumps(row["clocks"], separators=(",", ":")), seq]
    conn.execute(
        f"INSERT OR REPLACE INTO {table_sql(table)} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
        values,
    )


def current_seq(conn):
    return conn.execute("SELECT value FROM task_meta WHERE key = 'seq'").fetchone()[0]


def bump_seq(conn):
    seq = current_seq(conn) + 1
    conn.execute("UPDATE task_meta SET value = ? WHERE key = 'seq'", (seq,))
    return seq


# --- clocks and merge (Tack shared/src/hlc.ts, merge.ts) --------------------------------------


def format_hlc(ms, counter, node):
    return f"{ms:013d}:{counter:04d}:{node}"


def hlc_ms(hlc):
    return int(hlc[:13])


def hlc_counter(hlc):
    return int(hlc[14:18])


def clamp_hlc(hlc, now_ms):
    """A phone with a wrong clock can't win every conflict."""
    limit = now_ms + MAX_FUTURE_MS
    if hlc_ms(hlc) <= limit:
        return hlc
    return format_hlc(limit, hlc_counter(hlc), hlc[19:])


class ServerClock:
    """Stamps the server's own writes (PATCH from other apps). Always moves forward."""

    def __init__(self, node="cahier"):
        self.node = node
        self.ms = 0
        self.counter = 0
        self.lock = threading.Lock()

    def now(self, after=()):
        with self.lock:
            wall = int(time.time() * 1000)
            if wall > self.ms:
                self.ms, self.counter = wall, 0
            else:
                self.counter += 1
            # It must beat what's stored, so the edit actually wins, as a device edit made now would.
            for seen in after:
                if seen and (hlc_ms(seen), hlc_counter(seen)) >= (self.ms, self.counter):
                    self.ms, self.counter = hlc_ms(seen), hlc_counter(seen) + 1
            return format_hlc(self.ms, self.counter, self.node)


CLOCK = ServerClock()


def merge_change(existing, change):
    """Last write wins per field. Merging the same change twice gives the same result."""
    row = dict(existing) if existing else {"id": change["id"], "clocks": {}}
    row["clocks"] = dict(row.get("clocks") or {})
    changed = False
    for field, value in change["fields"].items():
        clock = change["clocks"].get(field)
        if clock is None:
            continue
        if clock > row["clocks"].get(field, HLC_ZERO):
            row[field] = value
            row["clocks"][field] = clock
            changed = True
    return row, changed


def valid_row(table, row):
    schema = SCHEMAS[table]
    return all(field in row and check(row[field]) for field, check in schema.items())


# --- sync (Tack server/src/sync.ts) -----------------------------------------------------------


class SyncError(Exception):
    def __init__(self, status, payload):
        super().__init__(str(payload))
        self.status = status
        self.payload = payload


def check_push(body):
    if not isinstance(body, dict) or not isinstance(body.get("changes"), list):
        raise SyncError(400, {"error": "Invalid push"})
    if body.get("protocol") != PROTOCOL_VERSION:
        raise SyncError(426, {"protocol": PROTOCOL_VERSION})
    changes = []
    for c in body["changes"]:
        ok = (
            isinstance(c, dict) and c.get("table") in TABLES
            and isinstance(c.get("id"), str) and 0 < len(c["id"]) <= 100
            and isinstance(c.get("fields"), dict) and isinstance(c.get("clocks"), dict)
            and all(isinstance(v, str) and HLC_RE.match(v) for v in c["clocks"].values())
        )
        if not ok:
            raise SyncError(400, {"error": "Invalid push"})
        changes.append(c)
    return changes


def apply_changes(conn, changes, now_ms):
    """Merges each change field by field. A row that would end up invalid is refused and sent back
    as it stands, so the device drops its version (Tack's RejectedChange)."""
    rejected = []
    seq = None
    for change in changes:
        table, row_id = change["table"], change["id"]
        existing = read_row(conn, table, row_id)
        if change.get("purge"):
            # Cahier has no Trash screen, so nothing deletes forever.
            rejected.append({"table": table, "id": row_id, "row": existing})
            continue
        allowed = SCHEMAS[table]
        clocks = {f: clamp_hlc(c, now_ms) for f, c in change["clocks"].items() if f in allowed}
        fields = {f: v for f, v in change["fields"].items() if f in allowed}
        row, changed = merge_change(existing, {"id": row_id, "fields": fields, "clocks": clocks})
        if not changed:
            continue
        row = {**FIELD_DEFAULTS.get(table, {}), **row}
        if not valid_row(table, row):
            rejected.append({"table": table, "id": row_id, "row": existing})
            continue
        if seq is None:
            seq = bump_seq(conn)
        write_row(conn, table, row, seq)
    return {"seq": seq if seq is not None else current_seq(conn), "serverTime": now_ms, "rejected": rejected}


def pull_changes(conn, since, now_ms):
    rows = {}
    for table in TABLES:
        found = select(conn, table, "WHERE seq > ?", (since,))
        if found:
            rows[table] = found
    # Tack's epoch changes when a backup is restored; Cahier's answers.db restore keeps seq, so 0.
    return {"epoch": 0, "seq": current_seq(conn), "serverTime": now_ms, "rows": rows, "tombstones": []}


# --- dates (Tack shared/src/dates.ts) ---------------------------------------------------------


def add_days(day, days):
    return (Date.fromisoformat(day) + timedelta(days=days)).isoformat()


def today_string(now_ms):
    return datetime.fromtimestamp(now_ms / 1000, TIME_ZONE).date().isoformat()


def zoned_ms(day, hhmm):
    y, m, d = map(int, day.split("-"))
    hh, mm = map(int, hhmm.split(":"))
    return int(datetime(y, m, d, hh, mm, tzinfo=TIME_ZONE).timestamp() * 1000)


def due_moment(value):
    """A date-only value counts as the end of its day."""
    if value["time"]:
        return zoned_ms(value["date"], value["time"])
    return zoned_ms(add_days(value["date"], 1), "00:00") - 1


def is_overdue(due, now_ms):
    return now_ms > due_moment(due)


def start_after_due(start, due):
    if not start or not due:
        return False
    if start["date"] != due["date"]:
        return start["date"] > due["date"]
    return bool(start["time"]) and bool(due["time"]) and start["time"] > due["time"]


# --- Today (Tack shared/src/selection.ts) -----------------------------------------------------


def is_planned(card, now_ms):
    """Put on Today by hand, on or before today. A plan carries over until done or taken off."""
    return not card["completed"] and bool(card.get("plannedFor")) and card["plannedFor"] <= today_string(now_ms)


def today_reason(card, now_ms):
    """Why a card belongs on Today, or None (Tack SPEC §3.6). Dates win over a plan."""
    if card["completed"]:
        return None
    today = today_string(now_ms)
    due, start = card.get("due"), card.get("start")
    if due:
        if is_overdue(due, now_ms):
            return "overdue"
        if due["date"] == today:
            return "dueToday"
        if start and start["date"] <= today and due["date"] > today:
            return "inProgress"
    return "planned" if is_planned(card, now_ms) else None


def next_plan(current, day):
    """Tack's setPlanned: a card already planned for an earlier day keeps that day, so
    "Planned 3 days ago" stays true. None takes it off."""
    if day is not None and current is not None and current <= day:
        return current
    return day


# --- the task source contract (nook/docs/TASK_SOURCE_API.md) ----------------------------------


def parse_instant(text, name):
    if not isinstance(text, str) or not text:
        raise SyncError(400, {"error": f"{name} is required (ISO 8601)"})
    try:
        value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise SyncError(400, {"error": f"invalid {name}"})
    if value.tzinfo is None:
        value = value.replace(tzinfo=TIME_ZONE)
    return value


def iso_value(value):
    """A date value as ISO 8601: the date alone, or the moment with its offset."""
    if value is None:
        return None
    if not value["time"]:
        return value["date"]
    y, m, d = map(int, value["date"].split("-"))
    hh, mm = map(int, value["time"].split(":"))
    return datetime(y, m, d, hh, mm, tzinfo=TIME_ZONE).isoformat()


def live_board(conn):
    """The Tasks tab shows one board: the first live one."""
    rows = select(conn, "boards", "WHERE deletedAt IS NULL ORDER BY position, id")
    return rows[0] if rows else None


def live_cards(conn):
    """Cards whose card, list and board are all live (Tack's isCardLive), with their list."""
    boards = {b["id"]: b for b in select(conn, "boards", "WHERE deletedAt IS NULL")}
    lists = {lst["id"]: lst for lst in select(conn, "lists", "WHERE deletedAt IS NULL") if lst["boardId"] in boards}
    out = []
    for card in select(conn, "cards", "WHERE deletedAt IS NULL"):
        lst = lists.get(card["listId"])
        if lst:
            out.append((card, lst, boards[lst["boardId"]]))
    return out


def feed_item(card, lst, base_url, now_ms):
    due, start = card.get("due"), card.get("start")
    return {
        "id": card["id"],
        "title": card["title"],
        "due": iso_value(due),
        "has_time": bool(due and due["time"]),
        "scheduled_for": card.get("plannedFor"),
        "done": card["completed"],
        "group": lst["name"],
        "source": SOURCE_KEY,
        "url": f"{base_url}/tasks/?card={card['id']}",
        # Optional fields: what Tack's Today and Calendar need beyond the required ones.
        "start": iso_value(start),
        "start_has_time": bool(start and start["time"]),
        "priority": card["priority"],
        "today_reason": today_reason(card, now_ms),
    }


def feed(conn, start_text, end_text, base_url, now_ms):
    """Tasks that fall in [from, to) by their dates (start → due, as on Tack's calendar), plus every
    task Tack's Today rule picks right now. Completed tasks follow the board's Show completed."""
    first = parse_instant(start_text, "from").astimezone(TIME_ZONE).date().isoformat()
    end = parse_instant(end_text, "to").astimezone(TIME_ZONE)
    last = (end - timedelta(microseconds=1)).date().isoformat()
    if last < first:
        raise SyncError(400, {"error": "to must be after from"})
    items = []
    for card, lst, board in live_cards(conn):
        if card["completed"] and not board["showCompleted"]:
            continue
        due, start = card.get("due"), card.get("start")
        in_window = False
        if due:
            span_from = start["date"] if start and not start_after_due(start, due) else due["date"]
            in_window = span_from <= last and first <= due["date"]
        if in_window or today_reason(card, now_ms):
            items.append(feed_item(card, lst, base_url, now_ms))
    items.sort(key=lambda i: (i["due"] is None, i["due"] or "", i["title"]))
    return items


def patch_task(conn, task_id, body, base_url, now_ms):
    """PATCH /api/tasks/<id> {done?, scheduled_for?}: the same writes Tack's setCardCompleted and
    setPlanned make, stamped with the server clock and merged like any device's edit."""
    if not isinstance(body, dict) or not ({"done", "scheduled_for"} & set(body)):
        raise SyncError(400, {"error": "send done and/or scheduled_for"})
    unknown = set(body) - {"done", "scheduled_for"}
    if unknown:
        raise SyncError(400, {"error": f"unknown field: {sorted(unknown)[0]}"})
    card = read_row(conn, "cards", task_id)
    live = {c["id"]: (c, lst) for c, lst, _ in live_cards(conn)}
    if not card or task_id not in live:
        raise SyncError(404, {"error": "task not found"})
    fields = {}
    if "done" in body:
        if not isinstance(body["done"], bool):
            raise SyncError(400, {"error": "done must be true or false"})
        if body["done"] != card["completed"]:
            fields["completed"] = body["done"]
            fields["completedAt"] = iso_now(now_ms) if body["done"] else None
    if "scheduled_for" in body:
        day = body["scheduled_for"]
        if day is not None and not _day(day):
            raise SyncError(400, {"error": "scheduled_for must be YYYY-MM-DD or null"})
        nxt = next_plan(card.get("plannedFor"), day)
        if nxt != card.get("plannedFor"):
            fields["plannedFor"] = nxt
    if fields:
        fields["updatedAt"] = iso_now(now_ms)
        clock = CLOCK.now(after=[card["clocks"].get(f) for f in fields])
        apply_changes(conn, [{"table": "cards", "id": task_id, "fields": fields,
                              "clocks": {f: clock for f in fields}}], now_ms)
    card = read_row(conn, "cards", task_id)
    return feed_item(card, live[task_id][1], base_url, now_ms)


def iso_now(now_ms):
    t = datetime.fromtimestamp(now_ms / 1000, timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"
