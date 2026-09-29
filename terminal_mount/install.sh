#!/usr/bin/env bash
# Copies gvim, gopen and gmove into ~/.local/bin and checks what they need.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dest="$HOME/.local/bin"
mkdir -p "$dest"
for s in gvim gopen gmove; do
  install -m 755 "$here/$s" "$dest/$s"
  echo "installed $dest/$s"
done

case ":$PATH:" in *":$dest:"*) ;; *) echo "note: $dest is not in your PATH — add: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;; esac
for tool in jq curl python3 vim xattr rclone; do
  command -v "$tool" >/dev/null || echo "missing: $tool"
done
ls -d "$HOME"/Library/CloudStorage/GoogleDrive-*/"My Drive" >/dev/null 2>&1 \
  || echo "missing: Google Drive for Desktop mount (brew install --cask google-drive, sign in, stream files)"
rclone listremotes 2>/dev/null | grep -qx 'gdrive:' \
  || echo "missing: rclone remote named gdrive (rclone config → new remote → drive → full access)"
