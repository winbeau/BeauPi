#!/bin/sh
set -eu

repo="${BEAUPI_REPO:-winbeau/beaupi}"
bin_dir="${BEAUPI_BIN_DIR:-$HOME/.local/bin}"
install_root="${BEAUPI_INSTALL_ROOT:-$HOME/.local/share/beaupi}"
version="${BEAUPI_VERSION:-}"
platform="${BEAUPI_PLATFORM:-}"
uninstall=false

usage() {
	cat <<'EOF'
Install BeauPi from a checksummed GitHub Release binary.

Usage:
  curl -fsSL https://github.com/winbeau/beaupi/releases/latest/download/install.sh | sh
  sh install.sh [--version <version>] [--bin-dir <dir>] [--install-root <dir>]
  sh install.sh --uninstall

Environment:
  BEAUPI_VERSION            Release version or tag, for example 0.83.0 or v0.83.0
  BEAUPI_BIN_DIR            Command directory (default: ~/.local/bin)
  BEAUPI_INSTALL_ROOT       Versioned bundle directory (default: ~/.local/share/beaupi)
EOF
}

require_value() {
	if [ "$#" -lt 2 ] || [ -z "$2" ]; then
		printf '%s requires a value\n' "$1" >&2
		exit 1
	fi
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--version)
			require_value "$@"
			version="$2"
			shift 2
			;;
		--bin-dir)
			require_value "$@"
			bin_dir="$2"
			shift 2
			;;
		--install-root)
			require_value "$@"
			install_root="$2"
			shift 2
			;;
		--uninstall)
			uninstall=true
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			printf 'Unknown option: %s\n' "$1" >&2
			usage >&2
			exit 1
			;;
	esac
done

if [ "$uninstall" = true ]; then
	rm -f "$bin_dir/beaupi"
	rm -rf "$install_root"
	printf 'Removed BeauPi from %s and %s\n' "$bin_dir" "$install_root"
	exit 0
fi

if [ -z "$platform" ]; then
	case "$(uname -s)" in
		Linux) os=linux ;;
		Darwin) os=darwin ;;
		*)
			printf 'Unsupported operating system: %s\n' "$(uname -s)" >&2
			exit 1
			;;
	esac

	case "$(uname -m)" in
		x86_64|amd64) arch=x64 ;;
		arm64|aarch64) arch=arm64 ;;
		*)
			printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2
			exit 1
			;;
	esac
	platform="$os-$arch"
fi

case "$platform" in
	linux-x64|linux-arm64|darwin-x64|darwin-arm64) ;;
	*)
		printf 'Unsupported BeauPi platform: %s\n' "$platform" >&2
		exit 1
		;;
esac

if ! command -v curl >/dev/null 2>&1; then
	printf 'curl is required to install BeauPi.\n' >&2
	exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
	printf 'tar is required to install BeauPi.\n' >&2
	exit 1
fi

if [ -n "${BEAUPI_DOWNLOAD_BASE_URL:-}" ]; then
	download_base="${BEAUPI_DOWNLOAD_BASE_URL%/}"
elif [ -n "$version" ]; then
	case "$version" in
		v*) tag="$version" ;;
		*) tag="v$version" ;;
	esac
	download_base="https://github.com/$repo/releases/download/$tag"
else
	download_base="https://github.com/$repo/releases/latest/download"
fi

asset="beaupi-$platform.tar.gz"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/beaupi-install.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT HUP INT TERM
archive="$temporary_dir/$asset"
checksums="$temporary_dir/SHA256SUMS"

curl -fsSL "$download_base/$asset" -o "$archive"
curl -fsSL "$download_base/SHA256SUMS" -o "$checksums"

expected_checksum="$(awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print $1; exit }' "$checksums")"
if [ -z "$expected_checksum" ]; then
	printf 'SHA256SUMS does not contain %s\n' "$asset" >&2
	exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
	actual_checksum="$(sha256sum "$archive" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
	actual_checksum="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
else
	printf 'sha256sum or shasum is required to verify BeauPi.\n' >&2
	exit 1
fi

if [ "$actual_checksum" != "$expected_checksum" ]; then
	printf 'Checksum verification failed for %s\n' "$asset" >&2
	exit 1
fi

if ! tar -tzf "$archive" | awk '
	$0 !~ /^beaupi(\/|$)/ { exit 1 }
	$0 ~ /(^|\/)\.\.(\/|$)/ { exit 1 }
	END { if (NR == 0) exit 1 }
'; then
	printf 'Archive layout is invalid: %s\n' "$asset" >&2
	exit 1
fi

extract_dir="$temporary_dir/extract"
mkdir -p "$extract_dir"
tar -xzf "$archive" -C "$extract_dir"
if [ ! -f "$extract_dir/beaupi/package.json" ] || [ ! -f "$extract_dir/beaupi/beaupi" ]; then
	printf 'Archive is missing BeauPi runtime files.\n' >&2
	exit 1
fi
chmod +x "$extract_dir/beaupi/beaupi"

installed_version="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$extract_dir/beaupi/package.json" | awk 'NR == 1 { print; exit }')"
if [ -z "$installed_version" ]; then
	printf 'Could not determine BeauPi version from package.json.\n' >&2
	exit 1
fi
if [ -n "$version" ] && [ "${version#v}" != "$installed_version" ]; then
	printf 'Requested version %s but archive contains %s.\n' "$version" "$installed_version" >&2
	exit 1
fi

target_dir="$install_root/$installed_version"
staging_dir="$install_root/.install.$$"
mkdir -p "$install_root" "$bin_dir"
rm -rf "$staging_dir"
mv "$extract_dir/beaupi" "$staging_dir"
rm -rf "$target_dir"
mv "$staging_dir" "$target_dir"

link_path="$bin_dir/.beaupi.$$"
rm -f "$link_path"
ln -s "$target_dir/beaupi" "$link_path"
mv -f "$link_path" "$bin_dir/beaupi"

printf 'Installed BeauPi %s to %s\n' "$installed_version" "$target_dir"
printf 'Command: %s\n' "$bin_dir/beaupi"
case ":$PATH:" in
	*":$bin_dir:"*) ;;
	*) printf 'Add %s to PATH before running beaupi.\n' "$bin_dir" ;;
esac
