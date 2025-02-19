import logger from '../config/logger.js';
import pool from '../config/database.js';
import { Wallet } from '../models/Wallet.js';
import WalletSocket from '../sockets/walletSocket.js';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import redisConnection from '../config/redisConfig.js';

export class WalletRepository {
  // Static field to store wallet socket instance
  static walletSocket = null;

  // Set the wallet socket instance
  static setWalletSocket(walletSocket) {
    if (!walletSocket) {
      logger.warn('WALLET_SOCKET_INITIALIZATION_FAILED', {
        message: 'Attempted to set null wallet socket'
      });
      return;
    }
    
    this.walletSocket = walletSocket;
    logger.info('WALLET_SOCKET_INITIALIZED', {
      message: 'Wallet socket successfully set'
    });
  }

  // Get the current wallet socket instance
  static getWalletSocket() {
    return this.walletSocket;
  }

  // Safely emit wallet update
  static safeEmitWalletUpdate(updateData) {
    try {
      if (this.walletSocket && typeof this.walletSocket.emitWalletUpdate === 'function') {
        this.walletSocket.emitWalletUpdate(updateData);
      } else {
        logger.warn('WALLET_SOCKET_EMIT_FAILED', {
          message: 'Cannot emit wallet update: socket not initialized',
          updateData
        });
      }
    } catch (error) {
      logger.error('WALLET_SOCKET_EMIT_ERROR', {
        message: 'Error emitting wallet update',
        error: error.message,
        updateData
      });
    }
  }

  // Ensure walletSocket is initialized
  static initializeWalletSocket(io) {
    if (!this.walletSocket) {
      const WalletSocketClass = require('../sockets/walletSocket.js').default;
      this.walletSocket = new WalletSocketClass(io);
    }
    return this.walletSocket;
  }

  // Add a method to get a client from the pool
  static async getPoolClient() {
    try {
      // Acquire a client from the pool
      const client = await pool.connect();
      return client;
    } catch (error) {
      logger.error('DATABASE_CLIENT_ACQUISITION_FAILED', {
        errorMessage: error.message
      });
      throw new Error('Unable to acquire database client');
    }
  }

