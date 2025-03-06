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

  /**
   * Validate and normalize game session ID
   * @param {string} gameSessionId - Game session ID to validate
   * @returns {string} Normalized game session ID
   * @throws {Error} If the game session ID is invalid
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
   * Validate if a given string is a valid UUID
   * @param {string} uuid - UUID to validate
   * @returns {boolean} Whether the UUID is valid
   */
  static isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuid && typeof uuid === 'string' && uuidRegex.test(uuid);
  }

  /**
   * Create a new game session
   * @param {Object} sessionData - Data for the new game session
   * @returns {Promise<string>} Created game session ID
   */
  async createGameSession(sessionData = {}) {
      const existingSession = await this.getCurrentActiveGameSession();
      if (existingSession) {
          // Return an error or a message indicating an active session exists
          throw new Error('An active game session already exists.');
      }
      const gameSessionId = GameRepository.generateGameSessionId();
      // Proceed with creating a new game session
      const newSession = await this.db.insert('game_sessions', sessionData);
      return newSession;
    try {
      const query = `
        INSERT INTO game_sessions 
        (game_session_id, status, game_type, created_at, total_bet_amount)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP, 0)
        RETURNING game_session_id
      `;

      const values = [
        gameSessionId, 
        sessionData.status || 'in_progress',
        sessionData.gameType || 'aviator'
      ];

      await this.pool.query(query, values);

      logger.info('GAME_SESSION_CREATED', {
        gameSessionId,
        gameType: values[2]
      });

      return gameSessionId;
    } catch (error) {
      logger.error('GAME_SESSION_CREATION_ERROR', {
        errorMessage: error.message,
        sessionData
      });
      throw error;
    }
  }

  /**
   * Validate if a given string is a valid UUID
   * @param {string} uuid - UUID to validate
   * @returns {boolean} - Whether the UUID is valid
   */
  static isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  /**
   * Normalize game session ID to a standard UUID
   * @param {string} gameSessionId - Game session ID to normalize
   * @returns {string} - Normalized game session ID
   */
  static normalizeGameSessionId(gameSessionId) {
    // If already a valid UUID, return as-is
    if (this.isValidUUID(gameSessionId)) {
      return gameSessionId;
    }

    // Create a hash from the input to generate a consistent UUID
    const hash = crypto.createHash('md5').update(gameSessionId).digest('hex');

    // Format the hash as a UUID
    return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(12,15)}-8${hash.slice(15,18)}-${hash.slice(18,30)}`;
  }

  /**
   * Utility method to validate UUID
   * @param {string} uuid - UUID to validate
   * @returns {boolean} - Whether the UUID is valid
   */
  isValidUUID(uuid) {
    const standardUuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const timestampUuidRegex = /^\d{13}-[0-9a-f]{8}$/;
    return uuid && typeof uuid === 'string' && 
           (standardUuidRegex.test(uuid) || timestampUuidRegex.test(uuid));
  }

  /**
   * Normalize game session ID to a standard UUID
   * @param {string} gameSessionId - Game session ID to normalize
   * @returns {string} - Normalized UUID
   */
  normalizeGameSessionId(gameSessionId) {
    // If it's already a standard UUID, return as-is
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(gameSessionId)) {
      return gameSessionId;
    }
    
    // For timestamp-based IDs, create a deterministic UUID
    const hash = crypto.createHash('md5').update(gameSessionId).digest('hex');
    return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(12,15)}-8${hash.slice(15,18)}-${hash.slice(18,30)}`;
  }

  // Constants for game session management
  static MAX_BET_PER_SESSION = 50000;  // Maximum total bet amount per session
  static MAX_SESSION_DURATION_MINUTES = 15;  // Maximum session duration
  static CLEANUP_INTERVAL_MINUTES = 30;  // Interval for cleaning up old sessions

  /**
   * Check if a game session has exceeded maximum bet limit
   * @param {string} gameSessionId - ID of the game session
   * @param {number} newBetAmount - Amount of the new bet
   * @returns {Promise<boolean>} - Whether the bet is allowed
   */
  static async isSessionBetLimitExceeded(gameSessionId, newBetAmount) {
    try {
      const query = `
        SELECT 
          total_bet_amount,
          game_type
        FROM game_sessions 
        WHERE game_session_id = $1
      `;
      const result = await dbPool.query(query, [gameSessionId]);

      if (result.rows.length === 0) {
        return false;  // Session not found, assume it's okay
      }

      const currentTotalBet = result.rows[0].total_bet_amount || 0;
      const willExceedLimit = currentTotalBet + newBetAmount > this.MAX_BET_PER_SESSION;

      logger.info('SESSION_BET_LIMIT_CHECK', {
        gameSessionId,
        currentTotalBet,
        newBetAmount,
        maxLimit: this.MAX_BET_PER_SESSION,
        willExceedLimit
      });

      return willExceedLimit;
    } catch (error) {
      logger.error('ERROR_CHECKING_SESSION_BET_LIMIT', {
        gameSessionId,
        newBetAmount,
        errorMessage: error.message
      });
      return true;  // Fail safe: prevent bet if we can't verify
    }
  }

  /**
   * Close expired game sessions
   * @returns {Promise<number>} Number of sessions closed
   */
  static async closeExpiredSessions() {
    try {
      const query = `
        UPDATE game_sessions
        SET 
          status = 'closed',
          ended_at = CURRENT_TIMESTAMP
        WHERE 
          status = 'in_progress' AND 
          created_at < CURRENT_TIMESTAMP - INTERVAL '${this.MAX_SESSION_DURATION_MINUTES} minutes'
        RETURNING game_session_id
      `;
      const result = await dbPool.query(query);

      logger.info('EXPIRED_SESSIONS_CLOSED', {
        closedSessionCount: result.rows.length
      });

      return result.rows.length;
    } catch (error) {
      logger.error('ERROR_CLOSING_EXPIRED_SESSIONS', {
        errorMessage: error.message
      });
      return 0;
    }
  }

  /**
   * Cleanup old and inactive game sessions
   * @returns {Promise<number>} Number of sessions cleaned up
   */
  static async cleanupOldSessions() {
    try {
      const query = `
        DELETE FROM game_sessions
        WHERE 
          status IN ('closed', 'completed') AND 
          ended_at < CURRENT_TIMESTAMP - INTERVAL '${this.CLEANUP_INTERVAL_MINUTES} minutes'
        RETURNING game_session_id
      `;
      const result = await dbPool.query(query);

      logger.info('OLD_SESSIONS_CLEANED', {
        cleanedSessionCount: result.rows.length
      });

      return result.rows.length;
    } catch (error) {
      logger.error('ERROR_CLEANING_OLD_SESSIONS', {
        errorMessage: error.message
      });
      return 0;
    }
  }

  /**
   * Create a comprehensive game record with bet and session tracking
   * @param {string} userId - User placing the bet
   * @param {string} gameType - Type of game
   * @param {number} betAmount - Bet amount
   * @param {string} playerBetId - Unique player bet ID
   * @param {string} gameSessionId - Game session ID
   * @returns {Promise<Object>} Created game record
   */
  async createGameRecord(userId, gameType, betAmount, playerBetId, gameSessionId) {
    try {
      await this.pool.query('BEGIN');

      // Normalize the game session ID
      const normalizedGameSessionId = this.normalizeGameSessionId(gameSessionId);

      // Fetch game type from game sessions table
      const sessionQuery = `
        SELECT game_type 
        FROM game_sessions 
        WHERE game_session_id = $1
      `;
      const sessionResult = await this.pool.query(sessionQuery, [normalizedGameSessionId]);

      if (sessionResult.rows.length === 0) {
        throw new Error('Game session not found');
      }

      const gameTypeFromSession = sessionResult.rows[0].game_type;

      // Create player bet record with nullable fields for game resolution
      const betQuery = `
        INSERT INTO player_bets (
          player_bet_id,
          user_id,
          game_session_id,
          bet_amount,
          status,
          cashout_multiplier,
          payout_amount,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, 'active', NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING *
      `;

      const betResult = await this.pool.query(betQuery, [
        playerBetId, 
        userId, 
        normalizedGameSessionId, 
        betAmount
      ]);

      await this.pool.query('COMMIT');

      logger.info('GAME_RECORD_CREATED', {
        gameSessionId: normalizedGameSessionId,
        playerBetId,
        userId,
        gameType: gameTypeFromSession,
        betAmount
      });

      return betResult.rows[0];
    } catch (error) {
      await this.pool.query('ROLLBACK');
      logger.error('Error creating game record', { 
        error: error.message, 
        userId, 
        gameSessionId 
      });
      throw error;
    }
  }

  /**
   * Create a game record for a player's bet
   * @param {string} userId - User ID
   * @param {string} gameType - Type of game (e.g., 'aviator')
   * @param {number} betAmount - Amount of the bet
   * @param {string} playerBetId - Unique ID for the player's bet
   * @param {string} gameSessionId - ID of the current game session
   * @returns {Promise<Object>} - Created game record
   */
  static async createGameRecord(
    userId, 
    gameType, 
    betAmount, 
    playerBetId, 
    gameSessionId
  ) {
    try {
      // Validate input parameters
      if (!this.isValidUUID(userId) || !this.isValidUUID(gameSessionId)) {
        throw new Error('Invalid UUID for userId or gameSessionId');
      }

      if (betAmount <= 0) {
        throw new Error('Bet amount must be positive');
      }

      const query = `
        INSERT INTO player_bets (
          id, 
          user_id, 
          game_type, 
          bet_amount, 
          game_session_id, 
          status, 
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, 'active', NOW()
        ) RETURNING *
      `;

      const values = [
        playerBetId, 
        userId, 
        gameType, 
        betAmount, 
        gameSessionId
      ];

      const result = await dbPool.query(query, values);

      logger.info('GAME_RECORD_CREATED', {
        userId,
        gameType,
        betAmount,
        playerBetId,
        gameSessionId
      });

      return result.rows[0];
    } catch (error) {
      logger.error('ERROR_CREATING_GAME_RECORD', {
        userId,
        gameType,
        betAmount,
        playerBetId,
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Save detailed game result with multiplier and crash point
   * @param {Object} gameState - Game state object
   * @returns {Promise<Object>} Saved game result
   */
  async saveGameResult(gameState) {
    const {
      gameSessionId, 
      crashPoint, 
      gameType = 'aviator', 
      status = 'completed'
    } = gameState;

    try {
      await this.pool.query('BEGIN');

      // Validate game session ID
      const normalizedGameSessionId = this.normalizeGameSessionId(gameSessionId);
      
      if (!this.isValidUUID(normalizedGameSessionId)) {
        throw new Error('Invalid game session ID');
      }

      // Update game session with final game result
      const gameSessionQuery = `
        UPDATE game_sessions 
        SET 
          status = $1::game_status, 
          crash_point = $2
        WHERE game_session_id = $3
        RETURNING *
      `;
      
      const gameSessionResult = await this.pool.query(gameSessionQuery, [
        status, 
        crashPoint, 
        normalizedGameSessionId
      ]);

      if (gameSessionResult.rows.length === 0) {
        throw new Error(`No game session found with ID: ${normalizedGameSessionId}`);
      }

      // Update all active bets in this game session to reflect game outcome
      const updateBetsQuery = `
        UPDATE player_bets 
        SET 
          status = CASE 
            WHEN cashout_multiplier IS NOT NULL AND cashout_multiplier > $2 THEN 'won'
            ELSE 'lost'
          END
        WHERE 
          game_session_id = $1 AND 
          status = 'active'
        RETURNING *
      `;

      const updateBetsResult = await this.pool.query(updateBetsQuery, [
        normalizedGameSessionId, 
        crashPoint
      ]);

      await this.pool.query('COMMIT');

      logger.info('GAME_RESULT_SAVED', {
        gameSessionId: normalizedGameSessionId,
        crashPoint,
        gameType,
        status,
        updatedBetsCount: updateBetsResult.rowCount
      });

      return {
        gameSession: gameSessionResult.rows[0],
        updatedBets: updateBetsResult.rows
      };
    } catch (error) {
      await this.pool.query('ROLLBACK');
      logger.error('Error saving game result', { 
        error: error.message, 
        gameSessionId 
      });
      throw error;
    }
  }

  /**
   * Retrieve game history for a user
   * @param {string} userId - User ID
   * @param {number} limit - Number of records to retrieve
   * @param {number} offset - Offset for pagination
   * @returns {Promise<Array<Object>>} Game history records
   */
  static async getUserGameHistory(userId, limit = 10, offset = 0) {
    const query = `
      SELECT 
        gs.game_session_id,
        gs.game_type,
        gs.status,
        gs.started_at,
        gs.ended_at,
        gs.multiplier,
        gs.crash_point,
        pb.bet_amount,
        pb.status AS bet_status,
        pb.payout_amount
      FROM game_sessions gs
      JOIN player_bets pb ON gs.game_session_id = pb.game_session_id
      WHERE pb.user_id = $1
      ORDER BY gs.started_at DESC
      LIMIT $2 OFFSET $3
    `;

    try {
      const result = await dbPool.query(query, [userId, limit, offset]);
      
      logger.info('Retrieved user game history', { 
        userId, 
        resultCount: result.rows.length 
      });

      return result.rows;
    } catch (error) {
      logger.error('Failed to retrieve user game history', { 
        userId,
        errorMessage: error.message 
      });
      throw error;
    }
  }

  /**
   * Get the current active game session
   * @param {string} gameType - Type of game
   * @returns {Promise<Object|null>} Current game session or null if not found
   */
  static async getCurrentGameSession(gameType = 'aviator') {
    try {
      const query = `
        SELECT * FROM game_sessions
        WHERE game_type = $1 AND status = 'in_progress'
        ORDER BY created_at DESC
        LIMIT 1
      `;
      
      const result = await dbPool.query(query, [gameType]);
      
      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      logger.error('ERROR_GETTING_CURRENT_GAME_SESSION', {
        gameType,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Create a new game session
   * @param {string} gameType - Type of game
   * @param {string} status - Status of the game session
   * @returns {Promise<Object>} Created game session
   */
  static async createGameSession(gameType = 'aviator', status = 'betting') {
    try {
      const query = `
        INSERT INTO game_sessions (
          game_type, 
          status
        ) VALUES (
          $1, 
          $2
        ) RETURNING game_session_id, game_type, status, created_at
      `;

      const result = await dbPool.query(query, [gameType, status]);

      logger.info('GAME_SESSION_CREATED', {
        gameSessionId: result.rows[0].game_session_id,
        gameType,
        status,
        timestamp: new Date().toISOString()
      });

      return result.rows[0];
    } catch (error) {
      logger.error('GAME_SESSION_CREATION_ERROR', {
        errorMessage: error.message,
        gameType,
        status,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  /**
   * Create a new game session
   * @param {string} gameType - Type of game
   * @param {string} originalGameId - Original game ID
   * @returns {Promise<Object>} Created game session
   */
  static async createGameSession(gameType, originalGameId) {
    // Create game session with default 'betting' status
    const query = `
      INSERT INTO game_sessions (
        game_type, 
        status
      ) VALUES (
        $1, 
        $2
      ) RETURNING game_session_id, game_type, status, created_at
    `;

    const result = await dbPool.query(query, [gameType, 'betting']);

    logger.info('GAME_SESSION_CREATED', {
      gameSessionId: result.rows[0].game_session_id,
      gameType,
      status: 'betting'
    });

    return result.rows[0];
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

          await redisClient.set(redisBetsKey, redisData);

          logger.info('ACTIVE_BETS_PUSHED_TO_REDIS', {
            gameSessionId,
            betCount: redisData.length
          });
        }
      } else if (status === 'completed') {
        // Clear Redis data when game ends
        await redisClient.del(redisBetsKey);
        
        logger.info('REDIS_GAME_DATA_CLEARED', {
          gameSessionId
        });
      }

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('UPDATE_GAME_SESSION_STATUS_ERROR', {
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
   * Find an active bet for a specific user
   * @param {string} userId - User ID
   * @returns {Promise<Object|null>} Active bet or null if not found
   */
  static async findActiveBetByUserId(userId) {
    if (!userId) {
      logger.warn('FIND_ACTIVE_BET_NO_USER_ID', {
        message: 'Attempted to find active bet without a user ID'
      });
      return null;
    }

    try {
      const query = `
        SELECT 
          pb.player_bet_id,
          pb.user_id,
          pb.game_session_id,
          pb.bet_amount,
          pb.status AS bet_status,
          gs.game_type,
          gs.status AS game_status,
          pb.created_at
        FROM 
          player_bets pb
        JOIN 
          game_sessions gs ON pb.game_session_id = gs.game_session_id
        WHERE 
          pb.user_id = $1 
          AND (
            (pb.status = 'active' AND gs.status = 'in_progress')
            OR 
            (pb.status = 'active' AND gs.status = 'completed')
          )
        ORDER BY pb.created_at DESC
        LIMIT 1
      `;

      const result = await dbPool.query(query, [userId]);

      logger.info('ACTIVE_BET_SEARCH_DETAILS', {
        userId,
        resultCount: result.rows.length,
        searchQuery: query,
        searchParams: [userId],
        foundBets: result.rows.map(bet => ({
          betId: bet.player_bet_id,
          status: bet.bet_status,
          amount: bet.bet_amount,
          gameType: bet.game_type
        }))
      });

      if (result.rows.length === 0) {
        // Fetch additional context about recent bets
        const recentBetsQuery = `
          SELECT 
            player_bet_id,
            status AS bet_status,
            bet_amount,
            created_at,
            game_session_id
          FROM 
            player_bets
          WHERE 
            user_id = $1
            AND status IN ('active', 'won', 'lost')
          ORDER BY created_at DESC
          LIMIT 5
        `;

        const recentBetsResult = await dbPool.query(recentBetsQuery, [userId]);

        logger.info('RECENT_BETS_CONTEXT', {
          userId,
          recentBets: recentBetsResult.rows.map(bet => ({
            betId: bet.player_bet_id,
            status: bet.bet_status,
            amount: bet.bet_amount
          }))
        });
      }

      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      logger.error('ERROR_FINDING_ACTIVE_BET', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Find all active bets for a specific user
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Active bets or empty array if not found
   */
  static async findActiveBetsByUserId(userId) {
    try {
      const query = `
        SELECT pb.*
        FROM player_bets pb
        JOIN game_sessions gs ON pb.game_session_id = gs.game_session_id
        WHERE 
          pb.user_id = $1 
          AND pb.status = 'active' 
          AND gs.status = 'in_progress'
      `;
      const result = await dbPool.query(query, [userId]);

      logger.info('ACTIVE_BETS_RETRIEVED', {
        userId,
        activeBetCount: result.rows.length
      });

      return result.rows;
    } catch (error) {
      logger.error('ERROR_FINDING_ACTIVE_BETS', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack,
        errorDetails: {
          name: error.name,
          code: error.code
        }
      });
      throw error;
    }
  }

  /**
   * Retrieve a player bet by its ID
   * @param {string} betId - ID of the player bet
   * @returns {Promise<Object|null>} - Player bet details or null if not found
   */
  async getPlayerBetById(betId) {
    if (!betId) {
      logger.warn('GET_PLAYER_BET_NO_ID', {
        message: 'Attempted to retrieve player bet without a bet ID'
      });
      return null;
    }

    try {
      const query = `
        SELECT 
          pb.player_bet_id,
          pb.user_id,
          pb.game_session_id,
          pb.bet_amount,
          pb.status AS bet_status,
          gs.game_type,
          gs.status AS game_status,
          pb.created_at
        FROM 
          player_bets pb
        JOIN 
          game_sessions gs ON pb.game_session_id = gs.game_session_id
        WHERE 
          pb.player_bet_id = $1
      `;

      const result = await this.pool.query(query, [betId]);

      if (result.rows.length === 0) {
        logger.warn('PLAYER_BET_NOT_FOUND', {
          betId,
          message: 'No player bet found with the given ID'
        });
        return null;
      }

      return result.rows[0];
    } catch (error) {
      logger.error('ERROR_RETRIEVING_PLAYER_BET', {
        betId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Retrieve a player bet by its ID (static version)
   * @param {string} betId - ID of the player bet
   * @returns {Promise<Object|null>} - Player bet details or null if not found
   */
  static async getPlayerBetById(betId) {
    if (!betId) {
      logger.warn('GET_PLAYER_BET_NO_ID', {
        message: 'Attempted to retrieve player bet without a bet ID'
      });
      return null;
    }

    try {
      const query = `
        SELECT 
          pb.player_bet_id,
          pb.user_id,
          pb.game_session_id,
          pb.bet_amount,
          pb.status AS bet_status,
          gs.game_type,
          gs.status AS game_status,
          pb.created_at
        FROM 
          player_bets pb
        JOIN 
          game_sessions gs ON pb.game_session_id = gs.game_session_id
        WHERE 
          pb.player_bet_id = $1
      `;

      const result = await dbPool.query(query, [betId]);

      if (result.rows.length === 0) {
        logger.warn('PLAYER_BET_NOT_FOUND', {
          betId,
          message: 'No player bet found with the given ID'
        });
        return null;
      }

      return result.rows[0];
    } catch (error) {
      logger.error('ERROR_RETRIEVING_PLAYER_BET', {
        betId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Retrieve a game session by its ID
   * @param {string} gameSessionId - ID of the game session
   * @returns {Promise<Object|null>} - Game session details or null if not found
   */
  static async getGameSessionById(gameSessionId) {
    try {
      // First, retrieve the columns that exist in the game_sessions table
      const schemaQuery = `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'game_sessions'
      `;
      const schemaResult = await dbPool.query(schemaQuery);
      const columns = schemaResult.rows.map(row => row.column_name);

      // Log the discovered columns for debugging
      logger.info('GAME_SESSIONS_TABLE_COLUMNS', { columns });

      // Dynamically construct the SELECT clause with only existing columns
      const selectColumns = columns
        .filter(col => ['game_session_id', 'game_type', 'status', 'multiplier', 'crash_point'].includes(col))
        .join(', ');

      // Construct the dynamic query
      const query = `
        SELECT ${selectColumns}
        FROM game_sessions 
        WHERE game_session_id = $1
      `;

      // Execute the query
      const result = await dbPool.query(query, [gameSessionId]);

      if (result.rows.length === 0) {
        logger.warn('GAME_SESSION_NOT_FOUND', {
          gameSessionId,
          message: 'No game session found with the given ID'
        });
        return null;
      }

      logger.info('GAME_SESSION_RETRIEVED', {
        gameSessionId,
        status: result.rows[0].status,
        multiplier: result.rows[0].multiplier
      });

      return result.rows[0];
    } catch (error) {
      logger.error('ERROR_RETRIEVING_GAME_SESSION', {
        gameSessionId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Find existing bet for a user in a game session
   * @param {string} userId - User ID
   * @param {string} gameSessionId - Game session ID
   * @returns {Promise<Object|null>} - Existing bet or null if not found
   */
  static async findBetByUserAndGameSession(userId, gameSessionId) {
    try {
      // Validate and normalize UUID
      if (!this.isValidUUID(userId) || !this.isValidUUID(gameSessionId)) {
        throw new Error('Invalid UUID format for userId or gameSessionId');
      }

      const query = `
        SELECT * 
        FROM player_bets 
        WHERE user_id = $1 AND game_session_id = $2
      `;

      const result = await dbPool.query(query, [userId, gameSessionId]);
      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      logger.error('ERROR_FINDING_BET', {
        userId,
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Update a player's bet record
   * @param {Object} betUpdateData - Bet update details
   * @param {string} betUpdateData.playerBetId - Unique bet identifier
   * @param {string} betUpdateData.status - New bet status
   * @param {number} [betUpdateData.cashoutMultiplier] - Cashout multiplier
   * @param {number} [betUpdateData.payoutAmount] - Payout amount
   * @returns {Promise<Object>} Updated bet record
   */
  async updatePlayerBet(betUpdateData) {
    const {
      playerBetId, 
      status, 
      cashoutMultiplier = null, 
      payoutAmount = null
    } = betUpdateData;

    try {
      await this.pool.query('BEGIN');

      // Validate playerBetId
      if (!this.isValidUUID(playerBetId)) {
        throw new Error('Invalid player bet ID');
      }

      // Update player bet record with flexible resolution
      const updateQuery = `
        UPDATE player_bets 
        SET 
          status = $2,
          cashout_multiplier = COALESCE($3, cashout_multiplier),
          payout_amount = COALESCE($4, payout_amount)
        WHERE player_bet_id = $1
        RETURNING *
      `;

      const updateResult = await this.pool.query(updateQuery, [
        playerBetId, 
        status, 
        cashoutMultiplier, 
        payoutAmount
      ]);

      if (updateResult.rows.length === 0) {
        throw new Error(`No bet found with ID: ${playerBetId}`);
      }

      await this.pool.query('COMMIT');

      logger.info('PLAYER_BET_UPDATED', {
        playerBetId,
        status,
        cashoutMultiplier,
        payoutAmount
      });

      return updateResult.rows[0];
    } catch (error) {
      await this.pool.query('ROLLBACK');
      logger.error('Error updating player bet', { 
        error: error.message, 
        playerBetId 
      });
      throw error;
    }
  }

  /**
   * Update a player's bet record statically
   * @param {Object} betUpdateData - Bet update details
   * @param {string} betUpdateData.playerBetId - Unique bet identifier
   * @param {string} betUpdateData.status - New bet status
   * @param {number} [betUpdateData.cashoutMultiplier] - Cashout multiplier
   * @param {number} [betUpdateData.payoutAmount] - Payout amount
   * @returns {Promise<Object>} Updated bet record
   */
  static async updatePlayerBetStatic(betUpdateData) {
    const {
      playerBetId,
      status,
      cashoutMultiplier,
      payoutAmount,
      originalBetAmount,
      userId
    } = betUpdateData;

    if (!playerBetId) {
      logger.warn('UPDATE_PLAYER_BET_NO_ID', {
        message: 'Attempted to update player bet without a bet ID'
      });
      return null;
    }

    try {
      // Validate cashout multiplier based on status
      if (status === 'active' && (!cashoutMultiplier || cashoutMultiplier <= 1)) {
        throw new Error('INVALID_ACTIVE_BET_MULTIPLIER');
      }

      if (status === 'won' && (!cashoutMultiplier || cashoutMultiplier <= 1)) {
        throw new Error('INVALID_WON_BET_MULTIPLIER');
      }

      if (status === 'lost' && cashoutMultiplier !== null) {
        throw new Error('INVALID_LOST_BET_MULTIPLIER');
      }

      const query = `
        UPDATE player_bets
        SET 
          status = $1,
          ${cashoutMultiplier !== undefined ? 'cashout_multiplier = $2,' : ''}
          ${payoutAmount !== undefined ? 'payout_amount = $3,' : ''}
        WHERE 
          player_bet_id = $${cashoutMultiplier !== undefined && payoutAmount !== undefined ? 4 : 2}
        RETURNING *
      `;

      const queryParams = [
        status,
        ...(cashoutMultiplier !== undefined ? [cashoutMultiplier] : []),
        ...(payoutAmount !== undefined ? [payoutAmount] : []),
        playerBetId
      ];

      const result = await dbPool.query(query, queryParams);

      if (result.rows.length === 0) {
        logger.warn('PLAYER_BET_UPDATE_FAILED', {
          playerBetId,
          message: 'No player bet found or updated'
        });
        return null;
      }

      logger.info('PLAYER_BET_UPDATED', {
        playerBetId,
        status,
        cashoutMultiplier,
        payoutAmount
      });

      return result.rows[0];
    } catch (error) {
      logger.error('ERROR_UPDATING_PLAYER_BET', {
        playerBetId,
        status,
        errorName: error.name,
        errorCode: error.code,
        errorMessage: error.message,
        errorDetails: error,
        errorStack: error.stack
      });

      throw error;
    }
  }

  async storeBet(betDetails) {
    const { userId, amount, gameSessionId } = betDetails;

    const client = await this.pool.connect();
    
    try {
      // Start transaction
      await client.query('BEGIN');

      // Validate required fields
      if (!betDetails.userId) {
        throw new Error('User ID is required for bet placement');
      }

      // Get the current active game session
      const sessionQuery = `
        SELECT game_session_id 
        FROM game_sessions 
        WHERE status = 'in_progress' 
        ORDER BY created_at DESC 
        LIMIT 1
      `;
      const sessionResult = await client.query(sessionQuery);

      if (sessionResult.rows.length === 0) {
        throw new Error('No active game session found');
      }

      const gameSessionId = sessionResult.rows[0].game_session_id;

      // Prepare bet data for insertion
      const insertQuery = `
        INSERT INTO player_bets (
          user_id, 
          game_session_id, 
          bet_amount, 
          status,
          cashout_multiplier,
          payout_amount,
          autocashout_multiplier,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP
        ) RETURNING *
      `;

      const values = [
        betDetails.userId,
        gameSessionId,
        betDetails.amount,
        betDetails.status || 'pending',
        betDetails.cashoutMultiplier || null,
        betDetails.payoutAmount || null,
        betDetails.autoCashoutMultiplier || null
      ];

      const result = await client.query(insertQuery, values);

      // Commit transaction
      await client.query('COMMIT');

      // Log successful bet storage
      logger.info('BET_STORED', {
        betId: result.rows[0].bet_id,
        userId: betDetails.userId,
        gameSessionId,
        amount: betDetails.amount,
        status: result.rows[0].status,
        autoCashoutMultiplier: result.rows[0].autocashout_multiplier
      });

      // Return complete bet details
      return result.rows[0];
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

      // Log bet storage error
      logger.error('BET_STORAGE_ERROR', {
        userId: betDetails.userId,
        amount: betDetails.amount,
        errorMessage: error.message
      });

      throw error;
    } finally {
      // Release the client back to the pool
      client.release();
    }
  }

  async updatePlayerBet(playerBetId, updateData) {
    try {
      // Validate required fields
      if (!playerBetId) {
        throw new Error('Player bet ID is required');
      }

      // Build the SET clause dynamically based on provided fields
      const updateFields = [];
      const queryParams = [];
      let paramIndex = 1;

      // Add each field to the update
      if (updateData.status !== undefined) {
        updateFields.push(`status = $${paramIndex++}`);
        queryParams.push(updateData.status);
      }

      if (updateData.cashoutMultiplier !== undefined) {
        updateFields.push(`cashout_multiplier = $${paramIndex++}`);
        queryParams.push(updateData.cashoutMultiplier);
      }

      if (updateData.winAmount !== undefined) {
        updateFields.push(`win_amount = $${paramIndex++}`);
        queryParams.push(updateData.winAmount);
      }

      // If no fields to update, return early
      if (updateFields.length === 0) {
        logger.warn('NO_FIELDS_TO_UPDATE', {
          playerBetId,
          providedFields: Object.keys(updateData)
        });
        return null;
      }

      // Construct the query
      const query = `
        UPDATE player_bets
        SET ${updateFields.join(', ')}
        WHERE player_bet_id = $${paramIndex}
        RETURNING *
      `;

      // Add the playerBetId as the last parameter
      queryParams.push(playerBetId);

      const result = await this.pool.query(query, queryParams);

      if (result.rows.length === 0) {
        logger.warn('PLAYER_BET_UPDATE_FAILED', {
          playerBetId,
          reason: 'Bet not found'
        });
        return null;
      }

      logger.info('PLAYER_BET_UPDATED', {
        playerBetId,
        updatedFields: Object.keys(updateData),
        newStatus: updateData.status
      });

      return result.rows[0];
    } catch (error) {
      logger.error('ERROR_UPDATING_PLAYER_BET', {
        playerBetId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async createPlayerBet(betData) {
    try {
      const {
        userId,
        gameSessionId,
        amount,
        currency = 'USD',
        betType = 'standard',
        status = 'active'
      } = betData;

      // Validate required fields
      if (!userId || !gameSessionId || !amount) {
        throw new Error('User ID, game session ID, and amount are required');
      }

      // Generate a unique bet ID
      const playerBetId = crypto.randomUUID();

      const query = `
        INSERT INTO player_bets (
          player_bet_id,
          user_id,
          game_session_id,
          amount,
          currency,
          bet_type,
          status,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
        RETURNING *
      `;

      const values = [
        playerBetId,
        userId,
        gameSessionId,
        amount,
        currency,
        betType,
        status
      ];

      const result = await this.pool.query(query, values);

      logger.info('PLAYER_BET_CREATED', {
        playerBetId,
        userId,
        gameSessionId,
        amount,
        currency,
        betType,
        status
      });

      return result.rows[0];
    } catch (error) {
      logger.error('ERROR_CREATING_PLAYER_BET', {
        userId: betData?.userId,
        gameSessionId: betData?.gameSessionId,
        amount: betData?.amount,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async endGameSession(gameSessionId, endData = {}) {
    try {
      if (!gameSessionId) {
        throw new Error('Game session ID is required');
      }

      const {
        status = 'completed',
        finalMultiplier = null,
        endedAt = new Date()
      } = endData;

      const query = `
        UPDATE game_sessions
        SET 
          status = $1,
          final_multiplier = $2,
          ended_at = $3
        WHERE game_session_id = $4
        RETURNING *
      `;

      const values = [status, finalMultiplier, endedAt, gameSessionId];

      const result = await this.pool.query(query, values);

      if (result.rows.length === 0) {
        logger.warn('GAME_SESSION_END_FAILED', {
          gameSessionId,
          reason: 'Session not found'
        });
        return null;
      }

      logger.info('GAME_SESSION_ENDED', {
        gameSessionId,
        status,
        finalMultiplier
      });

      return result.rows[0];
    } catch (error) {
      logger.error('ERROR_ENDING_GAME_SESSION', {
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
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
  static async updateGameSessionStatus(gameSessionId, status) {
    try {
      const query = `
        UPDATE game_sessions 
        SET status = $2::game_status
        WHERE game_session_id = $1
        RETURNING game_session_id, game_type, status, created_at
      `;

      const result = await dbPool.query(query, [gameSessionId, status]);

      if (result.rows.length === 0) {
        logger.warn('GAME_SESSION_UPDATE_NOT_FOUND', {
          gameSessionId,
          status
        });
        return null;
      }

      logger.info('GAME_SESSION_STATUS_UPDATED', {
        gameSessionId,
        newStatus: status
      });

      return result.rows[0];
    } catch (error) {
      logger.error('GAME_SESSION_STATUS_UPDATE_ERROR', {
        errorMessage: error.message,
        gameSessionId,
        status
      });
      throw error;
    }
  }

  /**
   * Store a bet in the player_bets table
   * @param {Object} betDetails - Details of the bet to store
   * @returns {Promise<Object>} Stored bet details
   */
  async storeBet(betDetails) {
    const client = await this.pool.connect();
    
    try {
      // Start transaction
      await client.query('BEGIN');

      // Validate required fields
      if (!betDetails.userId) {
        throw new Error('User ID is required for bet placement');
      }

      // Get the current active game session
      const sessionQuery = `
        SELECT game_session_id 
        FROM game_sessions 
        WHERE status = 'in_progress' 
        ORDER BY created_at DESC 
        LIMIT 1
      `;
      const sessionResult = await client.query(sessionQuery);

      if (sessionResult.rows.length === 0) {
        throw new Error('No active game session found');
      }

      const gameSessionId = sessionResult.rows[0].game_session_id;

      // Prepare bet data for insertion
      const insertQuery = `
        INSERT INTO player_bets (
          user_id, 
          game_session_id, 
          bet_amount, 
          status,
          cashout_multiplier,
          payout_amount,
          autocashout_multiplier,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP
        ) RETURNING *
      `;

      const values = [
        betDetails.userId,
        gameSessionId,
        betDetails.amount,
        betDetails.status || 'pending',
        betDetails.cashoutMultiplier || null,
        betDetails.payoutAmount || null,
        betDetails.autoCashoutMultiplier || null
      ];

      const result = await client.query(insertQuery, values);

      // Commit transaction
      await client.query('COMMIT');

      // Log successful bet storage
      logger.info('BET_STORED', {
        betId: result.rows[0].bet_id,
        userId: betDetails.userId,
        gameSessionId,
        amount: betDetails.amount,
        status: result.rows[0].status,
        autoCashoutMultiplier: result.rows[0].autocashout_multiplier
      });

      // Return bet details including auto-generated bet_id
      return {
        betId: result.rows[0].bet_id,
        userId: betDetails.userId,
        amount: result.rows[0].bet_amount,
        status: result.rows[0].status,
        autoCashoutMultiplier: result.rows[0].autocashout_multiplier,
        createdAt: result.rows[0].created_at
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

      // Log bet storage error
      logger.error('BET_STORAGE_ERROR', {
        userId: betDetails.userId,
        amount: betDetails.amount,
        errorMessage: error.message
      });

      throw error;
    } finally {
      // Release the client back to the pool
      client.release();
    }
  }

  /**
   * Update bet status in the player_bets table
   * @param {number} betId - ID of the bet to update
   * @param {string} status - New status for the bet
   * @returns {Promise<Object>} Updated bet details
   */
  async updateBetStatus(betId, status) {
    const client = await this.pool.connect();
    
    try {
      // Start transaction
      await client.query('BEGIN');

      // Update bet status
      const updateQuery = `
        UPDATE player_bets 
        SET status = $1
        WHERE bet_id = $2 
        RETURNING bet_id, status
      `;

      const result = await client.query(updateQuery, [status, betId]);

      // Commit transaction
      await client.query('COMMIT');

      // Log successful bet status update
      logger.info('BET_STATUS_UPDATED', {
        betId,
        newStatus: status
      });

      // Return updated bet details
      return {
        betId: result.rows[0].bet_id,
        status: result.rows[0].status
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

      // Log bet status update error
      logger.error('BET_STATUS_UPDATE_ERROR', {
        betId,
        status,
        errorMessage: error.message
      });

      throw error;
    } finally {
      // Release the client back to the pool
      client.release();
    }
  }

  /**
   * Retrieve bet details by bet ID
   * @param {number} betId - ID of the bet to retrieve
   * @returns {Promise<Object>} Bet details
   */
  async getBetDetails(betId) {
    try {
      const query = `
        SELECT 
          bet_id, 
          user_id, 
          game_session_id, 
          bet_amount, 
          status, 
          autocashout_multiplier,
          created_at
        FROM player_bets
        WHERE bet_id = $1
      `;

      const result = await this.pool.query(query, [betId]);

      if (result.rows.length === 0) {
        return null;
      }

      const betDetails = result.rows[0];
      return {
        betId: betDetails.bet_id,
        userId: betDetails.user_id,
        gameSessionId: betDetails.game_session_id,
        amount: parseFloat(betDetails.bet_amount),
        status: betDetails.status,
        autoCashoutMultiplier: betDetails.autocashout_multiplier ? 
          parseFloat(betDetails.autocashout_multiplier) : null,
        createdAt: betDetails.created_at
      };
    } catch (error) {
      logger.error('BET_DETAILS_RETRIEVAL_ERROR', {
        betId,
        errorMessage: error.message
      });

      throw error;
    }
  }

  async markGameSessionComplete(gameSessionId, crashPoint) {
    // Validate crash point value
    if (typeof crashPoint === 'string') {
      crashPoint = parseFloat(crashPoint);
    }

    if (isNaN(crashPoint) || crashPoint <= 0) {
      const error = new Error('Invalid crash point value');
      logger.error('GAME_SESSION_COMPLETE_ERROR', { 
        service: 'aviator-backend',
        gameSessionId,
        error: error.message,
        crashPoint
      });
      throw error;
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // First check if the game session exists and is in the correct state
      const checkQuery = `
        SELECT status 
        FROM game_sessions 
        WHERE game_session_id = $1
      `;
      
      const checkResult = await client.query(checkQuery, [gameSessionId]);
      
      if (checkResult.rows.length === 0) {
        logger.warn('GAME_SESSION_NOT_FOUND', { 
          service: 'aviator-backend',
          gameSessionId
        });
        throw new Error(`No game session found with ID: ${gameSessionId}`);
      }

      // Update game session status to completed
      const updateQuery = `
        UPDATE game_sessions 
        SET 
          status = 'completed',
          crash_point = $1,
          ended_at = CURRENT_TIMESTAMP
        WHERE 
          game_session_id = $2 AND 
          status != 'completed'
        RETURNING game_session_id, crash_point, status
      `;
      
      const result = await client.query(updateQuery, [crashPoint, gameSessionId]);

      if (result.rows.length === 0) {
        logger.warn('GAME_SESSION_ALREADY_COMPLETED', { 
          service: 'aviator-backend',
          gameSessionId,
          currentStatus: checkResult.rows[0].status
        });
        throw new Error(`Game session ${gameSessionId} is already in ${checkResult.rows[0].status} status`);
      }

      await client.query('COMMIT');
      logger.info('GAME_SESSION_COMPLETE_SUCCESS', { 
        service: 'aviator-backend',
        gameSessionId, 
        crashPoint: result.rows[0].crash_point,
        status: result.rows[0].status
      });
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('GAME_SESSION_COMPLETE_ERROR', { 
        service: 'aviator-backend',
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
   * Fetch the current active game session
   * @param {string} [gameType='aviator'] - Type of game to fetch session for
   * @returns {Promise<string|null>} Active game session ID or null if no active session
   */
  async getCurrentActiveGameSession(gameType = 'aviator') {
    try {
      const query = `
        SELECT game_session_id 
        FROM game_sessions 
        WHERE 
          status = 'in_progress' AND 
          game_type = $1 AND 
          created_at > CURRENT_TIMESTAMP - INTERVAL '15 minutes'
        ORDER BY created_at DESC 
        LIMIT 1
      `;

      const result = await this.pool.query(query, [gameType]);

      if (result.rows.length > 0) {
        const gameSessionId = result.rows[0].game_session_id;

        logger.info('ACTIVE_GAME_SESSION_RETRIEVED', {
          gameSessionId,
          gameType
        });

        return gameSessionId;
      }

      // If no active session, create a new one
      return this.createGameSession({ 
        gameType, 
        status: 'in_progress' 
      });
    } catch (error) {
      logger.error('CURRENT_GAME_SESSION_RETRIEVAL_ERROR', {
        gameType,
        errorMessage: error.message
      });
      
      // Fallback to creating a new session if retrieval fails
      return this.createGameSession({ 
        gameType, 
        status: 'in_progress' 
      });
    }
  }

  /**
   * Update total bet amount for a game session
   * @param {string} gameSessionId - ID of the game session
   * @param {number} betAmount - Amount to add to total bets
   * @returns {Promise<number>} Updated total bet amount
   */
  async updateSessionTotalBetAmount(gameSessionId, betAmount) {
    try {
      const query = `
        UPDATE game_sessions
        SET total_bet_amount = total_bet_amount + $1
        WHERE game_session_id = $2
        RETURNING total_bet_amount
      `;

      const result = await this.pool.query(query, [betAmount, gameSessionId]);

      if (result.rows.length > 0) {
        const totalBetAmount = result.rows[0].total_bet_amount;

        logger.info('SESSION_TOTAL_BET_UPDATED', {
          gameSessionId,
          betAmount,
          totalBetAmount
        });

        return totalBetAmount;
      }

      throw new Error('Game session not found');
    } catch (error) {
      logger.error('SESSION_TOTAL_BET_UPDATE_ERROR', {
        gameSessionId,
        betAmount,
        errorMessage: error.message
      });
      throw error;
    }
  }
}

export default GameRepository;
