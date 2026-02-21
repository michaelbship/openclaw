#!/usr/bin/env bash
# Apply fork-specific dependency patches after npm install.
# These patches fix issues in upstream dependencies that haven't been
# fixed by the dependency maintainers yet.
#
# Patch files live in patches/ and follow the pnpm naming convention:
#   @scope__package@version.patch  ->  node_modules/@scope/package
#
# This script is called from package.json "postinstall" and is safe to
# run multiple times (patches are applied with --forward so already-applied
# patches are skipped silently).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCHES_DIR="$(dirname "$SCRIPT_DIR")/patches"

# Exit silently if no patches directory (upstream install, not fork)
[ -d "$PATCHES_DIR" ] || exit 0

applied=0
skipped=0

for patchfile in "$PATCHES_DIR"/*.patch; do
  [ -f "$patchfile" ] || continue

  filename="$(basename "$patchfile")"

  # Parse pnpm patch naming: @scope__pkg@version.patch -> @scope/pkg
  # Remove the @version.patch suffix
  pkg="${filename%@[0-9]*}"
  # Replace __ with /
  pkg="${pkg//__//}"

  target="$(dirname "$SCRIPT_DIR")/node_modules/$pkg"

  if [ ! -d "$target" ]; then
    continue
  fi

  # Try to apply; --forward skips already-applied hunks
  if patch -p1 --forward --silent < "$patchfile" -d "$target" 2>/dev/null; then
    echo "  fork-patch: applied $filename"
    applied=$((applied + 1))
  else
    # Exit code 1 from patch --forward means "already applied"
    skipped=$((skipped + 1))
  fi
done

if [ $applied -gt 0 ]; then
  echo "  fork-patch: $applied patch(es) applied, $skipped already current"
fi
