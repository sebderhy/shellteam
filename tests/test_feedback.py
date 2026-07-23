"""Tests for in-product feedback (api/services/feedback.py + api/routers/feedback.py).

Covers the proof-of-work primitives, the per-box install id, and the endpoint's
validation + forwarding (the relay is mocked — these never hit the network).
"""

import hashlib
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from api.services import feedback


# ---------------------------------------------------------------------------
# Proof-of-work primitives
# ---------------------------------------------------------------------------
class TestProofOfWork:
    def test_leading_zero_bits_counts_bitwise(self):
        assert feedback._leading_zero_bits(bytes([0xFF])) == 0
        assert feedback._leading_zero_bits(bytes([0x0F])) == 4
        assert feedback._leading_zero_bits(bytes([0x00, 0xFF])) == 8
        assert feedback._leading_zero_bits(bytes([0x00, 0x01])) == 15

    def test_solve_pow_meets_difficulty(self):
        iid, ts, bits = "boxabc", 1_700_000_000, 12
        nonce = feedback.solve_pow(iid, ts, bits)
        digest = hashlib.sha256(f"{iid}:{ts}:{nonce}".encode()).digest()
        assert feedback._leading_zero_bits(digest) >= bits

    def test_solve_pow_is_verifiable_the_cheap_way(self):
        # The relay re-checks with a single hash — assert that exact check holds.
        iid, ts, bits = "anotherbox", 1_700_000_001, 10
        nonce = feedback.solve_pow(iid, ts, bits)
        recomputed = hashlib.sha256(f"{iid}:{ts}:{nonce}".encode()).digest()
        assert feedback._leading_zero_bits(recomputed) >= bits


# ---------------------------------------------------------------------------
# Install id — stable, anonymous, persisted once
# ---------------------------------------------------------------------------
class TestInstallId:
    def test_install_id_is_persisted_and_stable(self, tmp_path: Path, monkeypatch):
        monkeypatch.setattr(feedback, "INSTALL_ID_FILE", tmp_path / ".shellteam" / "feedback-install-id")
        first = feedback.install_id()
        assert first and len(first) == 32
        assert feedback.install_id() == first  # stable across calls
        assert (tmp_path / ".shellteam" / "feedback-install-id").read_text().strip() == first


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------
class TestFeedbackEndpoint:
    def test_rejects_unknown_kind(self, client, auth_header):
        resp = client.post("/api/feedback", headers=auth_header, data={"kind": "rant", "description": "x"})
        assert resp.status_code == 422

    def test_requires_description_or_voice(self, client, auth_header):
        resp = client.post("/api/feedback", headers=auth_header, data={"kind": "bug", "description": "  "})
        assert resp.status_code == 422

    def test_disabled_when_relay_url_unset(self, client, auth_header):
        with patch.object(feedback, "RELAY_URL", ""):
            resp = client.post("/api/feedback", headers=auth_header, data={"kind": "bug", "description": "hi"})
        assert resp.status_code == 503

    def test_forwards_bug_and_returns_issue_url(self, client, auth_header):
        sent = AsyncMock(return_value={"ok": True, "issue_url": "https://linear.app/team/issue/SHE-9"})
        with patch.object(feedback, "forward", sent):
            resp = client.post(
                "/api/feedback",
                headers=auth_header,
                data={"kind": "bug", "description": "It crashes on save"},
            )
        assert resp.status_code == 200
        assert resp.json()["issue_url"].endswith("SHE-9")
        kwargs = sent.await_args.kwargs
        assert kwargs["kind"] == "bug"
        assert kwargs["description"] == "It crashes on save"
        assert kwargs["meta"]["app_domain"] == "localhost"

    def test_rejects_non_image_screenshot(self, client, auth_header):
        with patch.object(feedback, "forward", AsyncMock(return_value={"ok": True})):
            resp = client.post(
                "/api/feedback",
                headers=auth_header,
                data={"kind": "bug", "description": "see attached"},
                files=[("screenshots", ("notes.txt", b"hello", "text/plain"))],
            )
        assert resp.status_code == 415

    def test_voice_only_report_is_transcribed(self, client, auth_header):
        sent = AsyncMock(return_value={"ok": True})
        with patch.object(feedback, "forward", sent), \
             patch("api.routers.feedback.stt.transcribe", AsyncMock(return_value="the save button is broken")):
            resp = client.post(
                "/api/feedback",
                headers=auth_header,
                data={"kind": "feature"},
                files=[("voice_recording", ("voice.webm", b"\x00\x01", "audio/webm"))],
            )
        assert resp.status_code == 200
        assert sent.await_args.kwargs["transcript"] == "the save button is broken"


# ---------------------------------------------------------------------------
# Attribution — owner vs. employee guest may both send; the relay must be told
# which, so a guest can never be mistaken for the owner (or vice-versa).
# ---------------------------------------------------------------------------
class TestFeedbackAttribution:

    def test_owner_submission_is_labelled_owner(self, client, auth_header):
        sent = AsyncMock(return_value={"ok": True})
        with patch.object(feedback, "forward", sent):
            resp = client.post(
                "/api/feedback", headers=auth_header,
                data={"kind": "bug", "description": "owner here"},
            )
        assert resp.status_code == 200
        meta = sent.await_args.kwargs["meta"]
        assert meta["submitted_by"] == "owner"
        assert "guest_folder" not in meta


    def test_unauthenticated_feedback_is_rejected(self, client):
        with patch.object(feedback, "forward", AsyncMock(return_value={"ok": True})) as sent:
            resp = client.post("/api/feedback", data={"kind": "bug", "description": "hi"})
        assert resp.status_code == 401
        sent.assert_not_awaited()

