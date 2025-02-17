import { createClient } from 'redis';
import logger from '../config/logger.js';

class RedisConnection {
  constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      // Optional: Add authentication if needed
      // password: process.env.REDIS_PASSWORD
    });

    // Metrics tracking
    this.metrics = {
      totalBetsReceived: 0,
      totalBetAmount: 0,
      gameSessionBetCounts: {},
      lastLoggedBetCount: 0
    };

    this.client.on('error', (err) => {
      logger.error('Redis Client Error', { 
        errorMessage: err.message,
        errorStack: err.stack 
      });
    });

    this.client.on('connect', () => {
      logger.info('Redis connection established');
      this.resetMetrics();
    });

    // Track connection state
    this._isConnecting = false;
    this._connectionPromise = null;
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
    // Log final metrics before disconnecting
    this.logMetrics();
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
