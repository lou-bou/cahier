"""python3 -m unittest discover tests -- the Tasks rules, ported from Tack, and the sync merge."""
import os
import sqlite3
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tasks  # noqa: E402

# 2026-11-20 12:00 in Algiers (UTC+1).
NOON = tasks.zoned_ms("2026-11-20", "12:00")
T = "2026-11-01T00:00:00.000Z"
H = "1790000000000:0000:dev1"


def card(**kw):
    base = {"completed": False, "start": None, "due": None, "plannedFor": None}
    base.update(kw)
    return base


def dv(date, time=None):
    return {"date": date, "time": time}


class Dates(unittest.TestCase):
    def test_date_only_due_is_end_of_day(self):
        self.assertFalse(tasks.is_overdue(dv("2026-11-20"), tasks.zoned_ms("2026-11-20", "23:59")))
        self.assertTrue(tasks.is_overdue(dv("2026-11-20"), tasks.zoned_ms("2026-11-21", "00:00")))

    def test_today_in_algiers_not_utc(self):
        # 23:30 UTC on the 20th is already the 21st in Algiers.
        self.assertEqual(tasks.today_string(tasks.zoned_ms("2026-11-21", "00:30")), "2026-11-21")


class Today(unittest.TestCase):
    def test_reasons(self):
        r = lambda c: tasks.today_reason(c, NOON)  # noqa: E731
        self.assertEqual(r(card(due=dv("2026-11-20", "11:00"))), "overdue")
        self.assertEqual(r(card(due=dv("2026-11-20", "18:00"))), "dueToday")
        self.assertEqual(r(card(due=dv("2026-11-25"), start=dv("2026-11-18"))), "inProgress")
        self.assertEqual(r(card(due=dv("2026-11-25"), plannedFor="2026-11-19")), "planned")
        self.assertIsNone(r(card(due=dv("2026-11-21"))))  # due within 24h is only "due soon", not Today
        self.assertIsNone(r(card(plannedFor="2026-11-21")))  # planned for later
        self.assertIsNone(r(card(due=dv("2026-11-19"), completed=True)))

    def test_plan_keeps_earlier_day(self):
        self.assertEqual(tasks.next_plan("2026-11-15", "2026-11-20"), "2026-11-15")
        self.assertEqual(tasks.next_plan(None, "2026-11-20"), "2026-11-20")
        self.assertIsNone(tasks.next_plan("2026-11-15", None))


class Sync(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        tasks.init(self.db)
        board = {"name": "M", "emoji": None, "color": "blue", "showCompleted": False, "position": "a0",
                 "createdAt": T, "updatedAt": T, "deletedAt": None}
        lst = {"boardId": "b", "name": "THOR", "position": "a0", "module": "thor",
               "createdAt": T, "updatedAt": T, "deletedAt": None}
        crd = {"boardId": "b", "listId": "l", "position": "a0", "title": "TD2", "description": "",
               "start": None, "due": dv("2026-11-20", "18:00"), "priority": "high", "completed": False,
               "completedAt": None, "plannedFor": None, "createdAt": T, "updatedAt": T, "deletedAt": None}
        res = tasks.apply_changes(self.db, [
            {"table": "boards", "id": "b", "fields": board, "clocks": {k: H for k in board}},
            {"table": "lists", "id": "l", "fields": lst, "clocks": {k: H for k in lst}},
            {"table": "cards", "id": "c", "fields": crd, "clocks": {k: H for k in crd}},
        ], NOON)
        self.assertEqual(res["rejected"], [])

    def test_last_write_wins_per_field(self):
        older, newer = "1790000000001:0000:dev2", "1790000000002:0000:dev3"
        tasks.apply_changes(self.db, [{"table": "cards", "id": "c", "fields": {"title": "new"}, "clocks": {"title": newer}}], NOON)
        tasks.apply_changes(self.db, [{"table": "cards", "id": "c", "fields": {"title": "old", "priority": "low"},
                                       "clocks": {"title": older, "priority": older}}], NOON)
        row = tasks.read_row(self.db, "cards", "c")
        self.assertEqual((row["title"], row["priority"]), ("new", "low"))

    def test_invalid_row_is_refused(self):
        res = tasks.apply_changes(self.db, [{"table": "cards", "id": "c", "fields": {"priority": "huge"},
                                             "clocks": {"priority": "1790000000009:0000:x"}}], NOON)
        self.assertEqual(len(res["rejected"]), 1)
        self.assertEqual(tasks.read_row(self.db, "cards", "c")["priority"], "high")

    def test_feed_and_patch(self):
        items = tasks.feed(self.db, "2026-11-20T00:00:00+01:00", "2026-11-21T00:00:00+01:00", "https://s", NOON)
        self.assertEqual([(i["id"], i["group"], i["due"], i["has_time"]) for i in items],
                         [("c", "THOR", "2026-11-20T18:00:00+01:00", True)])
        out = tasks.patch_task(self.db, "c", {"done": True}, "https://s", NOON)
        self.assertTrue(out["done"])
        # Done and hidden while the board hides completed tasks.
        self.assertEqual(tasks.feed(self.db, "2026-11-20T00:00:00Z", "2026-11-21T00:00:00Z", "https://s", NOON), [])
        with self.assertRaises(tasks.SyncError):
            tasks.patch_task(self.db, "missing", {"done": True}, "https://s", NOON)

    def test_server_write_beats_a_phone_clock_running_ahead(self):
        # Stored clocks are at most 5 minutes ahead (clamp_hlc); a PATCH right after must still win.
        wall = int(time.time() * 1000)
        ahead = tasks.format_hlc(wall + 4 * 60_000, 0, "phone")
        self.db.execute("UPDATE task_cards SET clocks = json_set(clocks, '$.completed', ?)", (ahead,))
        tasks.patch_task(self.db, "c", {"done": True}, "https://s", wall)
        self.assertTrue(tasks.read_row(self.db, "cards", "c")["completed"])


if __name__ == "__main__":
    unittest.main()
