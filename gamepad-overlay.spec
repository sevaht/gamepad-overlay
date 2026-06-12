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
# Point PySDL3 at the SDL3 shared library bundled under sdl3/bin so it does not
# probe the host system for one.
RUNTIME_HOOK_PATH.write_text(
    "import os\nimport sys\nfrom pathlib import Path\n\n"
    "bundle_root = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parent))\n"
    "sdl_binary_path = bundle_root / 'sdl3' / 'bin'\n"
    "if sdl_binary_path.is_dir():\n"
    "    os.environ.setdefault('SDL_DISABLE_METADATA', '1')\n"
    "    os.environ.setdefault('SDL_FIND_BINARIES', '0')\n"
    "    os.environ.setdefault('SDL_CHECK_BINARY_VERSION', '0')\n"
    "    os.environ.setdefault('SDL_BINARY_PATH', str(sdl_binary_path))\n",
    encoding="utf-8",
)


# PySDL3 ships the full SDL3 family; we only use core SDL3, so drop the unused
# satellite libraries and the metadata side-file to keep the bundle small.
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

# Pillow is built with AVIF/HEIF/AV1 support, but we only draw simple in-memory
# icons and never decode image files, so drop those large codec libraries.
UNUSED_PIL_BINARY_PREFIXES = (
    "libx265",
    "libx264",
    "libaom",
    "libSvtAv1Enc",
    "libavif",
    "librav1e",
    "libde265",
    "libheif",
    "libdav1d",
    # WebP is a separate PIL module (_webp), not linked by _imaging core, and
    # we never load WebP images.
    "libwebp",
    "libsharpyuv",
)

# The system Tcl/Tk we bundle ships a graphviz extension (libtcldot) and its
# cairo/pango/gobject/gio dependency stack. tkinter never loads it, and we
# verified tk/SDL only need libglib (via harfbuzz) -- not these -- so drop the
# whole chain. libglib itself is intentionally NOT listed (harfbuzz needs it).
UNUSED_TK_BINARY_PREFIXES = (
    "libtcldot",
    "libgvc",
    "libcgraph",
    "libcdt",
    "libpathplan",
    "libxdot",
    "libgd",
    "libgts",
    "libcairo",
    "libpango",
    "libpixman",
    "libgobject",
    "libgio",
    "libgmodule",
    "libfribidi",
    "libthai",
    "libdatrie",
    "libltdl",
)

# Orphaned native libraries with no remaining consumer in the bundle: they were
# pulled in by dependencies we trimmed (systemd/mount via the glib/gio stack) or
# by SDL features we never use (openh264 = video/camera decode). SDL falls back
# to the host libraries at runtime if it ever needs them.
UNUSED_SYSTEM_BINARY_PREFIXES = (
    "libopenh264",
    "libsystemd",
    "libmount",
)

_UNWANTED_BINARY_PREFIXES = (
    UNUSED_SDL_BINARY_PREFIXES
    + UNUSED_PIL_BINARY_PREFIXES
    + UNUSED_TK_BINARY_PREFIXES
    + UNUSED_SYSTEM_BINARY_PREFIXES
)


def _dest_path(entry: tuple[str, str]) -> str:
    return entry[1].replace("\\", "/")


def _exclude_unwanted_binary(entry: tuple[str, str]) -> bool:
    name = Path(entry[0]).name
    return any(
        name.startswith(prefix) for prefix in _UNWANTED_BINARY_PREFIXES
    )


def _exclude_sdl_data(entry: tuple[str, str]) -> bool:
    dest_path = _dest_path(entry)
    if not dest_path.startswith("sdl3/bin"):
        return False
    return Path(entry[0]).name in UNUSED_SDL_DATA_FILES


def _toc_dest_path(entry: tuple[str, str, str]) -> str:
    return str(entry[0]).replace("\\", "/")


def _toc_source_name(entry: tuple[str, str, str]) -> str:
    return Path(entry[1]).name


def _exclude_unwanted_analysis_entry(entry: tuple[str, str, str]) -> bool:
    dest_path = _toc_dest_path(entry)
    names = {Path(dest_path).name, _toc_source_name(entry)}
    if any(
        name.startswith(prefix)
        for name in names
        for prefix in _UNWANTED_BINARY_PREFIXES
    ):
        return True
    # The unused Tcl/Tk graphviz extension (scripts and helper libraries).
    if "graphviz" in dest_path.split("/"):
        return True
    if dest_path.startswith("sdl3/bin"):
        return _toc_source_name(entry) in UNUSED_SDL_DATA_FILES
    return False


if sys.platform == "win32":
    sys.path.insert(0, str(PROJECT_ROOT / "src"))
    from gamepad_overlay.tray_render import _create_face_buttons_image

    _ico_path = Path(workpath).resolve() / "gamepad-overlay.ico"
    _ico_path.parent.mkdir(parents=True, exist_ok=True)
    _ico_sizes = [16, 32, 48, 64, 128, 256]
    _ico_imgs = [
        _create_face_buttons_image(connected=True, size=s) for s in _ico_sizes
    ]
    _ico_imgs[0].save(str(_ico_path), format="ICO", append_images=_ico_imgs[1:])
    EXE_ICON: str | None = str(_ico_path)
else:
    EXE_ICON = None

datas: list[tuple[str, str]] = []
binaries: list[tuple[str, str]] = []
hiddenimports: list[str] = []

# The tray backend is platform specific and imported lazily, so collect the
# relevant package per platform: pystray on Windows/macOS, and the
# StatusNotifierItem (dbus-next) + XEmbed (python-xlib) backends on Linux.
collect_packages = [ENTRY_MODULE, "sevaht_utility", "sdl3"]
if sys.platform in ("win32", "darwin"):
    collect_packages.append("pystray")
else:
    collect_packages += ["dbus_next", "Xlib"]

for package_name in collect_packages:
    package_datas, package_binaries, package_hiddenimports = collect_all(
        package_name
    )
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

for distribution_name in ("gamepad-overlay", "sevaht-utility"):
    datas += copy_metadata(distribution_name)

datas = [entry for entry in datas if not _exclude_sdl_data(entry)]
binaries = [entry for entry in binaries if not _exclude_unwanted_binary(entry)]

# Modules we never use that otherwise add weight:
# - Pillow's AVIF/WebP codecs are separate plugins (not the _imaging core); we
#   only draw in-memory icons and never decode image files.
# - cryptography is only a dev dependency (twine -> keyring); --no-dev already
#   drops it, but exclude it defensively for non --no-dev builds.
# Note: aiohttp/requests are pulled in unconditionally by PySDL3's binary
# downloader (which we never use), but PySDL3 imports them at module load, so
# they cannot simply be excluded without a stub.
EXCLUDED_MODULES = [
    "cryptography",
    "PIL._avif",
    "PIL.AvifImagePlugin",
    "PIL._webp",
    "PIL.WebPImagePlugin",
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
    excludes=EXCLUDED_MODULES,
    noarchive=False,
    optimize=0,
)
analysis.datas = type(analysis.datas)(
    entry
    for entry in analysis.datas
    if not _exclude_unwanted_analysis_entry(entry)
)
analysis.binaries = type(analysis.binaries)(
    entry
    for entry in analysis.binaries
    if not _exclude_unwanted_analysis_entry(entry)
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
    icon=EXE_ICON,
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
