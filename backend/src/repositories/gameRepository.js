import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import { GameSession } from '../models/GameSession.js';
import { PlayerBet } from '../models/PlayerBet.js';
import { WalletRepository } from './walletRepository.js';

class GameRepository {
  // Create a comprehensive game record with bet and session tracking
  static async createGameRecord(userId, gameType, betAmount) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Create game session if not exists
      const sessionQuery = `
        INSERT INTO game_sessions (
          game_type, 
          status, 
          total_bet_amount
        ) VALUES ($1, 'in_progress', $2)
        ON CONFLICT (game_type, status) 
        DO UPDATE SET total_bet_amount = game_sessions.total_bet_amount + $2
        RETURNING id
      `;
      const sessionResult = await client.query(sessionQuery, [gameType, betAmount]);
      const gameSessionId = sessionResult.rows[0].id;

      // Withdraw bet amount from wallet
      await WalletRepository.withdraw(userId, betAmount, `${gameType} Game Bet`);

      // Create player bet
      const betQuery = `
        INSERT INTO player_bets (
          user_id, 
          game_session_id, 
          bet_amount, 
          status
        ) VALUES ($1, $2, $3, 'placed')
        RETURNING id
      `;
      const betResult = await client.query(betQuery, [userId, gameSessionId, betAmount]);
      const playerBetId = betResult.rows[0].id;

      // Commit transaction
      await client.query('COMMIT');
      
      logger.info('Game record created', { 
        userId, 
        gameType, 
        betAmount,
        gameSessionId,
        playerBetId
      });

      return {
        gameSessionId,
        playerBetId
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Failed to create game record', { 
        userId, 
        gameType, 
        betAmount,
        errorMessage: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // Save detailed game result with multiplier and crash point
  static async saveGameResult(gameState) {
    const client = await pool.connect();

    try {
      // Validate required fields
      if (!gameState || !gameState.gameSessionId) {
        throw new Error('Invalid game state: gameSessionId is required');
      }

      // Start transaction
      await client.query('BEGIN');

      // Update game session status
      const sessionQuery = `
        UPDATE game_sessions
        SET 
          status = $2,
          ended_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `;
      const sessionResult = await client.query(sessionQuery, [
        gameState.gameSessionId, 
        gameState.status || 'completed'
      ]);

      // Save game result details
      const resultQuery = `
        INSERT INTO game_results (
          game_session_id,
          status,
          multiplier,
          crash_point,
          start_time
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `;

      // Ensure numeric values are converted to numbers
      const multiplier = Number(gameState.multiplier || 1.00);
      const crashPoint = Number(gameState.crashPoint || 1.00);

      await client.query(resultQuery, [
        gameState.gameSessionId,
        gameState.status || 'unknown',
        multiplier,
        crashPoint,
        gameState.startTime ? new Date(gameState.startTime) : null
      ]);

      // Update player bets based on game result
      const updateBetsQuery = `
        UPDATE player_bets
        SET 
          status = CASE 
            WHEN $2 > 1.00 AND cashout_multiplier IS NULL THEN 
              CASE 
                WHEN $2 <= cashout_multiplier THEN 'won'
                ELSE 'lost'
              END
            ELSE status
          END,
          payout_amount = CASE 
            WHEN status = 'placed' AND $2 > 1.00 THEN bet_amount * $2
            ELSE 0
          END
        WHERE game_session_id = $1
      `;
      await client.query(updateBetsQuery, [
        gameState.gameSessionId, 
        multiplier
      ]);

      // Commit transaction
      await client.query('COMMIT');
      
      logger.info('Game result saved successfully', { 
        gameSessionId: gameState.gameSessionId, 
        status: gameState.status, 
        multiplier: multiplier,
        crashPoint: crashPoint
      });

      return {
        gameSessionId: gameState.gameSessionId,
        multiplier,
        crashPoint
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Failed to save game result', { 
        gameSessionId: gameState?.gameSessionId,
        errorMessage: error.message,
        gameState: JSON.stringify(gameState)
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // Retrieve game history for a user
  static async getUserGameHistory(userId, limit = 10, offset = 0) {
    const query = `
      SELECT 
        gs.id AS game_session_id,
        gs.game_type,
        gs.status,
        gs.total_bet_amount,
        gs.started_at,
        gs.ended_at,
        gr.multiplier,
        gr.crash_point,
        pb.bet_amount,
        pb.status AS bet_status,
        pb.payout_amount
      FROM game_sessions gs
      JOIN player_bets pb ON gs.id = pb.game_session_id
      LEFT JOIN game_results gr ON gs.id = gr.game_session_id
      WHERE pb.user_id = $1
      ORDER BY gs.started_at DESC
      LIMIT $2 OFFSET $3
    `;

    try {
      const result = await pool.query(query, [userId, limit, offset]);
      
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
}

export default GameRepository;
