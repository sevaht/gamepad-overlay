#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-dev}"
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE_ROOT="${PROJECT_ROOT}/release/gamepad-overlay-${TAG}-linux-x64"
ARCHIVE_PATH="${PROJECT_ROOT}/release/gamepad-overlay-${TAG}-linux-x64.tar.gz"
DIST_ROOT="${PROJECT_ROOT}/release/dist-linux"
WORK_ROOT="${PROJECT_ROOT}/release/build-linux"

cd "${PROJECT_ROOT}"

uv sync --no-dev
uv run --with pyinstaller pyinstaller \
    gamepad-server.spec \
    --clean \
    --noconfirm \
    --distpath "${DIST_ROOT}" \
    --workpath "${WORK_ROOT}"

rm -rf "${ARCHIVE_ROOT}" "${ARCHIVE_PATH}"
mkdir -p "${ARCHIVE_ROOT}"

cp -r "${DIST_ROOT}/gamepad-server/." "${ARCHIVE_ROOT}/"
cp "${PROJECT_ROOT}/README.md" "${ARCHIVE_ROOT}/README.md"
cp "${PROJECT_ROOT}/README-server.md" "${ARCHIVE_ROOT}/README-server.md"
cp "${PROJECT_ROOT}/README-overlay.md" "${ARCHIVE_ROOT}/README-overlay.md"

tar -C "${PROJECT_ROOT}/release" -czf "${ARCHIVE_PATH}" "$(basename "${ARCHIVE_ROOT}")"
