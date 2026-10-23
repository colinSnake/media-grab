#!/usr/bin/env bash
# Exercise both real Linux distribution formats, not only the staged Node core.
set -euo pipefail

bundle="$PWD/apps/desktop/src-tauri/target/release/bundle"
mapfile -t debs < <(find "$bundle/deb" -maxdepth 1 -type f -name '*.deb' | sort)
mapfile -t appimages < <(find "$bundle/appimage" -maxdepth 1 -type f -name '*.AppImage' | sort)
if [[ ${#debs[@]} -ne 1 || ${#appimages[@]} -ne 1 ]]; then
  echo "Expected exactly one .deb and one .AppImage in $bundle" >&2
  exit 1
fi

sudo apt-get install -y "${debs[0]}"
package=$(dpkg-deb --field "${debs[0]}" Package)
mapfile -t executables < <(dpkg -L "$package" | grep -E '^/usr/bin/[^/]+$' || true)
if [[ ${#executables[@]} -ne 1 ]]; then
  echo "Expected one installed executable in /usr/bin for $package" >&2
  exit 1
fi

export WEBKIT_DISABLE_COMPOSITING_MODE=1
export GDK_BACKEND=x11
for binary in "${executables[0]}" "${appimages[0]}"; do
  echo "Smoke checking installed desktop: $binary"
  # GitHub runners may not expose /dev/fuse. Exercise the AppImage's own
  # extract-and-run path rather than requiring privileged FUSE mounts in CI.
  if [[ "$binary" == *.AppImage ]]; then export APPIMAGE_EXTRACT_AND_RUN=1; fi
  dbus-run-session -- xvfb-run -a node scripts/smoke-installed-desktop.mjs "$binary"
  unset APPIMAGE_EXTRACT_AND_RUN
done
