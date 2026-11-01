#!/bin/sh
# Installs the offerstar binary for macOS (Apple silicon) or Linux.
#   curl -fsSL https://raw.githubusercontent.com/himanshu-mamgain/offerstar/main/install.sh | sh
# Set OFFERSTAR_INSTALL_DIR to install somewhere other than ~/.local/bin.
set -eu

REPO="himanshu-mamgain/offerstar"
BASE="https://github.com/$REPO/releases/latest/download"
DIR="${OFFERSTAR_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) echo "offerstar: unsupported system $(uname -s); try: npm i -g offerstar" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "offerstar: unsupported CPU $(uname -m); try: npm i -g offerstar" >&2; exit 1 ;;
esac
if [ "$os" = macos ] && [ "$arch" = x64 ]; then
  echo "offerstar: there is no Intel Mac build; install Node 22.18+ and run: npm i -g offerstar" >&2
  exit 1
fi

asset="offerstar-$os-$arch"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset..."
curl -fsSL "$BASE/$asset" -o "$tmp/offerstar"
curl -fsSL "$BASE/checksums.txt" -o "$tmp/checksums.txt"

expected="$(grep " $asset\$" "$tmp/checksums.txt" | cut -d ' ' -f 1)"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/offerstar" | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 "$tmp/offerstar" | cut -d ' ' -f 1)"
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "offerstar: checksum mismatch, not installing" >&2
  exit 1
fi

mkdir -p "$DIR"
install -m 755 "$tmp/offerstar" "$DIR/offerstar"
echo "Installed $DIR/offerstar"

case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "Add $DIR to your PATH, e.g.: echo 'export PATH=\"$DIR:\$PATH\"' >> ~/.profile" ;;
esac
echo "Next: offerstar init, then in Claude Code: /plugin install offerstar --marketplace $REPO"