  // Create wallet for a new user
  static async createWallet(walletId) {
    const query = `
      INSERT INTO wallets (wallet_id, user_id, currency, balance) 
      VALUES ($1, $2, 'KSH', 0.00) 
      ON CONFLICT (wallet_id) DO NOTHING
      RETURNING *
    `;
    try {
      const result = await pool.query(query, [walletId, walletId]);
      
      // If no rows returned (wallet already exists), fetch existing wallet
      if (result.rows.length === 0) {
        const existingWalletQuery = `
          SELECT * FROM wallets 
          WHERE wallet_id = $1
        `;
        const existingResult = await pool.query(existingWalletQuery, [walletId]);
        
        if (existingResult.rows.length > 0) {
          return Wallet.fromRow(existingResult.rows[0]);
        }
      }
      
      return result.rows.length > 0 ? Wallet.fromRow(result.rows[0]) : null;
    } catch (error) {
      logger.error('Error creating wallet', { 
        walletId, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Get wallet by wallet ID
  static async getWalletByWalletId(walletId) {
    try {
      const query = `
        SELECT wallet_id, user_id, balance, currency, created_at, updated_at
        FROM wallets
        WHERE wallet_id = $1
      `;
      const result = await pool.query(query, [walletId]);

      if (result.rows.length === 0) {
        return null;
      }

      // DIAGNOSTIC: Log full query result for debugging
      logger.error('WALLET_RETRIEVAL_DIAGNOSTIC', {
        walletId,
        queryResult: JSON.stringify(result.rows[0]),
        resultKeys: Object.keys(result.rows[0] || {})
      });

      return {
        walletId: result.rows[0].wallet_id,
        userId: result.rows[0].user_id,
        balance: parseFloat(result.rows[0].balance),
        currency: result.rows[0].currency,
        createdAt: result.rows[0].created_at,
        updatedAt: result.rows[0].updated_at
      };
    } catch (error) {
      // DIAGNOSTIC: Enhanced error logging
      logger.error('WALLET_RETRIEVAL_FAILED', {
        walletId,
        errorMessage: error.message,
        errorName: error.constructor.name,
        errorStack: error.stack
      });
      throw error;
    }
  }

  // Deposit funds
  static async deposit(userId, walletId, depositAmount, description = 'Manual Deposit', paymentMethod = 'manual', currency = 'KSH') {
    const client = await this.getPoolClient();
    try {
      // Start transaction
      await client.query('BEGIN');

      // If walletId is not provided, fetch it
      if (!walletId) {
        const walletIdQuery = `
          SELECT wallet_id 
          FROM wallets 
          WHERE user_id = $1
        `;
        const walletIdResult = await client.query(walletIdQuery, [userId]);

        // If no wallet exists, create one
        if (walletIdResult.rows.length === 0) {
          const createWalletQuery = `
            INSERT INTO wallets (wallet_id, user_id, currency, balance) 
            VALUES ($1, $2, $3, 0.00)
            RETURNING wallet_id
          `;
          const newWalletResult = await client.query(createWalletQuery, [userId, userId, currency]);
          walletId = newWalletResult.rows[0].wallet_id;
        } else {
          walletId = walletIdResult.rows[0].wallet_id;
        }
      }

      // DIAGNOSTIC: Log wallet retrieval details
      logger.error('WALLET_DEPOSIT_DIAGNOSTIC', {
        userId,
        walletId,
        depositAmount,
        description,
        paymentMethod,
        currency
      });

      // Lock the wallet row and verify it belongs to the user
      const walletQuery = `
        SELECT wallet_id, user_id, balance 
        FROM wallets 
        WHERE wallet_id = $1 AND user_id = $2
        FOR UPDATE
      `;
      const walletResult = await client.query(walletQuery, [walletId, userId]);

      // Check if wallet exists and belongs to the user
      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found or does not belong to the user');
      }

      const currentWallet = walletResult.rows[0];
      const currentBalance = parseFloat(currentWallet.balance);

      // Validate deposit amount
      const isDeposit = depositAmount > 0;
      const isWithdrawal = depositAmount < 0;

      if (!isDeposit && !isWithdrawal) {
        throw new Error('Deposit or withdrawal amount must be non-zero');
      }

      const transactionType = isDeposit ? 'deposit' : 'withdrawal';
      const absoluteAmount = Math.abs(depositAmount);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance ${isDeposit ? '+' : '-'} $1, 
            updated_at = NOW() 
        WHERE wallet_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [absoluteAmount, walletId]);
      const newBalance = parseFloat(updateResult.rows[0].balance);

      // Record transaction
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (wallet_id, user_id, transaction_type, amount, description, 
         payment_method, currency, status) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')
        RETURNING transaction_id
      `;
      const transactionResult = await client.query(transactionQuery, [
        walletId, 
        userId, 
        transactionType, 
        absoluteAmount, 
        description, 
        paymentMethod,
        currency
      ]);

      // Commit transaction
      await client.query('COMMIT');

      // Emit wallet update event
      this.safeEmitWalletUpdate({
        userId,
        walletId,
        balance: newBalance,
        transactionType: transactionType,
        amount: absoluteAmount,
        transactionId: transactionResult.rows[0].transaction_id
      });

      // Log transaction
      logger.info('WALLET_DEPOSIT_COMPLETED', {
        userId,
        walletId,
        depositAmount,
        currentBalance,
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id,
        description,
        paymentMethod,
        currency
      });

      return {
        userId,
        walletId,
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id
      };
    } catch (error) {
      // Rollback transaction
      await client.query('ROLLBACK');
      
      // Enhanced error logging
      logger.error('WALLET_DEPOSIT_FAILED', { 
        userId, 
        walletId, 
        depositAmount, 
        errorMessage: error.message,
        errorStack: error.stack
      });

      throw error;
    } finally {
      // Release the client back to the pool
      client.release();
    }
  }

  // Withdraw funds
  static async withdraw(walletId, withdrawAmount, description = 'Manual Withdrawal') {
    const client = await this.getPoolClient();

    try {
      // Begin transaction
      await client.query('BEGIN');

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance - $1, 
            updated_at = NOW() 
        WHERE wallet_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [withdrawAmount, walletId]);
      const newBalance = updateResult.rows[0].balance;

      // Commit transaction
      await client.query('COMMIT');

      // Log transaction
      logger.info('WALLET_WITHDRAWAL_COMPLETED', {
        walletId,
        withdrawAmount,
        newBalance
      });

      return {
        success: true,
        newBalance: parseFloat(newBalance)
      };

    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

      logger.error('WALLET_WITHDRAWAL_FAILED', {
        walletId,
        withdrawAmount,
        errorMessage: error.message
      });

      throw error;
    } finally {
      // Release client back to pool
      client.release();
    }
  }

  // Place a bet and update wallet
  static async placeBet(walletId, betAmount, gameId) {
    const client = await pool.connect();
    const traceId = uuidv4();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Validate and convert amount
      const betAmountFloat = parseFloat(betAmount);
      if (isNaN(betAmountFloat) || betAmountFloat <= 0) {
        throw new Error('INVALID_BET_AMOUNT');
      }

      // Detailed logging of bet placement attempt
      logger.info(`[${traceId}] WALLET_BET_PLACEMENT_ATTEMPT`, {
        walletId,
        betAmount: betAmountFloat,
        timestamp: new Date().toISOString()
      });

      // Check current balance with explicit locking
      const balanceQuery = `
        SELECT balance 
        FROM wallets 
        WHERE wallet_id = $1 
        FOR UPDATE SKIP LOCKED
      `;
      const balanceResult = await client.query(balanceQuery, [walletId]);

      // Detailed logging of balance check
      if (balanceResult.rows.length === 0) {
        throw new Error('USER_WALLET_NOT_FOUND');
      }

      const currentBalance = parseFloat(balanceResult.rows[0].balance);

      logger.info(`[${traceId}] WALLET_BALANCE_CHECK`, {
        walletId,
        currentBalance,
        betAmount: betAmountFloat,
        timestamp: new Date().toISOString()
      });

      // Validate sufficient balance
      if (currentBalance < betAmountFloat) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      // Generate unique transaction ID
      const transactionId = uuidv4();

      // Insert transaction record with comprehensive details
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (wallet_id, user_id, transaction_type, amount, description, transaction_id, status) 
        VALUES ($1, $2, 'bet', $3, $4, $5, 'completed')
        RETURNING *
      `;
      const transactionResult = await client.query(transactionQuery, [
        walletId, 
        await this.getUserIdFromWalletId(walletId), 
        betAmountFloat, 
        'Game Bet', 
        transactionId
      ]);

      // Update wallet balance with detailed logging
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance - $1, 
            updated_at = NOW() 
        WHERE wallet_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [betAmountFloat, walletId]);
      const newBalance = updateResult.rows[0].balance;

      // Detailed logging of balance update
      logger.info(`[${traceId}] WALLET_BALANCE_UPDATED`, {
        walletId,
        oldBalance: currentBalance,
        betAmount: betAmountFloat,
        newBalance,
        transactionId,
        timestamp: new Date().toISOString()
      });

      // Commit transaction
      await client.query('COMMIT');

      // Broadcast wallet update if socket is initialized
      this.safeEmitWalletUpdate({
        userId: await this.getUserIdFromWalletId(walletId),
        walletId,
        balance: newBalance,
        transactionType: 'bet',
        amount: betAmountFloat,
        transactionId: transactionId,
        gameId: gameId,
        traceId: traceId
      });

      return {
        success: true,
        amount: betAmountFloat,
        newBalance: newBalance,
        transactionId: transactionId,
        traceId: traceId
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      // Comprehensive error logging
      logger.error(`[${traceId}] WALLET_BET_PLACEMENT_FAILED`, { 
        walletId, 
        amount: betAmount, 
        errorType: error.constructor.name,
        errorMessage: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  // Process game winnings
  static async processWinnings(walletId, winAmount) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Validate and convert amount
      const winAmountFloat = parseFloat(winAmount);
      if (isNaN(winAmountFloat) || winAmountFloat < 0) {
        throw new Error('Invalid win amount');
      }

      // Generate unique transaction ID
      const transactionId = uuidv4();

      // Insert transaction record
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (wallet_id, user_id, transaction_type, amount, description, transaction_id, status) 
        VALUES ($1, $2, 'win', $3, $4, $5, 'completed')
        RETURNING *
      `;
      await client.query(transactionQuery, [
        walletId, 
        await this.getUserIdFromWalletId(walletId), 
        winAmountFloat, 
        'Game Winnings', 
        transactionId
      ]);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance + $1, 
            updated_at = NOW() 
        WHERE wallet_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [winAmountFloat, walletId]);
      const newBalance = updateResult.rows[0].balance;

      // Commit transaction
      await client.query('COMMIT');

      // Broadcast wallet update if socket is initialized
      this.safeEmitWalletUpdate({
        userId: await this.getUserIdFromWalletId(walletId),
        walletId,
        balance: newBalance,
        transactionType: 'win',
        amount: winAmountFloat,
        transactionId: transactionId
      });

      return newBalance;
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Winnings processing failed', { 
        walletId, 
        amount: winAmount, 
        errorMessage: error.message 
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  // Get transaction history
  static async getTransactionHistory(walletId, limit = 50, offset = 0) {
    const query = `
      SELECT * FROM wallet_transactions 
      WHERE wallet_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2 OFFSET $3
    `;
    try {
      const result = await pool.query(query, [walletId, limit, offset]);
      return result.rows.map(row => ({ ...row, currency: 'KSH' }));
    } catch (error) {
      logger.error('Error fetching transaction history', { 
        walletId, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Add balance to a user's wallet
  static async addBalance(walletId, amount) {
    try {
      const query = `
        INSERT INTO wallets (wallet_id, balance, total_deposited, currency)
        VALUES ($1, $2, $2, 'KSH')
        ON CONFLICT (wallet_id) DO UPDATE 
        SET 
          balance = wallets.balance + $2,
          total_deposited = wallets.total_deposited + $2,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *;
      `;
      
      const result = await pool.query(query, [walletId, amount]);

      // Broadcast wallet update if socket is initialized
      this.safeEmitWalletUpdate({
        userId: await this.getUserIdFromWalletId(walletId),
        walletId,
        balance: result.rows[0].balance,
        transactionType: 'add_balance',
        amount: amount
      });

      return result.rows[0];
    } catch (error) {
      console.error('Error adding wallet balance:', error);
      throw error;
    }
  }

  // Add this method to synchronize user balance with wallet
  static async syncUserBalanceWithWallet(walletId) {
    try {
      const query = `
        UPDATE users u
        SET 
          balance = w.balance,
          total_deposited = w.total_deposited,
          currency = w.currency,
          updated_at = CURRENT_TIMESTAMP
        FROM wallets w
        WHERE u.id = w.wallet_id AND u.id = $1
        RETURNING u.*;
      `;
      
      const result = await pool.query(query, [walletId]);

      // Broadcast wallet update if socket is initialized
      this.safeEmitWalletUpdate({
        userId: await this.getUserIdFromWalletId(walletId),
        walletId,
        balance: result.rows[0].balance,
        transactionType: 'sync_balance',
        reason: 'Sync user balance with wallet'
      });

      return result.rows[0];
    } catch (error) {
      console.error('Error syncing user balance with wallet:', error);
      throw error;
    }
  }

  // Add a method to sync all user balances
  static async syncAllUserBalancesWithWallets() {
    try {
      const query = `
        UPDATE users u
        SET 
          balance = w.balance,
          total_deposited = w.total_deposited,
          currency = w.currency,
          updated_at = CURRENT_TIMESTAMP
        FROM wallets w
        WHERE u.id = w.wallet_id
        RETURNING u.*;
      `;
      
      const result = await pool.query(query);

      // Broadcast wallet update for all users if socket is initialized
      for (const user of result.rows) {
        this.safeEmitWalletUpdate({
          userId: user.id,
          walletId: user.wallet_id,
          balance: user.balance,
          transactionType: 'sync_balance',
          reason: 'Sync all user balances with wallets'
        });
      }

      return result.rows;
    } catch (error) {
      console.error('Error syncing all user balances with wallets:', error);
      throw error;
    }
  }

  // Get user balance
  static async getUserBalance(walletId) {
    try {
      const balanceQuery = `
        SELECT balance 
        FROM wallets 
        WHERE wallet_id = $1
      `;
      const balanceResult = await pool.query(balanceQuery, [walletId]);
      
      if (balanceResult.rows.length === 0) {
        logger.warn('USER_WALLET_NOT_FOUND', { walletId });
        return 0;
      }

      return parseFloat(balanceResult.rows[0].balance);
    } catch (error) {
      logger.error('GET_USER_BALANCE_ERROR', {
        walletId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  // Deduct balance from user's wallet
  static async deductBalance(walletId, amount) {
    const query = `
      UPDATE wallets 
      SET balance = balance - $2, 
          updated_at = NOW() 
      WHERE wallet_id = $1 
      AND balance >= $2 
      RETURNING *
    `;
    try {
      const result = await pool.query(query, [walletId, amount]);
      
      if (result.rows.length === 0) {
        throw new Error('Insufficient balance or user wallet not found');
      }
      
      logger.info('Wallet balance deducted', { 
        walletId, 
        amount,
        newBalance: result.rows[0].balance 
      });

      // Broadcast wallet update if socket is initialized
      this.safeEmitWalletUpdate({
        userId: await this.getUserIdFromWalletId(walletId),
        walletId,
        balance: result.rows[0].balance,
        transactionType: 'deduct_balance',
        amount: amount
      });

      return Wallet.fromRow(result.rows[0]);
    } catch (error) {
      logger.error('Error deducting wallet balance', { 
        walletId, 
        amount, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Credit balance to user's wallet
  static async creditBalance(walletId, amount) {
    const query = `
      UPDATE wallets 
      SET balance = balance + $2, 
          updated_at = NOW() 
      WHERE wallet_id = $1 
      RETURNING *
    `;
    try {
      const result = await pool.query(query, [walletId, amount]);
      
      if (result.rows.length === 0) {
        throw new Error('User wallet not found');
      }
      
      logger.info('Wallet balance credited', { 
        walletId, 
        amount,
        newBalance: result.rows[0].balance 
      });

      // Broadcast wallet update if socket is initialized
      this.safeEmitWalletUpdate({
        userId: await this.getUserIdFromWalletId(walletId),
        walletId,
        balance: result.rows[0].balance,
        transactionType: 'credit_balance',
        amount: amount
      });

      return Wallet.fromRow(result.rows[0]);
    } catch (error) {
      logger.error('Error crediting wallet balance', { 
        walletId, 
        amount, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Get all user wallets
  static async getAllUserWallets() {
    const query = `
      SELECT 
        wallet_id AS id, 
        user_id AS userId, 
        balance, 
        currency 
      FROM wallets
    `;
    try {
      const result = await pool.query(query);
      
      return result.rows.map(row => ({
        id: row.id,
        userId: row.userId,
        balance: parseFloat(row.balance),
        currency: row.currency
      }));
    } catch (error) {
      logger.error('Error fetching all user wallets', { 
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  // Comprehensive diagnostic method for wallet credit
  static async diagnosticWalletCredit(
    walletId, 
    amount, 
    description = 'Game Win',
    metadata = {}
  ) {
    const diagnosticLog = {
      timestamp: new Date().toISOString(),
      walletId,
      amount,
      description,
      metadata,
      steps: []
    };

    const client = await this.getPoolClient();

    try {
      // Step 1: Validate input
      diagnosticLog.steps.push({
        step: 'input_validation',
        status: 'started',
        details: {
          walletId: !!walletId,
          amount: typeof amount === 'number' && amount > 0
        }
      });

      if (!walletId) {
        throw new Error('Invalid Wallet ID');
      }

      const creditAmount = parseFloat(amount);
      if (isNaN(creditAmount) || creditAmount <= 0) {
        throw new Error('Invalid credit amount');
      }

      diagnosticLog.steps[0].status = 'completed';

      // Step 2: Begin transaction
      diagnosticLog.steps.push({
        step: 'transaction_start',
        status: 'started'
      });
      await client.query('BEGIN');
      diagnosticLog.steps[1].status = 'completed';

      // Step 3: Verify wallet existence
      diagnosticLog.steps.push({
        step: 'wallet_verification',
        status: 'started'
      });
      const walletQuery = `
        SELECT wallet_id, user_id, balance 
        FROM wallets 
        WHERE wallet_id = $1 
        FOR UPDATE
      `;
      const walletResult = await client.query(walletQuery, [walletId]);

      if (walletResult.rowCount === 0) {
        throw new Error('Wallet not found');
      }

      const wallet = walletResult.rows[0];
      diagnosticLog.steps[2].status = 'completed';
      diagnosticLog.steps[2].walletDetails = {
        userId: wallet.user_id,
        currentBalance: parseFloat(wallet.balance)
      };

      // Step 4: Calculate new balance
      diagnosticLog.steps.push({
        step: 'balance_calculation',
        status: 'started',
        details: {
          currentBalance: parseFloat(wallet.balance),
          creditAmount
        }
      });
      const newBalance = Math.max(0, parseFloat(wallet.balance) + creditAmount);
      diagnosticLog.steps[3].status = 'completed';
      diagnosticLog.steps[3].details.newBalance = newBalance;

      // Step 5: Update wallet balance
      diagnosticLog.steps.push({
        step: 'balance_update',
        status: 'started'
      });
      const updateQuery = `
        UPDATE wallets 
        SET balance = $2, 
            updated_at = CURRENT_TIMESTAMP 
        WHERE wallet_id = $1
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [walletId, Math.max(0, newBalance)]);
      diagnosticLog.steps[4].status = 'completed';
      diagnosticLog.steps[4].details = {
        updatedBalance: parseFloat(updateResult.rows[0].balance)
      };

      // Step 6: Record transaction
      diagnosticLog.steps.push({
        step: 'transaction_record',
        status: 'started'
      });
      const transactionQuery = `
        INSERT INTO wallet_transactions (
          wallet_id, 
          user_id,
          transaction_type, 
          amount, 
          description
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING transaction_id
      `;
      const transactionResult = await client.query(transactionQuery, [
        walletId,
        wallet.user_id,
        'credit',
        creditAmount,
        metadata.reason || 'Transaction'
      ]);
      diagnosticLog.steps[5].status = 'completed';
      diagnosticLog.steps[5].details = {
        transactionId: transactionResult.rows[0].transaction_id
      };

      // Step 7: Commit transaction
      diagnosticLog.steps.push({
        step: 'transaction_commit',
        status: 'started'
      });
      await client.query('COMMIT');
      diagnosticLog.steps[6].status = 'completed';

      // Log the entire diagnostic information
      logger.info('WALLET_CREDIT_DIAGNOSTIC_SUCCESS', diagnosticLog);

      return {
        success: true,
        walletId,
        userId: wallet.user_id,
        amount: creditAmount,
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id,
        diagnosticLog
      };
    } catch (error) {
      // Rollback transaction on error
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        diagnosticLog.rollbackError = rollbackError.message;
      }

      // Add error details to diagnostic log
      diagnosticLog.error = {
        message: error.message,
        stack: error.stack
      };

      // Log the entire diagnostic information
      logger.error('WALLET_CREDIT_DIAGNOSTIC_FAILURE', diagnosticLog);

      throw error;
    } finally {
      // Release client back to pool
      client.release();
    }
  }

  // Override the existing creditBalanceStatic to use diagnostic method
  static async creditBalanceStatic(
    walletId, 
    amount, 
    description = 'Game Win',
    metadata = {}
  ) {
    try {
      return await this.diagnosticWalletCredit(
        walletId, 
        amount, 
        description, 
        metadata
      );
    } catch (error) {
      logger.error('WALLET_CREDIT_FALLBACK_ERROR', {
        walletId,
        amount,
        description,
        errorMessage: error.message
      });
      throw error;
    }
  }

  // Credit balance with transaction management similar to placeBet
  static async creditBalanceStatic(
    walletId, 
    amount, 
    description = 'Game Win',
    gameId = null,
    metadata = {}
  ) {
    const client = await pool.connect();
    const traceId = uuidv4();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Validate and convert amount
      const creditAmount = parseFloat(amount);
      if (isNaN(creditAmount) || creditAmount <= 0) {
        throw new Error('INVALID_CREDIT_AMOUNT');
      }

      // Detailed logging of credit attempt
      logger.info(`[${traceId}] WALLET_CREDIT_ATTEMPT`, {
        walletId,
        amount: creditAmount,
        description,
        gameId,
        timestamp: new Date().toISOString(),
        metadata: JSON.stringify(metadata)
      });

      // Check wallet existence with explicit locking
      const walletQuery = `
        SELECT wallet_id, user_id, balance 
        FROM wallets 
        WHERE wallet_id = $1 
        FOR UPDATE SKIP LOCKED
      `;
      const walletResult = await client.query(walletQuery, [walletId]);

      // Validate wallet exists
      if (walletResult.rowCount === 0) {
        throw new Error('USER_WALLET_NOT_FOUND');
      }

      const wallet = walletResult.rows[0];
      const currentBalance = parseFloat(wallet.balance);
      const userId = wallet.user_id;

      // Log balance before credit
      logger.info(`[${traceId}] WALLET_BALANCE_BEFORE_CREDIT`, {
        walletId,
        userId,
        currentBalance,
        creditAmount,
        timestamp: new Date().toISOString()
      });

      // Generate unique transaction ID
      const transactionId = uuidv4();

      // Insert transaction record with comprehensive details
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (wallet_id, user_id, transaction_type, amount, description, transaction_id, status, game_id) 
        VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7)
        RETURNING *
      `;
      const transactionResult = await client.query(transactionQuery, [
        walletId, 
        userId, 
        'credit', 
        creditAmount, 
        description, 
        transactionId,
        gameId
      ]);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance + $1, 
            updated_at = NOW() 
        WHERE wallet_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [creditAmount, walletId]);
      const newBalance = updateResult.rows[0].balance;

      // Detailed logging of balance update
      logger.info(`[${traceId}] WALLET_BALANCE_UPDATED`, {
        walletId,
        userId,
        oldBalance: currentBalance,
        creditAmount,
        newBalance,
        transactionId,
        gameId,
        timestamp: new Date().toISOString()
      });

      // Commit transaction
      await client.query('COMMIT');

      // Broadcast wallet update if socket is initialized
      this.safeEmitWalletUpdate({
        userId,
        walletId,
        balance: newBalance,
        transactionType: 'credit',
        amount: creditAmount,
        transactionId: transactionId,
        gameId: gameId,
        traceId: traceId
      });

      return {
        success: true,
        amount: creditAmount,
        newBalance: newBalance,
        transactionId: transactionId,
        traceId: traceId
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      // Comprehensive error logging
      logger.error(`[${traceId}] WALLET_CREDIT_FAILED`, { 
        walletId, 
        amount: amount, 
        description,
        gameId,
        errorType: error.constructor.name,
        errorMessage: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  // Record a wallet transaction with comprehensive metadata
  static async recordTransaction(
    walletId, 
    transactionType, 
    amount, 
    newBalance, 
    metadata = {}
  ) {
    const client = await this.getPoolClient();

    try {
      // Begin transaction
      await client.query('BEGIN');

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = $2, 
            updated_at = CURRENT_TIMESTAMP 
        WHERE wallet_id = $1 
        RETURNING wallet_id
      `;
      const updateResult = await client.query(updateQuery, [walletId, Math.max(0, newBalance)]);

      if (updateResult.rowCount === 0) {
        throw new Error('Wallet not found or balance update failed');
      }

      const walletId = updateResult.rows[0].wallet_id;

      // Record transaction in transactions table
      const transactionQuery = `
        INSERT INTO wallet_transactions (
          wallet_id, 
          user_id,
          transaction_type, 
          amount, 
          description
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING transaction_id
      `;
      const transactionResult = await client.query(transactionQuery, [
        walletId,
        await this.getUserIdFromWalletId(walletId),
        transactionType,
        amount,
        metadata.reason || 'Transaction'
      ]);

      // Commit transaction
      await client.query('COMMIT');

      // Log transaction details
      logger.info('WALLET_TRANSACTION_RECORDED', {
        walletId,
        transactionType,
        amount,
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id
      });

      return {
        id: transactionResult.rows[0].transaction_id,
        walletId,
        newBalance
      };

    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

      logger.error('WALLET_TRANSACTION_RECORD_FAILED', {
        walletId,
        transactionType,
        amount,
        errorMessage: error.message
      });

      throw error;
    } finally {
      // Release client back to pool
      client.release();
    }
  }

