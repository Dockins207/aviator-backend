import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import GameRepository from './gameRepository.js';
import RedisService from '../services/redisService.js';
import { WalletRepository } from './walletRepository.js';

export default class PlayerBetRepository {
  // Create a bet record in the database
  static async placeBet({
    userId, 
    betAmount, 
    gameSessionId = null, 
    cashoutMultiplier = null, 
    autocashoutMultiplier = null,
    status = 'pending',
    payoutAmount = null,
    betType = 'standard'
  }) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Validate user wallet balance
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

      // Insert bet record
      const betResult = await client.query(
        `INSERT INTO player_bets 
        (user_id, bet_amount, game_session_id, cashout_multiplier, 
         autocashout_multiplier, status, payout_amount, bet_type) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
        RETURNING bet_id`,
        [
          userId, 
          betAmount, 
          gameSessionId, 
          cashoutMultiplier, 
          autocashoutMultiplier, 
          status, 
          payoutAmount,
          betType
        ]
      );

      const betId = betResult.rows[0].bet_id;

      await client.query('COMMIT');

      return {
        bet_id: betId,
        bet_amount: betAmount,
        status: status
      };

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('BET_PLACEMENT_ERROR', {
        userId,
        betAmount,
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // Prevent any direct database interactions
  static async countActiveBets() {
    logger.info('Active bets count retrieval prevented');
    return 0;
  }

  static async cashoutBet({ betId, userId, currentMultiplier }) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Get bet details with row lock
      const betQuery = `
        SELECT * FROM player_bets 
        WHERE bet_id = $1 AND user_id = $2 AND status = 'active'
        FOR UPDATE
      `;
      const betResult = await client.query(betQuery, [betId, userId]);

      if (betResult.rows.length === 0) {
        throw new Error('Bet not found or not active');
      }

      const bet = betResult.rows[0];
      const payoutAmount = parseFloat((bet.bet_amount * currentMultiplier).toFixed(2));

      // Update bet with cashout details - only multiplier and payout
      const updateQuery = `
        UPDATE player_bets 
        SET 
          cashout_multiplier = $1,
          payout_amount = $2
        WHERE bet_id = $3 AND status = 'active'
        RETURNING *
      `;

      const updateResult = await client.query(updateQuery, [
        currentMultiplier,
        payoutAmount,
        betId
      ]);

      if (updateResult.rows.length === 0) {
        throw new Error('Failed to update bet');
      }

      // Update user's wallet
      const walletUpdate = await WalletRepository.updateBalance(
        client,
        userId,
        payoutAmount,
        'credit',
        'Game win payout',
        betId
      );

      await client.query('COMMIT');

      logger.info('BET_CASHOUT_SUCCESS', {
        betId,
        userId,
        originalBetAmount: bet.bet_amount,
        cashoutMultiplier: currentMultiplier,
        payoutAmount,
        newWalletBalance: walletUpdate.newBalance,
        timestamp: new Date().toISOString()
      });

      return {
        betId,
        winAmount: payoutAmount,
        multiplier: currentMultiplier,
        newBalance: walletUpdate.newBalance
      };

    } catch (error) {
      await client.query('ROLLBACK');
      
      logger.error('BET_CASHOUT_ERROR', {
        betId,
        userId,
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  static async processDatabaseCashout(bet, currentMultiplier) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const payoutAmount = parseFloat((bet.bet_amount * currentMultiplier).toFixed(2));

      // Update bet with cashout details - only multiplier and payout
      const updateQuery = `
        UPDATE player_bets 
        SET 
          cashout_multiplier = $1,
          payout_amount = $2
        WHERE bet_id = $3 AND status = 'active'
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
          status = 'active', 
          game_session_id = $2
        WHERE bet_id = $1 
        RETURNING *
      `;
      const values = [betId, gameSessionId];
      const result = await pool.query(query, values);
      
      if (result.rows.length > 0) {
        // Cache activated bet in Redis
        await RedisService.cacheActiveBets(gameSessionId, [result.rows[0]]);
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

      return result.rows[0];
    } catch (error) {
      logger.error('Update bet status error:', error);
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
          status, 
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
          cashout_multiplier, 
          autocashout_multiplier,
          status,
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
          status,
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
          status,
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

  // Database function handles Redis active bets synchronization
  static async addToActiveBets() {
    // No-op method to prevent errors if called elsewhere
    return;
  }
}
