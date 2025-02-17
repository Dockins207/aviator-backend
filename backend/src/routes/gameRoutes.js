import express from 'express';
import gameService from '../services/gameService.js';
import betService from '../services/betService.js'; // Assuming betService is in the same directory as gameService
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { authMiddleware } from '../middleware/authMiddleware.js';

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
router.get('/history', (req, res) => {
  res.json({ 
    message: 'Game history placeholder',
    history: []
  });
});

// Place a bet
router.post('/place', authMiddleware.authenticateToken, (req, res) => {
  try {
    const { amount } = req.body;
    const user = req.user.id; // Extract user ID from authenticated token

    // Validate input
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid bet amount'
      });
    }

    // Attempt to place bet using bet service
    const result = betService.placeBet({ 
      user, 
      amount 
    });
    
    res.status(200).json(result);
  } catch (error) {
    console.error('[BET_PLACEMENT_ERROR]', error);
    res.status(400).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Activate bet for cashout during flying phase
router.post('/activate-bet', authMiddleware.authenticateToken, (req, res) => {
  try {
    const { betId } = req.body;
    const user = req.user.id; // Extract user ID from authenticated token

    // Validate input
    if (!betId) {
      return res.status(400).json({
        success: false,
        message: 'Bet ID is required'
      });
    }

    // Attempt to activate bet
    const result = betService.activateBetForCashout(betId);
    
    res.status(200).json({
      ...result,
      message: 'Bet activated and ready for cashout'
    });
  } catch (error) {
    console.error('[BET_ACTIVATION_ERROR]', error);
    res.status(400).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// Cash out during game
router.post('/cashout', authMiddleware.authenticateToken, (req, res) => {
  try {
    const { betId } = req.body;
    const user = req.user.id; // Extract user ID from authenticated token

    // Validate input
    if (!betId) {
      return res.status(400).json({
        success: false,
        message: 'Bet ID is required'
      });
    }

    // Attempt to cashout bet
    const result = betService.cashoutBet({ 
      user, 
      betId 
    });
    
    res.status(200).json(result);
  } catch (error) {
    console.error('[CASHOUT_ERROR]', error);
    res.status(400).json({ 
      success: false, 
      message: error.message 
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
