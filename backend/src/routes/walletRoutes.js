import express from 'express';
import walletService from '../services/walletService.js';
import { paymentService } from '../services/paymentGatewayService.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import logger from '../config/logger.js';
import crypto from 'crypto';

const router = express.Router();

// Function to format balance with currency symbol before the amount
const formatBalance = (balance, currency = 'KSH') => {
  // Ensure balance is a number and format with two decimal places
  const formattedBalance = Number(balance).toFixed(2);
  
  // Return balance with currency symbol before the amount
  return `${currency} ${formattedBalance}`;
};

// Balance retrieval endpoint
router.get('/balance', authMiddleware.authenticateToken, async (req, res) => {
  const traceId = crypto.randomUUID();
  
  try {
    const userId = req.user.user_id;

    if (!userId) {
      logger.error(`[${traceId}] No user ID found in authenticated request`, {
        user: req.user
      });
      return res.status(400).json({
        status: 'error',
        message: 'Unable to retrieve user ID'
      });
    }

    logger.info(`[${traceId}] Balance retrieval request`, {
      userId: userId,
      requestTimestamp: new Date().toISOString()
    });
    
    // Fetch balance from wallets table using service method
    const wallet = await walletService.getWallet(userId);
    
    if (!wallet) {
      // If no wallet exists, create a new one with 0 balance
      const newWallet = await walletService.createWallet(userId);
      
      logger.info(`[${traceId}] New wallet created`, {
        userId: userId,
        initialBalance: 0,
        currency: 'KSH'
      });
      
      return res.json({
        status: 'success',
        wallet: {
          balance: 0,
          formattedBalance: 'KSH 0.00',
          currency: 'KSH',
          userId: userId,
          createdAt: newWallet.createdAt,
          lastUpdated: newWallet.updatedAt
        }
      });
    }
    
    // Format balance with currency symbol before the amount
    const formattedBalance = formatBalance(wallet.balance, wallet.currency);
    
    logger.info(`[${traceId}] Balance retrieved successfully`, {
      userId: userId,
      balance: formattedBalance,
      currency: wallet.currency,
      lastUpdated: wallet.updatedAt
    });
    
    res.json({
      status: 'success',
      wallet: {
        balance: parseFloat(wallet.balance).toFixed(2),
        formattedBalance: formattedBalance,
        currency: wallet.currency || 'KSH',
        userId: userId,
        createdAt: wallet.createdAt,
        lastUpdated: wallet.updatedAt
      }
    });
  } catch (error) {
    logger.error(`[${traceId}] Error fetching wallet balance`, {
      userId: req.user.user_id,
      errorMessage: error.message,
      errorStack: error.stack
    });
    
    res.status(500).json({ 
      status: 'error',
      message: 'Error fetching balance',
      details: error.message,
      traceId: traceId
    });
  }
});

