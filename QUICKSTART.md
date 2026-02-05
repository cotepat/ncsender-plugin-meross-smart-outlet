# Quick Start Guide

## For Users: Installing the Plugin

### Option 1: From ncSender Plugin Manager (Coming Soon)
Once published, you'll be able to install directly from ncSender's Plugin Manager.

### Option 2: Manual Installation

1. Download the latest release from GitHub Releases
2. Locate your ncSender plugins directory:
   - **macOS**: `~/Library/Application Support/ncSender/plugins/`
   - **Windows**: `%APPDATA%\\ncSender\\plugins\\`
   - **Linux**: `~/.config/ncSender/plugins/`
3. Extract the downloaded ZIP file into the plugins directory
4. Restart ncSender
5. Access via **Plugins → Meross Smart Outlet Controller** menu

## For Developers: Setting Up for Development

### 1. Clone the Repository

```bash
cd ~/GitHub
git clone https://github.com/cotepat/ncsender-plugin-meross-smart-outlet.git
cd ncsender-plugin-meross-smart-outlet
```

### 2. Test Locally

```bash
# Create a test package
./.scripts/test-package.sh

# Install the generated zip in ncSender
# Extract to: ~/Library/Application Support/ncSender/plugins/ (macOS)
```

### 3. Make Changes

1. Edit `index.js` and related modules
2. Update `manifest.json` version if needed
3. Test your changes by reinstalling in ncSender
4. Update `latest_release.md` with your changes

### 4. Publish Changes

```bash
# Commit your changes
git add -A
git commit -m "Description of changes"
git push

# Create a release tag (triggers automated release)
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin v1.0.1
```

The GitHub Action will automatically:
- Validate the code
- Create the plugin package
- Create a GitHub release with the zip file

## Using the Plugin

1. Open **Plugins → Meross Smart Outlet Controller**
2. Enter Meross credentials
3. Click **Discover Devices**
4. Add mappings and save settings
5. Test outlets from the **Testing** tab

## Support

- **Documentation**: See [README.md](README.md)
- **Issues**: Report bugs on GitHub Issues
- **ncSender Docs**: [Plugin Development Guide](https://github.com/siganberg/ncSender/blob/main/docs/PLUGIN_DEVELOPMENT.md)
# Quick Start Guide - Meross Smart Outlet Controller

Get up and running in 5 minutes!

## Prerequisites

- ncSender v0.3.111+ installed (includes Node.js - no separate install needed!)
- Meross smart plug connected to your Meross account
- Know your device name from Meross app

**Note**: This plugin has **zero dependencies** - it just works when you copy the files!

## Installation

### Standard Installation (Recommended)

**Just like any other ncSender plugin:**

1. **Get the ZIP file**
   - Download from releases, OR
   - Build it: `.scripts/package.sh` (creates `build/com.ncsender.meross-smart-outlet.zip`)

2. **Install in ncSender**
   - Open ncSender
   - Go to **Settings → Plugins**
   - Click **"Install Plugin"** or **"Install from ZIP"**
   - Select `com.ncsender.meross-smart-outlet.zip`
   - Done! ncSender handles everything

3. **Restart ncSender** (if needed)

If you have the source code:

```bash
cd /Users/patricecote/GitHub/ncsender-plugin-meross-smart-outlet
.scripts/install.sh  # Copies files directly for development
```

Then restart ncSender.

## Configuration

1. **Open Settings**
   - Go to **Settings → Plugins**
   - Find "Meross Smart Outlet Controller"
   - Click **Enable**
   - Click the **⚙️ Settings** icon

2. **Configure Meross Connection**
   - **Email**: Your Meross account email
   - **Password**: Your Meross account password
   - **Device Name**: Name from Meross app (e.g., "Smart Plug")
   - **Number of Channels**: How many outlets (usually 1 or 2)
   - **Min Signal Duration**: Leave at 250ms

3. **Add Command Mappings**

   **Example 1: Basic Coolant Control**
   ```
   Mapping #1:
   - Outlet: 1
   - Action: Turn ON
   - G-Codes: M8
   
   Mapping #2:
   - Outlet: 1
   - Action: Turn OFF
   - G-Codes: M9
   ```

   **Example 2: Coolant + Dust Collection**
   ```
   Mapping #1: Outlet 1 → Turn ON → M8
   Mapping #2: Outlet 1 → Turn OFF → M9
   Mapping #3: Outlet 2 → Turn ON → M3
   Mapping #4: Outlet 2 → Turn OFF → M5
   ```

4. **Save Settings**

5. **Reload Plugin** (if needed)
   ```bash
   curl -X POST http://localhost:8090/api/plugins/com.ncsender.meross-smart-outlet/reload
   ```

## Testing

1. **Open Console** in ncSender
2. **Send test commands**:
   ```
   M8    (should turn outlet ON)
   M9    (should turn outlet OFF)
   ```
3. **Check logs** for confirmation:
   ```
   [PLUGIN:com.ncsender.meross-smart-outlet] Command matched: M8 -> Outlet 1 on
   [PLUGIN:com.ncsender.meross-smart-outlet] Outlet 1 turned ON
   ```

## Common G-Code Commands

| Command | Standard Use | Example Mapping |
|---------|-------------|-----------------|
| `M8` | Coolant ON | Turn on coolant pump |
| `M9` | Coolant OFF | Turn off coolant pump |
| `M3` | Spindle ON CW | Turn on dust collection |
| `M5` | Spindle OFF | Turn off dust collection |
| `M65 P0` | Digital Output 0 | Custom accessory 1 |
| `M65 P1` | Digital Output 1 | Custom accessory 2 |
| `M7` | Mist coolant ON | Turn on mist system |

## Troubleshooting

### "Device not found"
- Check device name matches Meross app exactly (case-sensitive)
- Verify device is online in Meross app
- Try refreshing Meross app

### "Connection failed"
- Verify credentials are correct
- Check internet connection
- Try logging into Meross app first

### Outlet not responding
- Check command mapping matches your G-code exactly
- Look at plugin logs for errors
- Test outlet in Meross app to verify it works

### Need to reset
```bash
# Reload plugin
curl -X POST http://localhost:8090/api/plugins/com.ncsender.meross-smart-outlet/reload

# Or restart ncSender
```

## Next Steps

- Read full [README.md](./README.md) for advanced configuration
- Check [Python example](./python_example.py) for reference implementation
- Review ncSender [Plugin Development Guide](https://github.com/siganberg/ncsender/docs/PLUGIN_DEVELOPMENT.md)

## Safety Reminders

⚠️ **Important**:
- Outlets turn OFF when plugin loads/unloads (failsafe)
- Always test with non-critical equipment first
- Consider adding physical E-Stop for connected equipment
- Never exceed outlet power ratings

## Support

Issues? Questions? 
- GitHub: [Create an issue](https://github.com/cotepat/ncsender-plugin-meross-smart-outlet/issues)
- Check logs: Look for `[PLUGIN:com.ncsender.meross-smart-outlet]` messages
