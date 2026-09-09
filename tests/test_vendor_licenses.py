"""Compliance gate for third-party content redistributed in the repository.

Covers the vendored JavaScript assets AND the Impeccable design skills under
.agents/skills/ (Apache-2.0, pbakaus/impeccable) — QA-04 found the skills were
redistributed with no local license text and no NOTICE attribution, and this
test's inventory previously looked only at the two JS vendor directories.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "third_party" / "vendor-manifest.json"
VENDOR_DIRS = (
    ROOT / "computer" / "ai-chat" / "public" / "vendor",
    ROOT / "frontend" / "static" / "vendor",
    ROOT / ".agents" / "skills",
)


def test_every_vendored_asset_has_a_verified_license_record() -> None:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    records: dict[str, str] = {}

    for package in data["packages"]:
        assert package["version"]
        assert package["source"].startswith("https://")
        assert package["license"]
        license_path = ROOT / package["license_file"]
        assert license_path.is_file(), f"missing license for {package['name']}"
        assert len(license_path.read_text(encoding="utf-8")) > 500
        for path, digest in package["files"].items():
            assert path not in records, f"duplicate vendor manifest entry: {path}"
            records[path] = digest

    actual = {
        str(path.relative_to(ROOT))
        for directory in VENDOR_DIRS
        for path in directory.rglob("*")
        if path.is_file()
    }
    assert set(records) == actual, (
        "vendor manifest and redistributed files differ: "
        f"unrecorded={sorted(actual - set(records))} "
        f"stale={sorted(set(records) - actual)}. Every redistributed file "
        "needs a manifest record pointing at its license."
    )

    for relative_path, expected_digest in records.items():
        digest = hashlib.sha256((ROOT / relative_path).read_bytes()).hexdigest()
        assert digest == expected_digest, (
            f"unreviewed vendor asset change: {relative_path}"
        )


def test_notice_attributes_every_vendored_package() -> None:
    """A new vendored lib must land in NOTICE, not just the manifest."""
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    notice = (ROOT / "NOTICE").read_text(encoding="utf-8").lower()
    for package in data["packages"]:
        assert package["name"].lower() in notice, (
            f"{package['name']} is in the vendor manifest but not attributed in NOTICE"
        )
