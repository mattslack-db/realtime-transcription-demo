from .core import create_app
from .router import router
from . import whisperlive_lifespan  # noqa: F401 - register WhisperLive server lifespan

app = create_app(routers=[router])
