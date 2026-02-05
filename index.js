/*
 * Meross Smart Outlet Controller Plugin for ncSender
 * 
 * Controls Meross smart plug outlets based on G-code commands.
 * Supports configurable command mappings for multiple outlets/channels.
 * 
 * Version: 1.0.0
 */

import MerossCloudManager from './meross-cloud-manager.js';

let merossManagers = {}; // Map of device name -> MerossCloudManager
let commandMappings = [];
let discoveryTimer = null;
let discoveryInProgress = false;
let lastDiscoveryRequest = 0;
let nextDiscoveryAllowedAt = 0;
let discoveryBackoffMs = 0;

/**
 * Test outlet function - can be called externally
 * @param {string} deviceName - Name of device
 * @param {number} channelIndex - Channel index (1-based)
 * @param {boolean} turnOn - Turn on or off
 */
export async function testOutlet(deviceName, channelIndex, turnOn) {
  const manager = merossManagers[deviceName];
  if (!manager || !manager.isConnected()) {
    throw new Error(`Device ${deviceName} not connected. Please save settings and reload plugin first.`);
  }
  
  if (turnOn) {
    await manager.turnOn(channelIndex);
  } else {
    await manager.turnOff(channelIndex);
  }
  
  return { success: true, device: deviceName, channel: channelIndex, action: turnOn ? 'on' : 'off' };
}

/**
 * Get connection status
 */
export async function getStatus() {
  const connectedDevices = Object.entries(merossManagers)
    .filter(([_, manager]) => manager.isConnected())
    .map(([deviceName, _]) => deviceName);
  
  return {
    connected: connectedDevices.length > 0,
    devices: connectedDevices
  };
}


/**
 * Plugin initialization
 */
export function onLoad(ctx) {
  ctx.log('Meross Smart Outlet Controller v1.0.0 loading...');
  
  // Register command handler
  registerCommandHandler(ctx);
  
  // Register plugin settings UI
  registerPluginSettings(ctx);
  
  // Start discovery watcher (works without CNC connection)
  startDiscoveryWatcher(ctx);
  
  // Initialize Meross connection
  initializeMerossConnection(ctx);
  
  ctx.log('Meross Smart Outlet Controller loaded successfully');
}

/**
 * Initialize connection to Meross cloud
 */
async function initializeMerossConnection(ctx) {
  try {
    const settings = await loadSettingsFromAPI(ctx);
    
    if (!settings.merossEmail || !settings.merossPassword) {
      ctx.log('Meross credentials not configured. Please configure in plugin settings.');
      return;
    }
    
    // Find which devices are used in mappings
    const devicesUsed = new Set();
    (settings.commandMappings || []).forEach(mapping => {
      if (mapping.deviceName) {
        devicesUsed.add(mapping.deviceName);
      }
    });
    
    if (devicesUsed.size === 0) {
      ctx.log('No device mappings configured. Skipping device connections.');
      return;
    }
    
    ctx.log('Connecting to Meross cloud...');
    
    // Connect to each device used in mappings
    for (const deviceName of devicesUsed) {
      try {
        const manager = new MerossCloudManager(ctx);
        const connected = await manager.connect(
          settings.merossEmail,
          settings.merossPassword,
          deviceName
        );
        
        if (connected) {
          merossManagers[deviceName] = manager;
          ctx.log(`Successfully connected to device: ${deviceName}`);
          
          // Turn off all outlets on startup (failsafe)
          const deviceList = settings.discoveredDevices || [];
          const device = deviceList.find(d => d.devName === deviceName);
          if (device) {
            const numChannels = device.channels.length - 1; // Subtract master channel
            for (let i = 1; i <= numChannels; i++) {
              await manager.turnOff(i);
            }
          }
        }
      } catch (error) {
        ctx.log(`Failed to connect to device ${deviceName}:`, error.message);
      }
    }
    
    if (Object.keys(merossManagers).length > 0) {
      ctx.log('Startup failsafe: All outlets turned OFF');
    } else {
      ctx.log('No devices connected successfully');
    }
  } catch (error) {
    ctx.log('Error initializing Meross connection:', error.message);
  }
}

/**
 * Load settings from API
 */
async function loadSettingsFromAPI(ctx) {
  const defaultSettings = getDefaultSettings();
  
  try {
    const settings = ctx.getSettings ? ctx.getSettings() : {};
    return { ...defaultSettings, ...settings };
  } catch (error) {
    ctx.log('Failed to load settings, using defaults:', error);
    return defaultSettings;
  }
}

/**
 * Get default settings structure
 */
function getDefaultSettings() {
  return {
    merossEmail: '',
    merossPassword: '',
    discoveredDevices: [], // Array of devices with their channels
    discoverRequestedAt: 0,
    discoverCooldownUntil: 0,
    lastDiscoveryResult: null,
    minSignalDuration: 250, // milliseconds
    commandMappings: [
      // { deviceName: 'Smart Plug', channelIndex: 1, channelName: 'Filtration', action: 'on', gcodes: ['M8'] }
    ]
  };
}

/**
 * Watch for discovery requests and run without CNC
 */
