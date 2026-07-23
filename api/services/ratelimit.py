"""In-memory token-bucket rate limiter.

Usage as a FastAPI dependency:

    from api.services.ratelimit import RateLimiter

    _limit = RateLimiter(rate=5, period=60)  # 5 requests per 60 seconds

    @router.post("/foo")
    async def foo(request: Request, _=Depends(_limit)):
        ...

By default the bucket key is the client IP.  Pass `key="user"` to key by
authenticated user ID instead (requires `get_current_user` to have run first).
"""

import logging
import time
from dataclasses import dataclass, field

from fastapi import HTTPException, Request

log = logging.getLogger(__name__)

# Buckets older than this (seconds) are purged on the next cleanup pass.
_STALE_SECONDS = 600


@dataclass
class _Bucket:
    tokens: float
    last_refill: float


@dataclass(eq=False)
class RateLimiter:
    """Token-bucket rate limiter usable as a FastAPI ``Depends()`` callable.

    Parameters
    ----------
    rate:
        Maximum number of requests allowed in *period* seconds.
    period:
        Window length in seconds (default 60).
    key:
        ``"ip"`` (default) — bucket per client IP.
        ``"user"`` — bucket per authenticated user ID (reads ``request.state.user``).
    """

    rate: int
    period: int = 60
    key: str = "ip"
    _buckets: dict[str, _Bucket] = field(default_factory=dict, repr=False)
    _last_cleanup: float = field(default_factory=time.monotonic, repr=False)

    # -- FastAPI dependency interface --

    async def __call__(self, request: Request) -> None:
        bucket_key = self._resolve_key(request)
        if not self._allow(bucket_key):
            raise HTTPException(status_code=429, detail="Too many requests")

    def allow(self, request: Request) -> bool:
        """Consume one token for *request*'s key; return False if the bucket is empty.

        Unlike ``__call__`` this never raises — callers decide what to do when the
        limit is hit (e.g. record a failed auth attempt and escalate to 429).
        """
        return self._allow(self._resolve_key(request))

    def allow_key(self, key: str) -> bool:
        """Consume one token for an explicit bucket key. For handlers that know
        a better identity than the client IP (e.g. the ship gate's per-guest
        requester — all employee containers NAT through one host address, so an
        IP bucket would let one chatty guest starve the others)."""
        return self._allow(key)

    # -- core logic --

    def _resolve_key(self, request: Request) -> str:
        if self.key == "user":
            # Populated by get_current_user or manually on request.state
            user = getattr(request.state, "rate_limit_user_id", None)
            if user:
                return f"user:{user}"
            # Fall back to IP if user ID not available
        ip = request.client.host if request.client else "unknown"
        return f"ip:{ip}"

    def _allow(self, key: str) -> bool:
        now = time.monotonic()
        self._maybe_cleanup(now)

        bucket = self._buckets.get(key)
        if bucket is None:
            # First request — full bucket minus this request
            self._buckets[key] = _Bucket(tokens=self.rate - 1, last_refill=now)
            return True

        # Refill tokens based on elapsed time
        elapsed = now - bucket.last_refill
        bucket.tokens = min(self.rate, bucket.tokens + elapsed * (self.rate / self.period))
        bucket.last_refill = now

        if bucket.tokens >= 1:
            bucket.tokens -= 1
            return True
        return False

    def reset(self) -> None:
        """Clear all buckets. Useful for testing."""
        self._buckets.clear()

    def _maybe_cleanup(self, now: float) -> None:
        if now - self._last_cleanup < _STALE_SECONDS:
            return
        self._last_cleanup = now
        stale_cutoff = now - _STALE_SECONDS
        stale_keys = [k for k, b in self._buckets.items() if b.last_refill < stale_cutoff]
        for k in stale_keys:
            del self._buckets[k]


# Dedicated limiter for *failed* auth attempts. On a public bind, OWNER_TOKEN is
# the whole security boundary on a no-isolation box, so a wrong-token guess must
# be cheap to make only a few times per IP. A caller presenting the correct token
# never reaches this — only failures consume a token, so legitimate use is never
# throttled. 10 bad tokens / minute / IP, then 429 (the global 120/min net is far
# too loose to slow a dictionary attack).
auth_failure_limiter = RateLimiter(rate=10, period=60)


def note_auth_failure(request: Request) -> None:
    """Record a failed authentication for *request*'s IP; raise 429 once an IP
    has exceeded the failed-attempt budget. Call this on every rejected token."""
    if not auth_failure_limiter.allow(request):
        ip = request.client.host if request.client else "unknown"
        log.warning("Auth-failure backoff tripped for %s — too many bad tokens", ip)
        raise HTTPException(
            status_code=429, detail="Too many failed authentication attempts"
        )
