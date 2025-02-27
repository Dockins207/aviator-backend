import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import GameRepository from './gameRepository.js';

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
    try {
      // Validate bet type
      const validBetTypes = ['manual', 'auto', 'standard'];
      if (!validBetTypes.includes(betType)) {
        throw new Error(`Invalid bet type. Must be one of: ${validBetTypes.join(', ')}`);
      }

      const query = `
        INSERT INTO player_bets (
          user_id, 
          bet_amount,
          game_session_id,
          cashout_multiplier, 
          status,
          payout_amount,
          autocashout_multiplier,
          bet_type
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8
        )
      `;

      const values = [
        userId, 
        betAmount,
        null, // Explicitly set game_session_id to null
        cashoutMultiplier,
        status, 
        payoutAmount,
        autocashoutMultiplier,
        betType
      ];

      await pool.query(query, values);

      logger.info('BET_RECORD_CREATED', {
        userId,
        amount: betAmount,
        status
      });

      return true;
    } catch (error) {
      logger.error('BET_PLACEMENT_ERROR', {
        userId,
        betAmount,
        errorMessage: error.message
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
      const query = `
        UPDATE player_bets 
        SET status = 'active' 
        WHERE bet_id = $1 
        RETURNING bet_id
      `;
      const values = [betId];
      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        throw new Error('Bet not found or already activated');
      }

      return result.rows[0].bet_id;
    } catch (error) {
      logger.error('BET_ACTIVATION_ERROR', { 
        errorMessage: error.message, 
        betId 
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
}
