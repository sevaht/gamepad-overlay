from __future__ import annotations

import sys
import tomllib
from pathlib import Path

from PyInstaller.building.build_main import Analysis, COLLECT, EXE, PYZ
from PyInstaller.utils.hooks import collect_all, copy_metadata


PROJECT_ROOT = Path(SPECPATH).resolve()
PYPROJECT_PATH = PROJECT_ROOT / "pyproject.toml"


def _entry_module() -> str:
    with PYPROJECT_PATH.open("rb") as handle:
        data = tomllib.load(handle)

    tool = data.get("tool")
    if not isinstance(tool, dict):
        raise KeyError("tool table not found in pyproject.toml")

    entrypoint = tool.get("entrypoint")
    if not isinstance(entrypoint, dict):
        raise KeyError("tool.entrypoint table not found in pyproject.toml")

    module = entrypoint.get("module")
    if not isinstance(module, str) or not module:
        raise KeyError("tool.entrypoint.module not found in pyproject.toml")

    return module


ENTRY_MODULE = _entry_module()
LAUNCHER_PATH = Path(workpath).resolve() / f"{specnm}-launch.py"
RUNTIME_HOOK_PATH = Path(workpath).resolve() / f"{specnm}-runtime-hook.py"
LAUNCHER_PATH.parent.mkdir(parents=True, exist_ok=True)
LAUNCHER_PATH.write_text(
    "import runpy\n\n"
    "if __name__ == '__main__':\n"
    f"    runpy.run_module({ENTRY_MODULE!r}, run_name='__main__', alter_sys=True)\n",
    encoding="utf-8",
)
RUNTIME_HOOK_PATH.write_text(
    "import os\nimport sys\nfrom pathlib import Path\n\n"
    "bundle_root = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))\n"
    "sdl_binary_path = bundle_root / 'sdl3' / 'bin'\n"
    "if sdl_binary_path.is_dir():\n"
    "    os.environ.setdefault('SDL_DISABLE_METADATA', '1')\n"
    "    os.environ.setdefault('SDL_FIND_BINARIES', '0')\n"
    "    os.environ.setdefault('SDL_CHECK_BINARY_VERSION', '0')\n"
    "    os.environ.setdefault('SDL_BINARY_PATH', str(sdl_binary_path))\n"
    "\n"
    "if sys.platform.startswith('linux'):\n"
    "    os.environ.setdefault('QT_QPA_PLATFORMTHEME', '')\n"
    "    os.environ.setdefault('QT_STYLE_OVERRIDE', 'Fusion')\n",
    encoding="utf-8",
)


datas: list[tuple[str, str]] = []
binaries: list[tuple[str, str]] = []
hiddenimports: list[str] = []

for package_name in (ENTRY_MODULE, "sevaht_utility", "sdl3"):
    package_datas, package_binaries, package_hiddenimports = collect_all(
        package_name
    )
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

for distribution_name in ("gamepad-overlay", "sevaht-utility"):
    datas += copy_metadata(distribution_name)

if sys.platform.startswith("linux"):
    datas = [
        entry for entry in datas if Path(entry[0]).name != "libqgtk3.so"
    ]

analysis = Analysis(
    [str(LAUNCHER_PATH)],
    pathex=[str(PROJECT_ROOT / "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[str(RUNTIME_HOOK_PATH)],
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
    name="gamepad-overlay",
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
    name="gamepad-overlay",
)
