try:
    from ._version import version
except ImportError:
    # In source-only deployments, generated _version.py may be absent.
    version = "0.0.0"

__version__ = version
