#!/usr/bin/env python3
"""Build ENGAGE into one self-contained HTML file.

Inputs
  src/Engage.html        the main app, with three placeholders
  src/ProjectBrief.html  the Project brief app (shown inside the main app)
  data/register.json     the interface register   (REG_PACK)
  data/statutory.json    the statutory approvals  (SAD)
  VERSION                version label and build date (the app's ENGAGE_BUILD)

Output
  dist/Engage.html       the single file people open in a browser

The placeholders in src/Engage.html are:
  /*@@DATA register.json@@*/    replaced by the contents of data/register.json
  /*@@DATA statutory.json@@*/   replaced by the contents of data/statutory.json
  @@BRIEF_BASE64@@              replaced by src/ProjectBrief.html, base64-encoded

Usage
  python3 tools/build.py              build dist/Engage.html
  python3 tools/build.py --check FILE build and confirm the result is
                                      byte-identical to FILE (used to prove the
                                      split of v132 lost nothing)
  python3 tools/build.py --data DIR   read the data files from DIR instead of
                                      data/ (for example a private folder)
"""
import argparse
import base64
import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA_RE = re.compile(rb"/\*@@DATA ([A-Za-z0-9_.-]+)@@\*/")
BRIEF_MARK = b"@@BRIEF_BASE64@@"


def read_data(data_dir: pathlib.Path, name: bytes) -> bytes:
    path = data_dir / name.decode()
    if not path.exists():
        sys.exit(f"build: missing data file {path}")
    body = path.read_bytes()
    # Data files end with one newline for tidy diffs; the app line does not.
    if body.endswith(b"\n"):
        body = body[:-1]
    return body


def build(data_dir: pathlib.Path) -> bytes:
    main = (ROOT / "src" / "Engage.html").read_bytes()
    brief = (ROOT / "src" / "ProjectBrief.html").read_bytes()

    if main.count(BRIEF_MARK) != 1:
        sys.exit("build: src/Engage.html must contain @@BRIEF_BASE64@@ exactly once")
    names = DATA_RE.findall(main)
    if sorted(names) != [b"register.json", b"statutory.json"]:
        sys.exit(f"build: unexpected data placeholders {names}")

    version, built = read_version()
    brief = brief.replace(b"@@VERSION@@", version).replace(b"@@BUILT@@", built)
    main = main.replace(b"@@VERSION@@", version).replace(b"@@BUILT@@", built)
    has_csp = CSP_MARK in main
    if has_csp:
        if brief.count(CSP_MARK) != 1 or main.count(CSP_MARK) != 1:
            sys.exit("build: @@CSP@@ must appear once in each source file")
        brief_hashes = script_hashes(brief)
        brief = brief.replace(CSP_MARK, csp(brief_hashes))
    out = DATA_RE.sub(lambda m: read_data(data_dir, m.group(1)), main)
    out = out.replace(BRIEF_MARK, base64.b64encode(brief))
    if has_csp:
        # The Project brief runs in a srcdoc frame, which inherits this page's policy,
        # so the page's policy must allow the brief's scripts as well as its own.
        out = out.replace(CSP_MARK, csp(script_hashes(out) + brief_hashes))
    return out


CSP_MARK = b"@@CSP@@"
SCRIPT_RE = re.compile(rb"<script(?:\s[^>]*)?>(.*?)</script", re.S | re.I)
# The one inline event handler the app writes into its markup (a <select> in the
# programme allocation table). Allowed by hash rather than rewriting that code.
INLINE_HANDLERS = [b"event.stopPropagation()"]


def sha(b: bytes) -> bytes:
    return b"'sha256-" + base64.b64encode(hashlib.sha256(b).digest()) + b"'"


def script_hashes(html: bytes) -> list:
    return [sha(m.group(1)) for m in SCRIPT_RE.finditer(html)]


def csp(hashes: list) -> bytes:
    """Content-Security-Policy: only the app's own scripts may run (each is allowed by its
    SHA-256 hash), nothing is fetched from the network, and project text that slips into
    the page as markup cannot run code, load anything or submit forms."""
    seen = []
    for h in hashes + [sha(x) for x in INLINE_HANDLERS]:
        if h not in seen:
            seen.append(h)
    parts = [
        b"default-src 'none'",
        b"script-src " + b" ".join(seen) + b" 'unsafe-hashes'",
        b"style-src 'unsafe-inline'",
        b"img-src data: blob:",
        b"font-src data:",
        b"connect-src 'none'",
        b"frame-src 'self' data: blob:",
        b"object-src 'none'",
        b"base-uri 'none'",
        b"form-action 'none'",
    ]
    return b"; ".join(parts)


def read_version():
    """VERSION holds two lines: the version label (e.g. v133) and the build date.
    It is the one place the version is set; the app reads it as ENGAGE_BUILD."""
    path = ROOT / "VERSION"
    if not path.exists():  # the v132 baseline had no VERSION file
        return b"@@VERSION@@", b"@@BUILT@@"
    lines = [x.strip() for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
    if len(lines) != 2 or not re.fullmatch(r"v\d+(\.\d+)*", lines[0]):
        sys.exit("build: VERSION must have two lines: a label like v133, then the build date")
    return lines[0].encode(), lines[1].encode()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", metavar="FILE", help="compare the build with FILE byte for byte")
    ap.add_argument("--data", metavar="DIR", default=str(ROOT / "data"))
    ap.add_argument("--out", metavar="FILE", default=str(ROOT / "dist" / "Engage.html"))
    args = ap.parse_args()

    out = build(pathlib.Path(args.data))
    dest = pathlib.Path(args.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(out)
    digest = hashlib.sha256(out).hexdigest()
    print(f"built {dest} ({len(out):,} bytes, sha256 {digest})")

    if args.check:
        ref = pathlib.Path(args.check).read_bytes()
        if ref == out:
            print(f"identical to {args.check}")
        else:
            n = next((i for i, (a, b) in enumerate(zip(ref, out)) if a != b), min(len(ref), len(out)))
            sys.exit(f"DIFFERENT from {args.check}: first difference at byte {n}")


if __name__ == "__main__":
    main()
