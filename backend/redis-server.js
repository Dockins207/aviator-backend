import Redis from 'redis';
import logger from './src/config/logger.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

class RedisServer {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      // Redis connection configuration
      const redisConfig = {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        socket: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          connectTimeout: 5000,
          disconnectTimeout: 5000
        }
      };

      logger.info('Attempting Redis connection', {
        host: redisConfig.host,
        port: redisConfig.port,
        url: redisConfig.url
      });

      // Create Redis client
      this.client = Redis.createClient({
        url: redisConfig.url,
        socket: {
          host: redisConfig.host,
          port: redisConfig.port,
          connectTimeout: 5000,
          disconnectTimeout: 5000
        }
      });

      // Event listeners
      this.client.on('connect', () => {
        logger.info('Redis client connecting...');
      });

      this.client.on('ready', () => {
        this.isConnected = true;
        logger.info('Redis client is ready and connected');
      });

      this.client.on('error', (err) => {
        this.isConnected = false;
        logger.error('Redis client error', { 
          errorMessage: err.message,
          errorStack: err.stack 
        });
      });

      this.client.on('end', () => {
        this.isConnected = false;
        logger.warn('Redis connection closed');
      });

      // Establish connection
      await this.client.connect();

      return this.client;
    } catch (error) {
      logger.error('Failed to establish Redis connection', {
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async disconnect() {
    if (this.client && this.isConnected) {
      try {
        await this.client.quit();
        logger.info('Redis client disconnected');
      } catch (error) {
        logger.error('Error disconnecting Redis client', {
          errorMessage: error.message
        });
      }
    }
  }

  async start() {
    try {
      logger.info('Starting Redis server...');
      
      // Connect to Redis
      await this.connect();

      // Handle graceful shutdown
      process.on('SIGINT', async () => {
        logger.info('Received SIGINT. Shutting down Redis server...');
        await this.disconnect();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        logger.info('Received SIGTERM. Shutting down Redis server...');
        await this.disconnect();
        process.exit(0);
      });

      logger.info('Redis server started successfully');
    } catch (error) {
      logger.error('Failed to start Redis server', {
        errorMessage: error.message,
        errorStack: error.stack
      });
      process.exit(1);
    }
  }
}

// Create and start Redis server instance
const redisServer = new RedisServer();
redisServer.start();

export default redisServer;
