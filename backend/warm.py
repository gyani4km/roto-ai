"""Start-up warm-up so the first preview after a quiet period is not slow.

Cold causes on this PC: the 18 MB character is read and SHA-256 checked on the first request (about 10 s
when the file is not in the OS cache), and Windows trims the idle server's working set to a few MB, so the
next requests page-fault from disk. Both are removed here. Nothing is written; failures never stop the server.
"""
import asyncio
import os
import sys
from pathlib import Path


def pin_working_set(min_mb: int = 160, max_mb: int = 2048) -> bool:
    """Windows only: ask the OS not to trim this process below min_mb (hard minimum). Returns True if applied."""
    if sys.platform != 'win32':
        return False
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.SetProcessWorkingSetSizeEx.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t, ctypes.c_uint32]
        QUOTA_LIMITS_HARDWS_MIN_ENABLE, QUOTA_LIMITS_HARDWS_MAX_DISABLE = 0x1, 0x8
        return bool(k32.SetProcessWorkingSetSizeEx(k32.GetCurrentProcess(), min_mb << 20, max_mb << 20,
                                                   QUOTA_LIMITS_HARDWS_MIN_ENABLE | QUOTA_LIMITS_HARDWS_MAX_DISABLE))
    except Exception:
        return False


def _touch(paths: list[Path]) -> None:
    """Read the files once so they sit in the OS file cache."""
    for p in paths:
        try:
            with open(p, 'rb') as f:
                while f.read(1 << 20):
                    pass
        except OSError:
            pass


def warm_blocking(model_path: Path, extra: list[Path], inventory) -> None:
    pin_working_set()
    try:
        inventory(model_path)  # fills the checksum/inventory cache, also warms the file cache
    except Exception:
        pass
    _touch(extra)


async def warm(model_path: Path, extra: list[Path], inventory) -> None:
    if os.getenv('ROTO_WARM', '1') == '0':
        return
    await asyncio.to_thread(warm_blocking, model_path, extra, inventory)