// Deposit endpoint
router.post('/deposit', authMiddleware.authenticateToken, async (req, res) => {
  const traceId = crypto.randomUUID();
  
  try {
    // Log entire request for debugging
    logger.info(`[${traceId}] FULL_DEPOSIT_REQUEST`, {
      headers: req.headers,
      body: req.body,
      user: req.user
    });

    const userId = req.user.user_id;
    const { amount, paymentMethod, currency } = req.body;

    // Validate request body
    if (!req.body || Object.keys(req.body).length === 0) {
      logger.error(`[${traceId}] Empty request body`, {
        requestBody: req.body
      });
      return res.status(400).json({
        status: 'error',
        traceId,
        message: 'Empty request body',
        details: 'No deposit information provided'
      });
    }

    // Validate user ID
    if (!userId) {
      logger.error(`[${traceId}] No user ID found in authenticated request`, {
        user: req.user,
        headers: req.headers
      });
      return res.status(400).json({
        status: 'error',
        traceId,
        message: 'Unable to retrieve user ID',
        details: 'Authentication token is invalid or expired'
      });
    }

    // Validate amount
    if (amount === undefined || amount === null) {
      logger.error(`[${traceId}] Missing deposit amount`, {
        userId,
        requestBody: req.body
      });
      return res.status(400).json({ 
        status: 'error', 
        traceId,
        message: 'Deposit amount is required',
        details: 'No amount specified in the request'
      });
    }

    const depositAmount = parseFloat(amount);
    if (isNaN(depositAmount) || depositAmount <= 0) {
      logger.error(`[${traceId}] Invalid deposit amount`, {
        userId,
        amount,
        parsedAmount: depositAmount
      });
      return res.status(400).json({ 
        status: 'error', 
        traceId,
        message: 'Invalid deposit amount',
        details: 'Amount must be a positive number greater than zero'
      });
    }

    // Optional: Add maximum deposit limit
    const MAX_DEPOSIT_AMOUNT = 100000; // Adjust as needed
    if (depositAmount > MAX_DEPOSIT_AMOUNT) {
      logger.error(`[${traceId}] Deposit amount exceeds limit`, {
        userId,
        amount: depositAmount,
        maxLimit: MAX_DEPOSIT_AMOUNT
      });
      return res.status(400).json({
        status: 'error',
        traceId,
        message: `Deposit amount exceeds maximum limit of ${MAX_DEPOSIT_AMOUNT}`,
        details: `Maximum deposit is ${MAX_DEPOSIT_AMOUNT}`
      });
    }

    // Log detailed deposit attempt
    logger.info(`[${traceId}] Deposit attempt`, {
      userId,
      amount: depositAmount,
      timestamp: new Date().toISOString()
    });

    // Use wallet service to deposit directly
    let depositResult;
    try {
      depositResult = await walletService.deposit(
        userId, 
        depositAmount, 
        `${paymentMethod} Deposit`, 
        paymentMethod, 
        currency
      );
    } catch (depositError) {
      logger.error(`[${traceId}] Wallet deposit service error`, {
        userId,
        amount: depositAmount,
        errorMessage: depositError.message,
        errorStack: depositError.stack
      });
      return res.status(500).json({
        status: 'error',
        traceId,
        message: 'Deposit processing failed',
        details: depositError.message || 'Unable to complete deposit',
        suggestedAction: 'Please contact support'
      });
    }

    // Log successful deposit
    logger.info(`[${traceId}] Deposit successful`, {
      userId,
      amount: depositAmount,
      newBalance: depositResult.newBalance,
      timestamp: new Date().toISOString()
    });

    // Return successful deposit response
    return res.status(200).json({
      status: 'success',
      traceId,
      message: 'Deposit processed successfully',
      data: {
        balance: depositResult.newBalance,
        depositAmount,
        timestamp: new Date().toISOString()
      }
    });
  } catch (unexpectedError) {
    // Catch any unexpected errors
    logger.error(`[${traceId}] Unexpected deposit error`, { 
      errorMessage: unexpectedError.message,
      errorStack: unexpectedError.stack,
      requestBody: JSON.stringify(req.body)
    });

    res.status(500).json({ 
      status: 'error', 
      traceId,
      message: 'Unexpected error during deposit',
      details: unexpectedError.message,
      suggestedAction: 'Please try again or contact support'
    });
  }
});

