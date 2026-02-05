#!/bin/bash

# Package plugin into a ZIP file for distribution

PLUGIN_ID="com.ncsender.meross-smart-outlet"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$PLUGIN_DIR/build"
STAGING_DIR="$BUILD_DIR/$PLUGIN_ID"
ZIP_FILE="$BUILD_DIR/$PLUGIN_ID.zip"

echo "Building plugin: $PLUGIN_ID"
echo "Plugin directory: $PLUGIN_DIR"

# Create build directory
mkdir -p "$BUILD_DIR"

# Remove old staging and ZIP if exist
rm -rf "$STAGING_DIR"
if [ -f "$ZIP_FILE" ]; then
  rm "$ZIP_FILE"
  echo "Removed old build: $ZIP_FILE"
fi

# Create staging directory with plugin structure
mkdir -p "$STAGING_DIR"

# Copy plugin files to staging directory
cp "$PLUGIN_DIR/manifest.json" "$STAGING_DIR/"
cp "$PLUGIN_DIR/index.js" "$STAGING_DIR/"
cp "$PLUGIN_DIR/meross-cloud-manager.js" "$STAGING_DIR/"
cp "$PLUGIN_DIR/simple-mqtt-client.js" "$STAGING_DIR/"
cp "$PLUGIN_DIR/package.json" "$STAGING_DIR/"
cp "$PLUGIN_DIR/README.md" "$STAGING_DIR/"
cp "$PLUGIN_DIR/LICENSE" "$STAGING_DIR/"

echo "Files copied to staging directory"

# Create ZIP from build directory (this creates the plugin folder inside the ZIP)
cd "$BUILD_DIR"
zip -r "$PLUGIN_ID.zip" "$PLUGIN_ID/"

# Clean up staging directory
rm -rf "$STAGING_DIR"

echo "✓ Plugin packaged: $ZIP_FILE"
echo ""
echo "ZIP structure:"
unzip -l "$ZIP_FILE" | head -15
echo ""
echo "To install:"
echo "  1. Open ncSender"
echo "  2. Go to Settings → Plugins → Install from ZIP"
echo "  3. Select build/$PLUGIN_ID.zip"
