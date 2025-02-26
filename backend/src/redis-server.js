import Redis from 'redis';
import logger from './config/logger.js';

class RedisServer {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.MAX_RECONNECT_ATTEMPTS = 15;
    this.INITIAL_RECONNECT_DELAY_MS = 1000;
    this.connectionOptions = {
      host: process.env.REDIS_HOST || '192.168.75.118',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      url: process.env.REDIS_URL || 'redis://192.168.75.118:6379',
      socket: {
        connectTimeout: 10000,
        disconnectTimeout: 10000
      }
    };

    // Automatically attempt connection on initialization
    this.initializeConnection();
  }

  async initializeConnection() {
    try {
      logger.info('REDIS_INITIALIZATION_STARTED', {
        host: this.connectionOptions.host,
        port: this.connectionOptions.port,
        timestamp: new Date().toISOString()
      });
      await this.createRedisClient();
    } catch (error) {
      logger.error('REDIS_INITIALIZATION_FAILED', {
        errorMessage: error.message,
        errorStack: error.stack,
        host: this.connectionOptions.host,
        port: this.connectionOptions.port,
        timestamp: new Date().toISOString()
      });
      // Attempt first reconnection after initialization failure
      this.attemptReconnect();
    }
  }

  async createRedisClient() {
    try {
      if (this.client && this.client.isOpen) {
        return this.client;
      }

      // Comprehensive Redis connection options
      const redisOptions = {
        host: this.connectionOptions.host,
        port: this.connectionOptions.port,
        socket: {
          connectTimeout: 10000,
          disconnectTimeout: 10000
        },
        // Make password optional
        ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
        // Add database selection if needed
        database: parseInt(process.env.REDIS_DB || '0', 10)
      };

      // Create Redis client with comprehensive options
      this.client = Redis.createClient(redisOptions);

      // Attach comprehensive event listeners
      this.client.on('connect', () => {
        logger.info('REDIS_CLIENT_CONNECTED', {
          host: this.connectionOptions.host,
          port: this.connectionOptions.port,
          timestamp: new Date().toISOString()
        });
        this.isConnected = true;
        this.reconnectAttempts = 0;
      });

      this.client.on('error', (error) => {
        // Check if the error is related to authentication
        if (error.message.includes('ERR Client sent AUTH')) {
          logger.warn('REDIS_AUTH_CONFIGURATION_WARNING', {
            message: 'Redis authentication configuration might be incorrect',
            errorMessage: error.message,
            host: this.connectionOptions.host,
            port: this.connectionOptions.port
          });
          // Optional: Try connecting without password
          this.connectionOptions.password = undefined;
        }

        logger.error('REDIS_CLIENT_ERROR', {
          errorMessage: error.message,
          errorCode: error.code,
          host: this.connectionOptions.host,
          port: this.connectionOptions.port,
          timestamp: new Date().toISOString()
        });

        // Reset connection status
        this.isConnected = false;
        this.attemptReconnect();
      });

      // Explicitly connect
      await this.client.connect();

      return this.client;
    } catch (error) {
      logger.error('REDIS_CLIENT_CREATION_FAILED', {
        errorMessage: error.message,
        errorStack: error.stack,
        host: this.connectionOptions.host,
        port: this.connectionOptions.port,
        timestamp: new Date().toISOString()
      });

      // Trigger reconnection mechanism
      this.attemptReconnect();
      throw error;
    }
  }

  async attemptReconnect() {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logger.error('REDIS_MAX_RECONNECT_ATTEMPTS_REACHED', {
        maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
        timestamp: new Date().toISOString()
      });
      return;
    }

    this.reconnectAttempts++;
    const delay = this.INITIAL_RECONNECT_DELAY_MS * this.reconnectAttempts;

    logger.warn('REDIS_RECONNECTION_ATTEMPT', {
      attempt: this.reconnectAttempts,
      delay,
      timestamp: new Date().toISOString()
    });

    setTimeout(() => {
      this.initializeConnection();
    }, delay);
  }

  async connect() {
    try {
      await this.createRedisClient();
      return this.client;
    } catch (error) {
      this.handleConnectionError(error);
      throw error;
    }
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.quit();
        logger.info('REDIS_CLIENT_DISCONNECTED');
      } catch (error) {
        logger.error('REDIS_DISCONNECT_ERROR', {
          errorMessage: error.message
        });
      }
    }
  }

  async start() {
    try {
      await this.connect();

      process.on('SIGINT', async () => {
        logger.info('SIGINT: Shutting down Redis server...');
        await this.disconnect();
        process.exit(0);
      });

      process.on('SIGTERM', async () => {
        logger.info('SIGTERM: Shutting down Redis server...');
        await this.disconnect();
        process.exit(0);
      });

    } catch (error) {
      logger.error('REDIS_SERVER_START_FAILED', {
        errorMessage: error.message
      });
      process.exit(1);
    }
  }

  async getClient() {
    console.log('RedisServer.getClient() called', {
      clientExists: !!this.client,
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts
    });

    // If client doesn't exist or is not connected, attempt to create/reconnect
    if (!this.client || !this.isConnected) {
      try {
        console.log('Attempting to recreate Redis client...');
        await this.createRedisClient();
      } catch (reconnectError) {
        logger.error('REDIS_CLIENT_RECREATION_FAILED', {
          errorMessage: reconnectError.message,
          context: 'getClient'
        });
        throw new Error('SECURITY_VIOLATION_REDIS_CONNECTION_CLOSED');
      }
    }

    return this.client;
  }

  trackBetMetrics(gameSessionId, betAmount) {
    try {
      const metricsKey = `game:${gameSessionId}:metrics`;
      
      // Increment total bets count
      this.client.hincrBy(metricsKey, 'totalBetsCount', 1);
      
      // Increment total bet amount
      this.client.hincrByFloat(metricsKey, 'totalBetAmount', betAmount);
      
      // Set expiration for metrics (1 hour)
      this.client.expire(metricsKey, 3600);
      
      logger.debug('REDIS_BET_METRICS_TRACKED', {
        gameSessionId,
        betAmount,
        metricsKey
      });
    } catch (error) {
      logger.error('REDIS_BET_METRICS_TRACKING_ERROR', {
        gameSessionId,
        betAmount,
        errorMessage: error.message
      });
    }
  }

  handleConnectionError(error) {
    logger.error('REDIS_CONNECTION_FATAL', {
      errorMessage: error.message,
      reconnectAttempts: this.reconnectAttempts,
      errorStack: error.stack
    });
  }
}

export default new RedisServer();
