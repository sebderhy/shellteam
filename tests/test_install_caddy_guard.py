"""Regression: the Caddyfile guard must not block ShellTeam's own install.

`apt install caddy` (done by install.sh itself) plants a distro-default
/etc/caddy/Caddyfile. The operator-config guard treated that packaged default
as "your own site config" and died — so a fresh cloud box could never finish
a --domain/--remote install. caddyfile_is_pristine_default() proves the file
is the never-edited package conffile via dpkg's recorded md5; these tests run
the REAL function from install.sh against a shimmed dpkg-query.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _extracted_function() -> str:
    source = (ROOT / "install.sh").read_text(encoding="utf-8")
    match = re.search(
        r"^caddyfile_is_pristine_default\(\) \{.*?^\}", source, re.DOTALL | re.MULTILINE
    )
    assert match, "caddyfile_is_pristine_default not found in install.sh"
    return match.group(0)


def _run_guard(tmp_path: Path, content: str, recorded_md5: str | None) -> int:
    caddyfile = tmp_path / "Caddyfile"
    caddyfile.write_text(content, encoding="utf-8")

    shim_dir = tmp_path / "bin"
    shim_dir.mkdir(exist_ok=True)
    shim = shim_dir / "dpkg-query"
    if recorded_md5 is None:
        shim.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    else:
        shim.write_text(
            f'#!/bin/sh\nprintf "%s\\n" " {caddyfile} {recorded_md5}"\n',
            encoding="utf-8",
        )
    shim.chmod(0o755)

    script = "\n".join(
        [
            "set -uo pipefail",
            f'export PATH="{shim_dir}:$PATH"',
            _extracted_function(),
            f'caddyfile_is_pristine_default "{caddyfile}"',
        ]
    )
    return subprocess.run(
        ["bash", "-c", script], capture_output=True, timeout=10
    ).returncode


def test_unmodified_package_default_is_pristine(tmp_path: Path) -> None:
    content = "# stock caddy config\n:80 {\n}\n"
    md5 = hashlib.md5(content.encode()).hexdigest()
    assert _run_guard(tmp_path, content, md5) == 0


def test_operator_edited_caddyfile_is_not_pristine(tmp_path: Path) -> None:
    content = "mysite.example {\n  reverse_proxy :3000\n}\n"
    md5 = hashlib.md5(b"something else").hexdigest()
    assert _run_guard(tmp_path, content, md5) != 0


def test_no_dpkg_record_fails_closed(tmp_path: Path) -> None:
    """No conffile record (caddy from a tarball, non-Debian) => treat as
    operator config — the guard must fail CLOSED."""
    assert _run_guard(tmp_path, ":80 {\n}\n", None) != 0
