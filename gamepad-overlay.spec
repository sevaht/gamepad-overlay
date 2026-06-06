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


UNUSED_QT_PATH_PARTS = (
    "PySide6/Qt/translations",
    "PySide6/Qt/plugins/platformthemes",
    "PySide6/Qt/plugins/platforminputcontexts",
)
UNUSED_QT_BINARY_NAMES = {
    "libatk-1.0.so.0",
    "libatk-bridge-2.0.so.0",
    "libatspi.so.0",
    "libcairo-gobject.so.2",
    "libcairo.so.2",
    "libcloudproviders.so.0",
    "libdatrie.so.1",
    "libfribidi.so.0",
    "libgdk-3.so.0",
    "libgdk_pixbuf-2.0.so.0",
    "libglycin-2.so.0",
    "libgtk-3.so.0",
    "libicudata.so.78",
    "libicuuc.so.78",
    "libjson-glib-1.0.so.0",
    "libpango-1.0.so.0",
    "libpangocairo-1.0.so.0",
    "libpangoft2-1.0.so.0",
    "libthai.so.0",
    "libtinysparql-3.0.so.0",
    "libxml2.so.16",
}
UNUSED_SDL_BINARY_PREFIXES = (
    "libSDL3_image",
    "libSDL3_mixer",
    "libSDL3_net",
    "libSDL3_rtf",
    "libSDL3_ttf",
    "SDL3_image",
    "SDL3_mixer",
    "SDL3_net",
    "SDL3_rtf",
    "SDL3_ttf",
)
UNUSED_SDL_DATA_FILES = {"metadata.json"}


def _dest_path(entry: tuple[str, str]) -> str:
    return entry[1].replace("\\", "/")


def _exclude_qt_runtime_entry(entry: tuple[str, str]) -> bool:
    dest_path = _dest_path(entry)
    return any(dest_path.startswith(prefix) for prefix in UNUSED_QT_PATH_PARTS)


def _exclude_sdl_binary(entry: tuple[str, str]) -> bool:
    name = Path(entry[0]).name
    return any(name.startswith(prefix) for prefix in UNUSED_SDL_BINARY_PREFIXES)


def _exclude_sdl_data(entry: tuple[str, str]) -> bool:
    dest_path = _dest_path(entry)
    if not dest_path.startswith("sdl3/bin"):
        return False
    return Path(entry[0]).name in UNUSED_SDL_DATA_FILES


def _toc_dest_path(entry: tuple[str, str, str]) -> str:
    return str(entry[0]).replace("\\", "/")


def _toc_source_name(entry: tuple[str, str, str]) -> str:
    return Path(entry[1]).name


def _exclude_qt_analysis_entry(entry: tuple[str, str, str]) -> bool:
    dest_path = _toc_dest_path(entry)
    return any(dest_path.startswith(prefix) for prefix in UNUSED_QT_PATH_PARTS)


def _exclude_qt_analysis_binary(entry: tuple[str, str, str]) -> bool:
    return _toc_source_name(entry) in UNUSED_QT_BINARY_NAMES


def _exclude_sdl_analysis_entry(entry: tuple[str, str, str]) -> bool:
    dest_path = _toc_dest_path(entry)
    if not dest_path.startswith("sdl3/bin"):
        return False
    source_name = _toc_source_name(entry)
    return source_name in UNUSED_SDL_DATA_FILES or any(
        source_name.startswith(prefix) for prefix in UNUSED_SDL_BINARY_PREFIXES
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

datas = [
    entry
    for entry in datas
    if not _exclude_qt_runtime_entry(entry) and not _exclude_sdl_data(entry)
]
binaries = [
    entry
    for entry in binaries
    if not _exclude_qt_runtime_entry(entry) and not _exclude_sdl_binary(entry)
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
analysis.datas = type(analysis.datas)(
    entry
    for entry in analysis.datas
    if not _exclude_qt_analysis_entry(entry)
    and not _exclude_sdl_analysis_entry(entry)
)
analysis.binaries = type(analysis.binaries)(
    entry
    for entry in analysis.binaries
    if not _exclude_qt_analysis_entry(entry)
    and not _exclude_qt_analysis_binary(entry)
    and not _exclude_sdl_analysis_entry(entry)
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
    strip=sys.platform.startswith("linux"),
    upx=False,
    console=sys.platform != "win32",
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=sys.platform.startswith("linux"),
    upx=False,
    upx_exclude=[],
    name="gamepad-overlay",
)
