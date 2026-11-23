"""Card Spend Intelligence - local server.

* Serves the dashboard on http://127.0.0.1:8765 (this machine only).
* Keeps parsed statements in a SQLite database (default: ../data/cards.db).
* Lets the dashboard scan folders you register for new statement PDFs.

PDF passwords never reach this server: it only hands the (still encrypted)
PDF bytes to the browser tab, which decrypts and parses them, then sends back
the extracted transactions to be stored.

Usage:  python serve.py [PORT] [--db PATH] [--no-browser]
"""
import functools
import http.server
import json
import os
import socketserver
import sqlite3
import sys
import threading
import urllib.parse
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8765)
DB_PATH = Path(sys.argv[sys.argv.index("--db") + 1]).resolve() if "--db" in sys.argv else ROOT.parent / "data" / "cards.db"
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
API_HEADER = "X-CSI"
SKIP_DIRS = {"app", "data", ".git", "node_modules", "__pycache__"}

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'parent')),
  card TEXT,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS statements (
  id TEXT PRIMARY KEY,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  rel_path TEXT,
  card TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  pages INTEGER,
  meta TEXT NOT NULL,
  raw_lines TEXT,
  line_flags TEXT,
  parsed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_statements_folder ON statements(folder_id, rel_path);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  card TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  description TEXT NOT NULL,
  extra TEXT,
  amount REAL NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('debit', 'credit')),
  points INTEGER DEFAULT 0,
  foreign_ccy TEXT
);
CREATE INDEX IF NOT EXISTS ix_txn_statement ON transactions(statement_id);
CREATE INDEX IF NOT EXISTS ix_txn_date ON transactions(date);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def db():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA secure_delete = ON")
    return con


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db() as con:
        con.executescript(SCHEMA)


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def clean_path(p):
    p = (p or "").strip().strip('"').strip("'")
    if not p:
        raise ApiError(400, "Folder path is empty.")
    path = Path(os.path.expandvars(os.path.expanduser(p))).resolve()
    if not path.is_dir():
        raise ApiError(400, f"Folder not found: {path}")
    if path == ROOT or ROOT in path.parents:
        raise ApiError(400, "That is the app's own folder. Pick the folder that holds your statements.")
    return path


def pdfs_in(folder):
    out = []
    for f in folder.rglob("*"):
        if f.is_file() and f.suffix.lower() == ".pdf" and not any(part in SKIP_DIRS for part in f.relative_to(folder).parts[:-1]):
            out.append(f)
    return sorted(out)


def folder_files(row):
    """Yield (card, rel_path, abs_path) for every PDF under a registered folder."""
    base = Path(row["path"])
    if not base.is_dir():
        return
    if row["kind"] == "card":
        for f in pdfs_in(base):
            yield row["card"], f.relative_to(base).as_posix(), f
    else:
        for sub in sorted(p for p in base.iterdir() if p.is_dir() and p.name not in SKIP_DIRS and not p.name.startswith(".")):
            for f in pdfs_in(sub):
                yield sub.name, f.relative_to(base).as_posix(), f


def folder_json(row):
    d = dict(row)
    d["exists"] = Path(row["path"]).is_dir()
    return d


def api_raw(con, q, _b):
    r = con.execute("SELECT raw_lines, line_flags FROM statements WHERE id = ?", (q.get("id"),)).fetchone()
    if not r:
        raise ApiError(404, "Statement not found.")
    return {"rawLines": json.loads(r["raw_lines"] or "[]"), "lineFlags": json.loads(r["line_flags"] or "[]")}


