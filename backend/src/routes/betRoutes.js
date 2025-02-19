import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import betService from '../services/betService.js';
import logger from '../config/logger.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import GameRepository from '../repositories/gameRepository.js';
import redisRepository from '../redis-services/redisRepository.js';
import statsService from '../services/statsService.js';

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
      // Explicitly add decoded user to request object if not already present
      if (!req.user && req.auth) {
        req.user = req.auth;
      }

      const { amount } = req.body;
      const userId = req.user ? req.user.user_id || req.user.userId : null;

      // Log received request details with explicit user object check
      logger.info('[BET_PLACEMENT_REQUEST]', {
        amount,
        decodedUser: JSON.stringify(req.user || {}),
        userId: userId
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
      }, req);  // Pass entire request object

      // Track total bets
      statsService.incrementTotalBetsByAmount(betAmount);

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
        requestBody: JSON.stringify(req.body),
        userObject: JSON.stringify(req.user || {})
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
    const userId = req.user.user_id;
    const rawMultiplier = req.body.multiplier;
    const cashoutMultiplier = parseFloat(rawMultiplier);

    // Log detailed multiplier information
    logger.info('CASHOUT_MULTIPLIER_INCOMING', {
      userId,
      rawMultiplier,
      parsedMultiplier: cashoutMultiplier,
      rawMultiplierType: typeof rawMultiplier,
      parsedMultiplierType: typeof cashoutMultiplier
    });

    // Validate multiplier
    if (isNaN(cashoutMultiplier) || cashoutMultiplier <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid cashout multiplier'
      });
    }

    try {
      // Perform cashout
      const cashoutResult = await betService.cashOut(req, cashoutMultiplier);

      // Return successful cashout response
      res.status(200).json({
        success: true,
        ...cashoutResult
      });

    } catch (error) {
      // Log and handle errors
      logger.error('CASHOUT_PROCESS_CRITICAL_ERROR', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
      });

      // Determine appropriate error response
      const statusCode = error.name === 'ValidationError' ? 400 : 500;
      res.status(statusCode).json({
        success: false,
        message: error.message,
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

export function initializeStatsService(io) {
  // If io is not provided, do nothing
  if (!io) return;

  // Set up stats service
  statsService.setSocketIO(io);

  // Track online users and total bets
  io.on('connection', (socket) => {
    // Add user to online users when they connect
    if (socket.user && socket.user.id) {
      statsService.addOnlineUser(socket.user.id);
    }

    // Remove user from online users when they disconnect
    socket.on('disconnect', () => {
      if (socket.user && socket.user.id) {
        statsService.removeOnlineUser(socket.user.id);
      }
    });
  });
}

export default router;
