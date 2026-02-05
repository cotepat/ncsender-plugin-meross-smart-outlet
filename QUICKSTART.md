# Quick Start Guide - Meross Smart Outlet Controller

Get up and running in minutes.

## Prerequisites

- ncSender v0.3.111+
- Meross smart outlet linked to your Meross account

## Installation

1. Download the latest release ZIP from GitHub Releases
2. Open ncSender → **Settings → Plugins**
3. Click **Install Plugin** and select the ZIP file
4. Restart ncSender if prompted

## Configuration

1. Open **Plugins → Meross Smart Outlet Controller** (tool menu)
2. Enter Meross email and password
3. Click **Discover Devices**
4. In **Mappings**, add G-codes on the row matching your device/outlet/action
5. Click **Save**
6. Use **Testing** to toggle outlets

## Example Mappings

- Coolant ON: `M8` (Turn ON row)
- Coolant OFF: `M9` (Turn OFF row)
- Dust Collection ON: `M3`
- Dust Collection OFF: `M5`

## Troubleshooting

- **No devices**: verify credentials and retry **Discover Devices**
- **Outlet not responding**: confirm the G-code matches what your job sends
- **Need a reset**: reload the plugin or restart ncSender

## Support

- Docs: [README.md](README.md)
- Issues: https://github.com/cotepat/ncsender-plugin-meross-smart-outlet/issues
