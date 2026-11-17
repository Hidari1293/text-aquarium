"""Grab the Text Aquarium windows for visual verification.

Dev tool only (needs Pillow). It restores the target window, raises it just long
enough to take the shot, then puts it back where it was.

    python scripts/grab.py tank  C:/tmp/tank.png
    python scripts/grab.py overlay C:/tmp/overlay.png --keep
"""

import ctypes
import sys
import time
from ctypes import wintypes as wt

from PIL import ImageGrab

user32 = ctypes.WinDLL("user32", use_last_error=True)

# Without this, GetWindowRect reports DPI-virtualised coordinates while
# ImageGrab works in physical pixels, and the crop lands in the wrong place.
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # per-monitor v2
except Exception:  # pragma: no cover - old Windows
    ctypes.windll.user32.SetProcessDPIAware()

TITLES = {
    "tank": "Text Aquarium",
    "overlay": "Text Aquarium Overlay",
}

HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
SWP_NOMOVE = 0x0002
SWP_NOSIZE = 0x0001
SWP_SHOWWINDOW = 0x0040
SW_RESTORE = 9
SW_MINIMIZE = 6

user32.FindWindowW.restype = wt.HWND
user32.FindWindowW.argtypes = [wt.LPCWSTR, wt.LPCWSTR]
user32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
user32.SetWindowPos.argtypes = [
    wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wt.UINT
]
user32.SetForegroundWindow.argtypes = [wt.HWND]
user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
user32.IsWindowVisible.argtypes = [wt.HWND]


def find(title: str):
    hwnd = user32.FindWindowW(None, title)
    return hwnd or None


def main() -> int:
    key = sys.argv[1] if len(sys.argv) > 1 else "tank"
    out = sys.argv[2] if len(sys.argv) > 2 else f"C:/tmp/{key}.png"
    keep = "--keep" in sys.argv

    hwnd = find(TITLES.get(key, key))
    if not hwnd:
        print(f"window not found: {key}")
        return 1
    if not user32.IsWindowVisible(hwnd):
        print(f"window is hidden: {key}")
        return 2

    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
    user32.SetForegroundWindow(hwnd)
    time.sleep(1.1)

    rect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    box = (rect.left, rect.top, rect.right, rect.bottom)
    img = ImageGrab.grab(bbox=box, all_screens=True)
    img.save(out)
    print(f"saved {out} {img.size} from {box}")

    if not keep:
        user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE)
        user32.ShowWindow(hwnd, SW_MINIMIZE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
