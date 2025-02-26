import { createClient } from 'redis';
import logger from '../config/logger.js';

class RedisConnection {
  constructor() {
    this.client = null;
    this.pubClient = null;
    this.subClient = null;

    // Metrics tracking
    this.metrics = {
      totalBetsReceived: 0,
      totalBetAmount: 0,
      gameSessionBetCounts: {},
      lastLoggedBetCount: 0
    };
  }

  async connect() {
    try {
      const redisOptions = {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD
      };

      logger.info('REDIS_CONNECTION_ATTEMPT', {
        host: redisOptions.host,
        port: redisOptions.port
      });

      this.client = createClient({
        socket: {
          host: redisOptions.host,
          port: redisOptions.port,
          connectTimeout: 15000,
          disconnectTimeout: 15000
        },
        password: redisOptions.password
      });

      // Comprehensive error handling
      this.client.on('error', (err) => {
        logger.error('REDIS_CLIENT_ERROR', {
          errorMessage: err.message,
          errorCode: err.code,
          errorType: err.constructor.name,
          errorStack: err.stack
        });
      });

      this.client.on('connect', () => {
        logger.info('REDIS_CONNECTION_SUCCESSFUL', {
          host: redisOptions.host,
          port: redisOptions.port
        });
      });

      // Explicit connection and authentication
      await this.client.connect();
      
      // Additional authentication check
      const authResult = await this.client.auth(redisOptions.password);
      logger.info('REDIS_AUTHENTICATION_RESULT', { 
        authenticated: authResult === 'OK' 
      });

      return this.client;

      // Pub client
      this.pubClient = this.client.duplicate();

      // Sub client
      this.subClient = this.client.duplicate();

      // Error handling for each client
      [this.client, this.pubClient, this.subClient].forEach(client => {
        client.on('error', (err) => {
          console.error('REDIS_CONNECTION_ERROR', {
            errorMessage: err.message,
            errorStack: err.stack
          });
        });
      });

      this.resetMetrics();
    } catch (error) {
      logger.error('REDIS_CONNECTION_FAILED', {
        errorMessage: error.message,
        errorCode: error.code,
        errorType: error.constructor.name,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async testConnection() {
    try {
      const redisOptions = {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD
      };

      logger.info('REDIS_CONNECTION_TEST_STARTED', {
        host: redisOptions.host,
        port: redisOptions.port
      });

      const testClient = createClient({
        socket: {
          host: redisOptions.host,
          port: redisOptions.port,
          connectTimeout: 10000,
          disconnectTimeout: 10000
        },
        password: redisOptions.password
      });

      testClient.on('error', (err) => {
        logger.error('REDIS_TEST_CONNECTION_ERROR', {
          errorMessage: err.message,
          errorCode: err.code,
          errorType: err.constructor.name
        });
      });

      await testClient.connect();
      await testClient.auth(redisOptions.password);

      // Perform a simple Redis operation to verify full functionality
      await testClient.set('connection_test_key', 'success');
      const testValue = await testClient.get('connection_test_key');
      
      logger.info('REDIS_CONNECTION_TEST_SUCCESSFUL', {
        testValue,
        host: redisOptions.host,
        port: redisOptions.port
      });

      await testClient.del('connection_test_key');
      await testClient.quit();

      return true;
    } catch (error) {
      logger.error('REDIS_CONNECTION_TEST_FAILED', {
        errorMessage: error.message,
        errorCode: error.code,
        errorType: error.constructor.name,
        errorStack: error.stack
      });
      return false;
    }
  }

  getClient() {
    if (!this.client) {
      throw new Error('Redis client not initialized. Call connect() first.');
    }
    return this.client;
  }

  getPubClient() {
    if (!this.pubClient) {
      throw new Error('Redis pub client not initialized');
    }
    return this.pubClient;
  }

  getSubClient() {
    if (!this.subClient) {
      throw new Error('Redis sub client not initialized');
    }
    return this.subClient;
  }

  async disconnect() {
    try {
      // Log final metrics before disconnecting
      this.logMetrics();
      await Promise.all([
        this.client?.quit(),
        this.pubClient?.quit(),
        this.subClient?.quit()
      ]);

      logger.info('REDIS_DISCONNECTED');
    } catch (error) {
      logger.error('REDIS_DISCONNECT_ERROR', {
        errorMessage: error.message
      });
    }
  }

  // Reset metrics periodically or on demand
  resetMetrics() {
    this.metrics = {
      totalBetsReceived: 0,
      totalBetAmount: 0,
      gameSessionBetCounts: {},
      lastLoggedBetCount: 0
    };
    this.logMetrics();
  }

  // Log current metrics only when there are new bets
  logMetrics() {
    const newBetsSinceLastLog = this.metrics.totalBetsReceived - this.metrics.lastLoggedBetCount;
    
    if (newBetsSinceLastLog > 0) {
      logger.info('REDIS_BET_METRICS', {
        totalBetsReceived: this.metrics.totalBetsReceived,
        totalBetAmount: this.metrics.totalBetAmount,
        newBetsSinceLastLog,
        gameSessionBetCounts: Object.entries(this.metrics.gameSessionBetCounts)
          .map(([gameSessionId, counts]) => ({
            gameSessionId,
            ...counts
          }))
      });

      // Update last logged bet count
      this.metrics.lastLoggedBetCount = this.metrics.totalBetsReceived;
    }
  }

  // Track bet metrics
  trackBetMetrics(gameSessionId, betAmount) {
    // Increment total bets
    this.metrics.totalBetsReceived++;
    this.metrics.totalBetAmount += betAmount;

    // Track bets per game session
    if (!this.metrics.gameSessionBetCounts[gameSessionId]) {
      this.metrics.gameSessionBetCounts[gameSessionId] = {
        betCount: 0,
        totalAmount: 0
      };
    }
    
    const sessionMetrics = this.metrics.gameSessionBetCounts[gameSessionId];
    sessionMetrics.betCount++;
    sessionMetrics.totalAmount += betAmount;

    // Log metrics every 10 bets
    if (this.metrics.totalBetsReceived % 10 === 0) {
      this.logMetrics();
    }
  }
}

export default new RedisConnection();
