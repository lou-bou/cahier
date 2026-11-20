#!/usr/bin/env python3
"""One-off: copy a board from Tack into Cahier's Tasks tab. Python 3 stdlib only.

    python3 deploy/migrate_tack.py TACK_DB [--board "BigData Modules"] [--db data/answers.db] [--dry-run]

TACK_DB is a copy of Tack's database: tack.db, or a backup from Tack's `make backup`
(backups/tack-<stamp>.db.gz). It is opened read-only and never changed.

Rows keep their ids, positions and per-field clocks, and go in through the same merge as a device's
sync, so running it twice changes nothing and never overwrites an edit made in Cahier since.
Deleted lists and cards come along too (still deleted), so nothing from Tack is lost.
Each list is linked to the Cahier module of the same code, folder or title (ANGLAIS -> english).
Stop the API first or run it while it is idle; restarting it is not needed.
"""
import argparse
import gzip
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import tasks  # noqa: E402

ALIASES = {"anglais": "english", "eng": "english"}  # French list names on the Tack board


def modules():
    """{lowercased code, folder or title: folder} for every module in modules/."""
    out = {}
    base = os.path.join(ROOT, "modules")
    for slug in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        path = os.path.join(base, slug, "module.json")
        if slug.startswith((".", "_")) or not os.path.isdir(os.path.join(base, slug)):
            continue
        meta = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                meta = json.load(f)
        for key in (slug, meta.get("code") or slug, meta.get("title") or ""):
            if key:
                out[key.strip().lower()] = slug
    return out


def module_for(name, known):
    key = name.strip().lower()
    return known.get(ALIASES.get(key, key))


def open_tack(path):
    """A read-only connection. A .gz backup is unpacked to a temporary file first."""
    if path.endswith(".gz"):
        tmp = tempfile.NamedTemporaryFile(prefix="tack-", suffix=".db", delete=False)
        with gzip.open(path, "rb") as src, tmp:
            shutil.copyfileobj(src, tmp)
        path = tmp.name
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        sys.exit("error: the Tack database failed its integrity check")
    return conn


def tack_rows(conn, table, where, params):
    cur = conn.execute(f"SELECT * FROM {table} WHERE {where}", params)
    cols = [d[0] for d in cur.description]
    rows = []
    for r in cur.fetchall():
        row = dict(zip(cols, r))
        row.pop("seq", None)
        clocks = json.loads(row.pop("clocks"))
        for f in ("start", "due"):
            if f in row and row[f] is not None:
                row[f] = json.loads(row[f])
        for f in ("showCompleted", "completed"):
            if f in row:
                row[f] = row[f] == 1
        rows.append((row, clocks))
    return rows


def change(table, row, clocks):
    fields = {k: v for k, v in row.items() if k in tasks.SCHEMAS[table]}
    return {"table": table, "id": row["id"], "fields": fields, "clocks": {k: clocks[k] for k in fields if k in clocks}}


def main():
    ap = argparse.ArgumentParser(description="Copy a Tack board into Cahier's Tasks tab.")
    ap.add_argument("tack_db")
    ap.add_argument("--board", default="BigData Modules", help='Tack board name (default "BigData Modules")')
    ap.add_argument("--db", default=os.environ.get("ANSWERS_DB", os.path.join(ROOT, "data", "answers.db")),
                    help="Cahier database (default data/answers.db or $ANSWERS_DB)")
    ap.add_argument("--dry-run", action="store_true", help="show what would be copied, write nothing")
    args = ap.parse_args()

    tack = open_tack(args.tack_db)
    boards = tack_rows(tack, "boards", "name = ? AND deletedAt IS NULL", (args.board,))
    if len(boards) != 1:
        names = [r[0] for r in tack.execute("SELECT name FROM boards WHERE deletedAt IS NULL ORDER BY position")]
        sys.exit(f"error: found {len(boards)} live boards named {args.board!r}; Tack has: {', '.join(names)}")
    board, board_clocks = boards[0]
    lists = tack_rows(tack, "lists", "boardId = ? ORDER BY position", (board["id"],))
    cards = tack_rows(tack, "cards", "boardId = ? ORDER BY position", (board["id"],))

    known = modules()
    print(f"Tack board {board['name']!r}: {len(lists)} lists, {len(cards)} cards")
    changes = [change("boards", board, board_clocks)]
    for row, clocks in lists:
        slug = module_for(row["name"], known)
        state = " (deleted)" if row["deletedAt"] else ""
        live = sum(1 for c, _ in cards if c["listId"] == row["id"] and not c["deletedAt"])
        print(f"  {row['name']:<12} -> module {slug or '(none)':<8} {live} cards{state}")
        changes.append(change("lists", row, clocks))
    for row, clocks in cards:
        changes.append(change("cards", row, clocks))
    if args.dry_run:
        print("dry run: nothing written")
        return

    conn = sqlite3.connect(args.db, timeout=10)
    conn.execute("PRAGMA busy_timeout=10000")
    tasks.init(conn)
    conn.commit()
    now = int(time.time() * 1000)
    seq_before = tasks.current_seq(conn)
    with conn:
        conn.execute("BEGIN IMMEDIATE")
        result = tasks.apply_changes(conn, changes, now)
        if result["rejected"]:
            for r in result["rejected"]:
                print(f"  refused {r['table']} {r['id']}: invalid row", file=sys.stderr)
            raise SystemExit("error: some rows were refused, nothing written")
        # Link each list to its module, unless that was already set in Cahier.
        links = []
        for row, _ in lists:
            current = tasks.read_row(conn, "lists", row["id"])
            slug = module_for(row["name"], known)
            if slug and "module" not in current["clocks"]:
                links.append({"table": "lists", "id": row["id"], "fields": {"module": slug},
                              "clocks": {"module": tasks.CLOCK.now()}})
        # An empty board made by opening the Tasks tab before migrating steps aside.
        for other in tasks.select(conn, "boards", "WHERE deletedAt IS NULL AND id != ?", (board["id"],)):
            has_cards = conn.execute(
                "SELECT 1 FROM task_cards WHERE boardId = ? AND deletedAt IS NULL LIMIT 1", (other["id"],)
            ).fetchone()
            if has_cards:
                print(f"  note: Cahier board {other['name']!r} has tasks and stays; the Tasks tab shows the first board")
            else:
                print(f"  empty Cahier board {other['name']!r} marked deleted")
                links.append({"table": "boards", "id": other["id"],
                              "fields": {"deletedAt": tasks.iso_now(now)}, "clocks": {"deletedAt": tasks.CLOCK.now()}})
        if links:
            tasks.apply_changes(conn, links, now)
    total = conn.execute("SELECT COUNT(*) FROM task_cards WHERE boardId = ?", (board["id"],)).fetchone()[0]
    changed = tasks.current_seq(conn) != seq_before
    print(f"done: Cahier now holds {total} cards from this board"
          + ("" if changed else " (already up to date, nothing changed)"))


if __name__ == "__main__":
    main()
