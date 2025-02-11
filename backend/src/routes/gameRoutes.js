import express from 'express';
import gameService from '../services/gameService.js';

const router = express.Router();

// Debugging middleware
router.use((req, res, next) => {
  console.log(`[GAME_ROUTE] Received ${req.method} request to ${req.path}`);
  console.log(`[GAME_ROUTE] Headers:`, req.headers);
  console.log(`[GAME_ROUTE] Query Params:`, req.query);
  next();
});

// Placeholder controller functions
const gameController = {
  getGameHistory: (req, res) => {
    res.json({ 
      message: 'Game history placeholder',
      history: []
    });
  },
  placeBet: (req, res) => {
    res.json({ 
      message: 'Bet placement placeholder',
      betStatus: 'pending'
    });
  },
  cashOut: (req, res) => {
    res.json({ 
      message: 'Cashout placeholder',
      cashoutStatus: 'not implemented'
    });
  }
};

// Get current game state
router.get('/state', (req, res) => {
  try {
    const currentGameState = gameService.getCurrentGameState();
    
    console.log('[GAME_STATE] Returning current game state:', JSON.stringify(currentGameState, null, 2));
    
    res.status(200).json({
      success: true,
      data: currentGameState,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('[GAME_STATE_ERROR] Detailed error:', {
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
router.get('/history', gameController.getGameHistory);

// Place a bet
router.post('/bet', gameController.placeBet);

// Cash out during game
router.post('/cashout', gameController.cashOut);

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
