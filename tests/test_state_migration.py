"""Tests for the startup control-plane state migration (config.migrate_legacy_state_dir).

The DATA_DIR default moved off /data/users; git-pull upgrades don't run install.sh,
so the API migrates on startup. These pin the module globals the function reads.
"""

import api.config as config


def _setup(monkeypatch, tmp_path, *, overridden, seed_legacy=True):
    legacy_root = tmp_path / "legacy"
    data_dir = tmp_path / "state"
    monkeypatch.setattr(config, "OWNER_ID", "owner-x")
    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setattr(config, "_LEGACY_DATA_DIR", legacy_root)
    monkeypatch.setattr(config, "DATA_DIR_OVERRIDDEN", overridden)
    if seed_legacy:
        legacy_owner = legacy_root / "owner-x"
        legacy_owner.mkdir(parents=True)
        (legacy_owner / "ports.json").write_text('{"3000": true}')
    return data_dir / "owner-x"


def test_migrates_when_default_and_legacy_present(monkeypatch, tmp_path):
    target = _setup(monkeypatch, tmp_path, overridden=False)
    config.migrate_legacy_state_dir()
    assert (target / "ports.json").read_text() == '{"3000": true}'


def test_noop_when_data_dir_overridden(monkeypatch, tmp_path):
    target = _setup(monkeypatch, tmp_path, overridden=True)
    config.migrate_legacy_state_dir()
    assert not target.exists()  # Cloud / explicit DATA_DIR — never touched


def test_noop_when_legacy_absent(monkeypatch, tmp_path):
    target = _setup(monkeypatch, tmp_path, overridden=False, seed_legacy=False)
    config.migrate_legacy_state_dir()
    assert not target.exists()


def test_does_not_clobber_existing_state(monkeypatch, tmp_path):
    target = _setup(monkeypatch, tmp_path, overridden=False)
    target.mkdir(parents=True)
    (target / "ports.json").write_text('{"9999": true}')  # newer state already there
    config.migrate_legacy_state_dir()
    assert (target / "ports.json").read_text() == '{"9999": true}'  # untouched