def api_data(con, _q, _b):
    statements = {}
    cols = "id, folder_id, rel_path, card, file_name, size, pages, meta, parsed_at, (COALESCE(length(raw_lines), 0) > 2) AS has_raw"
    for r in con.execute(f"SELECT {cols} FROM statements ORDER BY card, file_name"):
        statements[r["id"]] = {
            "id": r["id"], "folderId": r["folder_id"], "relPath": r["rel_path"], "card": r["card"],
            "fileName": r["file_name"], "size": r["size"], "pages": r["pages"], "meta": json.loads(r["meta"]),
            "hasRaw": bool(r["has_raw"]),
            "parsedAt": r["parsed_at"], "txns": [],
        }
    for t in con.execute("SELECT * FROM transactions ORDER BY date, time"):
        s = statements.get(t["statement_id"])
        if s:
            s["txns"].append({
                "id": t["id"], "statementId": t["statement_id"], "card": t["card"], "date": t["date"], "time": t["time"],
                "description": t["description"], "extra": t["extra"] or "", "amount": t["amount"], "type": t["type"],
                "points": t["points"] or 0, "foreign": t["foreign_ccy"],
            })
    kv = {r["key"]: json.loads(r["value"]) for r in con.execute("SELECT key, value FROM kv")}
    folders = [folder_json(r) for r in con.execute("SELECT * FROM folders ORDER BY path")]
    return {"statements": list(statements.values()), "overrides": kv.get("overrides", {}), "settings": kv.get("settings", {}),
            "folders": folders, "dbPath": str(DB_PATH)}


def api_add_folder(con, _q, b):
    path = clean_path(b.get("path"))
    kind = "parent" if b.get("parent") else "card"
    card = (b.get("card") or "").strip() or (None if kind == "parent" else path.name)
    try:
        cur = con.execute("INSERT INTO folders (path, kind, card, added_at) VALUES (?, ?, ?, ?)", (str(path), kind, card, now()))
    except sqlite3.IntegrityError:
        raise ApiError(409, "That folder is already added.")
    if kind == "parent":
        cards = sorted({c for c, _, _ in folder_files({"path": str(path), "kind": "parent", "card": None})})
        if not cards:
            con.rollback()
            raise ApiError(400, "No sub-folders with PDF files found there. Untick 'one sub-folder per card' to add it as a single card.")
    return folder_json(con.execute("SELECT * FROM folders WHERE id = ?", (cur.lastrowid,)).fetchone())


def api_update_folder(con, q, b):
    fid = int(q["id"])
    row = con.execute("SELECT * FROM folders WHERE id = ?", (fid,)).fetchone()
    if not row:
        raise ApiError(404, "Folder not found.")
    if row["kind"] == "card" and (b.get("card") or "").strip():
        new = b["card"].strip()
        con.execute("UPDATE folders SET card = ? WHERE id = ?", (new, fid))
        con.execute("UPDATE statements SET card = ? WHERE folder_id = ?", (new, fid))
        con.execute("UPDATE transactions SET card = ? WHERE statement_id IN (SELECT id FROM statements WHERE folder_id = ?)", (new, fid))
    return {"ok": True}


def api_delete_folder(con, q, _b):
    fid = int(q["id"])
    removed = 0
    if q.get("purge") == "1":
        removed = con.execute("DELETE FROM statements WHERE folder_id = ?", (fid,)).rowcount
    con.execute("DELETE FROM folders WHERE id = ?", (fid,))
    return {"ok": True, "statementsRemoved": removed}


def api_scan(con, _q, _b):
    known = {}
    for r in con.execute("SELECT id, folder_id, rel_path, size FROM statements WHERE folder_id IS NOT NULL"):
        known[(r["folder_id"], r["rel_path"])] = (r["id"], r["size"])
    result = []
    for row in con.execute("SELECT * FROM folders ORDER BY path"):
        seen, new, changed = set(), [], []
        for card, rel, f in folder_files(row):
            size = f.stat().st_size
            k = (row["id"], rel)
            seen.add(k)
            if k not in known:
                new.append({"card": card, "rel": rel, "name": f.name, "size": size})
            elif known[k][1] != size:
                changed.append({"card": card, "rel": rel, "name": f.name, "size": size, "replaces": known[k][0]})
        missing = [{"id": sid, "rel": k[1]} for k, (sid, _) in known.items() if k[0] == row["id"] and k not in seen]
        info = folder_json(row)
        info.update(new=new, changed=changed, missing=missing,
                    total=sum(1 for k in known if k[0] == row["id"]))
        result.append(info)
    return {"folders": result}


def api_file(con, q, _b):
    row = con.execute("SELECT * FROM folders WHERE id = ?", (int(q["folder"]),)).fetchone()
    if not row:
        raise ApiError(404, "Folder not registered.")
    base = Path(row["path"]).resolve()
    target = (base / q["rel"]).resolve()
    if base not in target.parents or target.suffix.lower() != ".pdf" or not target.is_file():
        raise ApiError(403, "Not a PDF inside a registered folder.")
    return ("file", target)


