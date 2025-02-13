import { createClient } from 'redis';
import logger from '../config/logger.js';

class RedisConnection {
  constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      // Optional: Add authentication if needed
      // password: process.env.REDIS_PASSWORD
    });

    this.client.on('error', (err) => {
      logger.error('Redis Client Error', { 
        errorMessage: err.message,
        errorStack: err.stack 
      });
    });

    this.client.on('connect', () => {
      logger.info('Redis connection established');
    });

    // Track connection state
    this._isConnecting = false;
    this._connectionPromise = null;
  }

  async connect() {
    // Prevent multiple simultaneous connection attempts
    if (this._isConnecting) {
      return this._connectionPromise;
    }

    this._isConnecting = true;
    this._connectionPromise = new Promise(async (resolve, reject) => {
      try {
        // If not already open, connect
        if (!this.client.isOpen) {
          await this.client.connect();
        }
        resolve(this.client);
      } catch (error) {
        logger.error('Failed to establish Redis connection', {
          errorMessage: error.message,
          errorStack: error.stack
        });
        reject(error);
      } finally {
        this._isConnecting = false;
      }
    });

    return this._connectionPromise;
  }

  async disconnect() {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  // Add method to get the client
  getClient() {
    if (!this.client.isOpen) {
      logger.warn('Attempting to get Redis client before connection');
    }
    return this.client;
  }
}

const redisConnection = new RedisConnection();

export default redisConnection;
