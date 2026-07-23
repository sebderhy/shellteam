"""Runtime facade used by the API routers."""

from api.services import processes as _native


def _backend():
    return _native


async def get_status(user_id: str = ""):
    return await _backend().get_status(user_id)


async def start_computer(user_id: str = "", username: str = "", email: str = ""):
    return await _backend().start_computer(user_id, username, email=email)


async def stop_computer(user_id: str = ""):
    return await _backend().stop_computer(user_id)


async def recreate_container(user_id: str = "", username: str = "", email: str = ""):
    return await _backend().recreate_container(user_id, username, email)


async def get_container_ip(user_id: str = ""):
    return await _backend().get_container_ip(user_id)


async def resolve_username(username: str):
    return await _backend().resolve_username(username)


async def resolve_username_owner(username: str):
    return await _backend().resolve_username_owner(username)


async def verify_container_ip(user_id: str, source_ip: str):
    return await _backend().verify_container_ip(user_id, source_ip)


async def exec_create(user_id: str = ""):
    return await _backend().exec_create(user_id)


def exec_start(exec_id):
    return _backend().exec_start(exec_id)


def exec_resize(exec_id, height: int, width: int):
    return _backend().exec_resize(exec_id, height=height, width=width)


def user_home_dir(user_id: str = ""):
    return _backend().user_home_dir(user_id)