// Withdrawal endpoint
router.post('/withdraw', authMiddleware.authenticateToken, async (req, res) => {
  const traceId = crypto.randomUUID();
  
  try {
    const userId = req.user.user_id;
    const { amount } = req.body;

    // Validate user ID
    if (!userId) {
      logger.error(`[${traceId}] No user ID found in authenticated request`, {
        user: req.user
      });
      return res.status(400).json({
        status: 'error',
        traceId,
        message: 'Unable to retrieve user ID'
      });
    }

    // Validate withdrawal amount
    const withdrawalAmount = parseFloat(amount);
    if (!withdrawalAmount || withdrawalAmount <= 0) {
      return res.status(400).json({ 
        status: 'error', 
        traceId,
        message: 'Invalid withdrawal amount. Must be a positive number.',
        details: 'Amount must be greater than zero'
      });
    }

    // Optional: Add withdrawal amount limits
    const MIN_WITHDRAWAL_AMOUNT = 100;
    const MAX_WITHDRAWAL_AMOUNT = 50000;
    if (withdrawalAmount < MIN_WITHDRAWAL_AMOUNT || withdrawalAmount > MAX_WITHDRAWAL_AMOUNT) {
      return res.status(400).json({
        status: 'error',
        traceId,
        message: `Withdrawal amount must be between ${MIN_WITHDRAWAL_AMOUNT} and ${MAX_WITHDRAWAL_AMOUNT}`,
        details: `Allowed withdrawal range: ${MIN_WITHDRAWAL_AMOUNT} - ${MAX_WITHDRAWAL_AMOUNT}`
      });
    }

    // Log withdrawal attempt
    logger.info(`[${traceId}] Withdrawal attempt`, {
      userId,
      amount: withdrawalAmount
    });

    // Use wallet service to withdraw directly
    const withdrawalResult = await walletService.withdraw(
      userId, 
      withdrawalAmount, 
      'manual' // Source identifier
    );

    // Return successful withdrawal response
    return res.status(200).json({
      status: 'success',
      traceId,
      message: 'Withdrawal processed successfully',
      data: {
        balance: withdrawalResult.newBalance,
        withdrawalAmount
      }
    });
  } catch (error) {
    // Detailed error logging and response
    logger.error(`[${traceId}] Withdrawal failed`, { 
      userId: req.user.user_id, 
      errorMessage: error.message,
      errorStack: error.stack
    });

    res.status(error.statusCode || 500).json({ 
      status: 'error', 
      traceId,
      message: 'Withdrawal initialization failed',
      details: error.message,
      suggestedAction: 'Please try again or contact support'
    });
  }
});

// Verify M-Pesa Transaction endpoint
router.post('/mpesa/verify', authMiddleware.authenticateToken, async (req, res) => {
  const traceId = crypto.randomUUID();
  
  try {
    const { checkoutRequestId } = req.body;

    if (!checkoutRequestId) {
      return res.status(400).json({
        status: 'error',
        traceId,
        message: 'Checkout Request ID is required'
      });
    }

    // Verify M-Pesa transaction
    const verificationResult = await paymentService.verifyMpesaPayment(checkoutRequestId);

    res.status(200).json({
      status: 'success',
      traceId,
      message: 'M-Pesa transaction verified',
      data: verificationResult
    });
  } catch (error) {
    logger.error(`[${traceId}] M-Pesa transaction verification failed`, { 
      errorMessage: error.message,
      errorStack: error.stack
    });

    res.status(error.statusCode || 500).json({ 
      status: 'error', 
      traceId,
      message: 'M-Pesa transaction verification failed',
      details: error.message
    });
  }
});

// Get transaction history endpoint
router.get('/transactions', authMiddleware.authenticateToken, async (req, res) => {
  const traceId = crypto.randomUUID();
  
  try {
    const userId = req.user.user_id;
    const { 
      limit = 50, 
      offset = 0, 
      type 
    } = req.query;

    // Validate user ID
    if (!userId) {
      logger.error(`[${traceId}] No user ID found in authenticated request`, {
        user: req.user
      });
      return res.status(400).json({
        status: 'error',
        traceId,
        message: 'Unable to retrieve user ID'
      });
    }

    // Fetch transaction history
    const transactions = await walletService.getTransactionHistory(
      userId, 
      parseInt(limit), 
      parseInt(offset), 
      type
    );

    // Successful response
    res.status(200).json({
      status: 'success',
      traceId,
      message: 'Transaction history retrieved',
      data: {
        transactions: transactions.map(transaction => ({
          id: transaction.id,
          amount: transaction.amount,
          type: transaction.type,
          description: transaction.description,
          timestamp: transaction.createdAt,
          currency: transaction.currency || 'KSH'
        })),
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: transactions.length
        }
      }
    });
  } catch (error) {
    // Detailed error logging and response
    logger.error(`[${traceId}] Transaction history retrieval failed`, { 
      userId: req.user.user_id, 
      errorMessage: error.message,
      errorStack: error.stack
    });

    res.status(error.statusCode || 500).json({ 
      status: 'error', 
      traceId,
      message: 'Failed to retrieve transaction history',
      details: error.message,
      suggestedAction: 'Please try again or contact support'
    });
  }
});

export default router;
