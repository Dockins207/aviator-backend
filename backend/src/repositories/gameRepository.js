import { pool } from '../config/database.js';
import logger from '../config/logger.js';

class GameRepository {
  static async createGameRecord(userId, gameType, betAmount) {
    try {
      const query = `
        INSERT INTO games (
          user_id, 
          game_type, 
          bet_amount, 
          status
        ) VALUES ($1, $2, $3, 'IN_PROGRESS')
        RETURNING id
      `;

      const result = await pool.query(query, [userId, gameType, betAmount]);
      
      logger.info('Game record created', { 
        userId, 
        gameType, 
        betAmount 
      });

      return result.rows[0].id;
    } catch (error) {
      logger.error('Failed to create game record', { 
        userId, 
        gameType, 
        betAmount,
        errorMessage: error.message 
      });
      throw error;
    }
  }

  static async updateGameOutcome(gameId, status, winAmount) {
    try {
      const query = `
        UPDATE games
        SET 
          status = $2,
          win_amount = $3,
          resolved_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `;

      await pool.query(query, [gameId, status, winAmount]);
      
      logger.info('Game outcome updated', { 
        gameId, 
        status, 
        winAmount 
      });
    } catch (error) {
      logger.error('Failed to update game outcome', { 
        gameId, 
        status, 
        winAmount,
        errorMessage: error.message 
      });
      throw error;
    }
  }

  static async saveGameResult(gameState) {
    try {
      // Validate required fields
      if (!gameState || !gameState.gameId) {
        throw new Error('Invalid game state: gameId is required');
      }

      const query = `
        INSERT INTO game_results (
          game_id,
          status,
          multiplier,
          crash_point,
          start_time
        ) VALUES ($1, $2, $3, $4, $5)
      `;

      // Ensure numeric values are converted to numbers
      const multiplier = Number(gameState.multiplier || 1.00);
      const crashPoint = Number(gameState.crashPoint || 1.00);

      await pool.query(query, [
        gameState.gameId,
        gameState.status || 'unknown',
        multiplier,
        crashPoint,
        gameState.startTime ? new Date(gameState.startTime) : null
      ]);
      
      logger.info('Game result saved successfully', { 
        gameId: gameState.gameId, 
        status: gameState.status, 
        multiplier: multiplier,
        crashPoint: crashPoint
      });
    } catch (error) {
      logger.error('Failed to save game result', { 
        gameId: gameState?.gameId,
        errorMessage: error.message,
        gameState: JSON.stringify(gameState)
      });
      throw error;
    }
  }
}

export default GameRepository;
