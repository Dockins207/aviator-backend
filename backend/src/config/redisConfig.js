import { createClient } from 'redis';
import logger from '../config/logger.js';

class RedisConnection {
  constructor() {
    this.client = null;
    this.pubClient = null;
    this.subClient = null;

    // Prevent multiple connection logs
    this._hasLoggedConnection = false;

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
      // Main client
      this.client = createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379'
      });

      // Pub client
      this.pubClient = this.client.duplicate();

      // Sub client
      this.subClient = this.client.duplicate();

      // Connect all clients
      await Promise.all([
        this.client.connect(),
        this.pubClient.connect(),
        this.subClient.connect()
      ]);

      // Error handling for each client
      [this.client, this.pubClient, this.subClient].forEach(client => {
        client.on('error', (err) => {
          logger.error('REDIS_CONNECTION_ERROR', {
            errorMessage: err.message,
            errorStack: err.stack
          });
        });
      });

      // Log Redis connection only once
      if (!this._hasLoggedConnection) {
        logger.info('REDIS_CONNECTION_ESTABLISHED', {
          url: process.env.REDIS_URL || 'redis://localhost:6379'
        });
        this._hasLoggedConnection = true;
        this.resetMetrics();
      }

      return true;
    } catch (error) {
      logger.error('REDIS_CONNECTION_FAILED', {
        errorMessage: error.message,
        errorStack: error.stack
      });
      return false;
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
