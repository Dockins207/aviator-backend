import redisConnection from '../config/redisConfig.js';
import logger from '../config/logger.js';
import { v4 as uuidv4 } from 'uuid';

class RedisRepository {
  constructor() {
    // Do not get client immediately, defer until first use
    this._client = null;
  }

  // Lazy client retrieval
  async getClient() {
    if (!this._client) {
      // Ensure connection is established
      const connection = await import('../config/redisConfig.js');
      await connection.default.connect();
      this._client = connection.default.getClient();
    }
    return this._client;
  }

  // Store a bet in Redis with expiration
  async storeBet(gameId, betData, expirationSeconds = 3600) {
    try {
      const client = await this.getClient();
      // Use a hash to store bet details
      const betKey = `game:${gameId}:bets`;
      await client.hSet(betKey, betData.id, JSON.stringify(betData));
      
      // Set expiration for the entire hash
      await client.expire(betKey, expirationSeconds);
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  // Get bet by specific ID
  async getBetById(gameId, betId) {
    try {
      const client = await this.getClient();
      const betKey = `game:${gameId}:bets`;
      const betJson = await client.hGet(betKey, betId);
      
      if (betJson) {
        return JSON.parse(betJson);
      }
      
      return null;
    } catch (error) {
      logger.error(error);
      return null;
    }
  }

  // Atomic bet status update with optimistic locking
  async updateBetStatusAtomic(gameId, betId, expectedStatus, newStatus) {
    try {
      const client = await this.getClient();
      const betKey = `game:${gameId}:bets`;
      const betJson = await client.hGet(betKey, betId);
      
      if (!betJson) {
        return false;
      }
      
      const bet = JSON.parse(betJson);
      
      // Optimistic locking: only update if current status matches expected
      if (bet.status !== expectedStatus) {
        return false;
      }
      
      bet.status = newStatus;
      await client.hSet(betKey, betId, JSON.stringify(bet));
      
      return true;
    } catch (error) {
      logger.error(error);
      return false;
    }
  }

  // Track game-level metrics in Redis
  async incrementGameMetrics(gameId, metricKey, incrementValue = 1) {
    try {
      const client = await this.getClient();
      const key = `game:${gameId}:metrics:${metricKey}`;
      
      // Special handling for crash_points to convert to integer
      let finalIncrementValue = incrementValue;
      if (metricKey === 'crash_points') {
        // Convert to integer by multiplying by 100 to preserve 2 decimal places
        finalIncrementValue = Math.round(incrementValue * 100);
      }
      
      // Ensure the value is an integer
      const currentValue = await client.get(key) || '0';
      const numericValue = parseInt(currentValue, 10);
      
      const result = await client.incrBy(key, finalIncrementValue);
      
      // Set expiration to prevent metric accumulation
      await client.expire(key, 3600);  // 1 hour expiration
      
      return result;
    } catch (error) {
      logger.error(error);
      return 0;
    }
  }

  // Get game-level metrics
  async getGameMetrics(gameId, metricKey) {
    try {
      const client = await this.getClient();
      const key = `game:${gameId}:metrics:${metricKey}`;
      const value = await client.get(key);
      
      // Special handling for crash_points to convert back to float
      if (metricKey === 'crash_points' && value) {
        return parseFloat((parseInt(value, 10) / 100).toFixed(2));
      }
      
      return value ? parseInt(value, 10) : 0;
    } catch (error) {
      logger.error(error);
      return 0;
    }
  }

  // Update bet status
  async updateBetStatus(gameId, betId, status) {
    try {
      const client = await this.getClient();
      const betKey = `game:${gameId}:bets`;
      const betJson = await client.hGet(betKey, betId);
      
      if (betJson) {
        const bet = JSON.parse(betJson);
        bet.status = status;
        
        await client.hSet(betKey, betId, JSON.stringify(bet));
      }
    } catch (error) {
      logger.error(error);
    }
  }

  // Clear all bets for a game
  async clearGameBets(gameId) {
    try {
      const client = await this.getClient();
      await client.del(`game:${gameId}:bets`);
    } catch (error) {
      logger.error(error);
    }
  }

  // Get total bet amount for a game
  async getTotalBetAmount(gameId) {
    try {
      const client = await this.getClient();
      const bets = await client.hGetAll(`game:${gameId}:bets`);
      
      const totalBetAmount = Object.values(bets)
        .map(betJson => JSON.parse(betJson))
        .reduce((total, bet) => total + bet.amount, 0);

      return totalBetAmount;
    } catch (error) {
      logger.error(error);
      return 0;
    }
  }

  /**
   * Push a bet to a specific game session
   * @param {string} gameSessionId - Game session ID
   * @param {string} userId - User ID who placed the bet
   * @param {number} betAmount - Amount of the bet
   * @param {string} status - Status of the bet
   */
  async pushBetToGameSession(gameSessionId, userId, betAmount, status) {
    try {
      const client = await this.getClient();
      const betId = uuidv4(); // Generate unique bet ID
      
      // Prepare bet data
      const betData = {
        id: betId,
        userId,
        amount: betAmount,
        status,
        timestamp: Date.now()
      };

      // Store bet in game session hash
      const betKey = `game:${gameSessionId}:bets`;
      await client.hSet(betKey, betId, JSON.stringify(betData));
      
      // Set expiration for the bet hash
      await client.expire(betKey, 3600); // 1 hour expiration

      // Track bet metrics
      redisConnection.trackBetMetrics(gameSessionId, betAmount);

      logger.info('BET_PUSHED_TO_REDIS', {
        gameSessionId,
        userId,
        betAmount,
        betId,
        status
      });

      return betId;
    } catch (error) {
      logger.error('REDIS_BET_PUSH_FAILED', {
        errorMessage: error.message,
        gameSessionId,
        userId,
        betAmount
      });
      throw error;
    }
  }
}

export default new RedisRepository();
