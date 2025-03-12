import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import GameRepository from './gameRepository.js';
import RedisService from '../services/redisService.js';
import { WalletRepository } from './walletRepository.js';
import { query } from "../config/db.js";

export default class PlayerBetRepository {
  // Create a bet record in the database
  static async placeBet({
    userId, 
    betAmount, 
    cashoutMultiplier = null, 
    autocashoutMultiplier = null,
    payoutAmount = null,
    betType = 'standard'
  }) {
    // Create an instance and use the instance method
    const repository = new PlayerBetRepository();
    return repository.placeBet(userId, betAmount, autocashoutMultiplier, betType);
  }

  // Prevent any direct database interactions
  static async countActiveBets() {
    logger.info('Active bets count retrieval prevented');
    return 0;
  }

  /**
   * Process a bet cashout
   * @param {Object} options - Cashout options
   * @param {string} options.betId - Bet ID
   * @param {string} options.userId - User ID
   * @param {number} options.currentMultiplier - Cashout multiplier
   * @returns {Promise<Object>} - Cashout result
   */
  static async cashoutBet({ 
    betId, 
    userId, 
    currentMultiplier 
  }) {
    try {
      // Simply pass parameters to database function and let it handle all validation
      const result = await query(
        'SELECT cashout_bet($1, $2, $3) as result',
        [userId, betId, currentMultiplier]
      );

      // Parse the JSON result returned by database function
      const cashoutResult = result.rows[0].result;

      // Log outcome based on database response
      if (cashoutResult.success) {
        logger.info('DATABASE_CASHOUT_SUCCESS', {
          betId,
          userId,
          payoutAmount: cashoutResult.payout_amount,
          timestamp: new Date().toISOString()
        });
      } else {
        logger.warn('DATABASE_CASHOUT_FAILED', {
          betId,
          userId,
          reason: cashoutResult.message,
          timestamp: new Date().toISOString()
        });
      }

      // Fetch updated wallet balance for user after cashout
      const walletResult = await query(
        'SELECT balance FROM wallets WHERE user_id = $1',
        [userId]
      );

      return {
        success: cashoutResult.success,
        message: cashoutResult.message,
        winAmount: cashoutResult.payout_amount,
        newBalance: walletResult.rows[0]?.balance || 0
      };
    } catch (error) {
      logger.error('CASHOUT_DATABASE_ERROR', {
        error: error.message,
        stack: error.stack,
        betId,
        userId,
        timestamp: new Date().toISOString()
      });
      
      throw new Error(`Database cashout error: ${error.message}`);
    }
  }

  static async processDatabaseCashout(bet, currentMultiplier) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const payoutAmount = parseFloat((bet.bet_amount * currentMultiplier).toFixed(2));

      // Update bet with cashout details
      const updateQuery = `
        UPDATE player_bets 
        SET 
          cashout_multiplier = JSON_BUILD_OBJECT('timestamp', NOW(), 'multiplier', $1), 
          payout_amount = $2
        WHERE bet_id = $3
        RETURNING *
      `;
      
      const updateResult = await client.query(updateQuery, [
        currentMultiplier, 
        payoutAmount,
        bet.bet_id
      ]);

      if (updateResult.rows.length === 0) {
        throw new Error('Failed to update bet');
      }

      // Update user's wallet
      const walletUpdate = await WalletRepository.updateBalance(
        client,
        bet.user_id,
        payoutAmount,
        'credit',
        'Game win payout',
        bet.bet_id
      );

      // Remove from active bets in Redis if present
      const gameSessionId = bet.game_session_id;
      if (gameSessionId) {
        try {
          // Simply remove the bet from Redis without re-caching
          await RedisService.del(`active_bets:${gameSessionId}`);
          
          logger.info('CASHOUT_REDIS_CLEANUP', {
            service: 'aviator-backend',
            betId: bet.bet_id,
            userId: bet.user_id,
            gameSessionId,
            timestamp: new Date().toISOString()
          });
        } catch (redisError) {
          // Log but don't fail the transaction if Redis update fails
          logger.warn('REDIS_ACTIVE_BETS_REMOVE_ERROR', {
            service: 'aviator-backend',
            betId: bet.bet_id,
            userId: bet.user_id,
            gameSessionId,
            error: redisError.message
          });
        }
      }

