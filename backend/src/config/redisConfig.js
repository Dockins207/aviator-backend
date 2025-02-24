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
      logger.info('REDIS_CONNECTION_ATTEMPT', {
        url: process.env.REDIS_URL || 'redis://localhost:6379'
      });

      // Main client
      this.client = createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        socket: {
          connectTimeout: 10000,  // 10 seconds
          disconnectTimeout: 10000 // 10 seconds
        },
        retry_strategy: (options) => {
          // Exponential backoff retry strategy
          if (options.error && options.error.code === 'ECONNREFUSED') {
            logger.error('REDIS_CONNECTION_REFUSED', {
              attempt: options.attempt,
              totalRetryTime: options.total_retry_time
            });
            return Math.min(options.attempt * 100, 3000);
          }
          return undefined;
        }
      });

      // Set up event listeners
      this.client.on('connect', () => {
        logger.info('REDIS_CONNECTED');
      });

      this.client.on('ready', () => {
        logger.info('REDIS_READY');
      });

      this.client.on('error', (error) => {
        logger.error('REDIS_ERROR', {
          error: error.message,
          stack: error.stack
        });
      });

      this.client.on('end', () => {
        logger.warn('REDIS_CONNECTION_ENDED');
      });

      this.client.on('reconnecting', () => {
        logger.info('REDIS_RECONNECTING');
      });

      await this.client.connect();
      logger.info('REDIS_CONNECTION_SUCCESSFUL');

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
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  getClient() {
    if (!this.client) {
      throw new Error('Redis client not initialized');
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
