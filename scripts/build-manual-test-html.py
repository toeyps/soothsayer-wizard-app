#!/usr/bin/env python3
"""Regenerate docs/testing/manual-test-plan.html's embedded test data from
docs/testing/MANUAL_TEST_PLAN.md, so the two never drift.

MANUAL_TEST_PLAN.md is the source of truth. Edit it, then run:

    python scripts/build-manual-test-html.py            # rewrite the HTML
    python scripts/build-manual-test-html.py --check    # exit 1 if HTML is stale

Only the `const DATA = {...};` line of the HTML is replaced; the tester's
saved results live in the browser's localStorage keyed by test id, so ids that
still exist keep their pass/fail/notes.

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


def dump(data: dict) -> str:
    return "const DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";"


def main() -> int:
    data = parse(MD.read_text(encoding="utf-8"))
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
    if "--check" in sys.argv:
        if new_html != html:
            print("manual-test-plan.html is out of date — run scripts/build-manual-test-html.py", file=sys.stderr)
            return 1
        print(f"up to date ({data['total']} tests)")
        return 0
    HTML.write_text(new_html, encoding="utf-8", newline="")
    print(f"wrote {HTML.relative_to(ROOT)}: {len(data['sections'])} sections, {data['total']} tests")
    return 0


if __name__ == "__main__":
    sys.exit(main())
