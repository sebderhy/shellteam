"""Tests for port visibility service — api/services/ports.py."""

import json
import os


import pytest
from unittest.mock import patch

from api.services import ports


@pytest.fixture(autouse=True)
def _clean_state():
    """Reset module-level state between tests."""
    ports._public_ports.clear()
    ports._port_activity.clear()
    yield
    ports._public_ports.clear()
    ports._port_activity.clear()


@pytest.fixture
def tmp_data_dir(tmp_path):
    with patch.object(ports, "DATA_DIR", tmp_path):
        yield tmp_path


class TestIsPortPublic:
    def test_false_by_default(self):
        assert ports.is_port_public("user-1", 3000) is False

    def test_true_after_set(self):
        ports._public_ports["user-1"] = {3000}
        assert ports.is_port_public("user-1", 3000) is True

    def test_false_for_different_port(self):
        ports._public_ports["user-1"] = {3000}
        assert ports.is_port_public("user-1", 8000) is False

    def test_false_for_different_user(self):
        ports._public_ports["user-1"] = {3000}
        assert ports.is_port_public("user-2", 3000) is False


class TestGetPublicPorts:
    def test_empty_by_default(self):
        assert ports.get_public_ports("user-1") == set()

    def test_returns_copy(self):
        ports._public_ports["user-1"] = {3000, 8080}
        result = ports.get_public_ports("user-1")
        assert result == {3000, 8080}
        result.add(9999)
        assert 9999 not in ports._public_ports["user-1"]


class TestSetPortVisibility:
    def test_set_public(self, tmp_data_dir):
        result = ports.set_port_visibility("user-1", 3000, True)
        assert result == {3000}
        assert ports.is_port_public("user-1", 3000) is True

    def test_set_private(self, tmp_data_dir):
        ports.set_port_visibility("user-1", 3000, True)
        result = ports.set_port_visibility("user-1", 3000, False)
        assert result == set()
        assert ports.is_port_public("user-1", 3000) is False

    def test_idempotent_add(self, tmp_data_dir):
        ports.set_port_visibility("user-1", 3000, True)
        result = ports.set_port_visibility("user-1", 3000, True)
        assert result == {3000}

    def test_idempotent_remove(self, tmp_data_dir):
        result = ports.set_port_visibility("user-1", 3000, False)
        assert result == set()

    def test_multiple_ports(self, tmp_data_dir):
        ports.set_port_visibility("user-1", 3000, True)
        ports.set_port_visibility("user-1", 8080, True)
        result = ports.set_port_visibility("user-1", 9000, True)
        assert result == {3000, 8080, 9000}

    def test_max_limit(self, tmp_data_dir):
        with patch.object(ports, "MAX_PUBLIC_PORTS", 2):
            ports.set_port_visibility("user-1", 3000, True)
            ports.set_port_visibility("user-1", 8080, True)
            with pytest.raises(ValueError, match="Maximum of 2"):
                ports.set_port_visibility("user-1", 9000, True)

    def test_max_limit_idempotent_doesnt_count(self, tmp_data_dir):
        """Re-adding an existing port shouldn't trigger the limit."""
        with patch.object(ports, "MAX_PUBLIC_PORTS", 2):
            ports.set_port_visibility("user-1", 3000, True)
            ports.set_port_visibility("user-1", 8080, True)
            ports.set_port_visibility("user-1", 3000, True)  # no error

    def test_remove_then_add_within_limit(self, tmp_data_dir):
        with patch.object(ports, "MAX_PUBLIC_PORTS", 2):
            ports.set_port_visibility("user-1", 3000, True)
            ports.set_port_visibility("user-1", 8080, True)
            ports.set_port_visibility("user-1", 3000, False)
            result = ports.set_port_visibility("user-1", 9000, True)
            assert result == {8080, 9000}


