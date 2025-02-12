import axios from 'axios';
import logger from '../config/logger.js';
import { pool } from '../config/database.js';

// M-Pesa Payment Gateway for Safaricom
class MpesaPaymentGateway {
  constructor(config) {
    this.config = config;
    this.baseUrl = process.env.MPESA_BASE_URL || 'https://sandbox.safaricom.co.ke/mpesa/';
  }

  // Generate M-Pesa password
  generatePassword() {
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const shortCode = this.config.businessShortCode;
    const passkey = this.config.passkey;
    const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
    return { password, timestamp };
  }

  // Initiate STK Push for payment
  async initiateSTKPush(phoneNumber, amount, accountReference) {
    try {
      const { password, timestamp } = this.generatePassword();

      const response = await axios.post(
        `${this.baseUrl}stkpush/v1/processrequest`,
        {
          BusinessShortCode: this.config.businessShortCode,
          Password: password,
          Timestamp: timestamp,
          TransactionType: 'CustomerPayBillOnline',
          Amount: Math.round(amount),
          PartyA: this.sanitizePhoneNumber(phoneNumber),
          PartyB: this.config.businessShortCode,
          PhoneNumber: this.sanitizePhoneNumber(phoneNumber),
          CallBackURL: this.config.callbackUrl,
          AccountReference: accountReference || 'Payment',
          TransactionDesc: 'Payment for services'
        },
        {
          headers: {
            'Authorization': `Bearer ${await this.getAccessToken()}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        checkoutRequestId: response.data.CheckoutRequestID,
        responseCode: response.data.ResponseCode,
        responseDescription: response.data.ResponseDescription
      };
    } catch (error) {
      logger.error('M-Pesa STK Push Failed', { 
        amount, 
        phoneNumber,
        errorMessage: error.message,
        errorResponse: error.response?.data
      });
      throw new Error('M-Pesa STK Push initialization failed');
    }
  }

  // Query transaction status
  async queryTransactionStatus(checkoutRequestId) {
    try {
      const { password, timestamp } = this.generatePassword();

      const response = await axios.post(
        `${this.baseUrl}stkpushquery/v1/query`,
        {
          BusinessShortCode: this.config.businessShortCode,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: checkoutRequestId
        },
        {
          headers: {
            'Authorization': `Bearer ${await this.getAccessToken()}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        resultCode: response.data.ResultCode,
        resultDesc: response.data.ResultDesc,
        status: this.mapTransactionStatus(response.data.ResultCode)
      };
    } catch (error) {
      logger.error('M-Pesa Transaction Status Query Failed', { 
        checkoutRequestId,
        errorMessage: error.message,
        errorResponse: error.response?.data
      });
      throw new Error('M-Pesa transaction status query failed');
    }
  }

  // Get M-Pesa access token
  async getAccessToken() {
    try {
      const response = await axios.get(
        `${this.baseUrl}oauth/v1/generate`,
        {
          auth: {
            username: this.config.consumerKey,
            password: this.config.consumerSecret
          }
        }
      );
      return response.data.access_token;
    } catch (error) {
      logger.error('M-Pesa Access Token Generation Failed', { 
        errorMessage: error.message,
        errorResponse: error.response?.data
      });
      throw new Error('Failed to generate M-Pesa access token');
    }
  }

  // Sanitize phone number to M-Pesa format
  sanitizePhoneNumber(phoneNumber) {
    // Remove any non-digit characters
    const cleaned = phoneNumber.replace(/\D/g, '');
    
    // If number starts with 0, replace with 254
    if (cleaned.startsWith('0')) {
      return `254${cleaned.slice(1)}`;
    }
    
    // If number already starts with 254, return as is
    if (cleaned.startsWith('254')) {
      return cleaned;
    }
    
    // Default: prepend 254
    return `254${cleaned}`;
  }

  // Map M-Pesa result codes to transaction status
  mapTransactionStatus(resultCode) {
    switch (resultCode) {
      case '0':
        return 'completed';
      case '1032':
        return 'cancelled';
      case '1':
        return 'failed';
      default:
        return 'pending';
    }
  }
}

// Payment Service for M-Pesa
export const paymentService = {
  // Initialize M-Pesa payment
  async initializeMpesaPayment(userId, amount, phoneNumber) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Get M-Pesa configuration
      const mpesaConfig = {
        businessShortCode: process.env.MPESA_BUSINESS_SHORTCODE,
        consumerKey: process.env.MPESA_CONSUMER_KEY,
        consumerSecret: process.env.MPESA_CONSUMER_SECRET,
        passkey: process.env.MPESA_PASSKEY,
        callbackUrl: process.env.MPESA_CALLBACK_URL
      };

      // Create M-Pesa gateway instance
      const mpesaGateway = new MpesaPaymentGateway(mpesaConfig);

      // Generate unique account reference
      const accountReference = `deposit_${userId}_${Date.now()}`;

      // Initiate STK Push
      const paymentResult = await mpesaGateway.initiateSTKPush(
        phoneNumber, 
        amount, 
        accountReference
      );

      // Record payment transaction
      const insertQuery = `
        INSERT INTO wallet_transactions 
        (user_id, wallet_id, amount, currency, transaction_type, 
         payment_method, payment_gateway, external_transaction_id, 
         payment_status, payment_metadata, description, status) 
        VALUES (
          $1, 
          (SELECT id FROM wallets WHERE user_id = $1),
          $2, 
          'KSH', 
          'deposit',
          'mpesa',
          'safaricom',
          $3,
          'pending',
          $4,
          $5,
          'pending'
        ) RETURNING *
      `;
      const transactionResult = await client.query(insertQuery, [
        userId,
        amount,
        paymentResult.checkoutRequestId,
        JSON.stringify(paymentResult),
        `M-Pesa Deposit: ${accountReference}`
      ]);

      // Commit transaction
      await client.query('COMMIT');

      return {
        transaction: transactionResult.rows[0],
        paymentDetails: paymentResult
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      logger.error('M-Pesa Payment Initialization Failed', { 
        userId, 
        amount, 
        errorMessage: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  },

  // Verify M-Pesa payment status
  async verifyMpesaPayment(checkoutRequestId) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Get M-Pesa configuration
      const mpesaConfig = {
        businessShortCode: process.env.MPESA_BUSINESS_SHORTCODE,
        consumerKey: process.env.MPESA_CONSUMER_KEY,
        consumerSecret: process.env.MPESA_CONSUMER_SECRET,
        passkey: process.env.MPESA_PASSKEY,
        callbackUrl: process.env.MPESA_CALLBACK_URL
      };

      // Create M-Pesa gateway instance
      const mpesaGateway = new MpesaPaymentGateway(mpesaConfig);

      // Query transaction status
      const verificationResult = await mpesaGateway.queryTransactionStatus(checkoutRequestId);

      // Retrieve original transaction
      const transactionQuery = `
        SELECT * FROM wallet_transactions 
        WHERE external_transaction_id = $1 AND payment_method = 'mpesa'
      `;
      const transactionResult = await client.query(transactionQuery, [checkoutRequestId]);

      if (transactionResult.rows.length === 0) {
        throw new Error('Transaction not found');
      }

      const transaction = transactionResult.rows[0];

      // Update transaction status
      const updateQuery = `
        UPDATE wallet_transactions 
        SET 
          payment_status = $2, 
          payment_metadata = $3,
          status = CASE 
            WHEN $2 = 'completed' THEN 'completed'
            ELSE 'failed'
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE external_transaction_id = $1
        RETURNING *
      `;
      const updatedTransactionResult = await client.query(updateQuery, [
        checkoutRequestId,
        verificationResult.status,
        JSON.stringify(verificationResult)
      ]);

      // If payment is completed, update wallet balance
      if (verificationResult.status === 'completed') {
        const updateWalletQuery = `
          UPDATE wallets 
          SET 
            balance = balance + $2,
            total_deposited = total_deposited + $2,
            last_transaction_date = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $1
          RETURNING *
        `;
        await client.query(updateWalletQuery, [
          transaction.user_id, 
          transaction.amount
        ]);
      }

      // Commit transaction
      await client.query('COMMIT');

      return {
        transaction: updatedTransactionResult.rows[0],
        verificationDetails: verificationResult
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      logger.error('M-Pesa Payment Verification Failed', { 
        checkoutRequestId,
        errorMessage: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  }
};
