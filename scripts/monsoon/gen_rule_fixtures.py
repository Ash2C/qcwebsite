"""Generate parity fixtures for src/lib/monsoon/rules.ts from the Python CRM rules."""
import json
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
}

(OUT / "rules.fixtures.json").write_text(
    json.dumps(fixtures, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)

schema = resources.files("quantcloud.crm").joinpath("schema", "0001_init.sql").read_text(encoding="utf-8")
header = "-- Copied from quantcloud core by scripts/monsoon/gen_rule_fixtures.py. Do not edit.\n"
(OUT / "testing" / "0001_init.sql").write_text(header + schema, encoding="utf-8", newline="\n")
print("wrote fixtures and schema")
