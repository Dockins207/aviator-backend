import GameRepository from '../repositories/gameRepository.js';
import logger from '../config/logger.js';

// Function to run every minute to ensure no orphaned sessions
async function cleanupOrphanedSessions() {
  try {
    const gameRepo = new GameRepository();
    const result = await gameRepo.pool.query(`
      UPDATE game_sessions 
      SET 
        status = 'completed', 
        crash_point = 1.00,
        ended_at = CURRENT_TIMESTAMP
      WHERE 
        status IN ('betting', 'in_progress')
        AND created_at < NOW() - INTERVAL '5 minutes'
      RETURNING game_session_id
    `);
    
    if (result.rows.length > 0) {
      logger.warn('ORPHANED_SESSIONS_CLEANED', {
        service: 'aviator-backend',
        sessionCount: result.rows.length,
        sessionIds: result.rows.map(row => row.game_session_id)
      });
    }
  } catch (error) {
    logger.error('SESSION_CLEANUP_JOB_ERROR', {
      service: 'aviator-backend',
      errorMessage: error.message
    });
  }
}

// Set up interval for regular cleanup
setInterval(cleanupOrphanedSessions, 60000); // Run every minute

export default cleanupOrphanedSessions;