class TestPersistence:
    def test_persists_to_disk(self, tmp_data_dir):
        ports.set_port_visibility("user-1", 3000, True)
        path = tmp_data_dir / "user-1" / "public_ports.json"
        assert path.exists()
        assert json.loads(path.read_text()) == [3000]

    def test_removes_file_when_empty(self, tmp_data_dir):
        ports.set_port_visibility("user-1", 3000, True)
        ports.set_port_visibility("user-1", 3000, False)
        path = tmp_data_dir / "user-1" / "public_ports.json"
        assert not path.exists()

    def test_round_trip(self, tmp_data_dir):
        ports.set_port_visibility("user-1", 3000, True)
        ports.set_port_visibility("user-1", 8080, True)
        ports._public_ports.clear()
        assert ports.is_port_public("user-1", 3000) is False
        ports.seed_from_disk()
        assert ports.is_port_public("user-1", 3000) is True
        assert ports.is_port_public("user-1", 8080) is True

    def test_persists_activity_to_disk(self, tmp_data_dir):
        ports.record_port_hit("user-1", 3000, timestamp=123.0)
        path = tmp_data_dir / "user-1" / "port_activity.json"
        assert path.exists()
        data = json.loads(path.read_text())
        assert data["3000"]["last_hit_at"] == 123.0
        assert data["3000"]["hit_count"] == 1


class TestSeedFromDisk:
    def test_no_data_dir(self, tmp_path):
        with patch.object(ports, "DATA_DIR", tmp_path / "nonexistent"):
            assert ports.seed_from_disk() == 0

    def test_empty_data_dir(self, tmp_data_dir):
        assert ports.seed_from_disk() == 0

    def test_loads_multiple_users(self, tmp_data_dir):
        (tmp_data_dir / "user-1").mkdir()
        (tmp_data_dir / "user-1" / "public_ports.json").write_text("[3000]")
        (tmp_data_dir / "user-2").mkdir()
        (tmp_data_dir / "user-2" / "public_ports.json").write_text("[8080, 9000]")
        count = ports.seed_from_disk()
        assert count == 2
        assert ports.is_port_public("user-1", 3000)
        assert ports.is_port_public("user-2", 8080)
        assert ports.is_port_public("user-2", 9000)

    def test_skips_invalid_json(self, tmp_data_dir):
        (tmp_data_dir / "user-1").mkdir()
        (tmp_data_dir / "user-1" / "public_ports.json").write_text("not json")
        assert ports.seed_from_disk() == 0

    def test_skips_dirs_without_file(self, tmp_data_dir):
        (tmp_data_dir / "user-1").mkdir()
        assert ports.seed_from_disk() == 0

    def test_loads_activity_file(self, tmp_data_dir):
        (tmp_data_dir / "user-1").mkdir()
        (tmp_data_dir / "user-1" / "public_ports.json").write_text("[3000]")
        (tmp_data_dir / "user-1" / "port_activity.json").write_text(
            '{"3000": {"last_hit_at": 50.0, "hit_count": 3}}'
        )
        ports.seed_from_disk()
        activity = ports.get_port_activity("user-1")
        assert activity[3000]["last_hit_at"] == 50.0
        assert activity[3000]["hit_count"] == 3


class TestPortActivity:
    def test_record_port_hit_tracks_count_and_last_hit(self, tmp_data_dir):
        ports.record_port_hit("user-1", 3000, timestamp=100.0)
        ports.record_port_hit("user-1", 3000, timestamp=200.0)
        activity = ports.get_port_activity("user-1")
        assert activity[3000]["last_hit_at"] == 200.0
        assert activity[3000]["hit_count"] == 2

    def test_cleanup_stale_public_ports(self, tmp_data_dir):
        ports.set_port_visibility("user-1", 3000, True)
        ports.set_port_visibility("user-1", 8080, True)
        ports.record_port_hit("user-1", 8080, timestamp=900.0)
        closed = ports.cleanup_stale_public_ports("user-1", older_than_seconds=950.0)
        assert closed == [3000, 8080]
        assert ports.get_public_ports("user-1") == set()

    def test_cleanup_keeps_recent_public_ports(self, tmp_data_dir):
        ports.set_port_visibility("user-1", 3000, True)
        ports.record_port_hit("user-1", 3000, timestamp=1000.0)
        closed = ports.cleanup_stale_public_ports("user-1", older_than_seconds=900.0)
        assert closed == []
        assert ports.get_public_ports("user-1") == {3000}
