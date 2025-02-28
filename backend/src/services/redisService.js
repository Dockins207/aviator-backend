import { redisClient } from '../config/redis.js';
import logger from '../config/logger.js';

class RedisService {
  /**
   * Cache game session metadata
   * @param {string} gameSessionId - Unique game session identifier
   * @param {Object} sessionData - Session metadata to cache
   * @param {number} [expiry=3600] - Expiration time in seconds
   */
  static async cacheGameSession(gameSessionId, sessionData, expiry = 3600) {
    try {
      const sessionKey = `game_session:${gameSessionId}`;
      
      await redisClient.hmset(sessionKey, {
        ...sessionData,
        lastUpdated: Date.now().toString()
      });

      await redisClient.expire(sessionKey, expiry);

      logger.debug('GAME_SESSION_CACHED', {
        gameSessionId,
        metadata: Object.keys(sessionData)
      });
    } catch (error) {
      logger.error('REDIS_GAME_SESSION_CACHE_ERROR', {
        gameSessionId,
        errorMessage: error.message
      });
      throw error;
    }
  }

  /**
   * Retrieve game session metadata
   * @param {string} gameSessionId - Unique game session identifier
   * @returns {Promise<Object|null>} Cached session data
   */
  static async getGameSession(gameSessionId) {
    try {
      const sessionKey = `game_session:${gameSessionId}`;
      const sessionData = await redisClient.hgetall(sessionKey);

      return Object.keys(sessionData).length > 0 ? sessionData : null;
    } catch (error) {
      logger.error('REDIS_GAME_SESSION_RETRIEVE_ERROR', {
        gameSessionId,
        errorMessage: error.message
      });
      return null;
    }
  }

  /**
   * Check if a game session is active
   * @param {string} gameSessionId - Unique game session identifier
   * @returns {Promise<boolean>} Session active status
   */
  static async isGameSessionActive(gameSessionId) {
    const sessionData = await this.getGameSession(gameSessionId);
    return sessionData && sessionData.state === 'active';
  }

  /**
   * Cache active bets for a game session
   * @param {string} gameSessionId - Unique game session identifier
   * @param {Array} bets - List of active bets
   * @param {number} [expiry=3600] - Expiration time in seconds
   */
  static async cacheActiveBets(gameSessionId, bets, expiry = 3600) {
    try {
      const cacheKey = `active_bets:${gameSessionId}`;
      
      // Clear existing bets
      await redisClient.del(cacheKey);
      
      if (bets && bets.length > 0) {
        await redisClient.rpush(cacheKey, ...bets.map(bet => JSON.stringify(bet)));
        await redisClient.expire(cacheKey, expiry);
      }

      logger.debug('ACTIVE_BETS_CACHED', {
        gameSessionId,
        betCount: bets ? bets.length : 0
      });
    } catch (error) {
      logger.error('REDIS_ACTIVE_BETS_CACHE_ERROR', {
        gameSessionId,
        errorMessage: error.message
      });
      throw error;
    }
  }

  /**
   * Retrieve active bets for a game session
   * @param {string} gameSessionId - Unique game session identifier
   * @returns {Promise<Array>} List of active bets
   */
  static async retrieveActiveBets(gameSessionId) {
    try {
      const cacheKey = `active_bets:${gameSessionId}`;
      const cachedBets = await redisClient.lrange(cacheKey, 0, -1);

      return cachedBets.map(bet => JSON.parse(bet));
    } catch (error) {
      logger.error('REDIS_ACTIVE_BETS_RETRIEVE_ERROR', {
        gameSessionId,
        errorMessage: error.message
      });
      return [];
    }
  }

  /**
   * Clean up expired game sessions and active bets
   * @returns {Promise<Object>} Cleanup statistics
   */
  static async cleanupExpiredData() {
    try {
      const sessionKeys = await redisClient.keys('game_session:*');
      const betKeys = await redisClient.keys('active_bets:*');
      
      let sessionsCleanedCount = 0;
      let betsCleanedCount = 0;

      const now = Date.now();
      
      // Clean sessions
      for (const key of sessionKeys) {
        const sessionData = await redisClient.hgetall(key);
        const lastUpdated = parseInt(sessionData.lastUpdated || '0');
        
        if (now - lastUpdated > 3600000) { // 1 hour
          await redisClient.del(key);
          sessionsCleanedCount++;
        }
      }

      // Clean active bets
      for (const key of betKeys) {
        const ttl = await redisClient.ttl(key);
        if (ttl <= 0) {
          await redisClient.del(key);
          betsCleanedCount++;
        }
      }

      logger.info('REDIS_EXPIRED_DATA_CLEANED', {
        sessionsCleanedCount,
        betsCleanedCount
      });

      return { sessionsCleanedCount, betsCleanedCount };
    } catch (error) {
      logger.error('REDIS_CLEANUP_ERROR', {
        errorMessage: error.message
      });
      return { sessionsCleanedCount: 0, betsCleanedCount: 0 };
    }
  }
}

export default RedisService;
