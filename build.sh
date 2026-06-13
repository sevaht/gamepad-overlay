#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-dev}"
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE_ROOT="${PROJECT_ROOT}/release/gamepad-overlay-${TAG}-linux-x64"
ARCHIVE_PATH="${PROJECT_ROOT}/release/gamepad-overlay-${TAG}-linux-x64.tar.gz"
DIST_ROOT="${PROJECT_ROOT}/release/dist-linux"
WORK_ROOT="${PROJECT_ROOT}/release/build-linux"

cd "${PROJECT_ROOT}"

unset VIRTUAL_ENV || true
uv sync --no-dev
uv run python -c "import sdl3"
uv run --with pyinstaller pyinstaller \
    gamepad-overlay.spec \
    --clean \
    --noconfirm \
    --distpath "${DIST_ROOT}" \
    --workpath "${WORK_ROOT}"

rm -rf "${ARCHIVE_ROOT}" "${ARCHIVE_PATH}"

# Move (not copy) the single bundle directory into the release-named folder so
# we do not keep a duplicate ~60 MB copy in dist-linux.
mv "${DIST_ROOT}/gamepad-overlay" "${ARCHIVE_ROOT}"
cp "${PROJECT_ROOT}/README.md" "${ARCHIVE_ROOT}/README.md"

# Maximum gzip compression (-9); slower to create but smaller for the user.
tar -C "${PROJECT_ROOT}/release" -cf - "$(basename "${ARCHIVE_ROOT}")" \
    | gzip -9 > "${ARCHIVE_PATH}"

# Keep only the staged bundle directory and the archive; drop PyInstaller's
# work dir and the now-empty dist dir.
rm -rf "${DIST_ROOT}" "${WORK_ROOT}"

# PyInstaller logs reference its scratch --distpath (dist-linux), but that dir
# is moved into the tagged folder and then deleted above. Point at the real
# artifacts so the actual output location is unambiguous.
echo
echo "Build complete. Artifacts:"
echo "  ${ARCHIVE_ROOT}/"
echo "  ${ARCHIVE_PATH}"
