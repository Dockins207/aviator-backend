import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import betService from '../services/betService.js';
import logger from '../config/logger.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import GameRepository from '../repositories/gameRepository.js';
import redisRepository from '../redis-services/redisRepository.js';
import gameService from '../services/gameService.js';

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
router.post('/place-bet', 
  authMiddleware.authenticateToken, 
  async (req, res) => {
    try {
      const { amount, autoCashoutAt, autoRequeue } = req.body;

      // Log the authentication context
      logger.debug('[BET_REQUEST_AUTH]', {
        timestamp: new Date().toISOString(),
        hasUser: !!req.user,
        userId: req.user?.user_id,
        username: req.user?.username,
        token: req.token ? req.token.substring(0, 10) + '...' : null
      });

      // Ensure user is authenticated
      if (!req.user || !req.user.user_id) {
        logger.error('[AUTH_VALIDATION_FAILED]', {
          timestamp: new Date().toISOString(),
          hasUser: !!req.user,
          userId: req.user?.user_id
        });
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      // Log the bet details being sent
      logger.debug('[BET_DETAILS]', {
        timestamp: new Date().toISOString(),
        userId: req.user.user_id,
        amount,
        autoCashoutAt,
        autoRequeue
      });

      // Call betService with the request context
      const result = await betService.placeBet({
        amount: Number(amount),
        autoCashoutAt: autoCashoutAt ? Number(autoCashoutAt) : null,
        autoRequeue: !!autoRequeue
      }, req);

      // Log successful bet placement
      logger.info('[BET_PLACEMENT_SUCCESS]', {
        timestamp: new Date().toISOString(),
        betId: result.betId,
        userId: req.user.user_id,
        amount: Number(amount)
      });

      res.json(result);

    } catch (error) {
      // Log bet placement error
      logger.error('[BET_PLACEMENT_ERROR]', {
        timestamp: new Date().toISOString(),
        errorType: error.constructor.name,
        errorMessage: error.message,
        errorStack: error.stack,
        userId: req.user?.user_id,
        requestBody: req.body
      });

      // Send appropriate error response
      res.status(error.status || 500).json({
        success: false,
        message: error.message || 'Failed to place bet',
        code: error.code || 'BET_PLACEMENT_ERROR'
      });
    }
  }
);

// Cashout a bet - requires authentication
router.post('/cashout', 
  authMiddleware.authenticateToken, 
  async (req, res) => {
    try {
      const { multiplier } = req.body;
      
      // Validate multiplier
      if (!multiplier || isNaN(multiplier) || multiplier <= 1) {
        return res.status(400).json({
          success: false,
          message: 'Invalid cashout multiplier'
        });
      }

      // Use the authenticated user's ID
      const userId = req.user?.user_id;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'User not authenticated'
        });
      }

      const result = await betService.processCashout(userId, parseFloat(multiplier), req.socket);
      
      res.status(200).json({
        success: true,
        ...result
      });
    } catch (error) {
      // Log and handle errors
      logger.error('CASHOUT_ERROR', {
        service: 'aviator-backend',
        userId: req.user?.user_id,
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

export default router;
