"""The Composio SDK must never report calls to telemetry.composio.dev.

Regression (2026-09-25): a box with a Composio key POSTed a metric to
telemetry.composio.dev on startup. The SDK's ``allow_tracking=False`` only
covers the context that built the client, so ShellTeam turns the default off
for the whole process; these tests fail if an SDK upgrade moves that switch.
"""

import contextvars
import threading
from unittest.mock import patch

import composio.core.models.base as sdk_base

from api.services import composio as composio_svc


class _Traced:
    class _client:
        provider = "test"

    def call(self):
        return "ran"


def _traced_call_in_fresh_context():
    wrapped = sdk_base.trace_method(_Traced.call, "Traced.call")
    return contextvars.Context().run(wrapped, _Traced())


def test_sdk_traces_calls_by_default():
    """Guards the test itself: without ShellTeam's switch the SDK does report."""
    with patch.object(sdk_base, "allow_tracking", contextvars.ContextVar("t", default=True)), \
            patch.object(sdk_base, "push_event") as push:
        assert _traced_call_in_fresh_context() == "ran"
    assert push.called


def test_client_creation_disables_telemetry_in_every_context(monkeypatch):
    monkeypatch.setenv("COMPOSIO_API_KEY", "ak_test")
    monkeypatch.setattr(composio_svc, "_client", None)
    original = sdk_base.allow_tracking
    try:
        with patch("composio.Composio") as sdk_client:
            composio_svc._get_client()
        assert sdk_client.call_args.kwargs["allow_tracking"] is False
        with patch.object(sdk_base, "push_event") as push:
            assert _traced_call_in_fresh_context() == "ran"
            worker = threading.Thread(target=_traced_call_in_fresh_context)
            worker.start()
            worker.join()
        assert not push.called
    finally:
        sdk_base.allow_tracking = original
        composio_svc._client = None
