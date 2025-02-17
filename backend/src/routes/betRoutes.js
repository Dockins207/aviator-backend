import express from 'express';
import betService from '../services/betService.js';
import logger from '../config/logger.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import GameRepository from '../repositories/gameRepository.js';

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
  logger.info('[BET_REQUEST_DETAILS]', {
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
      const userId = req.user ? req.user.user_id : null;

      // Log received request details
      logger.info('[BET_PLACEMENT_REQUEST]', {
        amount,
        decodedUser: JSON.stringify(req.user)
      });

      // Comprehensive input validation with detailed logging
      if (amount === undefined || amount === null) {
        logger.error('[BET_PLACEMENT_ERROR] Missing bet amount', {
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
        logger.error('[BET_PLACEMENT_ERROR] Invalid bet amount', { 
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
        userId
      });

      // Log successful bet placement
      logger.info('[BET_PLACEMENT_SUCCESS]', {
        betId: result.betId,
        amount: betAmount,
        userId,
        gameId: result.gameSessionId
      });

      res.status(200).json(result);
    } catch (error) {
      // Comprehensive error logging
      logger.error('[BET_PLACEMENT_CRITICAL_ERROR]', {
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
      const userId = req.user.user_id;  // Extract user ID from token
      const { multiplier } = req.body;  // Get multiplier from body

      logger.info('CASHOUT_REQUEST_DETAILS', {
        userId,
        multiplier
      });

      // Find all active bets for the user using static method
      const activeBets = await GameRepository.findActiveBetsByUserId(userId);

      if (!activeBets || activeBets.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No active bets found for cashout',
          details: 'User does not have any active bets to cashout'
        });
      }

      const results = [];

      for (const activeBet of activeBets) {
        // Retrieve the current game session using static method
        const gameSession = await GameRepository.getGameSessionById(activeBet.game_session_id);

        if (!gameSession) {
          return res.status(400).json({
            success: false,
            message: 'Game session not found',
            details: 'Unable to retrieve current game session'
          });
        }

        // Convert multiplier to number and validate
        const currentMultiplier = Number(multiplier);
        if (isNaN(currentMultiplier) || currentMultiplier <= 1) {
          return res.status(400).json({
            success: false,
            message: 'Invalid multiplier',
            details: 'Multiplier must be a number greater than 1'
          });
        }

        // Use the active bet's ID
        const result = await betService.cashoutBet({ 
          betId: activeBet.player_bet_id,
          userId,
          currentMultiplier,
          betAmount: activeBet.bet_amount
        });

        results.push(result);
      }

      res.status(200).json(results);
    } catch (error) {
      // Comprehensive error logging
      logger.error('[BET_CASHOUT_CRITICAL_ERROR]', {
        message: error.message,
        stack: error.stack,
        userId: req.user.user_id,
        errorType: error.constructor.name,
        errorDetails: error
      });

      res.status(500).json({
        success: false,
        message: error.message || 'An unexpected error occurred during cashout',
        details: error.details || {}
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
