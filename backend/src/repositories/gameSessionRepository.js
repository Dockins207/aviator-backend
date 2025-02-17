import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import { GameSession } from '../models/GameSession.js';
import { v4 as uuidv4 } from 'uuid';

export default class GameSessionRepository {
  // No-op methods to prevent direct database interactions
  static async createGameSession() {
    logger.info('Game session creation prevented');
    return null;
  }

  static async updateGameSessionStatus() {
    logger.info('Game session status update prevented');
    return null;
  }

  static async getActiveGameSession() {
    logger.info('Active game session retrieval prevented');
    return null;
  }
}
