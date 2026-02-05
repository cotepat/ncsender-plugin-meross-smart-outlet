/*
 * Minimal MQTT Client for Meross
 * Uses only Node.js built-in modules (tls, net, crypto)
 * Implements only what we need: connect and publish
 */

import tls from 'tls';
import crypto from 'crypto';

class SimpleMqttClient {
  constructor(options) {
    this.host = options.host;
    this.port = options.port || 2001;
    this.clientId = options.clientId;
    this.username = options.username;
    this.password = options.password;
    this.keepalive = options.keepalive || 30;
    this.socket = null;
    this.connected = false;
    this.messageId = 1;
    this.ctx = options.ctx;
    this.pingTimer = null;
  }

  /**
   * Connect to MQTT broker
   */
  connect() {
    return new Promise((resolve, reject) => {
      this.ctx.log(`Connecting to MQTT broker: ${this.host}:${this.port}`);
      
      let connectResolved = false;
      
      this.socket = tls.connect({
        host: this.host,
        port: this.port,
        rejectUnauthorized: true
      });

      this.socket.on('connect', () => {
        this.ctx.log('TLS connection established, sending CONNECT packet');
        this._sendConnect();
      });

      this.socket.on('data', (data) => {
        this._handleData(data, (result) => {
          connectResolved = true;
          resolve(result);
        }, (error) => {
          connectResolved = true;
          reject(error);
        });
      });

      this.socket.on('error', (error) => {
        this.ctx.log(`MQTT error: ${error.message}`);
        if (!connectResolved) {
          connectResolved = true;
          reject(error);
        }
      });

      this.socket.on('close', (hadError) => {
        this.connected = false;
        
        // Clear ping timer
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        
        this.ctx.log(`MQTT connection closed${hadError ? ' with error' : ''}`);
        if (!connectResolved) {
          connectResolved = true;
          reject(new Error('MQTT connection closed before CONNACK'));
        }
      });
    });
  }

  /**
   * Send MQTT CONNECT packet
   */
  _sendConnect() {
    const protocolName = 'MQTT';
    const protocolLevel = 4; // MQTT 3.1.1
    const flags = 0xC2; // Clean session + username + password
    
    // Build variable header - fixed size calculation
    const protocolNameLength = 2 + protocolName.length; // 2 bytes for length + string
    const varHeader = Buffer.alloc(protocolNameLength + 4); // +4 for level, flags, keepalive
    let offset = 0;
    
    // Protocol name length (2 bytes)
    varHeader.writeUInt16BE(protocolName.length, offset);
    offset += 2;
    
    // Protocol name
    varHeader.write(protocolName, offset, 'utf8');
    offset += protocolName.length;
    
    // Protocol level (1 byte)
    varHeader.writeUInt8(protocolLevel, offset);
    offset += 1;
    
    // Connect flags (1 byte)
    varHeader.writeUInt8(flags, offset);
    offset += 1;
    
    // Keep alive (2 bytes)
    varHeader.writeUInt16BE(this.keepalive, offset);
    
    // Build payload
    const clientIdBuf = this._encodeString(this.clientId);
    const usernameBuf = this._encodeString(this.username);
    const passwordBuf = this._encodeString(this.password);
    
    const payload = Buffer.concat([clientIdBuf, usernameBuf, passwordBuf]);
    
    // Build complete packet
    const remainingLength = varHeader.length + payload.length;
    const packet = Buffer.concat([
      Buffer.from([0x10]), // CONNECT packet type
      this._encodeLength(remainingLength),
      varHeader,
      payload
    ]);
    
    this.ctx.log(`Sending MQTT CONNECT: clientId=${this.clientId.substring(0, 20)}..., username=${this.username}, packet size=${packet.length}`);
    this.ctx.log(`CONNECT packet hex: ${packet.toString('hex').substring(0, 200)}...`);
    this.socket.write(packet);
  }

