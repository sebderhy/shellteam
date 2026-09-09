"""Round-6 audit P2-02: the global rate limit must answer 429, not crash to 500.

The limiter raises FastAPI's ``HTTPException``, which route-level exception
handling converts to a response — but ``global_rate_limit`` is user middleware
and runs OUTSIDE that handling, so an exhausted bucket surfaced as a traceback
and ``500 Internal Server Error``. This exercises the SHIPPING app + middleware
stack (the existing ratelimit tests cover ``RateLimiter`` only as a route
dependency, where 429 always worked).
"""

from fastapi.testclient import TestClient

import api.main as main_mod
from api.services.ratelimit import RateLimiter


def test_exhausted_global_bucket_returns_429_not_500(monkeypatch):
    monkeypatch.setattr(main_mod, "_global_limit", RateLimiter(rate=2, period=60))
    # raise_server_exceptions=False: on the broken code the escaped exception
    # becomes a 500 response here instead of failing the test at the transport.
    with TestClient(main_mod.app, raise_server_exceptions=False) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/health").status_code == 200
        limited = client.get("/health")
        assert limited.status_code == 429, (
            f"expected a real 429 from the middleware, got {limited.status_code}"
        )
        assert limited.json() == {"detail": "Too many requests"}
