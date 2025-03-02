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
   * @param {number} [expiry=null] - Expiration time in seconds
   */
  static async cacheActiveBets(gameSessionId, bets, expiry = null) {
    try {
      const cacheKey = `active_bets:${gameSessionId}`;
      
      // Clear existing bets
      await redisClient.del(cacheKey);
      
      if (bets && bets.length > 0) {
        // If no custom expiry is provided, calculate based on game session
        if (!expiry) {
          // Retrieve game session end time
          const gameSession = await this.getGameSession(gameSessionId);
          
          if (gameSession && gameSession.endTime) {
            // Calculate expiry as seconds from now until game session end
            const now = Date.now();
            const endTime = parseInt(gameSession.endTime);
            expiry = Math.max(Math.ceil((endTime - now) / 1000), 0);
          } else {
            // Fallback to 10 minutes if no end time is found
            expiry = 600;
          }
        }

        // Cache bets
        await redisClient.rpush(cacheKey, ...bets.map(bet => JSON.stringify(bet)));
        
        // Only set expiry if it's greater than 0
        if (expiry > 0) {
          await redisClient.expire(cacheKey, expiry);
        }

        // Enhanced logging with more details
        logger.debug('ACTIVE_BETS_CACHED', {
          service: 'aviator-backend',
          gameSessionId,
          betCount: bets.length,
          expirySeconds: expiry,
          betIds: bets.map(bet => bet.bet_id || bet.betId),
          userIds: bets.map(bet => bet.user_id || bet.userId)
        });
      } else {
        logger.info('NO_ACTIVE_BETS_TO_CACHE', {
          service: 'aviator-backend',
          gameSessionId
        });
      }
    } catch (error) {
      logger.error('REDIS_ACTIVE_BETS_CACHE_ERROR', {
        service: 'aviator-backend',
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
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

      const parsedBets = cachedBets.map(bet => {
        const parsedBet = JSON.parse(bet);
        // Normalize property names for consistent access
        return {
          ...parsedBet,
          betId: parsedBet.betId || parsedBet.bet_id,
          userId: parsedBet.userId || parsedBet.user_id,
          bet_id: parsedBet.bet_id || parsedBet.betId,
          user_id: parsedBet.user_id || parsedBet.userId
        };
      });

      // Log retrieval details
      logger.info('ACTIVE_BETS_RETRIEVED', {
        service: 'aviator-backend',
        gameSessionId,
        betCount: parsedBets.length,
        betIds: parsedBets.map(bet => bet.bet_id),
        userIds: parsedBets.map(bet => bet.user_id)
      });

      return parsedBets;
    } catch (error) {
      logger.error('REDIS_ACTIVE_BETS_RETRIEVE_ERROR', {
        service: 'aviator-backend',
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
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

  /**
   * Set a key with expiry
   * @param {string} key - Redis key
   * @param {string} value - Value to store
   * @param {number} expiry - Expiration time in seconds
   * @returns {Promise<void>}
   */
  static async setWithExpiry(key, value, expiry) {
    try {
      await redisClient.set(key, value);
      await redisClient.expire(key, expiry);
      
      logger.debug('REDIS_SET_WITH_EXPIRY', {
        key,
        expiry
      });
    } catch (error) {
      logger.error('REDIS_SET_WITH_EXPIRY_ERROR', {
        key,
        errorMessage: error.message
      });
      throw error;
    }
  }

  /**
   * Get a value by key
   * @param {string} key - Redis key
   * @returns {Promise<string|null>} Stored value or null if not found
   */
  static async get(key) {
    try {
      const value = await redisClient.get(key);
      return value;
    } catch (error) {
      logger.error('REDIS_GET_ERROR', {
        key,
        errorMessage: error.message
      });
      return null;
    }
  }

  /**
   * Delete a key
   * @param {string} key - Redis key
   * @returns {Promise<void>}
   */
  static async del(key) {
    try {
      await redisClient.del(key);
      
      logger.debug('REDIS_DEL', {
        key
      });
    } catch (error) {
      logger.error('REDIS_DEL_ERROR', {
        key,
        errorMessage: error.message
      });
      throw error;
    }
  }

  /**
   * Get current game state
   * @returns {Promise<string>} Current game state
   */
  static async getGameState() {
    try {
      const gameState = await redisClient.get('game_state');
      return gameState || 'waiting';
    } catch (error) {
      logger.error('REDIS_GET_GAME_STATE_ERROR', {
        errorMessage: error.message
      });
      return 'waiting';
    }
  }

  /**
   * Set current game state
   * @param {string} key - State identifier (e.g., 'current')
   * @param {Object} gameState - Game state object
   * @returns {Promise<void>}
   */
  static async setGameState(key, gameState) {
    try {
      const stateKey = `game_state:${key}`;
      const stateString = typeof gameState === 'object' 
        ? JSON.stringify(gameState) 
        : gameState;
      
      await redisClient.set(stateKey, stateString);
      
      // Also set the main game state for backward compatibility
      if (key === 'current') {
        await redisClient.set('game_state', stateString);
      }
      
      logger.debug('REDIS_SET_GAME_STATE', {
        key: stateKey,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('REDIS_SET_GAME_STATE_ERROR', {
        key,
        errorMessage: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  /**
   * Subscribe to a Redis channel
   * @param {string} channel - Channel to subscribe to
   * @param {Function} callback - Callback to execute when a message is received
   */
  static async subscribe(channel, callback) {
    try {
      // Create a duplicate client for pub/sub (as recommended by Redis)
      const subscriber = redisClient.duplicate();
      
      // Subscribe to the channel
      await subscriber.subscribe(channel);
      
      // Set up message handler
      subscriber.on('message', (ch, message) => {
        if (ch === channel) {
          callback(message);
        }
      });
      
      logger.info('REDIS_SUBSCRIBE_SUCCESS', {
        service: 'aviator-backend',
        channel,
        timestamp: new Date().toISOString()
      });
      
      return subscriber;
    } catch (error) {
      logger.error('REDIS_SUBSCRIBE_ERROR', {
        service: 'aviator-backend',
        channel,
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  /**
   * Publish a message to a Redis channel
   * @param {string} channel - Channel to publish to
   * @param {string|Object} message - Message to publish (objects will be stringified)
   * @returns {Promise<number>} Number of clients that received the message
   */
  static async publish(channel, message) {
    try {
      // Convert object to string if necessary
      const messageString = typeof message === 'object' 
        ? JSON.stringify(message) 
        : message;
      
      // Publish the message
      const receiverCount = await redisClient.publish(channel, messageString);
      
      logger.debug('REDIS_PUBLISH_SUCCESS', {
        service: 'aviator-backend',
        channel,
        receiverCount,
        timestamp: new Date().toISOString()
      });
      
      return receiverCount;
    } catch (error) {
      logger.error('REDIS_PUBLISH_ERROR', {
        service: 'aviator-backend',
        channel,
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  /**
   * Retrieve a specific bet from Redis
   * @param {string} betId - Unique bet identifier
   * @returns {Promise<Object|null>} - Bet details or null if not found
   */
  static async getBet(betId) {
    try {
      // Construct Redis key for the bet
      const betKey = `bet:${betId}`;
      
      // Retrieve bet from Redis
      const betData = await this.get(betKey);
      
      if (!betData) {
        logger.debug('BET_NOT_FOUND_IN_REDIS', { betId });
        return null;
      }

      // Parse and return bet data
      const parsedBet = JSON.parse(betData);
      
      logger.debug('BET_RETRIEVED_FROM_REDIS', { 
        betId, 
        betDetails: {
          userId: parsedBet.userId,
          status: parsedBet.status
        }
      });

      return parsedBet;
    } catch (error) {
      logger.warn('REDIS_BET_RETRIEVAL_ERROR', {
        betId,
        errorMessage: error.message
      });
      
      return null;
    }
  }

  /**
   * Store a bet in Redis
   * @param {string} betId - Unique bet identifier
   * @param {Object} betData - Bet details to store
   * @param {number} [expiry=600] - Expiry time in seconds (default 10 minutes)
   */
  static async setBet(betId, betData, expiry = 600) {
    try {
      const betKey = `bet:${betId}`;
      
      // Serialize and store bet data
      await redisClient.set(betKey, JSON.stringify(betData), 'EX', expiry);
      
      logger.debug('BET_STORED_IN_REDIS', { 
        betId, 
        expiry,
        betDetails: {
          userId: betData.userId,
          status: betData.status
        }
      });
    } catch (error) {
      logger.warn('REDIS_BET_STORAGE_ERROR', {
        betId,
        errorMessage: error.message
      });
    }
  }
}

export default RedisService;
