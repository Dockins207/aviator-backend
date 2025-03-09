import pkg from 'pg';
import crypto from 'crypto';
import logger from '../config/logger.js';
import { pool as dbPool } from '../config/database.js';
import { redisClient } from '../config/redis.js';

const { Pool } = pkg;

class GameRepository {
  constructor(customPool = null) {
    this.pool = customPool || dbPool;
    
    logger.info('GAME_REPOSITORY_INITIALIZED', {
      service: 'aviator-backend',
      usingCustomPool: !!customPool
    });
  }

  /**
   * Generate a new unique game session ID
   * @returns {string} Newly generated UUID
   */
  static generateGameSessionId() {
    return crypto.randomUUID();
  }

  // Add this static method to fix the error
  /**
   * Static version of createGameSession for backward compatibility
   * @param {string} gameType - Type of game ('aviator')
   * @param {string} initialStatus - Initial status ('betting')
   * @returns {Promise<Object>} Created game session
   */
  static async createGameSession(gameType = 'aviator', initialStatus = 'betting') {
    logger.info('STATIC_CREATE_GAME_SESSION_CALLED', {
      service: 'aviator-backend',
      gameType,
      initialStatus
    });
    
    const repository = new GameRepository();
    return repository.createGameSession(gameType, initialStatus);
  }

  /**
   * Static version of markGameSessionComplete
   */
  static async markGameSessionComplete(gameSessionId, crashPoint) {
    const repository = new GameRepository();
    return repository.markGameSessionComplete(gameSessionId, crashPoint);
  }

  /**
   * Static version of getCurrentActiveGameSession
   */
  static async getCurrentActiveGameSession(gameType = 'aviator') {
    const repository = new GameRepository();
    return repository.getCurrentActiveGameSession(gameType);
  }

  /**
   * Static version of cleanupOldSessions
   */
  static async cleanupOldSessions(olderThanDays = 7) {
    const repository = new GameRepository();
    return repository.cleanupOldSessions(olderThanDays);
  }

  /**
   * Static version of updateGameSessionStatus for backward compatibility
   * @param {string} gameSessionId - ID of the game session
   * @param {string} status - New status for the game session
   * @returns {Promise<Object>} Updated game session
   */
  static async updateGameSessionStatus(gameSessionId, status) {
    const repository = new GameRepository();
    return repository.updateGameSessionStatus(gameSessionId, status);
  }

