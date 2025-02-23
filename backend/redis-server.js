import Redis from 'redis';
import logger from './src/config/logger.js';

class RedisServer {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.MAX_RECONNECT_ATTEMPTS = 15;
    this.INITIAL_RECONNECT_DELAY_MS = 1000;
    this.connectionOptions = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      url: process.env.REDIS_URL || 'redis://localhost:6379',
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

      this.client = Redis.createClient({
        url: this.connectionOptions.url,
        socket: {
          host: this.connectionOptions.host,
          port: this.connectionOptions.port,
          connectTimeout: this.connectionOptions.socket.connectTimeout,
          disconnectTimeout: this.connectionOptions.socket.disconnectTimeout,
          reconnectStrategy: (retries) => {
            if (retries > this.MAX_RECONNECT_ATTEMPTS) {
              return new Error('Max reconnection attempts reached');
            }
            return Math.min(retries * 100, 3000);
          }
        }
      });

      this.setupClientEventHandlers();
      await this.client.connect();
      this.isConnected = true;
      this.reconnectAttempts = 0;
      logger.info('REDIS_CLIENT_CONNECTED', {
        host: this.connectionOptions.host,
        port: this.connectionOptions.port
      });
      return this.client;
    } catch (error) {
      this.handleConnectionError(error);
      throw error;
    }
  }

  setupClientEventHandlers() {
    if (!this.client) return;

    this.client.on('connect', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      logger.info('REDIS_CONNECTION_ESTABLISHED', {
        host: this.connectionOptions.host,
        port: this.connectionOptions.port,
        timestamp: new Date().toISOString()
      });
    });

    this.client.on('error', (err) => {
      this.isConnected = false;
      this.reconnectAttempts++;
      logger.error('REDIS_CONNECTION_ERROR', {
        errorMessage: err.message,
        errorStack: err.stack,
        reconnectAttempts: this.reconnectAttempts,
        errorCode: err.code,
        host: this.connectionOptions.host,
        port: this.connectionOptions.port,
        timestamp: new Date().toISOString()
      });

      if (this.reconnectAttempts <= this.MAX_RECONNECT_ATTEMPTS) {
        const delay = this.calculateExponentialBackoff();
        logger.info('REDIS_RECONNECT_ATTEMPT_SCHEDULED', {
          attempt: this.reconnectAttempts,
          delay,
          nextAttemptAt: new Date(Date.now() + delay).toISOString()
        });
        setTimeout(() => this.attemptReconnect(), delay);
      } else {
        logger.error('REDIS_MAX_RECONNECT_ATTEMPTS_REACHED', {
          maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
          host: this.connectionOptions.host,
          port: this.connectionOptions.port
        });
      }
    });

    this.client.on('end', () => {
      this.isConnected = false;
      logger.warn('REDIS_CONNECTION_CLOSED', {
        reconnectAttempts: this.reconnectAttempts,
        timestamp: new Date().toISOString()
      });
      this.attemptReconnect();
    });
  }

  async attemptReconnect() {
    if (!this.isConnected && this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++;
      const delay = this.calculateExponentialBackoff();
      
      logger.info('REDIS_RECONNECT_ATTEMPT', {
        attempt: this.reconnectAttempts,
        maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
        delayMs: delay,
        nextAttemptAt: new Date(Date.now() + delay).toISOString(),
        host: this.connectionOptions.host,
        port: this.connectionOptions.port
      });

      await new Promise(resolve => setTimeout(resolve, delay));

      try {
        await this.createRedisClient();
        logger.info('REDIS_RECONNECT_SUCCESS', {
          attempt: this.reconnectAttempts,
          host: this.connectionOptions.host,
          port: this.connectionOptions.port,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('REDIS_RECONNECT_FAILURE', {
          attempt: this.reconnectAttempts,
          errorMessage: error.message,
          errorStack: error.stack,
          host: this.connectionOptions.host,
          port: this.connectionOptions.port,
          timestamp: new Date().toISOString()
        });
        if (this.reconnectAttempts < this.MAX_RECONNECT_ATTEMPTS) {
          return this.attemptReconnect();
        }
      }
    } else if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      logger.error('REDIS_MAX_RECONNECT_ATTEMPTS_EXCEEDED', {
        maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
        host: this.connectionOptions.host,
        port: this.connectionOptions.port,
        timestamp: new Date().toISOString()
      });
    }
  }

  calculateExponentialBackoff() {
    return Math.min(
      this.INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      60000  // Max 1 minute between retries
    );
  }

  handleConnectionError(error) {
    logger.error('REDIS_CONNECTION_FATAL', {
      errorMessage: error.message,
      reconnectAttempts: this.reconnectAttempts,
      errorStack: error.stack
    });
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
}

export default new RedisServer();
