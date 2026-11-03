#!/bin/bash
# Builds apps/macos/build/Muster.app: the SwiftUI app plus the Node server, daemon and web UI it runs.
# Run from anywhere after `npm run build` at the repository root. Node.js 22+ is found on the login PATH at launch
# (or set MUSTER_NODE). Options:
#   --embed-node=<path>  copy that node binary into the bundle (use an official nodejs.org build: it only links system
#                        libraries, unlike Homebrew's), so the app runs without a system Node
#   --dmg                also write build/Muster-<version>-<arch>.dmg with an Applications shortcut
set -euo pipefail
embed=""; dmg=0
for arg in "$@"; do
  case "$arg" in
    --embed-node=*) embed="${arg#--embed-node=}" ;;
    --dmg) dmg=1 ;;
    *) echo "Unknown option $arg" >&2; exit 2 ;;
  esac
done
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
version="$(node -p "require('$root/package.json').version")"
app="$here/build/Muster.app"
stage="$here/build/runtime"

for dist in packages/shared apps/server apps/daemon apps/web; do
  [ -d "$root/$dist/dist" ] || { echo "Missing $dist/dist: run npm run build first" >&2; exit 1; }
done

swift build --package-path "$here" -c release
bin="$(swift build --package-path "$here" -c release --show-bin-path)"
binary="$bin/Muster"

# Production dependencies of the server and daemon, resolved from the repository lockfile.
rm -rf "$stage"; mkdir -p "$stage"
for workspace in packages/shared apps/server apps/daemon; do
  mkdir -p "$stage/$workspace"
  node -e "const p=require('$root/$workspace/package.json');delete p.scripts;delete p.devDependencies;require('fs').writeFileSync('$stage/$workspace/package.json',JSON.stringify(p))"
  cp -R "$root/$workspace/dist" "$stage/$workspace/dist"
done
mkdir -p "$stage/apps/web" && cp -R "$root/apps/web/dist" "$stage/apps/web/dist"
node -e "require('fs').writeFileSync('$stage/package.json',JSON.stringify({name:'muster-runtime',private:true,workspaces:['packages/shared','apps/server','apps/daemon']}))"
cp "$root/package-lock.json" "$stage/package-lock.json"
(cd "$stage" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
# Replace workspace links with real directories so the bundle never depends on this checkout.
for name in shared server daemon; do
  src="$stage/apps/$name"; [ "$name" = shared ] && src="$stage/packages/shared"
  rm -rf "$stage/node_modules/@muster/$name" && cp -R "$src" "$stage/node_modules/@muster/$name"
done
rm -f "$stage/package-lock.json"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
# SwiftPM records the deployment target as the SDK version, which makes macOS run the app in its
# compatibility appearance (no Liquid Glass). Record the SDK it was really built with, like Xcode does.
vtool -set-build-version macos 15.0 "$(xcrun --sdk macosx --show-sdk-version)" -replace -output "$app/Contents/MacOS/Muster" "$binary"
cp "$here/Resources/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
# Package resources (Textual's syntax highlighter, math fonts) are found through Bundle.main.resourceURL.
for bundle in "$bin"/*.bundle; do [ -e "$bundle" ] && cp -R "$bundle" "$app/Contents/Resources/"; done
mv "$stage" "$app/Contents/Resources/runtime"
if [ -n "$embed" ]; then
  "$embed" -e 'if (+process.versions.node.split(".")[0] < 22) process.exit(1)' || { echo "$embed is not Node.js 22+" >&2; exit 1; }
  mkdir -p "$app/Contents/Resources/runtime/bin" && cp "$embed" "$app/Contents/Resources/runtime/bin/node"
fi
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Muster</string>
  <key>CFBundleDisplayName</key><string>Muster</string>
  <key>CFBundleIdentifier</key><string>dev.muster.desktop</string>
  <key>CFBundleExecutable</key><string>Muster</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
</dict></plist>
PLIST
codesign --force --deep --sign - "$app" >/dev/null 2>&1 || echo "codesign skipped" >&2
echo "Built $app"
if [ "$dmg" = 1 ]; then
  image="$here/build/Muster-$version-$(uname -m).dmg"
  folder="$here/build/dmg"
  rm -rf "$folder" "$image"; mkdir -p "$folder"
  cp -R "$app" "$folder/" && ln -s /Applications "$folder/Applications"
  hdiutil create -quiet -volname Muster -srcfolder "$folder" -format UDZO "$image" \
    || hdiutil makehybrid -quiet -hfs -hfs-volume-name Muster -o "$image" "$folder"
  rm -rf "$folder"
  echo "Built $image"
fi
