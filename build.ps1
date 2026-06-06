param(
    [string]$Tag = "dev"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ArchiveRoot = Join-Path $ProjectRoot "release/gamepad-overlay-$Tag-windows-x64"
$ArchivePath = Join-Path $ProjectRoot "release/gamepad-overlay-$Tag-windows-x64.zip"
$DistRoot = Join-Path $ProjectRoot "release/dist-windows"
$WorkRoot = Join-Path $ProjectRoot "release/build-windows"
$BundleRoot = Join-Path $DistRoot "gamepad-overlay"

Push-Location $ProjectRoot
try {
    Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue
    uv sync --no-dev
    uv run python -c "import sdl3"
    uv run --with pyinstaller pyinstaller gamepad-overlay.spec --clean --noconfirm --distpath $DistRoot --workpath $WorkRoot

    Remove-Item -Recurse -Force $ArchiveRoot -ErrorAction SilentlyContinue
    Remove-Item -Force $ArchivePath -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $ArchiveRoot | Out-Null

    Copy-Item -Recurse (Join-Path $BundleRoot "*") $ArchiveRoot
    Copy-Item (Join-Path $ProjectRoot "README.md") (Join-Path $ArchiveRoot "README.md")

    Compress-Archive -Path $ArchiveRoot -DestinationPath $ArchivePath
}
finally {
    Pop-Location
}