  /**
   * Handle incoming MQTT data
   */
  _handleData(data, resolve, reject) {
    // Log raw data for debugging
    this.ctx.log(`MQTT received ${data.length} bytes: ${data.toString('hex').substring(0, 100)}`);
    
    // Check packet type
    const packetType = data[0] >> 4;
    this.ctx.log(`MQTT packet type: ${packetType}`);
    
    if (packetType === 2) { // CONNACK
      const returnCode = data[3];
      this.ctx.log(`MQTT CONNACK return code: ${returnCode}`);
      if (returnCode === 0) {
        this.connected = true;
        this.ctx.log('MQTT connected successfully');
        this._startPingTimer();
        resolve();
      } else {
        const errors = {
          1: 'Connection refused: unacceptable protocol version',
          2: 'Connection refused: identifier rejected',
          3: 'Connection refused: server unavailable',
          4: 'Connection refused: bad username or password',
          5: 'Connection refused: not authorized'
        };
        reject(new Error(`MQTT connection refused: ${errors[returnCode] || returnCode}`));
      }
    } else if (packetType === 13) { // PINGRESP
      this.ctx.log('MQTT PINGRESP received');
    } else if (packetType === 9) { // SUBACK
      this.ctx.log('MQTT SUBACK received');
    } else if (packetType === 3) { // PUBLISH
      this.ctx.log(`MQTT PUBLISH received: ${data.length} bytes`);
    }
    // We're not handling other packets for now
  }
  
  /**
   * Start keepalive ping timer
   */
  _startPingTimer() {
    // Send ping at half the keepalive interval
    const pingInterval = (this.keepalive * 1000) / 2;
    
    this.pingTimer = setInterval(() => {
      if (this.connected && this.socket) {
        this._sendPing();
      }
    }, pingInterval);
    
    this.ctx.log(`Keepalive timer started: ping every ${pingInterval / 1000}s`);
  }
  
  /**
   * Send MQTT PINGREQ packet
   */
  _sendPing() {
    if (!this.socket) return;
    
    // PINGREQ packet: 0xC0 0x00
    this.socket.write(Buffer.from([0xC0, 0x00]));
    this.ctx.log('Sent MQTT PINGREQ');
  }

  /**
   * Subscribe to a topic
   */
  subscribe(topic) {
    if (!this.connected) {
      throw new Error('Not connected to MQTT broker');
    }

    const topicBuf = this._encodeString(topic);
    const messageId = this.messageId++;
    
    // Build SUBSCRIBE packet with QoS 0
    const packet = Buffer.concat([
      Buffer.from([0x82]), // SUBSCRIBE packet type
      this._encodeLength(2 + topicBuf.length + 1), // +2 for messageId, +1 for QoS
      Buffer.from([messageId >> 8, messageId & 0xFF]), // Message ID (2 bytes)
      topicBuf,
      Buffer.from([0x00]) // QoS 0
    ]);
    
    this.socket.write(packet);
    this.ctx.log(`Subscribed to ${topic}`);
  }

  /**
   * Publish a message to a topic
   */
  publish(topic, message) {
    if (!this.connected) {
      throw new Error('Not connected to MQTT broker');
    }

    const topicBuf = this._encodeString(topic);
    const messageBuf = Buffer.from(JSON.stringify(message));
    
    // Build PUBLISH packet with QoS 0 (fire and forget)
    const packet = Buffer.concat([
      Buffer.from([0x30]), // PUBLISH packet type, QoS 0
      this._encodeLength(topicBuf.length + messageBuf.length),
      topicBuf,
      messageBuf
    ]);
    
    this.socket.write(packet);
    this.ctx.log(`Published to ${topic}`);
  }

  /**
   * Encode a string with length prefix
   */
  _encodeString(str) {
    const strBuf = Buffer.from(str, 'utf8');
    const lenBuf = Buffer.allocUnsafe(2);
    lenBuf.writeUInt16BE(strBuf.length, 0);
    return Buffer.concat([lenBuf, strBuf]);
  }

  /**
   * Encode remaining length (variable length encoding)
   */
  _encodeLength(length) {
    const bytes = [];
    do {
      let byte = length % 128;
      length = Math.floor(length / 128);
      if (length > 0) {
        byte |= 0x80;
      }
      bytes.push(byte);
    } while (length > 0);
    return Buffer.from(bytes);
  }

  /**
   * Disconnect from broker
   */
  disconnect() {
    // Clear ping timer
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    
    if (this.socket) {
      // Send DISCONNECT packet
      this.socket.write(Buffer.from([0xE0, 0x00]));
      this.socket.end();
      this.connected = false;
    }
  }
}

export default SimpleMqttClient;