function startDiscoveryWatcher(ctx) {
  if (discoveryTimer) return;
  
  discoveryTimer = setInterval(async () => {
    if (discoveryInProgress) return;
    
    if (nextDiscoveryAllowedAt && Date.now() < nextDiscoveryAllowedAt) {
      return;
    }
    
    const settings = await loadSettingsFromAPI(ctx);
    const hasCreds = settings.merossEmail && settings.merossPassword;
    if (!hasCreds) return;
    
    const requestAt = settings.discoverRequestedAt || 0;
    const cooldownUntil = settings.discoverCooldownUntil || 0;
    if (!requestAt) return;
    if (cooldownUntil && Date.now() < cooldownUntil) return;
    const shouldDiscover = requestAt > lastDiscoveryRequest;
    if (!shouldDiscover) return;
    
    discoveryInProgress = true;
    try {
      await runDeviceDiscovery(ctx, settings);
      lastDiscoveryRequest = requestAt || Date.now();
      discoveryBackoffMs = 0;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      ctx.log('Discovery watcher failed:', message);
      if (message.includes('Beyond Login Limit')) {
        // Backoff more aggressively when Meross rate limits
        discoveryBackoffMs = discoveryBackoffMs ? Math.min(discoveryBackoffMs * 2, 15 * 60 * 1000) : 60 * 1000;
        nextDiscoveryAllowedAt = Date.now() + discoveryBackoffMs;
        ctx.log(`Discovery paused for ${Math.round(discoveryBackoffMs / 1000)}s due to login limit.`);
      }
    } finally {
      discoveryInProgress = false;
    }
  }, 3000);
}

/**
 * Discover devices and save to settings
 */
async function runDeviceDiscovery(ctx, settings) {
  ctx.log('Discovering Meross devices...');
  
  const tempManager = new MerossCloudManager(ctx);
  try {
    await tempManager._login(settings.merossEmail, settings.merossPassword);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    settings.lastDiscoveryResult = {
      status: 'error',
      message: message,
      at: Date.now()
    };
    if (message.includes('Beyond Login Limit')) {
      discoveryBackoffMs = discoveryBackoffMs ? Math.min(discoveryBackoffMs * 2, 60 * 60 * 1000) : 10 * 60 * 1000;
      nextDiscoveryAllowedAt = Date.now() + discoveryBackoffMs;
      settings.discoverCooldownUntil = nextDiscoveryAllowedAt;
      if (ctx.setSettings) {
        ctx.setSettings(settings);
      }
      ctx.log(`Discovery paused for ${Math.round(discoveryBackoffMs / 1000)}s due to login limit.`);
    }
    throw error;
  }
  
  const devices = await tempManager._getDevices();
  
  settings.discoveredDevices = devices.map(dev => ({
    devName: dev.devName,
    deviceType: dev.deviceType,
    uuid: dev.uuid,
    channels: dev.channels
  }));
  settings.discoverRequestedAt = 0;
  settings.lastDiscoveryResult = {
    status: 'success',
    message: `Found ${devices.length} device(s)`,
    at: Date.now()
  };
  
  if (ctx.setSettings) {
    ctx.setSettings(settings);
  }
  
  await tempManager.disconnect();
  ctx.log(`✓ Discovered ${devices.length} device(s)`);
}

/**
 * Register command handler
 */
function registerCommandHandler(ctx) {
  ctx.registerEventHandler('onBeforeCommand', async (commands, context, pluginContext) => {
    try {
      const settings = await loadSettingsFromAPI(ctx);
      
      // Process each command
      for (const cmdObj of commands) {
        const command = cmdObj.command.trim();
        const commandUpper = command.toUpperCase();
        
        // Check if this is a discover devices command
        if (command === '$$DISCOVER_DEVICES$$') {
          ctx.log('Discovery command detected');
          
          try {
            if (!settings.merossEmail || !settings.merossPassword) {
              ctx.log('Meross credentials not configured. Please configure in plugin settings.');
              return [];
            }
            
            await runDeviceDiscovery(ctx, settings);
          } catch (error) {
            ctx.log(`✗ Discovery failed: ${error.message}`);
          }
          
          return []; // Don't send to CNC
        }
        
        // Check for test commands (format: $$TEST_DEVICE_NAME_CHANNEL_ON$$)
        if (command.startsWith('$$TEST_')) {
          const match = command.match(/\$\$TEST_(.+)_(\d+)_(ON|OFF)\$\$/);
          if (match) {
            const deviceName = match[1].replace(/_/g, ' '); // Convert underscores back to spaces
            const channelIndex = parseInt(match[2]);
            const turnOn = match[3] === 'ON';
            
            ctx.log(`Test command detected: ${deviceName} / Channel ${channelIndex} -> ${turnOn ? 'ON' : 'OFF'}`);
            
            try {
              let manager = merossManagers[deviceName];
              if (!manager || !manager.isConnected()) {
                manager = new MerossCloudManager(ctx);
                const connected = await manager.connect(settings.merossEmail, settings.merossPassword, deviceName);
                if (!connected) {
                  throw new Error(`Device ${deviceName} not connected`);
                }
                merossManagers[deviceName] = manager;
              }
              
              if (turnOn) {
                await manager.turnOn(channelIndex);
                ctx.log(`✓ Test successful: ${deviceName} / Channel ${channelIndex} turned ON`);
              } else {
                await manager.turnOff(channelIndex);
                ctx.log(`✓ Test successful: ${deviceName} / Channel ${channelIndex} turned OFF`);
              }
            } catch (error) {
              ctx.log(`✗ Test failed: ${error.message}`);
            }
            
            // Don't send test commands to CNC
            return [];
          }
        }
      
      // Check if we have any connected managers, if not try to reconnect
      const hasConnectedManagers = Object.values(merossManagers).some(m => m.isConnected());
      if (!hasConnectedManagers) {
        // Try to reconnect if not connected
        await initializeMerossConnection(ctx);
        const stillNoConnection = Object.values(merossManagers).every(m => !m.isConnected());
        if (stillNoConnection) {
          return commands; // Skip if still not connected
        }
      }
        
        // Check against all command mappings
        for (const mapping of settings.commandMappings) {
          // Check if command matches any of the gcodes for this mapping
          const matches = mapping.gcodes.some(gcode => {
            const gcodePattern = gcode.trim().toUpperCase();
            
            // Handle different pattern types
            if (gcodePattern.includes(' ')) {
              // Exact match with parameters (e.g., "M65 P0")
              return commandUpper === gcodePattern;
            } else {
              // Match command code only (e.g., "M8" matches "M8" or "M8 P1")
              return commandUpper === gcodePattern || commandUpper.startsWith(gcodePattern + ' ');
            }
          });
          
          if (matches) {
            const channelName = mapping.channelName || `Channel ${mapping.channelIndex}`;
            ctx.log(`Command matched: ${command} -> ${mapping.deviceName} / ${channelName} ${mapping.action}`);
            
            // Get manager for this device
            const manager = merossManagers[mapping.deviceName];
            if (!manager || !manager.isConnected()) {
              ctx.log(`Device ${mapping.deviceName} not connected`);
              continue;
            }
            
            // Execute the action with debounce delay
            await new Promise(resolve => setTimeout(resolve, settings.minSignalDuration));
            
            if (mapping.action === 'on') {
              await manager.turnOn(mapping.channelIndex);
              ctx.log(`${mapping.deviceName} / ${channelName} turned ON`);
            } else if (mapping.action === 'off') {
              await manager.turnOff(mapping.channelIndex);
              ctx.log(`${mapping.deviceName} / ${channelName} turned OFF`);
            }
          }
        }
      }
      
      return commands;
    } catch (error) {
      ctx.log('Error in command handler:', error.message);
      return commands;
    }
  });
}