  // Debit balance for bet placement with comprehensive tracking
  static async debitBalanceStatic(
    walletId, 
    amount, 
    metadata = {}
  ) {
    const client = await this.getPoolClient();

    try {
      // Begin transaction
      await client.query('BEGIN');

      // Get current wallet balance
      const balanceQuery = `
        SELECT balance 
        FROM wallets 
        WHERE wallet_id = $1 
        FOR UPDATE
      `;
      const balanceResult = await client.query(balanceQuery, [walletId]);

      if (balanceResult.rowCount === 0) {
        throw new Error('Wallet not found');
      }

      const currentBalance = parseFloat(balanceResult.rows[0].balance);

      // Check sufficient balance
      if (currentBalance < amount) {
        throw new Error('Insufficient balance');
      }

      // Calculate new balance
      const newBalance = Math.max(0, currentBalance - amount);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = $2, 
            updated_at = CURRENT_TIMESTAMP 
        WHERE wallet_id = $1
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [walletId, newBalance]);

      // Record transaction
      const transactionQuery = `
        INSERT INTO wallet_transactions (
          wallet_id, 
          user_id,
          transaction_type, 
          amount, 
          description
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING transaction_id
      `;
      const transactionResult = await client.query(transactionQuery, [
        walletId,
        await this.getUserIdFromWalletId(walletId),
        'bet',
        amount,
        metadata.reason || 'Bet Placement'
      ]);

      // Commit transaction
      await client.query('COMMIT');

      // Log transaction details
      logger.info('WALLET_DEBIT_COMPLETED', {
        walletId,
        amount,
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id
      });

      return {
        success: true,
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id
      };

    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

      logger.error('WALLET_DEBIT_FAILED', {
        walletId,
        amount,
        errorMessage: error.message
      });

      throw error;
    } finally {
      // Release client back to pool
      client.release();
    }
  }

  // Credit balance for game winnings with comprehensive tracking
  static async creditBalanceStatic(
    walletId, 
    amount, 
    metadata = {}
  ) {
    const client = await this.getPoolClient();

    try {
      // Begin transaction
      await client.query('BEGIN');

      // Get current wallet balance
      const balanceQuery = `
        SELECT balance 
        FROM wallets 
        WHERE wallet_id = $1 
        FOR UPDATE
      `;
      const balanceResult = await client.query(balanceQuery, [walletId]);

      if (balanceResult.rowCount === 0) {
        throw new Error('Wallet not found');
      }

      const currentBalance = parseFloat(balanceResult.rows[0].balance);

      // Calculate new balance
      const newBalance = Math.max(0, currentBalance + amount);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = $2, 
            updated_at = CURRENT_TIMESTAMP 
        WHERE wallet_id = $1
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [walletId, newBalance]);

      // Record transaction
      const transactionQuery = `
        INSERT INTO wallet_transactions (
          wallet_id, 
          user_id,
          transaction_type, 
          amount, 
          description
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING transaction_id
      `;
      const transactionResult = await client.query(transactionQuery, [
        walletId,
        await this.getUserIdFromWalletId(walletId),
        'win',
        amount,
        metadata.reason || 'Game Winnings'
      ]);

      // Commit transaction
      await client.query('COMMIT');

      // Log transaction details
      logger.info('WALLET_CREDIT_COMPLETED', {
        walletId,
        amount,
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id
      });

      return {
        success: true,
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id
      };

    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

      logger.error('WALLET_CREDIT_FAILED', {
        walletId,
        amount,
        errorMessage: error.message
      });

      throw error;
    } finally {
      // Release client back to pool
      client.release();
    }
  }

  // Broadcast wallet balance update using Redis Pub/Sub
  static async broadcastWalletUpdate(userId, balanceUpdate) {
    try {
      // Ensure pub client is available
      const pubClient = redisConnection.getPubClient();

      // Prepare payload for broadcasting
      const payload = {
        userId,
        balance: balanceUpdate.newBalance,
        previousBalance: balanceUpdate.previousBalance,
        transactionType: balanceUpdate.transactionType || 'balance_update',
        timestamp: new Date().toISOString()
      };

      // Log detailed information before publishing
      logger.info('WALLET_BALANCE_BROADCAST_PREPARATION', {
        userId,
        payload: JSON.stringify(payload),
        pubClientAvailable: !!pubClient
      });

      // Publish to two channels:
      // 1. User-specific channel
      // 2. Global wallet updates channel
      const userChannel = `wallet:balance:${userId}`;
      const globalChannel = 'wallet:balance:global';

      // Publish the update
      const userPublishResult = await pubClient.publish(userChannel, JSON.stringify(payload));
      const globalPublishResult = await pubClient.publish(globalChannel, JSON.stringify(payload));

      logger.info('WALLET_BALANCE_BROADCAST', {
        userId,
        userChannelPublishResult: userPublishResult,
        globalChannelPublishResult: globalPublishResult,
        balanceChange: payload.newBalance - payload.previousBalance,
        transactionType: payload.transactionType
      });

      return payload;
    } catch (error) {
      logger.error('WALLET_BROADCAST_ERROR', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack,
        balanceUpdate: JSON.stringify(balanceUpdate)
      });
      throw error;
    }
  }

  // Setup WebSocket server to subscribe to Redis Pub/Sub wallet updates
  static setupWalletBalanceSubscription(io) {
    try {
      // Get Redis subscription client
      const subClient = redisConnection.getSubClient();
      const pubClient = redisConnection.getPubClient();

      // Log subscription setup details
      logger.info('WALLET_BALANCE_SUBSCRIPTION_SETUP', {
        subClientAvailable: !!subClient,
        pubClientAvailable: !!pubClient,
        ioNamespaceAvailable: !!io
      });

      // Create wallet namespace explicitly
      const walletNamespace = io.of('/wallet');

      // Ensure namespace is ready
      walletNamespace.on('connection', (socket) => {
        logger.info('WALLET_SOCKET_CONNECTED', {
          socketId: socket.id
        });
      });

      // Subscribe to global wallet updates channel
      subClient.subscribe('wallet:balance:global', (message, channel) => {
        try {
          // Ensure message is a string
          const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
          
          // Parse wallet update
          let walletUpdate;
          try {
            walletUpdate = JSON.parse(messageStr);
          } catch (parseError) {
            logger.error('WALLET_BALANCE_MESSAGE_PARSE_ERROR', {
              channel,
              message: messageStr,
              errorMessage: parseError.message
            });
            return;
          }

          // Validate wallet update structure
          if (!walletUpdate || !walletUpdate.userId) {
            logger.warn('INVALID_WALLET_UPDATE', {
              channel,
              update: walletUpdate
            });
            return;
          }

          // Broadcast to all connected clients in wallet namespace
          walletNamespace.emit('wallet:balance:update', walletUpdate);

          logger.info('WALLET_BALANCE_UPDATE_EMITTED', {
            channel,
            userId: walletUpdate.userId,
            balance: walletUpdate.balance,
            namespaceClients: walletNamespace.sockets.size
          });
        } catch (error) {
          logger.error('WALLET_BALANCE_UPDATE_HANDLER_ERROR', {
            errorMessage: error.message,
            errorStack: error.stack
          });
        }
      });

      // Method to dynamically subscribe to user-specific updates
      this.subscribeToUserWalletUpdates = (userId) => {
        const userChannel = `wallet:balance:${userId}`;
        
        // Subscribe to user-specific channel
        subClient.subscribe(userChannel, (message, channel) => {
          try {
            // Ensure message is a string
            const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
            
            // Parse wallet update
            let walletUpdate;
            try {
              walletUpdate = JSON.parse(messageStr);
            } catch (parseError) {
              logger.error('USER_WALLET_BALANCE_MESSAGE_PARSE_ERROR', {
                channel,
                message: messageStr,
                errorMessage: parseError.message
              });
              return;
            }

            // Validate wallet update structure
            if (!walletUpdate || !walletUpdate.userId) {
              logger.warn('INVALID_USER_WALLET_UPDATE', {
                channel,
                update: walletUpdate
              });
              return;
            }

            // Broadcast to wallet namespace
            walletNamespace.emit('wallet:balance:update', walletUpdate);

            logger.info('USER_WALLET_BALANCE_UPDATE_EMITTED', {
              channel,
              userId: walletUpdate.userId,
              balance: walletUpdate.balance
            });
          } catch (error) {
            logger.error('USER_WALLET_BALANCE_UPDATE_HANDLER_ERROR', {
              errorMessage: error.message,
              errorStack: error.stack
            });
          }
        });

        logger.info('USER_SPECIFIC_WALLET_CHANNEL_SUBSCRIBED', {
          userId,
          userChannel
        });
      };

      logger.info('WALLET_BALANCE_SUBSCRIPTION_SETUP_COMPLETE');
    } catch (error) {
      logger.error('WALLET_BALANCE_SUBSCRIPTION_ERROR', {
        errorMessage: error.message,
        errorStack: error.stack
      });
    }
  }

  // Record wallet transaction with real-time broadcasting
  static async recordTransaction(userId, transactionType, amount, metadata = {}) {
    const client = await this.getPoolClient();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Retrieve current balance
      const balanceQuery = 'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE';
      const balanceResult = await client.query(balanceQuery, [userId]);
      const currentBalance = parseFloat(balanceResult.rows[0].balance);

      // Calculate new balance based on transaction type
      let newBalance;
      switch (transactionType) {
        case 'deposit':
          newBalance = Math.max(0, currentBalance + amount);
          break;
        case 'withdrawal':
          newBalance = Math.max(0, currentBalance - amount);
          break;
        default:
          throw new Error(`Unsupported transaction type: ${transactionType}`);
      }

      // Validate balance
      if (newBalance < 0) {
        throw new Error('Insufficient funds');
      }

      // Record transaction
      const transactionQuery = `
        INSERT INTO wallet_transactions (
          user_id, 
          amount, 
          transaction_type,
          metadata
        ) VALUES ($1, $2, $3, $4)
      `;
      await client.query(transactionQuery, [
        userId, 
        amount, 
        transactionType,
        JSON.stringify(metadata)
      ]);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = $1, 
            updated_at = CURRENT_TIMESTAMP 
        WHERE user_id = $2
      `;
      await client.query(updateQuery, [Math.max(0, newBalance), userId]);

      // Commit transaction
      await client.query('COMMIT');

      // Broadcast wallet update
      const balanceUpdate = {
        userId,
        previousBalance: currentBalance,
        newBalance,
        transactionType,
        metadata
      };
      await this.broadcastWalletUpdate(userId, balanceUpdate);

      return balanceUpdate;
    } catch (error) {
      // Rollback transaction
      await client.query('ROLLBACK');

      logger.error('WALLET_TRANSACTION_ERROR', {
        userId,
        transactionType,
        amount,
        errorMessage: error.message
      });

      throw error;
    } finally {
      // Release client
      client.release();
    }
  }

  static async getUserIdFromWalletId(walletId) {
    try {
      const query = `
        SELECT user_id 
        FROM wallets 
        WHERE wallet_id = $1
      `;
      const result = await pool.query(query, [walletId]);

      if (result.rows.length === 0) {
        throw new Error('Wallet not found');
      }

      return result.rows[0].user_id;
    } catch (error) {
      logger.error('Error getting user ID from wallet ID', { 
        walletId, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Get wallet ID for a specific user
  static async getWalletIdByUserId(userId) {
    try {
      const query = `
        SELECT wallet_id 
        FROM wallets 
        WHERE user_id = $1
      `;
      
      logger.info('GET_WALLET_ID_BY_USER_ID_ATTEMPT', {
        userId
      });

      const result = await pool.query(query, [userId]);

      if (result.rowCount === 0) {
        logger.error('GET_WALLET_ID_NO_WALLET_FOUND', {
          userId
        });
        throw new Error(`No wallet found for user ID: ${userId}`);
      }

      const walletId = result.rows[0].wallet_id;

      logger.info('GET_WALLET_ID_SUCCESS', {
        userId,
        walletId
      });

      return walletId;
    } catch (error) {
      logger.error('GET_WALLET_ID_ERROR', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  // Get wallet details by user ID
  static async getWalletByUserId(userId) {
    const client = await this.getPoolClient();

    try {
      const query = `
        SELECT wallet_id, balance, currency, created_at, updated_at
        FROM wallets
        WHERE user_id = $1
      `;
      const result = await client.query(query, [userId]);

      if (result.rows.length === 0) {
        logger.warn('WALLET_NOT_FOUND_FOR_USER', {
          userId,
          message: 'No wallet found for the given user'
        });
        return null;
      }

      const wallet = result.rows[0];

      // Log wallet retrieval for debugging
      logger.info('WALLET_RETRIEVED_BY_USER_ID', {
        userId,
        walletId: wallet.wallet_id,
        balance: wallet.balance
      });

      return {
        walletId: wallet.wallet_id,
        userId: userId,
        balance: parseFloat(wallet.balance),
        currency: wallet.currency,
        createdAt: wallet.created_at,
        updatedAt: wallet.updated_at
      };
    } catch (error) {
      logger.error('WALLET_RETRIEVAL_BY_USER_ID_ERROR', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // Get wallet ID for a specific user
  static async getWalletIdByUserId(userId) {
    const client = await this.getPoolClient();

    try {
      const query = 'SELECT wallet_id FROM wallets WHERE user_id = $1';
      const result = await client.query(query, [userId]);

      if (result.rows.length === 0) {
        logger.warn('WALLET_ID_NOT_FOUND_FOR_USER', {
          userId,
          message: 'No wallet ID found for the given user'
        });
        return null;
      }

      return result.rows[0].wallet_id;
    } catch (error) {
      logger.error('WALLET_ID_RETRIEVAL_ERROR', {
        userId,
        errorMessage: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // Method to dynamically subscribe to user-specific updates
  static subscribeToUserWalletUpdates(userId) {
    try {
      // Get Redis subscription client
      const subClient = redisConnection.getSubClient();

      // User-specific channel
      const userChannel = `wallet:balance:${userId}`;

      // Subscribe to user-specific channel
      subClient.subscribe(userChannel);

      logger.info('USER_SPECIFIC_WALLET_CHANNEL_SUBSCRIBED', {
        userId,
        userChannel
      });
    } catch (error) {
      logger.error('USER_WALLET_CHANNEL_SUBSCRIPTION_ERROR', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
      });
    }
  }

  // Comprehensive balance verification and synchronization
  static async verifyAndSyncBalance(userId) {
    const client = await this.getPoolClient();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Retrieve current wallet balance
      const walletQuery = `
        SELECT wallet_id, balance, created_at 
        FROM wallets 
        WHERE user_id = $1 
        FOR UPDATE
      `;
      const walletResult = await client.query(walletQuery, [userId]);

      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found');
      }

      const walletId = walletResult.rows[0].wallet_id;
      const currentBalance = parseFloat(walletResult.rows[0].balance);
      const walletCreatedAt = walletResult.rows[0].created_at;

      // Comprehensive transaction query with initial balance consideration
      const transactionQuery = `
        WITH initial_balance AS (
          SELECT 
            COALESCE(
              (SELECT balance FROM wallets WHERE user_id = $1), 
              0
            ) AS starting_balance
        ),
        transaction_summary AS (
          SELECT 
            transaction_type,
            COALESCE(SUM(
              CASE 
                WHEN transaction_type IN ('deposit', 'initial_deposit', 'win', 'cashout', 'refund') THEN amount 
                WHEN transaction_type IN ('bet', 'withdrawal') THEN -amount 
                ELSE 0 
              END
            ), 0) as total_transactions,
            COUNT(*) as transaction_count
          FROM wallet_transactions
          WHERE user_id = $1 
            AND created_at >= (SELECT created_at FROM wallets WHERE user_id = $1)
          GROUP BY transaction_type
        )
        SELECT 
          initial_balance.starting_balance, 
          ARRAY_AGG(transaction_summary.transaction_type || ': ' || transaction_summary.total_transactions) as transaction_breakdown,
          SUM(transaction_summary.total_transactions) AS total_transactions,
          SUM(transaction_summary.transaction_count) AS total_transaction_count,
          GREATEST(0, initial_balance.starting_balance + SUM(transaction_summary.total_transactions)) AS calculated_balance
        FROM initial_balance, transaction_summary
        GROUP BY initial_balance.starting_balance
      `;
      const transactionResult = await client.query(transactionQuery, [userId]);
      
      // Add defensive check for empty transaction result
      if (!transactionResult.rows || transactionResult.rows.length === 0) {
        logger.warn('NO_TRANSACTION_HISTORY_FOUND', {
          userId,
          walletId
        });

        // If no transaction history, use current wallet balance
        const walletQuery = 'SELECT balance FROM wallets WHERE user_id = $1';
        const walletResult = await client.query(walletQuery, [userId]);

        if (!walletResult.rows || walletResult.rows.length === 0) {
          logger.error('NO_WALLET_FOUND', { userId });
          
          // Create a new wallet if none exists
          const createWalletQuery = `
            INSERT INTO wallets (user_id, balance, created_at, updated_at) 
            VALUES ($1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
            RETURNING wallet_id, balance
          `;
          const newWalletResult = await client.query(createWalletQuery, [userId]);
          
          return {
            walletId: newWalletResult.rows[0].wallet_id,
            currentBalance: 0,
            calculatedBalance: 0,
            corrected: false,
            reason: 'No wallet found, created new wallet'
          };
        }

        const currentBalance = parseFloat(walletResult.rows[0].balance);
        
        return {
          walletId,
          currentBalance,
          calculatedBalance: currentBalance,
          corrected: false,
          reason: 'No transaction history found'
        };
      }
      
      const initialBalance = parseFloat(transactionResult.rows[0].starting_balance || '0');
      const transactionTotal = parseFloat(transactionResult.rows[0].total_transactions || '0');
      const calculatedBalance = parseFloat(transactionResult.rows[0].calculated_balance || '0');
      const transactionBreakdown = transactionResult.rows[0].transaction_breakdown || [];
      const totalTransactionCount = parseInt(transactionResult.rows[0].total_transaction_count || '0');

      // Log extremely detailed balance verification information
      logger.error('BALANCE_VERIFICATION_DETAILED_LOG', {
        userId,
        walletId,
        currentBalance,
        initialBalance,
        transactionTotal,
        calculatedBalance,
        transactionBreakdown,
        totalTransactionCount,
        walletCreatedAt
      });

      // Determine if balance needs correction
      const balanceDifference = Math.abs(currentBalance - calculatedBalance);
      const BALANCE_TOLERANCE = 0.01; // Allow small floating-point discrepancies

      if (balanceDifference > BALANCE_TOLERANCE || calculatedBalance < 0) {
        // Log significant discrepancy
        logger.warn('BALANCE_DISCREPANCY_DETECTED', {
          userId,
          walletId,
          currentBalance,
          calculatedBalance,
          difference: balanceDifference,
          transactionBreakdown
        });

        // Update wallet balance with ZERO if calculated balance is negative
        const updateQuery = `
          UPDATE wallets 
          SET balance = 0, 
              updated_at = CURRENT_TIMESTAMP 
          WHERE wallet_id = $1
          RETURNING balance
        `;
        const updateResult = await client.query(updateQuery, [walletId]);

        // Broadcast wallet update
        await this.broadcastWalletUpdate(userId, {
          newBalance: 0,
          previousBalance: currentBalance,
          transactionType: 'balance_correction',
          reason: 'Negative balance detected and reset'
        });

        // Commit transaction
        await client.query('COMMIT');

        return {
          walletId,
          currentBalance,
          calculatedBalance: 0,
          corrected: true,
          difference: balanceDifference,
          reason: 'Negative balance detected and reset'
        };
      }

      // Commit transaction
      await client.query('COMMIT');

      return {
        walletId,
        currentBalance,
        calculatedBalance,
        corrected: false,
        difference: balanceDifference
      };
    } catch (error) {
      // Rollback transaction
      await client.query('ROLLBACK');

      logger.error('BALANCE_VERIFICATION_ERROR', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
      });

      throw error;
    } finally {
      // Release client
      client.release();
    }
  }

  // Comprehensive balance verification and synchronization
  static async verifyAndSyncBalance(userId) {
    const client = await this.getPoolClient();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Retrieve current wallet balance
      const walletQuery = `
        SELECT wallet_id, balance, created_at 
        FROM wallets 
        WHERE user_id = $1 
        FOR UPDATE
      `;
      const walletResult = await client.query(walletQuery, [userId]);

      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found');
      }

      const walletId = walletResult.rows[0].wallet_id;
      const currentBalance = parseFloat(walletResult.rows[0].balance);
      const walletCreatedAt = walletResult.rows[0].created_at;

      // Comprehensive transaction query with initial balance consideration
      const transactionQuery = `
        WITH initial_balance AS (
          SELECT 
            COALESCE(
              (SELECT balance FROM wallets WHERE user_id = $1), 
              0
            ) AS starting_balance
        ),
        transaction_summary AS (
          SELECT 
            transaction_type,
            COALESCE(SUM(
              CASE 
                WHEN transaction_type IN ('deposit', 'initial_deposit', 'win', 'cashout', 'refund') THEN amount 
                WHEN transaction_type IN ('bet', 'withdrawal') THEN -amount 
                ELSE 0 
              END
            ), 0) as total_transactions,
            COUNT(*) as transaction_count
          FROM wallet_transactions
          WHERE user_id = $1 
            AND created_at >= (SELECT created_at FROM wallets WHERE user_id = $1)
          GROUP BY transaction_type
        )
        SELECT 
          initial_balance.starting_balance, 
          ARRAY_AGG(transaction_summary.transaction_type || ': ' || transaction_summary.total_transactions) as transaction_breakdown,
          SUM(transaction_summary.total_transactions) AS total_transactions,
          SUM(transaction_summary.transaction_count) AS total_transaction_count,
          GREATEST(0, initial_balance.starting_balance + SUM(transaction_summary.total_transactions)) AS calculated_balance
        FROM initial_balance, transaction_summary
        GROUP BY initial_balance.starting_balance
      `;
      const transactionResult = await client.query(transactionQuery, [userId]);
      
      // Add defensive check for empty transaction result
      if (!transactionResult.rows || transactionResult.rows.length === 0) {
        logger.warn('NO_TRANSACTION_HISTORY_FOUND', {
          userId,
          walletId
        });

        // If no transaction history, use current wallet balance
        const walletQuery = 'SELECT balance FROM wallets WHERE user_id = $1';
        const walletResult = await client.query(walletQuery, [userId]);

        if (!walletResult.rows || walletResult.rows.length === 0) {
          logger.error('NO_WALLET_FOUND', { userId });
          
          // Create a new wallet if none exists
          const createWalletQuery = `
            INSERT INTO wallets (user_id, balance, created_at, updated_at) 
            VALUES ($1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
            RETURNING wallet_id, balance
          `;
          const newWalletResult = await client.query(createWalletQuery, [userId]);
          
          return {
            walletId: newWalletResult.rows[0].wallet_id,
            currentBalance: 0,
            calculatedBalance: 0,
            corrected: false,
            reason: 'No wallet found, created new wallet'
          };
        }

        const currentBalance = parseFloat(walletResult.rows[0].balance);
        
        return {
          walletId,
          currentBalance,
          calculatedBalance: currentBalance,
          corrected: false,
          reason: 'No transaction history found'
        };
      }
      
      const initialBalance = parseFloat(transactionResult.rows[0].starting_balance || '0');
      const transactionTotal = parseFloat(transactionResult.rows[0].total_transactions || '0');
      const calculatedBalance = parseFloat(transactionResult.rows[0].calculated_balance || '0');
      const transactionBreakdown = transactionResult.rows[0].transaction_breakdown || [];
      const totalTransactionCount = parseInt(transactionResult.rows[0].total_transaction_count || '0');

      // Log extremely detailed balance verification information
      logger.error('BALANCE_VERIFICATION_DETAILED_LOG', {
        userId,
        walletId,
        currentBalance,
        initialBalance,
        transactionTotal,
        calculatedBalance,
        transactionBreakdown,
        totalTransactionCount,
        walletCreatedAt
      });

      // Determine if balance needs correction
      const balanceDifference = Math.abs(currentBalance - calculatedBalance);
      const BALANCE_TOLERANCE = 0.01; // Allow small floating-point discrepancies

      if (balanceDifference > BALANCE_TOLERANCE || calculatedBalance < 0) {
        // Log significant discrepancy
        logger.warn('BALANCE_DISCREPANCY_DETECTED', {
          userId,
          walletId,
          currentBalance,
          calculatedBalance,
          difference: balanceDifference,
          transactionBreakdown
        });

        // Update wallet balance with ZERO if calculated balance is negative
        const updateQuery = `
          UPDATE wallets 
          SET balance = 0, 
              updated_at = CURRENT_TIMESTAMP 
          WHERE wallet_id = $1
          RETURNING balance
        `;
        const updateResult = await client.query(updateQuery, [walletId]);

        // Broadcast wallet update
        await this.broadcastWalletUpdate(userId, {
          newBalance: 0,
          previousBalance: currentBalance,
          transactionType: 'balance_correction',
          reason: 'Negative balance detected and reset'
        });

        // Commit transaction
        await client.query('COMMIT');

        return {
          walletId,
          currentBalance,
          calculatedBalance: 0,
          corrected: true,
          difference: balanceDifference,
          reason: 'Negative balance detected and reset'
        };
      }

      // Commit transaction
      await client.query('COMMIT');

      return {
        walletId,
        currentBalance,
        calculatedBalance,
        corrected: false,
        difference: balanceDifference
      };
    } catch (error) {
      // Rollback transaction
      await client.query('ROLLBACK');

      logger.error('BALANCE_VERIFICATION_ERROR', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
      });

      throw error;
    } finally {
      // Release client
      client.release();
    }
  }

  // Get the current wallet socket instance
  static getWalletSocket() {
    return this.walletSocket;
  }
}

export default WalletRepository;
