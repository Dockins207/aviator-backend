import Redis from 'ioredis';
import logger from '../config/logger.js';

class WagerMonitorRedisService {
  constructor() {
    // Redis connection configuration
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      db: process.env.REDIS_DB || 0
    });

    // Wager-specific Redis key prefixes
    this.KEYS = {
      ACTIVE_WAGERS: 'aviator:active_wagers:',
      WAGER_DETAILS: 'aviator:wager_details:',
      USER_WAGERS: 'aviator:user_wagers:'
    };

    // Set up error handling
    this.redis.on('error', (error) => {
      logger.error('Redis Connection Error', {
        service: 'wager-monitor-redis',
        errorMessage: error.message
      });
    });
  }

  // Save a new wager
  async saveWager(wager) {
    try {
      // Validate wager object
      if (!wager || !wager.id || !wager.userId) {
        throw new Error('Invalid wager object');
      }

      // Store wager details
      await this.redis.hmset(
        `${this.KEYS.WAGER_DETAILS}${wager.id}`, 
        wager
      );

      // Index wager by user
      await this.redis.sadd(
        `${this.KEYS.USER_WAGERS}${wager.userId}`, 
        wager.id
      );

      // Track active wagers
      await this.redis.sadd(
        this.KEYS.ACTIVE_WAGERS, 
        wager.id
      );

      // Log wager storage
      logger.info('WAGER_STORED_IN_REDIS', {
        wagerId: wager.id,
        userId: wager.userId,
        gameId: wager.gameId
      });

      return wager;
    } catch (error) {
      logger.error('Failed to save wager in Redis', {
        error: error.message,
        wagerData: wager
      });
      throw error;
    }
  }

  // Update existing wager
  async updateWager(updatedWager) {
    try {
      // Update wager details
      await this.redis.hmset(
        `${this.KEYS.WAGER_DETAILS}${updatedWager.id}`, 
        updatedWager
      );

      // Remove from active wagers if no longer active
      if (updatedWager.status !== 'active') {
        await this.redis.srem(
          this.KEYS.ACTIVE_WAGERS, 
          updatedWager.id
        );
      }

      // Log wager update
      logger.info('WAGER_UPDATED_IN_REDIS', {
        wagerId: updatedWager.id,
        newStatus: updatedWager.status
      });

      return updatedWager;
    } catch (error) {
      logger.error('Failed to update wager in Redis', {
        error: error.message,
        wagerData: updatedWager
      });
      throw error;
    }
  }

  // Retrieve a specific wager
  async getWager(wagerId) {
    try {
      const wagerDetails = await this.redis.hgetall(
        `${this.KEYS.WAGER_DETAILS}${wagerId}`
      );

      return wagerDetails.id ? wagerDetails : null;
    } catch (error) {
      logger.error('Failed to retrieve wager from Redis', {
        wagerId,
        error: error.message
      });
      throw error;
    }
  }

  // Get active wagers for a user or all users
  async getUserActiveWagers(userId = null) {
    try {
      let activeWagerIds;

      if (userId) {
        // Get active wager IDs for specific user
        const userWagerIds = await this.redis.smembers(
          `${this.KEYS.USER_WAGERS}${userId}`
        );
        
        // Filter only active wagers
        activeWagerIds = await Promise.all(
          userWagerIds.map(async (wagerId) => {
            const wager = await this.getWager(wagerId);
            return wager && wager.status === 'active' ? wagerId : null;
          })
        );
      } else {
        // Get all active wager IDs
        activeWagerIds = await this.redis.smembers(
          this.KEYS.ACTIVE_WAGERS
        );
      }

      // Retrieve full wager details
      const activeWagers = await Promise.all(
        activeWagerIds
          .filter(id => id !== null)
          .map(wagerId => this.getWager(wagerId))
      );

      return activeWagers;
    } catch (error) {
      logger.error('Failed to retrieve active wagers', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  // Reset game session (remove all wagers for a specific game)
  async resetGameSession(gameId) {
    try {
      // Find and remove wagers for specific game
      const activeWagers = await this.getUserActiveWagers();
      const gameWagers = activeWagers.filter(wager => wager.gameId === gameId);

      // Remove game wagers
      const deletedWagers = await Promise.all(
        gameWagers.map(async (wager) => {
          await this.redis.del(`${this.KEYS.WAGER_DETAILS}${wager.id}`);
          await this.redis.srem(this.KEYS.ACTIVE_WAGERS, wager.id);
          return wager.id;
        })
      );

      logger.info('GAME_SESSION_RESET', {
        gameId,
        deletedWagers: deletedWagers.length
      });

      return { 
        gameId, 
        deletedWagers 
      };
    } catch (error) {
      logger.error('Failed to reset game session', {
        gameId,
        error: error.message
      });
      throw error;
    }
  }

  // Reset all active sessions
  async resetAllActiveSessions() {
    try {
      // Get all active wager IDs
      const activeWagerIds = await this.redis.smembers(
        this.KEYS.ACTIVE_WAGERS
      );

      // Remove all active wagers
      const deletedWagers = await Promise.all(
        activeWagerIds.map(async (wagerId) => {
          await this.redis.del(`${this.KEYS.WAGER_DETAILS}${wagerId}`);
          return wagerId;
        })
      );

      // Clear active wagers set
      await this.redis.del(this.KEYS.ACTIVE_WAGERS);

      logger.info('ALL_ACTIVE_SESSIONS_RESET', {
        deletedWagers: deletedWagers.length
      });

      return { deletedWagers };
    } catch (error) {
      logger.error('Failed to reset all active sessions', {
        error: error.message
      });
      throw error;
    }
  }
}

export default WagerMonitorRedisService;
