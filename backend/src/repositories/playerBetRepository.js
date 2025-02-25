import pool from '../config/database.js';
import logger from '../config/logger.js';
import { v4 as uuidv4 } from 'uuid';
import GameRepository from './gameRepository.js';

export class PlayerBetRepository {
  // Create a bet record in the database
  static async placeBet({
    betId = uuidv4(), 
    userId, 
    amount, 
    gameSessionId, 
    cashoutMultiplier, 
    autocashout = false 
  }) {
    try {
      let validGameSessionId = gameSessionId;

      if (!validGameSessionId) {
        const sessionCheckQuery = 'SELECT game_session_id FROM game_sessions WHERE status = $1';
        const sessionCheckResult = await pool.query(sessionCheckQuery, ['in_progress']);
        
        if (sessionCheckResult.rows.length === 0) {
          const newGameSession = await GameRepository.createGameSession('aviator', 'in_progress');
          validGameSessionId = newGameSession.game_session_id;
        }
      }

      const query = `
        INSERT INTO player_bets (
          player_bet_id, 
          user_id, 
          game_session_id, 
          bet_amount, 
          cashout_multiplier, 
          status,
          autocashout_multiplier
        ) VALUES (
          $1, $2, $3, $4, $5, 
          $6, $7
        ) RETURNING *
      `;

      const values = [
        betId, 
        userId, 
        validGameSessionId, 
        amount, 
        autocashout ? cashoutMultiplier : null,
        autocashout ? 'active' : 'placed', 
        autocashout ? cashoutMultiplier : null
      ];

      const result = await pool.query(query, values);

      logger.info('BET_RECORD_CREATED', {
        betId,
        userId,
        amount,
        gameSessionId: validGameSessionId,
        status: result.rows[0].status,
        autocashout,
        cashoutMultiplier: result.rows[0].cashout_multiplier
      });

      return result.rows[0];
    } catch (error) {
      logger.error('BET_RECORD_CREATION_ERROR', {
        errorMessage: error.message,
        betDetails: {
          betId,
          userId,
          amount,
          gameSessionId,
          cashoutMultiplier,
          autocashout
        },
        errorStack: error.stack
      });
      throw error;
    }
  }

  // Prevent any direct database interactions
  static async countActiveBets() {
    logger.info('Active bets count retrieval prevented');
    return 0;
  }

  static async cashoutBet() {
    logger.info('Direct bet cashout prevented');
    return null;
  }

  static async settleBet() {
    logger.info('Direct bet settlement prevented');
    return null;
  }

  static async activateBet(betId) {
    try {
      // Logic to activate the bet
      const query = `UPDATE player_bets SET status = 'active' WHERE id = $1 RETURNING *`;
      const values = [betId];
      const result = await this.pool.query(query, values);

      if (result.rows.length === 0) {
        throw new Error('Bet not found or already activated');
      }

      return result.rows[0]; // Return the activated bet details
    } catch (error) {
      logger.error('BET_ACTIVATION_ERROR', { errorMessage: error.message, betId });
      throw new Error('Failed to activate bet');
    }
  }

  static async findBetById(betId) {
    const query = 'SELECT * FROM player_bets WHERE player_bet_id = $1';
    const values = [betId];
    const result = await pool.query(query, values);
    return result.rows.length > 0 ? result.rows[0] : null;
  }
}
