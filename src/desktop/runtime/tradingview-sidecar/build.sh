#!/bin/sh
set -eu

usage() {
  printf '%s\n' "usage: $0 [--live-smoke] [--tauri-output]"
  printf '%s\n' ""
  printf '%s\n' "Builds the standalone Apple Silicon TradingView/yfinance helper."
  printf '%s\n' "Set TRADER_MARKET_SIDECAR_BUILD_PYTHON to override python3.12."
  printf '%s\n' "Set TRADER_MARKET_SIDECAR_BUILD_VENV or TRADER_MARKET_SIDECAR_DIST_DIR to override build paths."
  printf '%s\n' "Use --tauri-output to write the exact externalBin into src/desktop/tauri/binaries."
}

live_smoke=false
tauri_output=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --live-smoke) live_smoke=true ;;
    --tauri-output) tauri_output=true ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
desktop_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
repository_root=$(CDPATH= cd -- "$desktop_root/../.." && pwd)
build_python=${TRADER_MARKET_SIDECAR_BUILD_PYTHON:-python3.12}
venv_dir=${TRADER_MARKET_SIDECAR_BUILD_VENV:-"$script_dir/.venv"}
dist_dir=${TRADER_MARKET_SIDECAR_DIST_DIR:-"$script_dir/dist"}
if [ "$tauri_output" = true ]; then
  dist_dir="$desktop_root/tauri/binaries"
fi
work_dir="$script_dir/build"
binary_name=trader-market-sidecar-aarch64-apple-darwin
binary_path="$dist_dir/$binary_name"

if ! command -v "$build_python" >/dev/null 2>&1; then
  printf '%s\n' "Python 3.12 is required to build the pinned arm64 helper." >&2
  printf '%s\n' "Install it or set TRADER_MARKET_SIDECAR_BUILD_PYTHON to an arm64 Python 3.12 executable." >&2
  exit 1
fi

python_version=$(
  "$build_python" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
)
python_arch=$(
  "$build_python" -c 'import platform; print(platform.machine())'
)
if [ "$python_version" != "3.12" ]; then
  printf '%s\n' "Expected Python 3.12, found $python_version at $build_python." >&2
  exit 1
fi
if [ "$python_arch" != "arm64" ]; then
  printf '%s\n' "Expected an arm64 build interpreter, found $python_arch at $build_python." >&2
  exit 1
fi

if [ ! -x "$venv_dir/bin/python" ]; then
  "$build_python" -m venv "$venv_dir"
fi

"$venv_dir/bin/python" -m pip install \
  --disable-pip-version-check \
  --requirement "$script_dir/requirements-build.txt"

mkdir -p "$dist_dir" "$work_dir"
"$venv_dir/bin/python" -m PyInstaller \
  --noconfirm \
  --clean \
  --distpath "$dist_dir" \
  --workpath "$work_dir" \
  "$script_dir/tradingview-sidecar.spec"

file_description=$(file -b "$binary_path")
case "$file_description" in
  *"Mach-O 64-bit executable arm64"*) ;;
  *)
    printf '%s\n' "Unexpected output architecture: $file_description" >&2
    exit 1
    ;;
esac

if [ "$live_smoke" = true ]; then
  "$venv_dir/bin/python" "$script_dir/smoke_test.py" \
    --binary "$binary_path" \
    --live
else
  "$venv_dir/bin/python" "$script_dir/smoke_test.py" \
    --binary "$binary_path"
fi

size_bytes=$(stat -f '%z' "$binary_path")
size_human=$(du -h "$binary_path" | awk '{print $1}')
sha256=$(shasum -a 256 "$binary_path" | awk '{print $1}')
printf '%s\n' "binary=$binary_path"
printf '%s\n' "architecture=arm64"
printf '%s\n' "minimum_macos=14.0"
printf '%s\n' "size_bytes=$size_bytes"
printf '%s\n' "size_human=$size_human"
printf '%s\n' "sha256=$sha256"