def api_save_statement(con, _q, s):
    sid = s["id"]
    if s.get("replaces"):
        con.execute("DELETE FROM statements WHERE id = ?", (s["replaces"],))
    con.execute("DELETE FROM statements WHERE id = ?", (sid,))
    con.execute(
        "INSERT INTO statements (id, folder_id, rel_path, card, file_name, size, pages, meta, raw_lines, line_flags, parsed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (sid, s.get("folderId"), s.get("relPath"), s["card"], s["fileName"], int(s["size"]), s.get("pages"), json.dumps(s.get("meta") or {}),
         json.dumps(s.get("rawLines") or []), json.dumps(s.get("lineFlags") or []), s.get("parsedAt") or now()))
    con.executemany(
        "INSERT OR REPLACE INTO transactions (id, statement_id, card, date, time, description, extra, amount, type, points, foreign_ccy) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [(t["id"], sid, s["card"], t["date"], t.get("time"), t["description"], t.get("extra") or "", float(t["amount"]), t["type"],
          int(t.get("points") or 0), t.get("foreign")) for t in s.get("txns", [])])
    return {"ok": True, "transactions": len(s.get("txns", []))}


def api_delete_statement(con, q, _b):
    return {"ok": True, "removed": con.execute("DELETE FROM statements WHERE id = ?", (q["id"],)).rowcount}


def api_put_kv(con, q, b):
    if q["key"] not in ("overrides", "settings"):
        raise ApiError(400, "Unknown key.")
    con.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", (q["key"], json.dumps(b)))
    return {"ok": True}


def api_clear(con, q, _b):
    n = con.execute("DELETE FROM statements").rowcount
    con.execute("DELETE FROM kv")
    if q.get("folders") == "1":
        con.execute("DELETE FROM folders")
    con.commit()
    con.execute("VACUUM")
    return {"ok": True, "statementsRemoved": n}


ROUTES = {
    ("GET", "/api/data"): api_data,
    ("GET", "/api/scan"): api_scan,
    ("GET", "/api/raw"): api_raw,
    ("GET", "/api/file"): api_file,
    ("POST", "/api/folders"): api_add_folder,
    ("PATCH", "/api/folders"): api_update_folder,
    ("DELETE", "/api/folders"): api_delete_folder,
    ("POST", "/api/statements"): api_save_statement,
    ("DELETE", "/api/statements"): api_delete_statement,
    ("PUT", "/api/kv"): api_put_kv,
    ("DELETE", "/api/all"): api_clear,
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass

    def _host_ok(self):
        return self.headers.get("Host", "") in ALLOWED_HOSTS

    def _send_json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _api(self, method):
        if not self._host_ok() or self.headers.get(API_HEADER) != "1":
            return self._send_json(403, {"error": "Forbidden"})
        url = urllib.parse.urlsplit(self.path)
        fn = ROUTES.get((method, url.path))
        if not fn:
            return self._send_json(404, {"error": "Not found"})
        q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        body = None
        if method in ("POST", "PUT", "PATCH"):
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        try:
            with db() as con:
                res = fn(con, q, body)
        except ApiError as e:
            return self._send_json(e.status, {"error": str(e)})
        except Exception as e:
            return self._send_json(500, {"error": f"{type(e).__name__}: {e}"})
        if isinstance(res, tuple) and res[0] == "file":
            data = res[1].read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self._send_json(200, res)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._api("GET")
        if not self._host_ok():
            return self._send_json(403, {"error": "Forbidden"})
        super().do_GET()

    def do_POST(self):
        self._api("POST")

    def do_PUT(self):
        self._api("PUT")

    def do_PATCH(self):
        self._api("PATCH")

    def do_DELETE(self):
        self._api("DELETE")


def main():
    init_db()
    handler = functools.partial(Handler, directory=str(ROOT))
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), handler) as httpd:
        url = f"http://127.0.0.1:{PORT}/"
        print(f"Card Spend Intelligence running at {url}  (Ctrl+C to stop)")
        print(f"Database: {DB_PATH}")
        if "--no-browser" not in sys.argv:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
