import express from 'express';
import gameService from '../services/gameService.js';
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { authMiddleware } from '../middleware/authMiddleware.js';
import logger from '../config/logger.js';

const router = express.Router();

// Middleware to log request details
function logRequestDetails(req, res, next) {
  // Removed console.log for request details
  next();
}

router.use(logRequestDetails);

// Get current game state
router.get('/state', (req, res) => {
  try {
    const currentGameState = gameService.getCurrentGameState();
    
    // Generate a unique state version to prevent hydration
    const stateVersion = crypto.randomBytes(16).toString('hex');
    
    res.status(200).json({
      success: true,
      data: currentGameState,
      timestamp: Date.now(),
      stateVersion: stateVersion,  // Unique identifier for this state
      serverProcessingTime: performance.now(), // Optional: track server processing time
      dataIntegrity: crypto.createHash('sha256').update(JSON.stringify(currentGameState)).digest('hex') // Optional: data integrity check
    });
  } catch (error) {
    logger.error('GAME_STATE_ERROR', {
      message: error.message,
      stack: error.stack,
      timestamp: Date.now()
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Error retrieving game state',
      error: {
        message: error.message,
        code: 'GAME_STATE_RETRIEVAL_ERROR'
      },
      timestamp: Date.now()
    });
  }
});

// Get game history
router.get('/history', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const history = await gameService.getGameHistory();
    res.json({ 
      success: true,
      data: history
    });
  } catch (error) {
    logger.error('GAME_HISTORY_ERROR', {
      error: error.message,
      userId: req.user?.user_id
    });
    
    res.status(500).json({
      success: false,
      message: 'Error retrieving game history',
      error: error.message
    });
  }
});

// Get current game statistics
router.get('/stats', async (req, res) => {
  try {
    const stats = await gameService.getCurrentGameStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('GAME_STATS_ERROR', {
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      message: 'Error retrieving game statistics',
      error: error.message
    });
  }
});

// 404 handler for undefined routes
router.use((req, res) => {
  console.warn(`[GAME_ROUTE] Undefined route accessed: ${req.method} ${req.path}`);
  res.status(404).json({
    success: false,
    message: 'Route not found',
    requestedPath: req.path,
    timestamp: Date.now()
  });
});

export default router;
