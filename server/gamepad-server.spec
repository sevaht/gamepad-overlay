from __future__ import annotations

import ctypes.util
import sys
from pathlib import Path

from PyInstaller.building.build_main import Analysis, COLLECT, EXE, PYZ
from PyInstaller.utils.hooks import collect_all, copy_metadata


PROJECT_ROOT = Path(SPECPATH).resolve()


def _system_sdl2_binary() -> tuple[str, str] | None:
    library_name = ctypes.util.find_library("SDL2")
    if not library_name:
        return None

    library_path = Path(library_name)
    if library_path.is_absolute() and library_path.exists():
        return (str(library_path), ".")

    for search_root in (
        Path("/usr/lib"),
        Path("/usr/lib/x86_64-linux-gnu"),
        Path("/usr/lib64"),
        Path("/lib"),
        Path("/lib/x86_64-linux-gnu"),
        Path("/lib64"),
        Path("/usr/local/lib"),
    ):
        candidate = search_root / library_name
        if candidate.exists():
            return (str(candidate), ".")

    return None


datas: list[tuple[str, str]] = []
binaries: list[tuple[str, str]] = []
hiddenimports: list[str] = []

for package_name in ("sevaht_utility", "sdl2"):
    package_datas, package_binaries, package_hiddenimports = collect_all(
        package_name
    )
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

for distribution_name in ("gamepad-server", "sevaht-utility"):
    datas += copy_metadata(distribution_name)

if sys.platform == "win32":
    try:
        package_datas, package_binaries, package_hiddenimports = collect_all(
            "sdl2dll"
        )
    except ImportError:
        pass
    else:
        datas += package_datas
        binaries += package_binaries
        hiddenimports += package_hiddenimports
else:
    sdl2_binary = _system_sdl2_binary()
    if sdl2_binary is not None:
        binaries.append(sdl2_binary)


analysis = Analysis(
    ["src/gamepad_server/__main__.py"],
    pathex=[str(PROJECT_ROOT / "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(analysis.pure)

exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="gamepad-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=sys.platform != "win32",
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="gamepad-server",
)
