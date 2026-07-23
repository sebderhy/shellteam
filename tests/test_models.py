"""Tests for Pydantic models."""

import pytest
from pydantic import ValidationError

from api.models.schemas import ComputerStatus


class TestComputerStatus:
    def test_full_status(self):
        s = ComputerStatus(
            status="running",
            container_id="abc123",
            username="alice",
            public_url="https://alice.shellteam.sh",
        )
        assert s.status == "running"
        assert s.container_id == "abc123"
        assert s.username == "alice"
        assert s.public_url == "https://alice.shellteam.sh"

    def test_minimal_status(self):
        s = ComputerStatus(status="stopped")
        assert s.status == "stopped"
        assert s.container_id is None
        assert s.username is None
        assert s.public_url is None

    def test_status_required(self):
        with pytest.raises(ValidationError):
            ComputerStatus()