      await client.query('COMMIT');

      logger.info('BET_CASHOUT_SUCCESS', {
        betId: bet.bet_id,
        userId: bet.user_id,
        originalBetAmount: bet.bet_amount,
        cashoutMultiplier: currentMultiplier,
        payoutAmount,
        newWalletBalance: walletUpdate.newBalance,
        timestamp: new Date().toISOString()
      });

      return {
        betId: bet.bet_id,
        winAmount: payoutAmount,
        multiplier: currentMultiplier,
        newBalance: walletUpdate.newBalance
      };

    } catch (error) {
      await client.query('ROLLBACK');
      
      logger.error('BET_CASHOUT_ERROR', {
        betId: bet.bet_id,
        userId: bet.user_id,
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  static async settleBet() {
    logger.info('Direct bet settlement prevented');
    return null;
  }

  static async activateBet(betId, gameSessionId) {
    try {
      const query = `
        UPDATE player_bets 
        SET 
          game_session_id = $2
        WHERE bet_id = $1 
        RETURNING *
      `;
      const values = [betId, gameSessionId];
      const result = await pool.query(query, values);
      
      if (result.rows.length > 0) {
        return result.rows[0].bet_id;
      }

      throw new Error('Bet not found or already activated');
    } catch (error) {
      logger.error('BET_ACTIVATION_ERROR', { 
        betId,
        gameSessionId,
        errorMessage: error.message 
      });
      throw new Error('Failed to activate bet');
    }
  }

  static async findBetById(betId) {
    const query = 'SELECT * FROM player_bets WHERE bet_id = $1';
    const values = [betId];
    const result = await pool.query(query, values);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  static async updateBetStatus(betId, status, payoutAmount = null) {
    const client = await pool.connect();
    try {
      const query = `
        UPDATE player_bets 
        SET 
          status = $1, 
          payout_amount = COALESCE($2, payout_amount)
        WHERE bet_id = $3
        RETURNING user_id, bet_amount, payout_amount
      `;

      const result = await client.query(query, [status, payoutAmount, betId]);
      
      if (result.rows.length === 0) {
        throw new Error(`Bet not found: ${betId}`);
      }

      // Remove from active bets in Redis if present
      const bet = result.rows[0];
      const gameSessionId = await PlayerBetRepository.findBetById(betId).then(bet => bet.game_session_id);
      if (gameSessionId) {
        try {
          // Simply remove the bet from Redis without re-caching
          await RedisService.del(`active_bets:${gameSessionId}`);
        } catch (redisError) {
          // Log but don't fail the transaction if Redis update fails
          logger.warn('REDIS_ACTIVE_BETS_REMOVE_ERROR', {
            service: 'aviator-backend',
            betId,
            userId: bet.user_id,
            gameSessionId,
            error: redisError.message
          });
        }
      }

      return result.rows[0];
    } catch (error) {
      logger.error('Update bet status error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Activate all pending bets for the current in_progress game session
   * @returns {Promise<Array>} - List of activated bets
   */
  static async activatePendingBets() {
    const client = await pool.connect();
    try {
      // Call the database function to activate pending bets
      const result = await client.query('SELECT * FROM activate_pending_bets_with_redis()');
      
      // Cache activated bets in Redis if any exist
      if (result.rows.length > 0) {
        // Assuming the first row contains the game_session_id
        const gameSessionId = result.rows[0].game_session_id;
        
        await RedisService.cacheActiveBets(gameSessionId, result.rows);
        
        logger.info('PENDING_BETS_ACTIVATED_AND_CACHED', {
          service: 'aviator-backend',
          activatedCount: result.rows.length,
          gameSessionId,
          activatedBetIds: result.rows.map(bet => bet.bet_id),
          activatedUserIds: result.rows.map(bet => bet.user_id),
          timestamp: new Date().toISOString()
        });
      } else {
        logger.info('NO_PENDING_BETS_TO_ACTIVATE', {
          service: 'aviator-backend',
          timestamp: new Date().toISOString()
        });
      }
      
      return result.rows;
    } catch (error) {
      logger.error('ACTIVATE_PENDING_BETS_ERROR', {
        service: 'aviator-backend',
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    } finally {
      client.release();
    }
  }

  static async getBetsByUser(userId, limit = 50, offset = 0) {
    const client = await pool.connect();
    try {
      const query = `
        SELECT 
          bet_id, 
          game_session_id, 
          bet_amount, 
          cashout_multiplier, 
          payout_amount, 
          autocashout_multiplier,
          created_at
        FROM player_bets
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `;

      const result = await client.query(query, [userId, limit, offset]);
      return result.rows;
    } catch (error) {
      logger.error('Get user bets error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async getActiveBetsByUser(userId) {
    const client = await pool.connect();
    try {
      const query = `
        SELECT 
          bet_id, 
          game_session_id, 
          bet_amount, 
          autocashout_multiplier,
          created_at
        FROM player_bets
        WHERE 
          user_id = $1 AND 
          status IN ('pending', 'active')
      `;
      
      const result = await client.query(query, [userId]);
      return result.rows;
    } catch (error) {
      logger.error('Get active user bets error:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  static async getActiveBets() {
    try {
      const query = `
        SELECT 
          bet_id, 
          user_id, 
          game_session_id, 
          bet_amount, 
          cashout_multiplier, 
          autocashout_multiplier,
          created_at
        FROM player_bets
        WHERE 
          status = 'active'
      `;
      
      const result = await pool.query(query);
      return result.rows;
    } catch (error) {
      logger.error('GET_ACTIVE_BETS_ERROR', {
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      return [];
    }
  }

  static async getBetDetails(betId, userId) {
    try {
      const query = `
        SELECT 
          bet_id, 
          user_id, 
          game_session_id, 
          bet_amount, 
          cashout_multiplier, 
          autocashout_multiplier,
          created_at
        FROM player_bets
        WHERE 
          bet_id = $1 AND 
          user_id = $2
      `;
      
      const values = [betId, userId];
      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        logger.warn('BET_DETAILS_NOT_FOUND', {
          betId,
          userId,
          timestamp: new Date().toISOString()
        });
        return null;
      }

      return result.rows[0];
    } catch (error) {
      logger.error('GET_BET_DETAILS_ERROR', {
        betId,
        userId,
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      return null;
    }
  }

  static async getActiveBetsForSession(gameSessionId) {
    try {
      // Validate game session ID
      if (!gameSessionId || gameSessionId === 'currentGameSessionId') {
        logger.warn('INVALID_GAME_SESSION_ID', {
          providedSessionId: gameSessionId,
          timestamp: new Date().toISOString()
        });
        
        // Create instance of GameRepository to get current session
        const gameRepository = new GameRepository();
        const currentSessionId = await gameRepository.getCurrentActiveGameSession();
        
        if (!currentSessionId) {
          logger.error('NO_ACTIVE_GAME_SESSION_FOUND', {
            timestamp: new Date().toISOString()
          });
          return [];
        }
        
        gameSessionId = currentSessionId;
      }
      
      // First, check Redis
      const redisBets = await RedisService.retrieveActiveBets(gameSessionId);
      
      if (redisBets.length > 0) {
        return redisBets;
      }
      
      // Fallback to database if Redis is empty
      const query = `
        SELECT 
          bet_id, 
          user_id, 
          bet_amount, 
          autocashout_multiplier,
          created_at
        FROM player_bets
        WHERE 
          game_session_id = $1 AND 
          status = 'active'
      `;
      
      const result = await pool.query(query, [gameSessionId]);
      
      // Cache database results in Redis
      if (result.rows.length > 0) {
        await RedisService.cacheActiveBets(gameSessionId, result.rows);
      }
      
      return result.rows;
    } catch (error) {
      logger.error('ACTIVE_BETS_RETRIEVAL_ERROR', {
        gameSessionId,
        errorMessage: error.message,
        timestamp: new Date().toISOString()
      });
      return [];
    }
  }

  /**
   * Get all active bets for a game session
   * @param {string} gameSessionId - Game session ID
   * @returns {Promise<Array>} - List of active bets
   */
  static async getActiveBetsByGameSession(gameSessionId) {
    try {
      const result = await pool.query(
        `SELECT 
          bet_id, user_id, bet_amount, game_session_id, 
          cashout_multiplier, autocashout_multiplier, 
          payout_amount, bet_type, created_at
        FROM player_bets 
        WHERE game_session_id = $1 AND status = 'active'`,
        [gameSessionId]
      );

      return result.rows;
    } catch (error) {
      logger.error('GET_ACTIVE_BETS_ERROR', {
        service: 'aviator-backend',
        gameSessionId,
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  // Database function handles Redis active bets synchronization
  static async addToActiveBets() {
    // No-op method to prevent errors if called elsewhere
    return;
  }

  /**
   * Place a bet for a user
   * Always creates bets with NULL game_session_id and 'pending' status
   */
  async placeBet(userId, betAmount, autocashoutMultiplier, betType) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // First validate wallet balance
      const walletResult = await client.query(
        'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );

      if (walletResult.rows.length === 0 || walletResult.rows[0].balance < betAmount) {
        throw new Error('Insufficient balance');
      }

      // Deduct bet amount from wallet
      await client.query(
        'UPDATE wallets SET balance = balance - $1 WHERE user_id = $2',
        [betAmount, userId]
      );
      
      // Directly insert with NULL game_session_id
      const query = `
        INSERT INTO player_bets (
          user_id, 
          bet_amount, 
          autocashout_multiplier, 
          bet_type,
          status,
          game_session_id
        ) VALUES ($1, $2, $3, $4, 'pending', NULL)
        RETURNING bet_id
      `;

      const result = await client.query(query, [
        userId, 
        betAmount, 
        autocashoutMultiplier, 
        betType
      ]);
      
      if (!result.rows[0]?.bet_id) {
        throw new Error('Failed to create bet');
      }
      
      await client.query('COMMIT');
      
      logger.info('BET_PLACED_WITHOUT_SESSION', {
        service: 'aviator-backend',
        betId: result.rows[0].bet_id,
        userId,
        betAmount,
        status: 'pending'
      });
      
      return {
        bet_id: result.rows[0].bet_id,
        status: 'pending'
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Process a cashout for a bet
   * @param {Object} options - Cashout options
   * @param {string} options.betId - Bet ID (UUID)
   * @param {string} options.userId - User ID (UUID)
   * @param {number} options.currentMultiplier - Current multiplier value
   * @returns {Promise<Object>} - Result of cashout operation
   */
  async cashoutBet(options) {
    try {
      const { betId, userId, currentMultiplier } = options;

      // Log cashout attempt
      logger.info('CASHOUT_ATTEMPT', {
        betId,
        userId,
        multiplier: currentMultiplier,
        timestamp: new Date().toISOString()
      });

      // Call the database function directly with all required parameters
      const result = await query(
        'SELECT cashout_bet($1, $2, $3) as result',
        [userId, betId, currentMultiplier]
      );

      // Parse the JSON result returned by database function
      const cashoutResult = result.rows[0].result;

      if (!cashoutResult.success) {
        // Log failure with database-provided message
        logger.warn('CASHOUT_FAILED', {
          betId,
          userId,
          reason: cashoutResult.message,
          timestamp: new Date().toISOString()
        });
        
        throw new Error(cashoutResult.message || 'Cashout failed');
      }

      // Log success
      logger.info('CASHOUT_SUCCESS', {
        betId,
        userId,
        payoutAmount: cashoutResult.payout_amount,
        timestamp: new Date().toISOString()
      });

      // Fetch updated wallet balance for user
      const walletResult = await query(
        'SELECT balance FROM wallets WHERE user_id = $1',
        [userId]
      );

      // Return success response with payout and new balance
      return {
        success: true,
        winAmount: cashoutResult.payout_amount,
        newBalance: walletResult.rows[0]?.balance || 0
      };
    } catch (error) {
      // Log database or unexpected errors
      logger.error('CASHOUT_ERROR', {
        error: error.message,
        stack: error.stack,
        options,
        timestamp: new Date().toISOString()
      });
      
      throw new Error(`Failed to process cashout: ${error.message}`);
    }
  }
}
