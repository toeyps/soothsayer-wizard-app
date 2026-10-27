#!/usr/bin/env python3
"""Regenerate docs/testing/manual-test-plan.html's embedded test data from
docs/testing/MANUAL_TEST_PLAN.md, so the two never drift.

MANUAL_TEST_PLAN.md is the source of truth. Edit it, then run:

    python scripts/build-manual-test-html.py            # rewrite the HTML
    python scripts/build-manual-test-html.py --check    # exit 1 if HTML is stale

Only the `const DATA = {...};` line of the HTML is replaced; the tester's
saved results live in the browser's localStorage keyed by test id, so ids that
still exist keep their pass/fail/notes.

Two more sources are folded into the same DATA line (the team only gets the
HTML, so they must be inside it):
    docs/testing/TEST_ROUNDS.md      the round-by-round order: the overview table,
                                     each "## รอบ N — ..." section, the
                                     "## ข้อที่ต้องทำมือเพิ่ม" list, and the fenced
                                     ```rounds block = THE one item -> round map
    docs/testing/TEST_DATA_GUIDE.md  the fenced ```files block = the
                                     "ไฟล์ที่ใช้" line shown on an item
Both fenced blocks are validated: an item with no round or two rounds, or a
block naming an id / section that does not exist, fails the build AND --check.

Markdown format (as used by the plan):
    ## KEY                       section key
    ### Title                    section title
    _blurb_                      optional one-line blurb
    - [ ] **ID — title** 🆕      item; trailing 🆕 = new, 👀 = watch, 🐍 = sidecar
      - step                     one bullet per step
      - **คาดหวัง:** expected    the expected result (last bullet)
    ## ของที่รู้อยู่แล้ว ...       trailing "known issues" bullet list
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MD = ROOT / "docs" / "testing" / "MANUAL_TEST_PLAN.md"
HTML = ROOT / "docs" / "testing" / "manual-test-plan.html"
ROUNDS_MD = ROOT / "docs" / "testing" / "TEST_ROUNDS.md"
GUIDE_MD = ROOT / "docs" / "testing" / "TEST_DATA_GUIDE.md"

FLAGS = {"🆕": "new", "👀": "watch", "🐍": "sidecar"}
ITEM = re.compile(r"^- \[ \] \*\*(?P<id>[A-Z]+-\d+[a-z]?) — (?P<t>.+?)\*\*(?P<flag>\s*[🆕👀🐍])?\s*$")
EXPECT = "**คาดหวัง:** "


def parse(md_text: str) -> dict:
    sections, known = [], []
    cur = None          # current section
    item = None         # current test
    in_known = False
    lines = md_text.split("\n")
    # only parse from the first "## KEY" section onward (skips intro + TOC)
    for line in lines:
        m = re.match(r"^## ([A-Z][A-Z0-9]*)\s*$", line)
        if m:
            cur = {"key": m.group(1), "title": "", "blurb": "", "tests": []}
            sections.append(cur)
            item, in_known = None, False
            continue
        if line.startswith("## ของที่รู้อยู่แล้ว"):
            cur, item, in_known = None, None, True
            continue
        if in_known:
            if line.startswith("- "):
                known.append(line[2:].strip())
            continue
        if cur is None:
            continue
        if line.startswith("### ") and not cur["title"]:
            cur["title"] = line[4:].strip()
            continue
        m = re.match(r"^_(.+)_\s*$", line)
        if m and item is None and not cur["tests"]:
            cur["blurb"] = m.group(1)
            continue
        m = ITEM.match(line)
        if m:
            item = {"id": m.group("id"), "t": m.group("t"), "s": [], "e": ""}
            flag = (m.group("flag") or "").strip()
            if flag:
                item["w"] = FLAGS[flag]
            cur["tests"].append(item)
            continue
        if item is not None and line.startswith("  - "):
            body = line[4:].strip()
            if body.startswith(EXPECT):
                item["e"] = body[len(EXPECT):].strip()
            else:
                item["s"].append(body)
    total = sum(len(s["tests"]) for s in sections)
    return {"sections": sections, "known": known, "total": total}


class PlanError(Exception):
    pass


ID_RE = re.compile(r"^([A-Z]+)-(\d+)([a-z]?)$")
RANGE_RE = re.compile(r"^([A-Z]+)-(\d+)\.\.(\d+)$")


def fenced(md_text: str, lang: str, where: str) -> list:
    blocks = re.findall(r"^```" + lang + r"[ \t]*\n(.*?)^```[ \t]*$", md_text, re.M | re.S)
    if len(blocks) != 1:
        raise PlanError(f"{where}: expected exactly one ```{lang} block, found {len(blocks)}")
    return [l.rstrip() for l in blocks[0].split("\n")]


def expand(token: str, sec_of: dict, sections: dict, where: str):
    """-> ('section', key) | ('ids', [ids]). Raises on anything unknown."""
    if token in sections:
        return "section", token
    m = RANGE_RE.match(token)
    if m:
        pre, a, b = m.group(1), int(m.group(2)), int(m.group(3))
        for e in (f"{pre}-{a}", f"{pre}-{b}"):
            if e not in sec_of:
                raise PlanError(f"{where}: range {token} — {e} does not exist in the plan")
        if a > b:
            raise PlanError(f"{where}: range {token} is backwards")
        ids = []
        for tid in sec_of:
            mm = ID_RE.match(tid)
            if mm and mm.group(1) == pre and a <= int(mm.group(2)) <= b:
                ids.append(tid)
        return "ids", ids
    if token in sec_of:
        return "ids", [token]
    raise PlanError(f"{where}: '{token}' is not an item id or section key in MANUAL_TEST_PLAN.md")


def table_rows(lines: list) -> list:
    rows = []
    for l in lines:
        if not l.startswith("|"):
            continue
        cells = [c.strip() for c in l.strip().strip("|").split("|")]
        if all(re.fullmatch(r":?-{3,}:?", c) for c in cells):
            continue
        rows.append(cells)
    return rows


SKIP = "skip"            # the "ข้ามได้" group (needs a project from an older version)


def round_key(label: str):
    """'3' / '6 (ไม่บังคับ)' -> '3'; 'ข้ามได้' -> 'skip'; anything else -> None."""
    m = re.match(r"^(\d+)", label)
    if m:
        return m.group(1)
    if label.startswith("ข้าม"):
        return SKIP
    return None


def parse_rounds(md_text: str, data: dict) -> dict:
    """Give every test exactly one round (t['r'], a string key) and build DATA.rounds."""
    sections = {s["key"]: s for s in data["sections"]}
    sec_of = {t["id"]: s["key"] for s in data["sections"] for t in s["tests"]}
    lines = md_text.split("\n")

    # intro = text between the H1 and the overview table
    intro, i = [], 1
    while i < len(lines) and not lines[i].startswith("|"):
        if lines[i].strip():
            intro.append(lines[i].strip())
        i += 1
    j = i
    while j < len(lines) and lines[j].startswith("|"):
        j += 1
    meta = {}                                       # insertion order = display order
    for row in table_rows(lines[i:j])[1:]:          # [1:] drops the header row
        k = round_key(row[0]) if row else None
        if len(row) != 4 or k is None:
            raise PlanError(f"TEST_ROUNDS.md: bad overview row {row} (want: รอบ | ชุดข้อมูล | หมวด / ข้อ | ประมาณ)")
        if k in meta:
            raise PlanError(f"TEST_ROUNDS.md: round {k} has two rows in the overview table")
        meta[k] = {"id": k, "label": row[0], "badge": "ข้ามได้" if k == SKIP else "รอบ " + k,
                   "data": row[1], "what": row[2], "time": row[3], "title": "", "body": [], "order": []}
    if not meta:
        raise PlanError("TEST_ROUNDS.md: overview table not found")

    # "## รอบ N — title" / "## ข้ามได้ — title" bodies, and the extra hand-work list.
    # Any other "## " section (e.g. the dev-only notes) is NOT embedded.
    extra = {"title": "", "body": []}
    cur = None
    for l in lines[j:]:
        if l.startswith("## "):
            m = re.match(r"^## รอบ (\d+)[^—]*— (.+)$", l)
            if m or l.startswith("## ข้ามได้"):
                k = m.group(1) if m else SKIP
                if k not in meta:
                    raise PlanError(f"TEST_ROUNDS.md: section '{l}' has no row in the overview table")
                cur = meta[k]["body"]
                meta[k]["title"] = m.group(2).strip() if m else l[3:].strip()
            elif l.startswith("## ข้อที่ต้องทำมือเพิ่ม"):
                extra["title"] = l[3:].strip()
                cur = extra["body"]
            else:
                cur = None
            continue
        if l.strip() == "---" or l.startswith("```"):
            cur = None
            continue
        if cur is not None and l.strip():
            cur.append(l.rstrip())
    for k, r in meta.items():
        if not r["title"]:
            raise PlanError(f"TEST_ROUNDS.md: round {k} has no '## รอบ {k} — ...' section")

    # the team gets ONE installer and the data files without their folder:
    # what is embedded must not name an installer version or a data path
    shown = intro + extra["body"] + [x for r in meta.values() for x in [r["data"], r["what"], r["title"]] + r["body"]]
    for x in shown:
        if "WizardTestData" in x or re.search(r"\b\d+\.\d+\.\d+\b", x):
            raise PlanError(f"TEST_ROUNDS.md: text shown to testers names a data path or a version: '{x}'")

    # the machine-readable map
    by_id, by_sec, order = {}, {}, {}
    for raw in fenced(md_text, "rounds", "TEST_ROUNDS.md"):
        l = raw.strip()
        if not l or l.startswith("#"):
            continue
        m = re.match(r"^(\d+|" + SKIP + r"):(.*)$", l)
        if not m:
            raise PlanError(f"TEST_ROUNDS.md rounds block: bad line '{l}'")
        n = m.group(1)
        if n not in meta:
            raise PlanError(f"TEST_ROUNDS.md rounds block: round {n} is not in the overview table")
        if n in order:
            raise PlanError(f"TEST_ROUNDS.md rounds block: round {n} listed twice")
        order[n] = []
        for tok in m.group(2).split():
            kind, val = expand(tok, sec_of, sections, f"TEST_ROUNDS.md rounds block (round {n})")
            if kind == "section":
                if val in by_sec:
                    raise PlanError(f"rounds block: section {val} is in round {by_sec[val]} and round {n}")
                by_sec[val] = n
                secs = [val]
            else:
                if not val:
                    raise PlanError(f"rounds block: '{tok}' matches no item")
                for tid in val:
                    if tid in by_id:
                        raise PlanError(f"rounds block: {tid} is in round {by_id[tid]} and round {n}")
                    by_id[tid] = n
                secs = [sec_of[t] for t in val]
            for k in secs:
                if k not in order[n]:
                    order[n].append(k)
    missing = [n for n in meta if n not in order]
    if missing:
        raise PlanError(f"TEST_ROUNDS.md rounds block: no line for round(s) {missing}")

    unassigned = []
    for s in data["sections"]:
        for t in s["tests"]:
            r = by_id.get(t["id"], by_sec.get(s["key"]))
            if r is None:
                unassigned.append(t["id"])
            else:
                t["r"] = r
    if unassigned:
        raise PlanError("items with no round (add them to TEST_ROUNDS.md's rounds block): " + ", ".join(unassigned))
    for k, n in by_sec.items():
        if not any(t["r"] == n for t in sections[k]["tests"]):
            raise PlanError(f"rounds block: section {k} in round {n} has no item left (all named elsewhere)")

    rounds = []
    for k, r in meta.items():
        r["order"] = order[k]
        r["count"] = sum(1 for s in data["sections"] for t in s["tests"] if t["r"] == k)
        rounds.append(r)
    if sum(r["count"] for r in rounds) != data["total"]:
        raise PlanError("round counts do not add up to the total")
    return {"intro": intro, "list": rounds, "extra": extra}


def apply_files(md_text: str, data: dict) -> None:
    """Attach the "ไฟล์ที่ใช้" text (t['f']) from TEST_DATA_GUIDE.md's files block.

    Per item: every `ID => text` line naming it (joined with ·); if none, the
    `SECTION@round` line; if none, the `SECTION` line. `+ ID => text` lines are
    always appended on top.
    """
    sections = {s["key"]: s for s in data["sections"]}
    sec_of = {t["id"]: s["key"] for s in data["sections"] for t in s["tests"]}
    item, extra, sec_round, sec = {}, {}, {}, {}
    for raw in fenced(md_text, "files", "TEST_DATA_GUIDE.md"):
        l = raw.strip()
        if not l or l.startswith("#"):
            continue
        add = l.startswith("+ ")
        if add:
            l = l[2:].strip()
        if " => " not in l:
            raise PlanError(f"TEST_DATA_GUIDE.md files block: bad line '{raw}'")
        lhs, text = (x.strip() for x in l.split(" => ", 1))
        # file NAMES only: the team keeps the files wherever it likes
        if "\\" in text or re.search(r"\S/\S", text):
            raise PlanError(f"TEST_DATA_GUIDE.md files block: write file names only, no folder/path: '{raw}'")
        for tok in lhs.split():
            where = f"TEST_DATA_GUIDE.md files block ('{tok}')"
            m = re.match(r"^([A-Z][A-Z0-9]*)@(\d+|" + SKIP + r")$", tok)
            if m:
                if add:
                    raise PlanError(f"{where}: '+' lines must name items, not a section")
                if m.group(1) not in sections:
                    raise PlanError(f"{where}: no such section")
                rn = m.group(2)
                if not any(t["r"] == rn for t in sections[m.group(1)]["tests"]):
                    raise PlanError(f"{where}: that section has no item in round {rn}")
                sec_round.setdefault((m.group(1), rn), []).append(text)
                continue
            kind, val = expand(tok, sec_of, sections, where)
            if kind == "section":
                if add:
                    raise PlanError(f"{where}: '+' lines must name items, not a section")
                sec.setdefault(val, []).append(text)
            else:
                for tid in val:
                    (extra if add else item).setdefault(tid, []).append(text)
    for s in data["sections"]:
        for t in s["tests"]:
            parts = item.get(t["id"]) or sec_round.get((s["key"], t["r"])) or sec.get(s["key"]) or []
            parts = parts + extra.get(t["id"], [])
            if parts:
                t["f"] = " · ".join(parts)


def build() -> dict:
    data = parse(MD.read_text(encoding="utf-8"))
    data["rounds"] = parse_rounds(ROUNDS_MD.read_text(encoding="utf-8"), data)
    apply_files(GUIDE_MD.read_text(encoding="utf-8"), data)
    return data


def dump(data: dict) -> str:
    return "const DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";"


def main() -> int:
    try:
        data = build()
    except PlanError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    html = HTML.read_text(encoding="utf-8")
    pat = re.compile(r"^const DATA = \{.*\};[ \t]*$", re.M)
    if not pat.search(html):
        print("could not find `const DATA = ...;` in the HTML", file=sys.stderr)
        return 2
    new_html = pat.sub(lambda _m: dump(data), html, count=1)
    # header (version + count) baked into the HTML outside DATA
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    new_html = re.sub(
        r'(<p class="sub">)v[\d.]+ · \d+ ข้อ(</p>)',
        lambda m: f"{m.group(1)}v{version} · {data['total']} ข้อ{m.group(2)}",
        new_html, count=1,
    )
    per_round = ", ".join(f"{r['id']}={r['count']}" for r in data["rounds"]["list"])
    with_files = sum(1 for s in data["sections"] for t in s["tests"] if "f" in t)
    summary = f"{data['total']} tests ({per_round}; {with_files} with a file line)"
    if "--check" in sys.argv:
        if new_html != html:
            print("manual-test-plan.html is out of date — run scripts/build-manual-test-html.py", file=sys.stderr)
            return 1
        print(f"up to date — {summary}")
        return 0
    HTML.write_text(new_html, encoding="utf-8", newline="")
    print(f"wrote {HTML.relative_to(ROOT)}: {len(data['sections'])} sections, {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
