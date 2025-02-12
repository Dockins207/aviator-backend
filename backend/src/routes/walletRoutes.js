import express from 'express';
import { walletService } from '../services/walletService.js';
import { WalletRepository } from '../repositories/walletRepository.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import logger from '../config/logger.js';

const router = express.Router();

// Get user wallet balance
router.get('/balance', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const balance = await WalletRepository.getUserBalance(userId);

    res.status(200).json({
      status: 'success',
      data: {
        balance: parseFloat(balance)
      }
    });
  } catch (error) {
    console.error('Failed to fetch user balance', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve wallet balance'
    });
  }
});

// Deposit funds (authenticated route)
router.post('/deposit', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Invalid deposit amount' 
      });
    }

    const result = await walletService.deposit(
      userId, 
      parseFloat(amount), 
      description || 'Manual Deposit'
    );

    res.status(200).json({
      status: 'success',
      message: 'Deposit successful',
      data: {
        transaction: result.transaction,
        newBalance: result.wallet.balance,
        currency: result.wallet.currency || 'KSH'
      }
    });
  } catch (error) {
    logger.error('Deposit error', { 
      userId: req.user.id, 
      errorMessage: error.message 
    });
    res.status(500).json({ 
      status: 'error', 
      message: 'Deposit failed' 
    });
  }
});

// Withdraw funds (authenticated route)
router.post('/withdraw', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Invalid withdrawal amount' 
      });
    }

    const result = await walletService.withdraw(
      userId, 
      parseFloat(amount), 
      description || 'Manual Withdrawal'
    );

    res.status(200).json({
      status: 'success',
      message: 'Withdrawal successful',
      data: {
        transaction: result.transaction,
        newBalance: result.wallet.balance,
        currency: result.wallet.currency || 'KSH'
      }
    });
  } catch (error) {
    logger.error('Withdrawal error', { 
      userId: req.user.id, 
      errorMessage: error.message 
    });
    res.status(500).json({ 
      status: 'error', 
      message: 'Withdrawal failed' 
    });
  }
});

// Get transaction history (authenticated route)
router.get('/transactions', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 50, offset = 0 } = req.query;

    const transactions = await walletService.getTransactionHistory(
      userId, 
      parseInt(limit), 
      parseInt(offset)
    );

    res.status(200).json({
      status: 'success',
      data: {
        transactions,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    logger.error('Transaction history error', { 
      userId: req.user.id, 
      errorMessage: error.message 
    });
    res.status(500).json({ 
      status: 'error', 
      message: 'Failed to retrieve transaction history' 
    });
  }
});

export default router;
