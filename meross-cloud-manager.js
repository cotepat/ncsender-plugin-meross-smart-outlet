/*
 * Meross Cloud Manager
 * Handles connection and control of Meross devices via the Meross cloud
 * 
 * Uses HTTP API for login/device list, MQTT for device control
 * Based on reverse-engineered Meross protocol
 */

import crypto from 'crypto';
import https from 'https';
import SimpleMqttClient from './simple-mqtt-client.js';

class MerossCloudManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.baseUrl = 'https://iotx-us.meross.com';
    this.token = null;
    this.key = null;
    this.userId = null;
    this.device = null;
    this.mqttDomain = null;
    this.mqttClient = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectBackoff = 5000; // 5 seconds
  }

  // Shared auth cache to avoid repeated logins
  static sharedAuth = null;
  static loginPromise = null;
  static loginTtlMs = 6 * 60 * 60 * 1000; // 6 hours
  static loginBlockedUntil = 0;

  /**
   * Throttle Meross HTTP requests to avoid rate limits
   * Conservative default: 1 request per 10 seconds
   */
  static httpMinIntervalMs = 10000;
  static httpLastRequestAt = 0;
  static httpQueue = Promise.resolve();

  static async _throttleHttpRequest(ctx) {
    const now = Date.now();
    const elapsed = now - MerossCloudManager.httpLastRequestAt;
    const waitMs = Math.max(0, MerossCloudManager.httpMinIntervalMs - elapsed);
    if (waitMs > 0) {
      if (ctx && ctx.log) {
        ctx.log(`Meross HTTP throttling: waiting ${waitMs}ms`);
      }
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    MerossCloudManager.httpLastRequestAt = Date.now();
  }
  
  /**
   * Generate MD5 hash
   */
  _md5(text) {
    return crypto.createHash('md5').update(text).digest('hex');
  }
  
  /**
   * Generate message signature for Meross API
   * Format: MD5(SECRET + timestamp + nonce + base64_params)
   */
  _generateSignature(timestamp, nonce, base64Params, secret) {
    const stringToSign = `${secret}${timestamp}${nonce}${base64Params}`;
    const hash = this._md5(stringToSign);
    
    // Debug log
    this.ctx.log(`Signature calculation: MD5("${secret.substring(0, 10)}...${timestamp}${nonce}${base64Params}") = ${hash}`);
    
    return hash;
  }
  
  /**
   * Base64 encode a string
   */
  _base64Encode(str) {
    return Buffer.from(str).toString('base64');
  }
  
  /**
   * Make HTTP request to Meross API
   */
  async _makeRequest(endpoint, data = {}, useAuth = true) {
    return new Promise((resolve, reject) => {
      // Queue requests to enforce global throttle
      MerossCloudManager.httpQueue = MerossCloudManager.httpQueue
        .then(() => MerossCloudManager._throttleHttpRequest(this.ctx))
        .then(() => this._makeRequestInternal(endpoint, data, useAuth, resolve, reject))
        .catch(reject);
    });
  }

  async _makeRequestInternal(endpoint, data = {}, useAuth = true, resolve, reject) {
    try {
      // Generate nonce (16 character alphanumeric)
      const nonce = crypto.randomBytes(8).toString('hex').toUpperCase().substring(0, 16);
      const timestamp = Date.now(); // Milliseconds, not seconds!
      
      // Base64 encode the parameters
      const paramsJson = JSON.stringify(data);
      const base64Params = this._base64Encode(paramsJson);
      
      // Generate signature - ALWAYS use the constant secret for HTTP API
      // The 'key' from login is only used for MQTT, not HTTP signatures!
      const secret = '23x17ahWarFH6w29';
      const signature = this._generateSignature(timestamp, nonce, base64Params, secret);
      
      // Build request payload
      const payload = {
        params: base64Params,
        sign: signature.toLowerCase(), // Must be lowercase!
        timestamp: timestamp,
        nonce: nonce
      };
      
      const postData = JSON.stringify(payload);
      
      // Debug logging for signature issues
      if (useAuth) {
        this.ctx.log(`Auth request to ${endpoint}:`);
        this.ctx.log(`  Token: ${this.token ? this.token.substring(0, 20) + '...' : 'NONE'}`);
        this.ctx.log(`  Key: ${this.key ? this.key.substring(0, 20) + '...' : 'NONE'}`);
        this.ctx.log(`  Payload: ${postData.substring(0, 150)}...`);
      }
      
      const options = {
        hostname: 'iotx-us.meross.com',
        port: 443,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'okhttp/3.6.0',
          'vender': 'Meross',
          'AppVersion': '1.3.0',
          'AppLanguage': 'EN'
        }
      };
      
      // Add authorization header if authenticated
      if (useAuth && this.token) {
        options.headers['Authorization'] = `Basic ${this.token}`;
      }
      
      const req = https.request(options, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          try {
            // Log raw response for debugging (only first 300 chars)
            this.ctx.log(`Meross API Response (${endpoint}): ${responseData.substring(0, 300)}...`);
            
            const parsed = JSON.parse(responseData);
            
            // Check for successful response
            if (parsed.apiStatus === 0 || parsed.apiStatus === '0') {
              resolve(parsed.data);
            } else {
              // Better error formatting
              const errorCode = parsed.apiStatus || parsed.error || 'UNKNOWN';
              const errorMsg = parsed.info || parsed.message || parsed.error || 'Unknown error';
              reject(new Error(`Meross API Error ${errorCode}: ${errorMsg}`));
            }
          } catch (error) {
            // If JSON parse fails, show the actual response
            reject(new Error(`Failed to parse Meross response: ${responseData.substring(0, 100)}... Error: ${error.message}`));
          }
        });
      });
      
      req.on('error', (error) => {
        reject(new Error(`Network error: ${error.message}`));
      });
      
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout - Meross cloud not responding'));
      });
      
      req.write(postData);
      req.end();
    } catch (error) {
      reject(error);
    }
  }
  
  /**
   * Login to Meross cloud
   */
  async _login(email, password) {
    this.ctx.log('Logging in to Meross cloud...');
    this.ctx.log(`Attempting login for: ${email}`);
    
    try {
      if (MerossCloudManager.loginBlockedUntil && Date.now() < MerossCloudManager.loginBlockedUntil) {
        const waitSeconds = Math.max(0, Math.round((MerossCloudManager.loginBlockedUntil - Date.now()) / 1000));
        throw new Error(`Login temporarily blocked due to rate limit. Try again in ${waitSeconds}s.`);
      }

      const now = Date.now();
      if (MerossCloudManager.sharedAuth && (now - MerossCloudManager.sharedAuth.lastLoginAt) < MerossCloudManager.loginTtlMs) {
        const cached = MerossCloudManager.sharedAuth;
        this.token = cached.token;
        this.key = cached.key;
        this.userId = cached.userId;
        this.mqttDomain = cached.mqttDomain || 'mqtt-us-4.meross.com';
        this.baseUrl = cached.domain || this.baseUrl;
        this.ctx.log('Reusing cached Meross login credentials');
        return true;
      }

      if (MerossCloudManager.loginPromise) {
        await MerossCloudManager.loginPromise;
        const cached = MerossCloudManager.sharedAuth;
        if (cached) {
          this.token = cached.token;
          this.key = cached.key;
          this.userId = cached.userId;
          this.mqttDomain = cached.mqttDomain || 'mqtt-us-4.meross.com';
          this.baseUrl = cached.domain || this.baseUrl;
          this.ctx.log('Reusing cached Meross login credentials');
          return true;
        }
      }

      MerossCloudManager.loginPromise = (async () => {
        // NOTE: Password is sent in PLAINTEXT (base64 encoded), not MD5 hashed
        // Endpoint changed from /v1/Auth/Login to /v1/Auth/signIn in v0.4.6.0
        const response = await this._makeRequest('/v1/Auth/signIn', {
          email,
          password
        }, false); // Don't use auth for login
        
        if (!response || !response.token || !response.key) {
          throw new Error('Invalid login response - missing credentials');
        }
        
        this.token = response.token;
        this.key = response.key;
        this.userId = response.userid || response.userId;
        this.mqttDomain = response.mqttDomain || 'mqtt-us-4.meross.com';
        this.baseUrl = response.domain || this.baseUrl;
        
        MerossCloudManager.sharedAuth = {
          token: this.token,
          key: this.key,
          userId: this.userId,
          mqttDomain: this.mqttDomain,
          domain: this.baseUrl,
          lastLoginAt: Date.now()
        };
        MerossCloudManager.loginBlockedUntil = 0;
        
        this.ctx.log('Successfully logged in to Meross cloud');
        this.ctx.log(`User ID: ${this.userId}`);
      })();

      await MerossCloudManager.loginPromise;
      MerossCloudManager.loginPromise = null;

      return true;
    } catch (error) {
      MerossCloudManager.loginPromise = null;
      const message = error && error.message ? error.message : String(error);
      if (message.includes('Beyond Login Limit') || message.includes('429') || message.includes('request too frequent')) {
        MerossCloudManager.loginBlockedUntil = Date.now() + (12 * 60 * 60 * 1000); // 12 hours
        this.ctx.log('Login blocked due to rate limit; pausing login attempts for 12 hours.');
      }
      this.ctx.log(`Login failed: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get list of devices
   */
  async _getDevices() {
    this.ctx.log('Fetching device list...');
    
    // Empty object becomes empty JSON "{}" when stringified, then base64 encoded
    const response = await this._makeRequest('/v1/Device/devList', {}, true);
    
    // Response should have a list of devices
    if (!Array.isArray(response)) {
      this.ctx.log('Warning: devList response is not an array:', JSON.stringify(response).substring(0, 200));
      return [];
    }
    
    // Debug: log first device to see available fields
    if (response && response.length > 0) {
      this.ctx.log(`Sample device data: ${JSON.stringify(response[0], null, 2).substring(0, 800)}`);
    }
    
    return response || [];
  }
  
  /**
   * Connect to MQTT broker
   */
  async _connectMqtt() {
    if (this.mqttClient && this.mqttClient.connected) {
      return; // Already connected
    }
    
    this.ctx.log(`Connecting to MQTT broker: ${this.mqttDomain}`);
    
    // Generate app ID and client ID
    const appId = this._md5(`API${crypto.randomBytes(16).toString('hex')}`);
    const clientId = `app:${appId}`;
    
    // Store the response topic for use in message headers
    this.clientResponseTopic = `/app/${this.userId}-${appId}/subscribe`;
    this.ctx.log(`Client response topic: ${this.clientResponseTopic}`);
    
    // Password is MD5 of userId + key
    const hashedPassword = this._md5(`${this.userId}${this.key}`);
    
    this.mqttClient = new SimpleMqttClient({
      host: this.mqttDomain,
      port: 2001,
      clientId,
      username: this.userId,
      password: hashedPassword,
      keepalive: 30,
      ctx: this.ctx
    });
    
    await this.mqttClient.connect();
    
    // Subscribe to necessary topics
    this.mqttClient.subscribe(`/app/${this.userId}/subscribe`);
    this.mqttClient.subscribe(this.clientResponseTopic);
  }
  
  /**
   * Send command to device via MQTT
   */
  async _sendDeviceCommand(namespace, payload) {
    // Check if MQTT is connected, try to reconnect if not
    if (!this.mqttClient || !this.mqttClient.connected) {
      this.ctx.log('MQTT not connected, attempting to reconnect...');
      try {
        await this._connectMqtt();
      } catch (error) {
        throw new Error('Failed to reconnect to MQTT broker: ' + error.message);
      }
    }
    
    const messageId = crypto.randomBytes(16).toString('hex');
    const timestamp = Math.floor(Date.now() / 1000);
    
    // Debug: log clientResponseTopic
    this.ctx.log(`Using clientResponseTopic: ${this.clientResponseTopic || 'UNDEFINED!'}`);
    
    // Build the message in Meross protocol format
    const message = {
      header: {
        from: this.clientResponseTopic,
        messageId,
        method: 'SET',
        namespace,
        timestamp,
        sign: this._md5(`${messageId}${this.key}${timestamp}`),
        payloadVersion: 1
      },
      payload
    };
    
    this.ctx.log(`Sending device command via MQTT: ${namespace}`);
    this.ctx.log(`Full message: ${JSON.stringify(message)}`);
    
    // Publish to device's MQTT topic
    const topic = `/appliance/${this.device.uuid}/subscribe`;
    this.mqttClient.publish(topic, message);
    
    // MQTT is fire-and-forget (QoS 0), so we don't wait for response
    return Promise.resolve();
  }
  
  /**
   * Connect to Meross cloud and find the target device
   */
  async connect(email, password, deviceName) {
    try {
      this.ctx.log('Connecting to Meross cloud...');
      
      // Login
      await this._login(email, password);
      
      // Get devices
      const devices = await this._getDevices();
      this.ctx.log(`Found ${devices.length} Meross devices`);
      
      // Log each device with details
      if (devices.length > 0) {
        this.ctx.log('═══════════════════════════════════════════════════');
        this.ctx.log('Available Meross Devices:');
        devices.forEach((dev, index) => {
          const numOutlets = dev.channels ? dev.channels.length - 1 : 0; // Subtract 1 for master channel
          this.ctx.log(`  ${index + 1}. "${dev.devName}" (${dev.deviceType}, ${numOutlets} outlets)`);
        });
        this.ctx.log('═══════════════════════════════════════════════════');
      }
      
      // Find target device
      this.device = devices.find(dev => dev.devName === deviceName);
      
      if (!this.device) {
        const deviceNames = devices.map(d => d.devName).join(', ');
        throw new Error(`Device "${deviceName}" not found. Available devices: ${deviceNames || 'none'}`);
      }
      
      this.connected = true;
      this.reconnectAttempts = 0;
      this.ctx.log(`Connected to device: ${this.device.devName} (UUID: ${this.device.uuid})`);
      
      // Connect to MQTT for device control
      try {
        await this._connectMqtt();
        this.ctx.log('MQTT connection established - device control ready');
      } catch (mqttError) {
        this.ctx.log(`MQTT connection failed: ${mqttError.message}`);
        throw mqttError;
      }
      
      return true;
    } catch (error) {
      this.ctx.log('Connection error:', error.message);
      this.connected = false;
      
      // Attempt reconnect
      this.reconnectAttempts++;
      const waitTime = Math.min(this.reconnectBackoff * (2 ** (this.reconnectAttempts - 1)), 300000);
      this.ctx.log(`Reconnecting in ${Math.round(waitTime / 1000)} seconds... (attempt ${this.reconnectAttempts})`);
      
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this.connect(email, password, deviceName);
    }
  }
  
  /**
   * Check if connected to device
   */
  isConnected() {
    return this.connected && this.device !== null && this.token !== null;
  }
  
  /**
   * Turn on a specific outlet/channel
   */
  async turnOn(channel) {
    if (!this.isConnected()) {
      throw new Error('Not connected to Meross device');
    }
    
    try {
      const namespace = 'Appliance.Control.ToggleX';
      const payload = {
        togglex: {
          channel: channel, // Channel 0=all, 1=first outlet, 2=second outlet, etc.
          onoff: 1
        }
      };
      
      await this._sendDeviceCommand(namespace, payload);
      this.ctx.log(`Outlet ${channel} turned ON`);
    } catch (error) {
      this.ctx.log(`Error turning on outlet ${channel}:`, error.message);
      this.connected = false;
      throw error;
    }
  }
  
  /**
   * Turn off a specific outlet/channel
   */
  async turnOff(channel) {
    if (!this.isConnected()) {
      throw new Error('Not connected to Meross device');
    }
    
    try {
      const namespace = 'Appliance.Control.ToggleX';
      const payload = {
        togglex: {
          channel: channel, // Channel 0=all, 1=first outlet, 2=second outlet, etc.
          onoff: 0
        }
      };
      
      await this._sendDeviceCommand(namespace, payload);
      this.ctx.log(`Outlet ${channel} turned OFF`);
    } catch (error) {
      this.ctx.log(`Error turning off outlet ${channel}:`, error.message);
      this.connected = false;
      throw error;
    }
  }
  
  /**
   * Disconnect from Meross cloud
   */
  async disconnect() {
    try {
      if (this.device && this.connected) {
        this.ctx.log('Turning off all outlets before disconnect (failsafe)...');
        
        // Try to determine number of channels from device info
        const numChannels = this.device.channels?.length || 2;
        
        for (let i = 1; i <= numChannels; i++) {
          try {
            await this.turnOff(i);
          } catch (error) {
            this.ctx.log(`Error turning off outlet ${i}:`, error.message);
          }
        }
      }
      
      // Disconnect MQTT
      if (this.mqttClient) {
        try {
          this.mqttClient.disconnect();
        } catch (error) {
          this.ctx.log('Error disconnecting MQTT:', error.message);
        }
      }
      
      // Logout
      if (this.token) {
        try {
          await this._makeRequest('/v1/Profile/logout', {});
        } catch (error) {
          this.ctx.log('Error during logout:', error.message);
        }
      }
      
      this.connected = false;
      this.device = null;
      this.token = null;
      this.key = null;
      this.userId = null;
      this.mqttClient = null;
      
      this.ctx.log('Disconnected from Meross cloud');
    } catch (error) {
      this.ctx.log('Error during disconnect:', error.message);
    }
  }
}

export default MerossCloudManager;
