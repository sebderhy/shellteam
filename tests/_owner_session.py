"""Real owner sessions for tests (SHE-136): cookies carry a minted session,
never OWNER_TOKEN, so tests that need a signed-in browser mint one here."""

from api.services import sessions


def session_token(fresh: bool = True) -> str:
    """A live session-cookie value (``shellteam_token``)."""
    return sessions.mint("test", fresh=fresh).token


def files_token() -> str:
    """A live read-only files credential (``shellteam_files``), bound to a new session."""
    return sessions.mint("test").files_cred
