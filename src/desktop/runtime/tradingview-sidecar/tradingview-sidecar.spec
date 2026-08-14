"""PyInstaller recipe for the Apple Silicon market-data helper."""

from pathlib import Path
from shutil import copyfile

from PyInstaller.utils.hooks import collect_all, copy_metadata


SPEC_DIR = Path(SPECPATH).resolve()
REPOSITORY_ROOT = SPEC_DIR.parents[3]
ENTRYPOINT = SPEC_DIR / "entrypoint.py"
SIDECAR_SOURCE = REPOSITORY_ROOT / "api" / "tradingview-websocket" / "sidecar.py"

# The source directory contains a hyphen and therefore cannot be imported by
# multiprocessing's spawn bootstrap. Stage the unchanged source under a valid
# module name in PyInstaller's disposable work directory. This also lets the
# analyzer see every import in the original implementation.
GENERATED_DIR = Path(workpath).resolve() / "generated"
GENERATED_DIR.mkdir(parents=True, exist_ok=True)
GENERATED_SIDECAR = GENERATED_DIR / "unicorn_tradingview_sidecar.py"
copyfile(SIDECAR_SOURCE, GENERATED_SIDECAR)

datas = []
binaries = []
hiddenimports = []

# yfinance and curl_cffi both use runtime-selected modules/resources. Collect
# their complete installed packages so profile and earnings endpoints retain
# the same behavior as the Python script. The TradingView package is tiny, and
# collecting it completely protects its websocket import boundary as well.
for package in ("tradingview_websocket", "yfinance", "curl_cffi", "lxml"):
    package_datas, package_binaries, package_hiddenimports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

for distribution in (
    "tradingview-websocket",
    "websocket-client",
    "yfinance",
    "curl_cffi",
):
    datas += copy_metadata(distribution)

analysis = Analysis(
    [str(ENTRYPOINT)],
    pathex=[str(GENERATED_DIR)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=1,
)
python_archive = PYZ(analysis.pure)

executable = EXE(
    python_archive,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="unicorn-market-sidecar-aarch64-apple-darwin",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch="arm64",
    codesign_identity=None,
    entitlements_file=None,
)
