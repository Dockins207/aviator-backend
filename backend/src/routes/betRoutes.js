import express from 'express';
import betService from '../services/betService.js';
import logger from '../config/logger.js';

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

// Place a bet
router.post('/place', (req, res) => {
  // Comprehensive request logging
  console.error('[BET_PLACEMENT_FULL_REQUEST_DETAILS]', {
    body: JSON.stringify(req.body),
    headers: JSON.stringify(req.headers),
    method: req.method,
    contentType: req.get('Content-Type')
  });

  try {
    const { amount, user } = req.body;

    // Comprehensive input validation with detailed logging
    if (amount === undefined || amount === null) {
      console.error('[BET_PLACEMENT_ERROR] Missing bet amount', {
        receivedBody: JSON.stringify(req.body),
        expectedFields: ['amount', 'user']
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
    const result = betService.placeBet({ 
      amount: betAmount, 
      user: user || 'Anonymous' 
    });

    // Log successful bet placement
    console.log('[BET_PLACEMENT_SUCCESS]', {
      betId: result.betId,
      amount: betAmount,
      user: user || 'Anonymous'
    });

    res.status(200).json(result);
  } catch (error) {
    // Comprehensive error logging
    console.error('[BET_PLACEMENT_CRITICAL_ERROR]', {
      message: error.message,
      stack: error.stack,
      requestBody: JSON.stringify(req.body),
      errorType: error.constructor.name
    });

    res.status(500).json({
      success: false,
      message: error.message || 'Failed to place bet',
      details: 'An unexpected error occurred during bet placement'
    });
  }
});

// Cashout a bet
router.post('/cashout', (req, res) => {
  // Comprehensive request logging
  console.error('[BET_CASHOUT_FULL_REQUEST_DETAILS]', {
    body: JSON.stringify(req.body),
    headers: JSON.stringify(req.headers),
    method: req.method,
    contentType: req.get('Content-Type')
  });

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
    const result = betService.cashoutBet({ betId });

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
});

// Debugging endpoint to view current bets
router.get('/current-bets', (req, res) => {
  try {
    const currentBets = betService.getCurrentBets();
    
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
});

export default router;
