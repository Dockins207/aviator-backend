import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import { GameSession } from '../models/GameSession.js';

export class GameSessionRepository {
  // Create a new game session
  static async createGameSession(gameType) {
    const query = `
      INSERT INTO game_sessions (
        game_type, 
        status, 
        total_bet_amount
      ) VALUES ($1, 'pending', 0.00) 
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [gameType]);
      return result.rows.length > 0 ? GameSession.fromRow(result.rows[0]) : null;
    } catch (error) {
      logger.error('Error creating game session', { 
        gameType, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Update game session status
  static async updateGameSessionStatus(sessionId, status, totalBetAmount = null) {
    const query = `
      UPDATE game_sessions 
      SET 
        status = $2,
        ${totalBetAmount !== null ? 'total_bet_amount = $3,' : ''}
        ended_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;

    try {
      const params = totalBetAmount !== null 
        ? [sessionId, status, totalBetAmount]
        : [sessionId, status];

      const result = await pool.query(query, params);
      return result.rows.length > 0 ? GameSession.fromRow(result.rows[0]) : null;
    } catch (error) {
      logger.error('Error updating game session', { 
        sessionId, 
        status, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Get active game session
  static async getActiveGameSession(gameType) {
    const query = `
      SELECT * FROM game_sessions 
      WHERE 
        game_type = $1 AND 
        status IN ('pending', 'in_progress')
      ORDER BY started_at DESC
      LIMIT 1
    `;

    try {
      const result = await pool.query(query, [gameType]);
      return result.rows.length > 0 ? GameSession.fromRow(result.rows[0]) : null;
    } catch (error) {
      logger.error('Error fetching active game session', { 
        gameType, 
        errorMessage: error.message 
      });
      throw error;
    }
  }
}