  /**
   * Validate if a given string is a valid UUID
   * @param {string} uuid - UUID to validate
   * @returns {boolean} Whether the UUID is valid
   */
  static isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuid && typeof uuid === 'string' && uuidRegex.test(uuid);
  }

  /**
   * Normalize game session ID
   * @param {string} gameSessionId - Game session ID to normalize
   * @returns {string} Normalized game session ID
   */
  static normalizeGameSessionId(gameSessionId) {
    // If it's already a standard UUID, return as-is
    if (this.isValidUUID(gameSessionId)) {
      return gameSessionId;
    }

    // If it's a placeholder or invalid, generate a new UUID
    if (!gameSessionId || gameSessionId === 'currentGameSessionId') {
      logger.warn('INVALID_GAME_SESSION_ID_GENERATED', {
        providedId: gameSessionId
      });
      return this.generateGameSessionId();
    }
    
    // Create a deterministic UUID from the input
    const hash = crypto.createHash('md5').update(gameSessionId).digest('hex');
    const normalizedId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(12,15)}-8${hash.slice(15,18)}-${hash.slice(18,30)}`;
    
    logger.info('GAME_SESSION_ID_NORMALIZED', {
      originalId: gameSessionId,
      normalizedId
    });

    return normalizedId;
  }

  /**
   * Create a new game session
   * @param {string} gameType - Type of game ('aviator')
   * @param {string} initialStatus - Initial status ('betting')
   * @returns {Promise<Object>} Created game session
   */
  async createGameSession(gameType = 'aviator', initialStatus = 'betting') {
    try {
      const query = `
        INSERT INTO game_sessions 
        (game_type, status)
        VALUES ($1, $2)
        RETURNING *
      `;

      const values = [gameType, initialStatus];
      const result = await this.pool.query(query, values);

      logger.info('GAME_SESSION_CREATED', {
        service: 'aviator-backend',
        gameSessionId: result.rows[0].game_session_id,
        gameType,
        initialStatus
      });

      return result.rows[0];
    } catch (error) {
      logger.error('GAME_SESSION_CREATION_ERROR', {
        service: 'aviator-backend',
        errorMessage: error.message,
        gameType,
        initialStatus
      });
      throw error;
    }
  }

  /**
   * Update game session status
   * @param {string} gameSessionId - ID of the game session
   * @param {string} status - New status for the game session
   * @returns {Promise<Object>} Updated game session
   */
  async updateGameSessionStatus(gameSessionId, status) {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      // Update game session status
      const updateQuery = `
        UPDATE game_sessions 
        SET status = $2::game_status 
        WHERE game_session_id = $1 
        RETURNING *
      `;
      
      const result = await client.query(updateQuery, [gameSessionId, status]);
      
      if (result.rows.length === 0) {
        logger.warn('UPDATE_GAME_SESSION_STATUS_NOT_FOUND', {
          service: 'aviator-backend',
          gameSessionId,
          status
        });
        return null;
      }

      // Handle Redis operations based on game status
      const redisBetsKey = `game:${gameSessionId}:active_bets`;

      if (status === 'in_progress') {
        // Get and push active bets to Redis when game starts
        const activeBetsQuery = `
          SELECT * FROM get_active_bets_for_redis($1)
        `;
        
        const activeBetsResult = await client.query(activeBetsQuery, [gameSessionId]);
        
        if (activeBetsResult.rows.length > 0) {
          const redisData = activeBetsResult.rows.map(bet => ({
            betId: bet.bet_id,
            userId: bet.user_id,
            betAmount: bet.bet_amount,
            autoCashoutMultiplier: bet.autocashout_multiplier,
            gameSessionId: bet.game_session_id,
            status: bet.status
          }));

          await redisClient.set(redisBetsKey, JSON.stringify(redisData));

          logger.info('ACTIVE_BETS_PUSHED_TO_REDIS', {
            service: 'aviator-backend',
            gameSessionId,
            betCount: redisData.length
          });
        }
      } else if (status === 'completed') {
        // Clear Redis data when game ends
        await redisClient.del(redisBetsKey);
        
        logger.info('REDIS_GAME_DATA_CLEARED', {
          service: 'aviator-backend',
          gameSessionId
        });
      }

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('UPDATE_GAME_SESSION_STATUS_ERROR', {
        service: 'aviator-backend',
        gameSessionId,
        status,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get the current active game session
   * @param {string} gameType - Type of game
   * @returns {Promise<Object|null>} Current game session or null if not found
   */
  async getCurrentActiveGameSession(gameType = 'aviator') {
    try {
      const query = `
        SELECT * 
        FROM game_sessions
        WHERE game_type = $1 AND status = 'in_progress'
        ORDER BY created_at DESC
        LIMIT 1
      `;
      
      const result = await this.pool.query(query, [gameType]);
      
      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      logger.error('ERROR_GETTING_CURRENT_GAME_SESSION', {
        service: 'aviator-backend',
        gameType,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Mark a game session as complete with a crash point
   * @param {string} gameSessionId - ID of the game session to complete
   * @param {number} crashPoint - Crash point value
   * @returns {Promise<Object>} Updated game session
   */
  async markGameSessionComplete(gameSessionId, crashPoint) {
    if (typeof crashPoint !== 'number' || isNaN(crashPoint) || crashPoint <= 0) {
      logger.error('INVALID_CRASH_POINT', { 
        gameSessionId, 
        crashPoint,
        crashPointType: typeof crashPoint
      });
      // Ensure a valid value even in error cases
      crashPoint = parseFloat(crashPoint) || 1.00;
    }

    // Force to numeric with 2 decimal places
    crashPoint = parseFloat(crashPoint.toFixed(2));
    
    logger.info('MARKING_SESSION_COMPLETE', {
      gameSessionId,
      crashPoint
    });

    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');

      const updateQuery = `
        UPDATE game_sessions 
        SET 
          status = 'completed',
          crash_point = $1,
          ended_at = CURRENT_TIMESTAMP
        WHERE 
          game_session_id = $2 AND
          status = 'in_progress'
        RETURNING game_session_id, crash_point, status
      `;
      
      const result = await client.query(updateQuery, [crashPoint, gameSessionId]);

      if (result.rows.length === 0) {
        logger.warn('GAME_SESSION_UPDATE_FAILED', { 
          gameSessionId,
          crashPoint
        });
        throw new Error(`Failed to update game session ${gameSessionId}`);
      }

      await client.query('COMMIT');
      
      logger.info('GAME_SESSION_COMPLETE_SUCCESS', { 
        gameSessionId, 
        savedCrashPoint: result.rows[0].crash_point,
        requestedCrashPoint: crashPoint,
        status: result.rows[0].status
      });
      
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('GAME_SESSION_COMPLETE_ERROR', { 
        gameSessionId, 
        error: error.message,
        errorStack: error.stack
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Clean up old completed game sessions
   * @param {number} olderThanDays - Delete sessions older than this many days
   * @returns {Promise<number>} Number of sessions deleted
   */
  async cleanupOldSessions(olderThanDays = 7) {
    try {
      const query = `
        DELETE FROM game_sessions
        WHERE 
          status = 'completed' AND
          created_at < NOW() - INTERVAL '${olderThanDays} days'
        RETURNING game_session_id
      `;

      const result = await this.pool.query(query);
      const deletedCount = result.rows.length;

      logger.info('OLD_SESSIONS_CLEANED', {
        service: 'aviator-backend', 
        deletedCount,
        olderThanDays
      });

      return deletedCount;
    } catch (error) {
      logger.error('SESSION_CLEANUP_ERROR', {
        service: 'aviator-backend',
        error: error.message
      });
      throw error;
    }
  }

  // Add this method to handle game session creation with locking
  static async createGameSessionWithLock(gameType = 'aviator', initialStatus = 'betting') {
    const repository = new GameRepository();
    const client = await repository.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // First complete any existing active sessions
      const cleanupResult = await client.query(`
        UPDATE game_sessions 
        SET 
          status = 'completed', 
          crash_point = 1.00,
          ended_at = CURRENT_TIMESTAMP
        WHERE 
          status IN ('betting', 'in_progress')
        RETURNING game_session_id
      `);
      
      if (cleanupResult.rows.length > 0) {
        logger.warn('CLEANED_UP_EXISTING_ACTIVE_SESSIONS', {
          service: 'aviator-backend',
          sessionIds: cleanupResult.rows.map(row => row.game_session_id)
        });
        
        // Add a small delay to ensure the cleanup is propagated
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // Use advisory lock to prevent race conditions
      const lockResult = await client.query('SELECT pg_try_advisory_xact_lock(42)');
      const lockAcquired = lockResult.rows[0].pg_try_advisory_xact_lock;
      
      if (!lockAcquired) {
        logger.warn('FAILED_TO_ACQUIRE_SESSION_LOCK', {
          service: 'aviator-backend'
        });
        throw new Error('Could not acquire lock for session creation');
      }
      
      // Double-check there are no active sessions after lock acquired
      const checkResult = await client.query(`
        SELECT COUNT(*) as count FROM game_sessions 
        WHERE status IN ('betting', 'in_progress')
      `);
      
      if (parseInt(checkResult.rows[0].count) > 0) {
        logger.error('RACE_CONDITION_MULTIPLE_SESSIONS_DETECTED', {
          service: 'aviator-backend',
          count: parseInt(checkResult.rows[0].count)
        });
        throw new Error('Race condition detected - active sessions still exist');
      }
      
      // Create the new session
      const query = `
        INSERT INTO game_sessions 
        (game_type, status)
        VALUES ($1, $2)
        RETURNING *
      `;
      
      const result = await client.query(query, [gameType, initialStatus]);
      
      await client.query('COMMIT');
      
      logger.info('GAME_SESSION_CREATED_WITH_LOCK', {
        service: 'aviator-backend',
        gameSessionId: result.rows[0].game_session_id
      });
      
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('GAME_SESSION_CREATION_ERROR', {
        service: 'aviator-backend',
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    } finally {
      client.release();
    }
  }
}

export default GameRepository;
