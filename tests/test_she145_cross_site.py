"""SHE-145: another website must not be able to drive the API or the cockpit
through the owner's browser."""

from unittest.mock import AsyncMock, patch

import httpx
import respx

EVIL = {"Origin": "https://evil.example", "Content-Type": "text/plain"}


def test_cross_site_simple_post_to_the_cockpit_proxy_is_refused(client, auth_header):
    # The exploit: repoint every agent at an attacker's model endpoint.
    body = '{"provider":"claude","baseUrl":"https://evil","token":"x"}'
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(url__regex=r".*/api/gateway").mock(return_value=httpx.Response(200, json={}))
        r = client.post("/api/computers/ai/gateway", content=body, headers={**auth_header, **EVIL})
        assert r.status_code == 403 and not route.called
        # Same with a sibling subdomain origin (an agent-built app).
        r = client.post("/api/computers/ai/gateway", content=body,
                        headers={**auth_header, "Origin": "http://alice-5173.localhost", "Content-Type": "text/plain"})
        assert r.status_code == 403 and not route.called


def test_every_state_changing_route_is_covered(client, auth_header):
    for method, path in (("POST", "/api/knowledge/dream/run"), ("POST", "/api/computers"),
                         ("DELETE", "/api/settings/secrets/X"), ("POST", "/api/computers/cockpit/api/github/clone")):
        r = client.request(method, path, headers={**auth_header, "Origin": "null"})
        assert r.status_code == 403, path


def test_the_cockpit_proxy_wants_json(client, auth_header):
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(url__regex=r".*/api/gateway").mock(return_value=httpx.Response(200, json={}))
        r = client.post("/api/computers/ai/gateway", content="{}", headers={**auth_header, "Content-Type": "text/plain"})
        assert r.status_code == 415 and not route.called


def test_same_origin_cockpit_proxy_serves_only_the_github_widget(client, auth_header):
    # The chat SPA renders model output; it must never run on the dashboard origin.
    for path in ("index.html", "app.js", "api/gateway", "_api/zip"):
        assert client.get(f"/api/computers/cockpit/{path}", headers=auth_header).status_code == 404, path


def test_dashboard_requests_still_pass(client, auth_header):
    r = client.post("/api/settings/secrets", headers={**auth_header, "Origin": "http://localhost"},
                    json={"name": "not a name", "value": "x"})
    assert r.status_code == 400  # reached the route


def test_token_less_box_refuses_a_rebound_name(client):
    with patch("api.main.OWNER_TOKEN", ""):
        assert client.get("/api/auth/me", headers={"Host": "rebind.evil.example"}).status_code == 421
        assert client.get("/health", headers={"Host": "100.94.1.2:8000"}).status_code == 200
        assert client.get("/health", headers={"Host": "localhost:8000"}).status_code == 200
