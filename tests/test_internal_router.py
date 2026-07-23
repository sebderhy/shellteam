"""Tests for internal router — /internal/* endpoints."""

import os


import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient

from api.main import app


class TestResolveUsername:
    def test_endpoint_removed(self):
        """/internal/resolve was an unauthenticated Cloud-era endpoint (container
        IP enumeration) with no OSS caller — it must stay gone."""
        with TestClient(app) as client:
            resp = client.get("/internal/resolve/alice")
        assert resp.status_code == 404


class TestCheckDomain:
    """GET /internal/check-domain — Caddy on-demand TLS validation.

    Caddy's `ask` probe connects from loopback; anything proxied from outside
    carries the real client IP and must be rejected (the endpoint would
    otherwise leak cert-issuance policy to the internet).
    """

    @staticmethod
    def _loopback_client():
        return TestClient(app, client=("127.0.0.1", 51000))

    def test_main_domain_allowed(self):
        with self._loopback_client() as client:
            resp = client.get("/internal/check-domain", params={"domain": "localhost"})
        assert resp.status_code == 200

    def test_valid_subdomain_allowed(self):
        with self._loopback_client() as client:
            resp = client.get("/internal/check-domain", params={"domain": "alice.localhost"})
        assert resp.status_code == 200

    def test_port_subdomain_allowed(self):
        with self._loopback_client() as client:
            resp = client.get("/internal/check-domain", params={"domain": "alice-3000.localhost"})
        assert resp.status_code == 200

    def test_foreign_domain_rejected(self):
        with self._loopback_client() as client:
            resp = client.get("/internal/check-domain", params={"domain": "evil.com"})
        assert resp.status_code == 403

    def test_missing_param_returns_422(self):
        with self._loopback_client() as client:
            resp = client.get("/internal/check-domain")
        assert resp.status_code == 422

    def test_non_loopback_client_rejected(self):
        """External requests (Caddy-proxied, real client IP) must get 403."""
        with TestClient(app, client=("203.0.113.7", 44321)) as client:
            resp = client.get("/internal/check-domain", params={"domain": "localhost"})
        assert resp.status_code == 403
