from pydantic import BaseModel


class ComputerStatus(BaseModel):
    status: str
    container_id: str | None = None
    username: str | None = None
    public_url: str | None = None

