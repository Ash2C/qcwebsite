"""Generate parity fixtures for src/lib/monsoon/rules.ts from the Python CRM rules."""
import json
import re
from datetime import date
from difflib import SequenceMatcher
from importlib import resources
from pathlib import Path

from quantcloud.crm import rules

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "src" / "lib" / "monsoon"

EXISTING = [
    "Meridian Harbour Asset Management (MHAM)",
    "Northwind Capital",
    "Corvane",
    "Brightwater Family Office",
    "Acme Capital Pte Ltd",
    "Acme Capital Partners Asia",
]

NAME_KEYS = ["Jane Tan", "  jane   TAN ", "Jane\tTan", "JANE\u00a0TAN", "José Álvarez", ""]
MERGES = [
    (
        {"id": "1", "name": "A", "email": None, "phone": " ", "title": "CEO"},
        {"name": "B", "email": "a@b.co", "phone": "123", "title": "CFO", "linkedin_url": ""},
    ),
    (
        {"id": "1", "name": "A", "email": None, "phone": " ", "title": "CEO"},
        {},
    ),
]
CORES = [
    "Meridian Harbour Asset Management (MHAM)",
    "Northwind Capital",
    "The Capital Group",
    "Acme Capital Pte. Ltd.",
    "A&B Partners",
    "(X)",
    "",
]
RATIOS = [
    ("brightwater famly", "brightwater family"),
    ("corvane", "corvine"),
    ("abcdef", "abcdxy"),
    ("", ""),
    ("abc", ""),
    ("northwind", "northwind"),
    ("alpha beta", "beta alpha"),
]
SIMILAR = [
    "MHAM", "Northwind Capital Management", "Brightwater Famly Office", "Corvane",
    "Pinecrest Holdings", "Acme Capital", "acme capital pte ltd", "Corvine",
    "Corvanne", "Acme", "North",
]

TODAY = date(2026, 11, 13)
DUE_MEMBERS = [
    {},
    {"next_action": "  ", "next_action_date": "2026-11-12"},
    {"next_action": "Send deck"},
    {"next_action": "Send deck", "next_action_date": None},
    {"next_action": "Send deck", "next_action_date": "2026-11-12"},
    {"next_action": "Send deck", "next_action_date": "2026-11-13"},
    {"next_action": "Send deck", "next_action_date": "2026-11-14"},
    {"next_action": "Send deck", "next_action_date": "2026-11-20"},
    {"next_action": "Send deck", "next_action_date": "2026-11-21"},
    {"next_action": "Send deck", "next_action_date": "2027-01-05"},
    {"next_action": "Send deck", "next_action_date": "2026-11-13T23:30:00+00:00"},
]

LAST_ACTION_CASES = [
    [],
    [
        {"kind": "stage", "at": "2026-11-10T09:00:00+00:00"},
        {"kind": "system", "at": "2026-11-11T09:00:00+00:00"},
    ],
    [
        {"kind": "call", "at": "2026-11-01T09:00:00+00:00", "summary": "intro"},
        {"kind": "email", "at": "2026-11-05T09:00:00+00:00", "summary": "follow-up"},
        {"kind": "stage", "at": "2026-11-12T09:00:00+00:00", "summary": "to Warm"},
    ],
    [
        {"kind": "note", "at": "2026-11-09T08:00:00+00:00"},
        {"kind": "meeting", "at": "2026-10-20T08:00:00+00:00"},
    ],
    [
        {"kind": "meeting", "at": "2026-11-05T10:00:00"},
        {"kind": "call", "at": "2026-11-05T10:00:00+00:00"},
        {"kind": "email", "at": "2026-11-05T09:59:59Z"},
    ],
    [
        {"kind": "note", "at": "2026-11-05T10:00:00+00:00"},
        {"kind": "call", "at": "2026-11-05T10:00:00+00:00"},
    ],
]


def _iso(o):
    if isinstance(o, date):
        return o.isoformat()
    raise TypeError(type(o))


def _index_of(touches, chosen):
    if chosen is None:
        return None
    return next(i for i, t in enumerate(touches) if t is chosen)


fixtures = {
    "name_key": [{"in": n, "out": rules.name_key(n)} for n in NAME_KEYS],
    "merge_fill_empty": [
        {"existing": e, "incoming": i, "out": rules.merge_fill_empty(e, i)} for e, i in MERGES
    ],
    "org_name_cores": [{"in": n, "out": rules.org_name_cores(n)} for n in CORES],
    "ratio": [{"a": a, "b": b, "out": SequenceMatcher(None, a, b).ratio()} for a, b in RATIOS],
    "similar_org_names": [
        {"name": n, "existing": EXISTING, "out": rules.similar_org_names(n, EXISTING)} for n in SIMILAR
    ],
    "due_bucket": [
        {"member": m, "today": TODAY.isoformat(), "out": rules.due_bucket(m, TODAY)} for m in DUE_MEMBERS
    ],
    "last_action": [
        {"touches": t, "out": _index_of(t, rules.last_action(t))} for t in LAST_ACTION_CASES
    ],
}

(OUT / "rules.fixtures.json").write_text(
    json.dumps(fixtures, ensure_ascii=False, indent=2, default=_iso) + "\n", encoding="utf-8", newline="\n"
)

header = "-- Copied from quantcloud core by scripts/monsoon/gen_rule_fixtures.py. Do not edit.\n"
schema_dir = resources.files("quantcloud.crm").joinpath("schema")
for entry in sorted(schema_dir.iterdir(), key=lambda e: e.name):
    if re.fullmatch(r"\d{4}_.*\.sql", entry.name):
        text = entry.read_text(encoding="utf-8")
        (OUT / "testing" / entry.name).write_text(header + text, encoding="utf-8", newline="\n")
print("wrote fixtures and schema")