/**
 * Register plugin settings UI
 */
function registerPluginSettings(ctx) {
  const html = `
    <style>
      .plugin-settings {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
        padding: 8px;
        color: var(--color-text-primary, #e0e0e0);
        max-height: 80vh;
        overflow-y: auto;
      }
      
      .ms-tabs {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid var(--color-border, #333);
        margin-bottom: 8px;
      }
      
      .ms-tab {
        all: unset;
        cursor: pointer;
        padding: 4px 8px;
        font-size: 0.78rem;
        color: var(--color-text-secondary);
        border-radius: 4px 4px 0 0;
      }
      
      .ms-tab.active {
        color: var(--color-text-primary);
        background: var(--color-surface, #2a2a2a);
        border: 1px solid var(--color-border, #333);
        border-bottom: none;
      }
      
      .ms-tab-content {
        display: none;
      }
      
      .ms-tab-content.active {
        display: block;
      }
      
      @media (max-width: 900px) {
        .two-column-layout {
          grid-template-columns: 1fr;
        }
      }
      
      .settings-section {
        margin-bottom: 8px;
        border: 1px solid var(--color-border, #333);
        border-radius: 6px;
        padding: 10px;
        background: var(--color-surface-muted, #1a1a1a);
      }
      
      .settings-section h3 {
        margin-top: 0;
        margin-bottom: 6px;
        color: var(--color-text-primary);
        font-size: 0.9rem;
      }
      
      .form-group {
        margin-bottom: 8px;
      }
      
      .form-group label {
        display: block;
        margin-bottom: 6px;
        color: var(--color-text-secondary);
        font-size: 0.9rem;
      }
      
      .form-group input,
      .form-group select {
        width: 100%;
        padding: 5px 8px;
        background: var(--color-surface, #2a2a2a);
        border: 1px solid var(--color-border, #333);
        border-radius: 4px;
        color: var(--color-text-primary);
        font-size: 0.8rem;
      }
      
      .form-group input:focus,
      .form-group select:focus {
        outline: none;
        border-color: var(--color-primary, #007bff);
      }
      
      .help-text {
        font-size: 0.75rem;
        color: var(--color-text-secondary);
        margin-top: 2px;
        line-height: 1.3;
      }
      
      .outlet-test-section {
        display: flex;
        gap: 6px;
      }
      
      .outlet-test-btn {
        padding: 4px 8px;
        border: 1px solid var(--color-border, #333);
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.75rem;
        transition: all 0.2s;
      }

      .outlet-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 8px;
      }

      .outlet-card {
        border: 1px solid var(--color-border, #333);
        background: var(--color-surface, #2a2a2a);
        border-radius: 6px;
        padding: 8px;
        display: grid;
        gap: 6px;
      }

      .outlet-card-device {
        font-size: 0.75rem;
        color: var(--color-text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }

      .outlet-card-name {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--color-text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .outlet-card-buttons {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }
      
      .outlet-test-btn.on {
        background: #28a745;
        color: white;
        border-color: #28a745;
      }
      
      .outlet-test-btn.on:hover {
        background: #218838;
      }
      
      .outlet-test-btn.off {
        background: #dc3545;
        color: white;
        border-color: #dc3545;
      }
      
      .outlet-test-btn.off:hover {
        background: #c82333;
      }
      
      .outlet-test-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      
      .test-status {
        font-size: 0.85rem;
        padding: 8px;
        border-radius: 4px;
        margin-top: 8px;
        display: none;
      }
      
      .test-status.show {
        display: block;
      }
      
      .test-status.success {
        background: rgba(40, 167, 69, 0.2);
        color: #28a745;
      }
      
      .test-status.error {
        background: rgba(220, 53, 69, 0.2);
        color: #dc3545;
      }
      
      .command-mapping {
        background: var(--color-surface, #2a2a2a);
        border: 1px solid var(--color-border, #444);
        border-radius: 6px;
        padding: 10px;
        margin-bottom: 8px;
      }
      
      .command-mapping-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      
      .command-mapping-header h4 {
        margin: 0;
        font-size: 1rem;
        color: var(--color-text-primary);
      }
      
      .btn {
        padding: 4px 8px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.75rem;
        transition: background-color 0.2s;
      }
      
      .btn-danger {
        background: #dc3545;
        color: white;
      }
      
      .btn-danger:hover {
        background: #c82333;
      }
      
      .btn-primary {
        background: #007bff;
        color: white;
      }
      
      .btn-primary:hover {
        background: #0056b3;
      }
      
      .btn-success {
        background: #28a745;
        color: white;
        margin-top: 16px;
      }
      
      .btn-success:hover {
        background: #218838;
      }
      
      .btn-secondary {
        background: #6c757d;
        color: white;
      }
      
      .btn-secondary:hover {
        background: #5a6268;
      }
      
      .connection-status {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px;
        background: var(--color-surface, #2a2a2a);
        border: 1px solid var(--color-border, #444);
        border-radius: 6px;
        margin-bottom: 12px;
      }
      
      .status-indicator {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .status-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #6c757d;
      }
      
      .status-dot.connected {
        background: #28a745;
        animation: pulse 2s infinite;
      }
      
      .status-dot.disconnected {
        background: #dc3545;
      }
      
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
      
      .fetch-status {
        margin-top: 8px;
        padding: 8px 12px;
        border-radius: 4px;
        font-size: 0.9rem;
        display: none;
      }
      
      .fetch-status.show {
        display: block;
      }
      
      .fetch-status.loading {
        background: var(--color-info, #17a2b8);
        color: white;
      }
      
      .fetch-status.success {
        background: var(--color-success, #28a745);
        color: white;
      }
      
      .fetch-status.error {
        background: var(--color-danger, #dc3545);
        color: white;
      }
      
      .devices-container {
        margin-top: 12px;
        display: none;
      }
      
      .devices-container.show {
        display: block;
      }
      
      .device-card {
        background: var(--color-surface, #2a2a2a);
        border: 1px solid var(--color-border, #444);
        border-radius: 6px;
        padding: 8px;
        margin-bottom: 8px;
      }
      
      .device-header {
        font-weight: 600;
        color: var(--color-text-primary);
        margin-bottom: 6px;
        font-size: 0.85rem;
      }
      
      .device-type {
        color: var(--color-text-secondary);
        font-size: 0.75rem;
        margin-bottom: 6px;
      }
      
      .channel-list {
        margin-left: 16px;
      }
      
      .channel-item {
        padding: 4px 0;
        color: var(--color-text-secondary);
        font-size: 0.8rem;
      }
      
      .channel-name {
        font-weight: 500;
        color: var(--color-text-primary);
      }
      
      .inline-group {
        display: grid;
        grid-template-columns: 1fr 1fr 1.2fr;
        gap: 6px;
        align-items: end;
      }
      
      .gcode-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 4px;
      }
      
      .gcode-tag {
        background: var(--color-primary, #007bff);
        color: white;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: 0.7rem;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      
      .gcode-tag button {
        background: none;
        border: none;
        color: white;
        cursor: pointer;
        padding: 0;
        font-size: 1rem;
        line-height: 1;
      }
      
      .gcode-input-wrapper {
        display: flex;
        gap: 6px;
      }
      
      .gcode-input-wrapper input {
        flex: 1;
      }
      
      .save-status {
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 0.9rem;
        margin-top: 12px;
        display: none;
      }
      
      .save-status.success {
        background: rgba(40, 167, 69, 0.2);
        color: #28a745;
        display: block;
      }
      
      .save-status.error {
        background: rgba(220, 53, 69, 0.2);
        color: #dc3545;
        display: block;
      }
      
      .connection-status {
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 0.9rem;
        margin-bottom: 16px;
      }
      
      .connection-status.connected {
        background: rgba(40, 167, 69, 0.2);
        color: #28a745;
      }
      
      .connection-status.disconnected {
        background: rgba(220, 53, 69, 0.2);
        color: #dc3545;
      }
    </style>
    
    <div class="plugin-settings">
      <div class="ms-tabs">
        <button class="ms-tab active" data-tab="connection">Connection</button>
        <button class="ms-tab" data-tab="mappings">Mappings</button>
        <button class="ms-tab" data-tab="testing">Testing</button>
      </div>
      
      <div class="ms-tab-content active" id="ms-tab-connection">
        <div class="settings-section">
          <h3>Meross Connection</h3>
          <div class="form-group">
            <label for="merossEmail">Meross Email:</label>
            <input type="email" id="merossEmail" placeholder="your.email@example.com">
          </div>
          
          <div class="form-group">
            <label for="merossPassword">Meross Password:</label>
            <input type="password" id="merossPassword" placeholder="Your Meross password">
            <p class="help-text">Credentials stored locally and used only for Meross cloud connection.</p>
          </div>
          
          <div class="form-group">
            <label>Devices:</label>
            <button class="btn btn-secondary" id="fetchDevicesBtn" onclick="fetchDevices()">Discover Devices</button>
            <div id="fetchStatus" class="fetch-status"></div>
            <div id="devicesContainer" class="devices-container"></div>
          </div>
          
          <div class="form-group">
            <label for="minSignalDuration">Min Signal Duration (ms):</label>
            <input type="number" id="minSignalDuration" min="0" step="50" placeholder="250">
            <p class="help-text">Debounce time before activating outlet.</p>
          </div>
        </div>
        
        <div class="settings-section">
          <h3>Connection Status</h3>
          <div id="connectionStatus" class="connection-status">
            <div class="status-indicator">
              <span class="status-dot" id="statusDot"></span>
              <span id="statusText">Checking...</span>
            </div>
            <button class="btn btn-secondary" onclick="checkConnection()">Refresh Status</button>
          </div>
        </div>
      </div>
      
      <div class="ms-tab-content" id="ms-tab-mappings">
        <div class="settings-section">
          <h3>Command Mappings</h3>
          <p class="help-text">Map G-code commands to outlet actions.</p>
          
          <div id="commandMappingsContainer"></div>
          
          <button class="btn btn-primary" onclick="addCommandMapping()">+ Add Mapping</button>
        </div>
      </div>
      
      <div class="ms-tab-content" id="ms-tab-testing">
        <div class="settings-section">
          <h3>Test Outlets</h3>
          <p class="help-text">Test each outlet to verify connection. Save settings first!</p>
          
          <div id="outletTestControls"></div>
          
          <div id="testStatus" class="test-status"></div>
        </div>
      </div>
      
      <button class="btn btn-success" onclick="window.saveAllSettings && window.saveAllSettings()">Save Settings</button>
      
      <div id="saveStatus" class="save-status"></div>
    </div>
    
    <script>
      (function() {
        const pluginId = 'com.ncsender.meross-smart-outlet';
        let currentSettings = {};
        
        // Load settings
        function getDefaultUiSettings() {
          return {
            merossEmail: '',
            merossPassword: '',
            discoveredDevices: [],
            minSignalDuration: 250,
            commandMappings: []
          };
        }

        function initTabs() {
          const tabs = document.querySelectorAll('.ms-tab');
          const contents = document.querySelectorAll('.ms-tab-content');
          
          tabs.forEach(tab => {
            tab.addEventListener('click', () => {
              const target = tab.getAttribute('data-tab');
              tabs.forEach(t => t.classList.remove('active'));
              contents.forEach(c => c.classList.remove('active'));
              tab.classList.add('active');
              const content = document.getElementById('ms-tab-' + target);
              if (content) {
                content.classList.add('active');
              }
            });
          });
        }

        function loadSettings() {
          fetch('/api/plugins/' + pluginId + '/settings')
            .then(response => {
              if (!response.ok) {
                throw new Error('Failed to load settings');
              }
              return response.json();
            })
            .then(settings => {
              currentSettings = Object.assign(getDefaultUiSettings(), settings || {});
              renderSettings();
            })
            .catch(error => {
              console.error('Failed to load settings:', error);
              currentSettings = getDefaultUiSettings();
              renderSettings();
            });
        }
        
        // Render settings form
        function renderSettings() {
          document.getElementById('merossEmail').value = currentSettings.merossEmail || '';
          document.getElementById('merossPassword').value = currentSettings.merossPassword || '';
          document.getElementById('minSignalDuration').value = currentSettings.minSignalDuration || 250;
          
          // Show discovered devices if available
          if (currentSettings.discoveredDevices && currentSettings.discoveredDevices.length > 0) {
            renderDiscoveredDevices(currentSettings.discoveredDevices);
          }
          
          renderCommandMappings();
        }
        
        // Render outlet test controls based on discovered devices
        function renderOutletTests() {
          const container = document.getElementById('outletTestControls');
          const devices = currentSettings.discoveredDevices || [];
          
          if (devices.length === 0) {
            container.innerHTML = '<p style="color: var(--color-text-secondary);">Please discover devices first</p>';
            return;
          }
          
          container.innerHTML = '';
          container.className = 'outlet-grid';
          
          devices.forEach(device => {
            // Channel cards (skip master channel at index 0)
            device.channels.forEach((channel, chIndex) => {
              if (chIndex === 0) return; // Skip master
              
              const card = document.createElement('div');
              card.className = 'outlet-card';
              
              const deviceLabel = document.createElement('div');
              deviceLabel.className = 'outlet-card-device';
              deviceLabel.textContent = device.devName;
              
              const nameLabel = document.createElement('div');
              nameLabel.className = 'outlet-card-name';
              nameLabel.textContent = channel.devName || ('Outlet ' + chIndex);
              
              const buttons = document.createElement('div');
              buttons.className = 'outlet-card-buttons';
              
              const btnOn = document.createElement('button');
              btnOn.className = 'outlet-test-btn on';
              btnOn.textContent = 'ON';
              btnOn.addEventListener('click', () => testOutletButton(device.devName, chIndex, true));
              
              const btnOff = document.createElement('button');
              btnOff.className = 'outlet-test-btn off';
              btnOff.textContent = 'OFF';
              btnOff.addEventListener('click', () => testOutletButton(device.devName, chIndex, false));
              
              buttons.appendChild(btnOn);
              buttons.appendChild(btnOff);
              
              card.appendChild(deviceLabel);
              card.appendChild(nameLabel);
              card.appendChild(buttons);
              container.appendChild(card);
            });
          });
        }
        
        // Fetch devices from Meross
        window.fetchDevices = async function() {
          const fetchStatus = document.getElementById('fetchStatus');
          const devicesContainer = document.getElementById('devicesContainer');
          const fetchBtn = document.getElementById('fetchDevicesBtn');
          
          const email = document.getElementById('merossEmail').value;
          const password = document.getElementById('merossPassword').value;
          
          if (!email || !password) {
            fetchStatus.textContent = 'Please enter email and password first';
            fetchStatus.className = 'fetch-status show error';
            return;
          }
          
          fetchBtn.disabled = true;
          fetchStatus.textContent = 'Connecting to Meross...';
          fetchStatus.className = 'fetch-status show loading';
          devicesContainer.className = 'devices-container';
          
          try {
            // Refresh settings and check cooldown
            const latestResponse = await fetch('/api/plugins/' + pluginId + '/settings');
            if (latestResponse.ok) {
              currentSettings = await latestResponse.json();
            }
            
            const cooldownUntil = currentSettings.discoverCooldownUntil || 0;
            if (cooldownUntil && Date.now() < cooldownUntil) {
              const secondsLeft = Math.max(0, Math.round((cooldownUntil - Date.now()) / 1000));
              fetchStatus.textContent = 'Discovery rate-limited. Try again in ' + secondsLeft + 's.';
              fetchStatus.className = 'fetch-status show error';
              fetchBtn.disabled = false;
              return;
            }
            
            // Save credentials and request discovery without CNC
            currentSettings.merossEmail = email;
            currentSettings.merossPassword = password;
            currentSettings.discoverRequestedAt = Date.now();
            
            await fetch('/api/plugins/' + pluginId + '/settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(currentSettings)
            });
            
            // Poll for discovered devices
            let attempts = 0;
            let found = false;
            while (attempts < 8 && !found) {
              await new Promise(resolve => setTimeout(resolve, 2000));
              const response = await fetch('/api/plugins/' + pluginId + '/settings');
              if (response.ok) {
                const settings = await response.json();
                currentSettings = settings;
                
                if (settings.discoveredDevices && settings.discoveredDevices.length > 0) {
                  renderDiscoveredDevices(settings.discoveredDevices);
                  fetchStatus.textContent = 'Found ' + settings.discoveredDevices.length + ' device(s)';
                  fetchStatus.className = 'fetch-status show success';
                  found = true;
                }
              }
              attempts++;
            }
            
            if (!found) {
              const lastResult = currentSettings.lastDiscoveryResult;
              if (lastResult && lastResult.message) {
                const ageSec = Math.max(0, Math.round((Date.now() - lastResult.at) / 1000));
                fetchStatus.textContent = 'Discovery result: ' + lastResult.message + ' (' + ageSec + 's ago)';
              } else {
                fetchStatus.textContent = 'No devices found yet. Check logs for details.';
              }
              fetchStatus.className = 'fetch-status show error';
            }
          } catch (error) {
            fetchStatus.textContent = 'Error: ' + error.message;
            fetchStatus.className = 'fetch-status show error';
          } finally {
            fetchBtn.disabled = false;
          }
        };
        
        // Render discovered devices
        function renderDiscoveredDevices(devices) {
          const container = document.getElementById('devicesContainer');
          container.innerHTML = '';
          
          devices.forEach(device => {
            const card = document.createElement('div');
            card.className = 'device-card';
            
            const header = document.createElement('div');
            header.className = 'device-header';
            header.textContent = device.devName;
            
            const type = document.createElement('div');
            type.className = 'device-type';
            type.textContent = device.deviceType + ' (' + (device.channels.length - 1) + ' outlets)';
            
            card.appendChild(header);
            card.appendChild(type);
            
            // Render channels (skip index 0 which is master)
            if (device.channels && device.channels.length > 1) {
              const channelList = document.createElement('div');
              channelList.className = 'channel-list';
              
              device.channels.forEach((channel, index) => {
                if (index === 0) return; // Skip master channel
                
                const channelItem = document.createElement('div');
                channelItem.className = 'channel-item';
                channelItem.innerHTML =
                  '<span class="channel-name">' + (channel.devName || 'Outlet ' + index) + '</span>' +
                  '<span style="color: var(--color-text-tertiary);"> (Channel ' + index + ')</span>';
                channelList.appendChild(channelItem);
              });
              
              card.appendChild(channelList);
            }
            
            container.appendChild(card);
          });
          
          container.className = 'devices-container show';
        }
        
        // Check connection status
        window.checkConnection = async function() {
          const statusDot = document.getElementById('statusDot');
          const statusText = document.getElementById('statusText');
          
          statusDot.className = 'status-dot';
          statusText.textContent = 'Checking...';
          
          try {
            // Try to get plugin settings (if this works, plugin is loaded)
            const response = await fetch('/api/plugins/' + pluginId + '/settings');
            if (response.ok) {
              const settings = await response.json();
              const hasCredentials = settings.merossEmail && settings.merossPassword;
              const hasDevices = settings.discoveredDevices && settings.discoveredDevices.length > 0;
              const hasMappings = settings.commandMappings && settings.commandMappings.length > 0;
              
              if (hasCredentials && hasDevices && hasMappings) {
                // Show number of devices configured
                const deviceCount = settings.discoveredDevices.length;
                statusDot.className = 'status-dot connected';
                statusText.textContent = 'Connected (' + deviceCount + ' device' + (deviceCount > 1 ? 's' : '') + ')';
              } else if (hasCredentials && hasDevices) {
                statusDot.className = 'status-dot';
                statusText.textContent = 'Devices discovered, add mappings';
              } else if (hasCredentials) {
                statusDot.className = 'status-dot';
                statusText.textContent = 'Credentials set, discover devices';
              } else {
                statusDot.className = 'status-dot disconnected';
                statusText.textContent = 'Not configured';
              }
            } else {
              statusDot.className = 'status-dot disconnected';
              statusText.textContent = 'Plugin not loaded';
            }
          } catch (error) {
            statusDot.className = 'status-dot disconnected';
            statusText.textContent = 'Error checking status';
          }
        };
        
        // Test outlet function for UI buttons
        window.testOutletButton = async function(deviceName, channelIndex, turnOn) {
          console.log('testOutletButton called:', deviceName, channelIndex, turnOn);
          const testStatus = document.getElementById('testStatus');
          
          // Disable all test buttons
          const buttons = document.querySelectorAll('.outlet-test-btn');
          buttons.forEach(btn => btn.disabled = true);
          
          testStatus.textContent = 'Testing ' + deviceName + ' / Channel ' + channelIndex + '... ' + (turnOn ? 'turning ON' : 'turning OFF');
          testStatus.className = 'test-status show';
          
          try {
            // Send a console command to test the outlet
            // Format: $$TEST_Device_Name_1_ON$$ (spaces in device name replaced with underscores)
            const deviceNameFormatted = deviceName.replace(/\s/g, '_');
            const testCommand = '$$TEST_' + deviceNameFormatted + '_' + channelIndex + '_' + (turnOn ? 'ON' : 'OFF') + '$$';
            console.log('Sending command:', testCommand);
            
            const response = await fetch('/api/send-command', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ command: testCommand })
            });
            
            console.log('Response status:', response.status);
            
            if (!response.ok) {
              throw new Error('Failed to send test command');
            }
            
            // Wait a moment for the command to execute
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            testStatus.textContent = '✓ Test command sent. Check plugin logs for confirmation.';
            testStatus.className = 'test-status success show';
          } catch (error) {
            testStatus.textContent = '✗ Error: ' + error.message + '. Make sure plugin is loaded and connected.';
            testStatus.className = 'test-status error show';
          } finally {
            // Re-enable buttons
            buttons.forEach(btn => btn.disabled = false);
            
            // Hide status after 4 seconds
            setTimeout(() => {
              testStatus.className = 'test-status';
            }, 4000);
          }
        };
        
        // Render command mappings
        function renderCommandMappings() {
          const container = document.getElementById('commandMappingsContainer');
          const mappings = currentSettings.commandMappings || [];
          const devices = currentSettings.discoveredDevices || [];
          
          if (devices.length === 0) {
            container.innerHTML = '<p style="color: var(--color-text-secondary);">Please discover devices first</p>';
            return;
          }
          
          container.innerHTML = mappings.map((mapping, index) => {
            // Build device options
            const deviceOptions = devices.map(dev =>
              '<option value="' + dev.devName + '" ' + (mapping.deviceName === dev.devName ? 'selected' : '') + '>' + dev.devName + '</option>'
            ).join('');
            
            // Build channel options for selected device
            const selectedDevice = devices.find(d => d.devName === mapping.deviceName) || devices[0];
            const channelOptions = selectedDevice.channels
              .map((ch, chIndex) => {
                if (chIndex === 0) return ''; // Skip master channel
                const channelName = ch.devName || 'Outlet ' + chIndex;
                return '<option value="' + chIndex + '" ' + (mapping.channelIndex === chIndex ? 'selected' : '') + '>' + channelName + '</option>';
              })
              .filter(Boolean)
              .join('');

            const gcodeTags = (mapping.gcodes || []).map((gcode, gcodeIndex) =>
              '<div class="gcode-tag">' +
                '<span>' + gcode + '</span>' +
                '<button onclick="removeGcode(' + index + ', ' + gcodeIndex + ')">×</button>' +
              '</div>'
            ).join('');

            return '' +
              '<div class="command-mapping" data-index="' + index + '">' +
                '<div class="command-mapping-header">' +
                  '<h4>Mapping #' + (index + 1) + '</h4>' +
                  '<button class="btn btn-danger" onclick="removeCommandMapping(' + index + ')">Remove</button>' +
                '</div>' +
                '<div class="inline-group">' +
                  '<div class="form-group">' +
                    '<label>Device:</label>' +
                    '<select onchange="updateMappingDevice(' + index + ', this.value)">' +
                      deviceOptions +
                    '</select>' +
                  '</div>' +
                  '<div class="form-group">' +
                    '<label>Channel:</label>' +
                    '<select id="channel-select-' + index + '" onchange="updateMappingChannel(' + index + ', parseInt(this.value))">' +
                      channelOptions +
                    '</select>' +
                  '</div>' +
                  '<div class="form-group">' +
                    '<label>Action:</label>' +
                    '<select onchange="updateMapping(' + index + ', \\\'action\\\', this.value)">' +
                      '<option value="on" ' + (mapping.action === 'on' ? 'selected' : '') + '>Turn ON</option>' +
                      '<option value="off" ' + (mapping.action === 'off' ? 'selected' : '') + '>Turn OFF</option>' +
                    '</select>' +
                  '</div>' +
                '</div>' +
                '<div class="form-group" style="margin-top: 12px;">' +
                  '<label>G-Codes:</label>' +
                  '<div class="gcode-input-wrapper">' +
                    '<input type="text" id="gcode-input-' + index + '" placeholder="e.g., M8 or M65 P0">' +
                    '<button class="btn btn-primary" onclick="addGcode(' + index + ')">Add</button>' +
                  '</div>' +
                '</div>' +
                '<div class="gcode-tags">' +
                  gcodeTags +
                '</div>' +
              '</div>';
          }).join('');
        }
        
        // Add G-code to mapping
        window.addGcode = function(mappingIndex) {
          const input = document.getElementById('gcode-input-' + mappingIndex);
          const gcode = input.value.trim().toUpperCase();
          
          if (gcode && !currentSettings.commandMappings[mappingIndex].gcodes.includes(gcode)) {
            currentSettings.commandMappings[mappingIndex].gcodes.push(gcode);
            input.value = '';
            renderCommandMappings();
          }
        };
        
        // Remove G-code from mapping
        window.removeGcode = function(mappingIndex, gcodeIndex) {
          currentSettings.commandMappings[mappingIndex].gcodes.splice(gcodeIndex, 1);
          renderCommandMappings();
        };
        
        // Update mapping device
        window.updateMappingDevice = function(index, deviceName) {
          currentSettings.commandMappings[index].deviceName = deviceName;
          
          // Reset channel to first available
          const device = currentSettings.discoveredDevices.find(d => d.devName === deviceName);
          if (device && device.channels.length > 1) {
            currentSettings.commandMappings[index].channelIndex = 1;
            currentSettings.commandMappings[index].channelName = device.channels[1].devName || 'Outlet 1';
          }
          
          renderCommandMappings();
        };
        
        // Update mapping channel
        window.updateMappingChannel = function(index, channelIndex) {
          const mapping = currentSettings.commandMappings[index];
          const device = currentSettings.discoveredDevices.find(d => d.devName === mapping.deviceName);
          
          if (device) {
            mapping.channelIndex = channelIndex;
            mapping.channelName = device.channels[channelIndex].devName || 'Outlet ' + channelIndex;
          }
        };
        
        // Update mapping field
        window.updateMapping = function(index, field, value) {
          currentSettings.commandMappings[index][field] = value;
        };
        
        // Add new command mapping
        window.addCommandMapping = function() {
          if (!currentSettings.commandMappings) {
            currentSettings.commandMappings = [];
          }
          
          const devices = currentSettings.discoveredDevices || [];
          if (devices.length === 0) {
            alert('Please discover devices first');
            return;
          }
          
          // Default to first device, first channel
          const firstDevice = devices[0];
          const firstChannel = firstDevice.channels[1]; // Skip master at index 0
          
          currentSettings.commandMappings.push({
            deviceName: firstDevice.devName,
            channelIndex: 1,
            channelName: (firstChannel && firstChannel.devName) ? firstChannel.devName : 'Outlet 1',
            action: 'on',
            gcodes: []
          });
          renderCommandMappings();
        };
        
        // Remove command mapping
        window.removeCommandMapping = function(index) {
          currentSettings.commandMappings.splice(index, 1);
          renderCommandMappings();
        };
        
        // Save all settings
        window.saveAllSettings = function() {
          currentSettings.merossEmail = document.getElementById('merossEmail').value;
          currentSettings.merossPassword = document.getElementById('merossPassword').value;
          currentSettings.minSignalDuration = parseInt(document.getElementById('minSignalDuration').value);
          
          const saveStatus = document.getElementById('saveStatus');
          
          fetch('/api/plugins/' + pluginId + '/settings', {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(currentSettings)
          })
          .then(response => {
            if (!response.ok) {
              throw new Error('Failed to save settings');
            }
            saveStatus.textContent = 'Settings saved successfully. Please reload the plugin for changes to take effect.';
            saveStatus.className = 'save-status success';
            setTimeout(() => {
              saveStatus.style.display = 'none';
            }, 5000);
          })
          .catch(error => {
            console.error('Failed to save settings:', error);
            saveStatus.textContent = 'Failed to save settings: ' + error.message;
            saveStatus.className = 'save-status error';
          });
        };
        
        // Initialize
        initTabs();
        loadSettings();
        checkConnection();
        
        // Render outlet tests after settings load
        setTimeout(() => {
          renderOutletTests();
        }, 100);
      })();
    </script>
  `;
  
  ctx.registerConfigUI(html);
  
  // Register test outlet API endpoint
  ctx.registerAPIEndpoint = ctx.registerAPIEndpoint || function() {};
}

/**
 * Plugin cleanup
 */
export function onUnload(ctx) {
  ctx.log('Meross Smart Outlet Controller shutting down...');
  
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
  
  // Disconnect from all devices and turn off all outlets (failsafe)
  for (const [deviceName, manager] of Object.entries(merossManagers)) {
    manager.disconnect().catch(error => {
      ctx.log(`Error disconnecting from ${deviceName}:`, error.message);
    });
  }
  
  ctx.log('Meross Smart Outlet Controller unloaded');
}
