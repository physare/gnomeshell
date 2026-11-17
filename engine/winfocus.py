"""
Open a file or folder the way a double click does, and bring the window it
opens to the front.

GnomeShell's engine runs in the background (Blender with no window), and
Windows doesn't let a background program put another window in front: the
folder or Bambu Studio opened behind GnomeShell's window, or only flashed in
the taskbar, so nothing seemed to happen. This watches for the window that
opens (the Explorer window for the folder, or the program that opens the
file, such as Bambu Studio) and brings it forward.

Nothing here needs Blender. On anything but Windows it only opens the target.
"""

import os
import subprocess
import sys
import threading
import time

_WIN = sys.platform == "win32"

if _WIN:
    import ctypes
    from ctypes import wintypes

    _u = ctypes.WinDLL("user32", use_last_error=True)
    _k = ctypes.WinDLL("kernel32", use_last_error=True)
    _sh = ctypes.WinDLL("shell32", use_last_error=True)
    _ENUM = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    _u.EnumWindows.argtypes = [_ENUM, wintypes.LPARAM]
    _u.IsWindowVisible.argtypes = [wintypes.HWND]
    _u.IsIconic.argtypes = [wintypes.HWND]
    _u.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    _u.GetWindow.restype = wintypes.HWND
    _u.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    _u.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    _u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    _u.GetWindowThreadProcessId.restype = wintypes.DWORD
    _u.GetForegroundWindow.restype = wintypes.HWND
    _u.SetForegroundWindow.argtypes = [wintypes.HWND]
    _u.BringWindowToTop.argtypes = [wintypes.HWND]
    _u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    _u.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    _u.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ctypes.c_size_t]
    _k.GetCurrentThreadId.restype = wintypes.DWORD
    _k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    _k.OpenProcess.restype = wintypes.HANDLE
    _k.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    _k.CloseHandle.argtypes = [wintypes.HANDLE]
    _sh.FindExecutableW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPWSTR]
    _sh.FindExecutableW.restype = ctypes.c_size_t


def _windows():
    """Every visible, unowned top-level window: (hwnd, class, title, exe name)."""
    out = []

    def each(h, _):
        if not _u.IsWindowVisible(h) or _u.GetWindow(h, 4):  # 4: GW_OWNER (a dialog or tool window)
            return True
        title = ctypes.create_unicode_buffer(512)
        cls = ctypes.create_unicode_buffer(256)
        _u.GetWindowTextW(h, title, 512)
        _u.GetClassNameW(h, cls, 256)
        out.append((h, cls.value, title.value, _exe_of(h)))
        return True

    _u.EnumWindows(_ENUM(each), 0)
    return out


def _class_of(h):
    if not h:
        return ""
    cls = ctypes.create_unicode_buffer(256)
    _u.GetClassNameW(h, cls, 256)
    return cls.value


def _exe_of(h):
    pid = wintypes.DWORD()
    _u.GetWindowThreadProcessId(h, ctypes.byref(pid))
    hp = _k.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not hp:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        n = wintypes.DWORD(1024)
        if _k.QueryFullProcessImageNameW(hp, 0, buf, ctypes.byref(n)):
            return os.path.basename(buf.value).lower()
        return ""
    finally:
        _k.CloseHandle(hp)


def _program_for(path):
    """The exe a double click on this file starts (bambu-studio.exe for a .3mf), lower case."""
    buf = ctypes.create_unicode_buffer(1024)
    if _sh.FindExecutableW(path, None, buf) > 32:
        return os.path.basename(buf.value).lower()
    return ""


def _front(h):
    """Put a window in front, restoring it if it's minimised."""
    if _u.IsIconic(h):
        _u.ShowWindow(h, 9)  # SW_RESTORE
    fg = _u.GetForegroundWindow()
    me = _k.GetCurrentThreadId()
    them = _u.GetWindowThreadProcessId(fg, None) if fg else 0
    # Sharing input with the window in front (GnomeShell's own, which was just
    # clicked) is what lets a background program hand the front to another.
    attached = bool(them and them != me and _u.AttachThreadInput(me, them, True))
    try:
        ok = _u.SetForegroundWindow(h)
        _u.BringWindowToTop(h)
    finally:
        if attached:
            _u.AttachThreadInput(me, them, False)
    if not ok:  # last resort: a tap of Alt counts as input from this program
        _u.keybd_event(0x12, 0, 1, 0)
        _u.keybd_event(0x12, 0, 3, 0)
        _u.SetForegroundWindow(h)


def _is_folder_window(cls, title, name, path):
    """Explorer's window showing this folder: Windows 11 titles it
    "<folder> - File Explorer", Windows 10 just "<folder>" (or the full path)."""
    if cls != "CabinetWClass":
        return False
    t = title.lower()
    return any(t == x or t.startswith(x + " - ") for x in (name, path))


def _watch(target, before, timeout):
    is_dir = os.path.isdir(target)
    path = os.path.normpath(target).lower()
    name = os.path.basename(path)
    prog = "" if is_dir else _program_for(target)
    end = time.time() + timeout
    done = set()
    settle = None
    tries = 0
    while time.time() < end:
        found = []
        for h, cls, title, exe in _windows():
            hit = _is_folder_window(cls, title, name, path) if is_dir else bool(prog) and exe == prog and bool(title)
            if hit:
                found.append((h not in before, h))
        # A new window first (the one just opened), then one already open that
        # took it (Windows 11 opens a folder as a tab in an Explorer window
        # that's already open; Bambu Studio opens a file in its own window).
        found.sort(reverse=True)
        if is_dir:
            # Explorer moves the folder between windows for a moment while it
            # opens: keep the folder's window in front until it settles.
            # Only take it back from Explorer itself (or GnomeShell's window
            # that was clicked): a window you switch to stays in front.
            fg = _u.GetForegroundWindow()
            ours = {h for _, h in found}
            took = fg in before or _class_of(fg) == "CabinetWClass"
            pick = [h for _, h in found] if found and fg not in ours and took else []
        else:
            pick = [h for fresh, h in found if h not in done and (fresh or not done)]
        if pick and tries < 8:
            try:
                _front(pick[0])
            except OSError:
                pass
            tries += 1
            done.add(pick[0])
        if done and settle is None:
            # A program shows a splash before its main window: keep watching a
            # little longer and bring the main one forward too.
            settle = time.time() + (4.0 if is_dir else 12.0)
        if settle and time.time() > settle:
            return
        time.sleep(0.25)


def open_front(target, timeout=45.0):
    """Open target (a folder, or a file with its program) and bring its window
    forward once it shows. Returns straight away; the watching runs aside."""
    target = os.path.abspath(target)
    if not hasattr(os, "startfile"):
        return
    before = set()
    if _WIN:
        try:
            before = {h for h, *_ in _windows()}
        except OSError:
            before = set()
    try:
        if _WIN and os.path.isdir(target):
            # A window of its own (/n): Windows 11 otherwise folds the folder
            # into an Explorer window already open, as a tab behind the one showing.
            subprocess.Popen(f'explorer.exe /n,"{target}"')
        else:
            os.startfile(target)
    except OSError as e:
        raise RuntimeError(f"Windows couldn't open {os.path.basename(target)}: {e.strerror or e}")
    if _WIN:
        threading.Thread(target=_safe_watch, args=(target, before, timeout), daemon=True).start()


def _safe_watch(target, before, timeout):
    try:
        _watch(target, before, timeout)
    except Exception as e:  # bringing it forward is a nicety: never take GnomeShell down for it
        print("  Couldn't bring the window forward:", e, flush=True)
