import express from 'express';
import betService from '../services/betService.js';
import logger from '../config/logger.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = express.Router();

// Middleware to log all bet-related requests
const betRequestLogger = (req, res, next) => {
  logger.info('[BET_REQUEST]', {
    method: req.method,
    path: req.path,
    body: JSON.stringify(req.body),
    timestamp: new Date().toISOString(),
    clientIp: req.ip
  });
  next();
};

// Middleware to log all bet-related request details
const betRequestDetailsLogger = (req, res, next) => {
  console.log('[BET_REQUEST_DETAILS]', {
    method: req.method,
    path: req.path,
    headers: JSON.stringify(req.headers),
    body: JSON.stringify(req.body),
    query: JSON.stringify(req.query),
    contentType: req.get('Content-Type')
  });
  next();
};

router.use(betRequestLogger);
router.use(betRequestDetailsLogger);

// Place a bet - requires authentication
router.post('/place', 
  authMiddleware.authenticateToken, 
  async (req, res) => {
    try {
      const { amount } = req.body;

      // Comprehensive request logging
      console.error('[BET_PLACEMENT_FULL_REQUEST_DETAILS]', {
        body: JSON.stringify(req.body),
        headers: JSON.stringify(req.headers),
        method: req.method,
        contentType: req.get('Content-Type'),
        userId: req.user ? req.user.user_id : 'NO USER ID',
        decodedUser: JSON.stringify(req.user)
      });

      const userId = req.user ? req.user.user_id : null;

      // Comprehensive input validation with detailed logging
      if (amount === undefined || amount === null) {
        console.error('[BET_PLACEMENT_ERROR] Missing bet amount', {
          receivedBody: JSON.stringify(req.body),
          expectedFields: ['amount']
        });
        return res.status(400).json({
          success: false,
          message: 'Bet amount is required',
          details: 'Amount field must be provided'
        });
      }

      // Convert amount to number and validate
      const betAmount = Number(amount);
      if (isNaN(betAmount) || betAmount <= 0) {
        console.error('[BET_PLACEMENT_ERROR] Invalid bet amount', { 
          amount, 
          parsedAmount: betAmount,
          receivedBody: JSON.stringify(req.body)
        });
        return res.status(400).json({
          success: false,
          message: 'Invalid bet amount. Must be a positive number.',
          details: `Received amount: ${amount}`
        });
      }

      // Place bet
      const result = await betService.placeBet({ 
        amount: betAmount, 
        user: req.user ? req.user.user_id : null
      });

      // Log successful bet placement
      console.log('[BET_PLACEMENT_SUCCESS]', {
        betId: result.betId,
        amount: betAmount,
        user: req.user ? req.user.user_id : null,
        gameId: result.gameId
      });

      res.status(200).json(result);
    } catch (error) {
      // Comprehensive error logging
      console.error('[BET_PLACEMENT_CRITICAL_ERROR]', {
        errorMessage: error.message,
        errorStack: error.stack,
        requestBody: JSON.stringify(req.body)
      });

      res.status(500).json({
        success: false,
        message: 'Bet placement failed',
        error: error.message
      });
    }
  }
);

// Cashout a bet - requires authentication
router.post('/cashout', 
  authMiddleware.authenticateToken, 
  async (req, res) => {
    try {
      const { betId } = req.body;

      // Validate bet ID
      if (!betId) {
        console.error('[BET_CASHOUT_ERROR] Missing bet ID', {
          receivedBody: JSON.stringify(req.body),
          expectedFields: ['betId']
        });
        return res.status(400).json({
          success: false,
          message: 'Bet ID is required',
          details: 'Cashout request must include a bet ID'
        });
      }

      // Cashout bet
      const result = await betService.cashoutBet({ betId });

      // Log successful cashout
      console.log('[BET_CASHOUT_SUCCESS]', {
        betId,
        winnings: result.winnings
      });

      res.status(200).json(result);
    } catch (error) {
      // Comprehensive error logging
      console.error('[BET_CASHOUT_CRITICAL_ERROR]', {
        message: error.message,
        stack: error.stack,
        requestBody: JSON.stringify(req.body),
        errorType: error.constructor.name
      });

      res.status(500).json({
        success: false,
        message: error.message || 'Failed to cashout bet',
        details: 'An unexpected error occurred during bet cashout'
      });
    }
  }
);

// Debugging endpoint to view current bets - requires authentication
router.get('/current-bets', 
  authMiddleware.authenticateToken, 
  async (req, res) => {
    try {
      const currentBets = await betService.getCurrentBets();
      
      logger.info('[CURRENT_BETS_RETRIEVED]', {
        betCount: currentBets.length,
        timestamp: new Date().toISOString()
      });

      res.status(200).json({
        success: true,
        bets: currentBets
      });
    } catch (error) {
      logger.error('[CURRENT_BETS_ERROR]', {
        error: error.message,
        stack: error.stack
      });

      res.status(500).json({
        success: false,
        message: 'Failed to retrieve current bets'
      });
    }
  }
);

export default router;
