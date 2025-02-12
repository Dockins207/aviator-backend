import express from 'express';
import { paymentService } from '../services/paymentGatewayService.js';
import { authMiddleware } from '../middleware/authMiddleware.js';
import logger from '../config/logger.js';

const router = express.Router();

// Initialize M-Pesa payment
router.post('/mpesa/initialize', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, phoneNumber } = req.body;

    // Validate input
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Invalid payment amount' 
      });
    }

    if (!phoneNumber) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Phone number is required' 
      });
    }

    // Initialize M-Pesa payment
    const result = await paymentService.initializeMpesaPayment(
      userId, 
      parseFloat(amount), 
      phoneNumber
    );

    res.status(200).json({
      status: 'success',
      message: 'M-Pesa payment initialized',
      data: {
        transactionId: result.transaction.external_transaction_id,
        amount: result.transaction.amount,
        currency: result.transaction.currency,
        phoneNumber: phoneNumber,
        paymentDetails: result.paymentDetails
      }
    });
  } catch (error) {
    logger.error('M-Pesa payment initialization error', { 
      userId: req.user.id, 
      errorMessage: error.message 
    });
    res.status(500).json({ 
      status: 'error', 
      message: 'M-Pesa payment initialization failed' 
    });
  }
});

// Verify M-Pesa payment status
router.post('/mpesa/verify', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const { checkoutRequestId } = req.body;

    // Validate input
    if (!checkoutRequestId) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Checkout Request ID is required' 
      });
    }

    // Verify M-Pesa payment
    const result = await paymentService.verifyMpesaPayment(checkoutRequestId);

    res.status(200).json({
      status: 'success',
      message: 'M-Pesa payment verification complete',
      data: {
        transactionId: result.transaction.external_transaction_id,
        status: result.transaction.payment_status,
        amount: result.transaction.amount,
        currency: result.transaction.currency,
        verificationDetails: result.verificationDetails
      }
    });
  } catch (error) {
    logger.error('M-Pesa payment verification error', { 
      errorMessage: error.message 
    });
    res.status(500).json({ 
      status: 'error', 
      message: 'M-Pesa payment verification failed' 
    });
  }
});

// Get M-Pesa payment methods
router.get('/methods', authMiddleware.authenticateToken, async (req, res) => {
  try {
    const paymentMethods = [
      {
        method: 'mpesa',
        name: 'M-Pesa',
        description: 'Mobile Money Payment via Safaricom',
        currencies: ['KSH'],
        minimumAmount: 10,
        maximumAmount: 70000
      }
    ];

    res.status(200).json({
      status: 'success',
      data: {
        paymentMethods
      }
    });
  } catch (error) {
    logger.error('Payment methods retrieval error', { 
      userId: req.user.id, 
      errorMessage: error.message 
    });
    res.status(500).json({ 
      status: 'error', 
      message: 'Failed to retrieve payment methods' 
    });
  }
});

export default router;
