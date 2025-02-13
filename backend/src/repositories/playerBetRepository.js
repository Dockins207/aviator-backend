import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import { PlayerBet } from '../models/PlayerBet.js';
import { WalletRepository } from './walletRepository.js';

export class PlayerBetRepository {
  // Place a bet
  static async placeBet(userId, gameSessionId, betAmount) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Withdraw from wallet
      await WalletRepository.withdraw(userId, betAmount, 'Game Bet');

      // Create bet record
      const betQuery = `
        INSERT INTO player_bets (
          user_id, 
          game_session_id, 
          bet_amount, 
          status
        ) VALUES ($1, $2, $3, 'placed') 
        RETURNING *
      `;

      const betResult = await client.query(betQuery, [
        userId, 
        gameSessionId, 
        betAmount
      ]);

      // Commit transaction
      await client.query('COMMIT');

      return PlayerBet.fromRow(betResult.rows[0]);
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Error placing bet', { 
        userId, 
        gameSessionId, 
        betAmount, 
        errorMessage: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // Cashout bet
  static async cashoutBet(betId, cashoutMultiplier) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Get bet details
      const getBetQuery = `
        SELECT * FROM player_bets 
        WHERE id = $1 AND status = 'placed'
        FOR UPDATE
      `;
      const betResult = await client.query(getBetQuery, [betId]);
      
      if (betResult.rows.length === 0) {
        throw new Error('Bet not found or already settled');
      }

      const bet = PlayerBet.fromRow(betResult.rows[0]);
      const payoutAmount = bet.betAmount * cashoutMultiplier;

      // Update bet record
      const updateBetQuery = `
        UPDATE player_bets 
        SET 
          status = 'cashout', 
          cashout_multiplier = $2,
          payout_amount = $3
        WHERE id = $1
        RETURNING *
      `;
      const updatedBetResult = await client.query(updateBetQuery, [
        betId, 
        cashoutMultiplier, 
        payoutAmount
      ]);

      // Deposit payout to wallet
      await WalletRepository.deposit(
        bet.userId, 
        payoutAmount, 
        'Game Cashout'
      );

      // Commit transaction
      await client.query('COMMIT');

      return PlayerBet.fromRow(updatedBetResult.rows[0]);
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Error cashing out bet', { 
        betId, 
        cashoutMultiplier, 
        errorMessage: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // Settle bet (win/lose)
  static async settleBet(betId, status, multiplier = null) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Get bet details
      const getBetQuery = `
        SELECT * FROM player_bets 
        WHERE id = $1 AND status = 'placed'
        FOR UPDATE
      `;
      const betResult = await client.query(getBetQuery, [betId]);
      
      if (betResult.rows.length === 0) {
        throw new Error('Bet not found or already settled');
      }

      const bet = PlayerBet.fromRow(betResult.rows[0]);
      
      // Calculate payout for winning bet
      const payoutAmount = status === 'won' && multiplier 
        ? bet.betAmount * multiplier 
        : 0;

      // Update bet record
      const updateBetQuery = `
        UPDATE player_bets 
        SET 
          status = $2, 
          cashout_multiplier = $3,
          payout_amount = $4
        WHERE id = $1
        RETURNING *
      `;
      const updatedBetResult = await client.query(updateBetQuery, [
        betId, 
        status, 
        multiplier, 
        payoutAmount
      ]);

      // Handle payout for winning bet
      if (status === 'won' && payoutAmount > 0) {
        await WalletRepository.deposit(
          bet.userId, 
          payoutAmount, 
          'Game Win'
        );
      }

      // Commit transaction
      await client.query('COMMIT');

      return PlayerBet.fromRow(updatedBetResult.rows[0]);
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Error settling bet', { 
        betId, 
        status, 
        multiplier, 
        errorMessage: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // Get user's active bets
  static async getUserActiveBets(userId) {
    const query = `
      SELECT * FROM player_bets 
      WHERE 
        user_id = $1 AND 
        status = 'placed'
    `;

    try {
      const result = await pool.query(query, [userId]);
      return result.rows.map(PlayerBet.fromRow);
    } catch (error) {
      logger.error('Error fetching active bets', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    }
  }
}
