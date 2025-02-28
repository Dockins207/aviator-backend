import logger from '../config/logger.js';
import { pool } from '../config/database.js';
import { Wallet } from '../models/Wallet.js';
import WalletSocket from '../sockets/walletSocket.js';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export class WalletRepository {
  // Static field to store wallet socket instance
  static walletSocket = null;

  // Set the wallet socket instance
  static setWalletSocket(walletSocket) {
    if (!walletSocket) {
      return;
    }
    
    this.walletSocket = walletSocket;
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
      }
    } catch (error) {
      throw error;
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
      logger.error('POOL_CLIENT_ERROR', {
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
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

      return {
        walletId: result.rows[0].wallet_id,
        userId: result.rows[0].user_id,
        balance: parseFloat(result.rows[0].balance),
        currency: result.rows[0].currency,
        createdAt: result.rows[0].created_at,
        updatedAt: result.rows[0].updated_at
      };
    } catch (error) {
      throw error;
    }
  }

  // Deposit funds
  static async deposit(
    userId, 
    walletId = null, 
    amount, 
    description = 'Deposit', 
    transactionType = 'manual', 
    currency = 'KSH'
  ) {
    const client = await this.getPoolClient();
    
    try {
      // Start transaction
      await client.query('BEGIN');

      // Find or create wallet if not specified
      if (!walletId) {
        const walletQuery = 'SELECT wallet_id FROM wallets WHERE user_id = $1';
        const walletResult = await client.query(walletQuery, [userId]);
        
        if (walletResult.rows.length === 0) {
          throw new Error('Wallet not found');
        }
        
        walletId = walletResult.rows[0].wallet_id;
      }

      // Insert transaction record
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (user_id, wallet_id, amount, description, transaction_type, currency)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING transaction_id, amount
      `;
      const transactionResult = await client.query(transactionQuery, [
        userId, 
        walletId, 
        amount, 
        description, 
        transactionType,
        currency
      ]);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance + $1 
        WHERE wallet_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [amount, walletId]);

      // Commit transaction
      await client.query('COMMIT');

      const newBalance = parseFloat(updateResult.rows[0].balance);
      const transactionId = transactionResult.rows[0].transaction_id;

      // Emit wallet update via socket
      this.safeEmitWalletUpdate({
        userId,
        walletId,
        balance: newBalance,
        transactionId,
        transactionType,
        amount,
        description,
        timestamp: new Date().toISOString()
      });

      // Log successful deposit
      logger.info('WALLET_DEPOSIT_SUCCESS', {
        userId,
        walletId,
        amount,
        newBalance
      });

      return {
        success: true,
        walletId,
        newBalance,
        transactionId
      };

    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

      // Log deposit failure
      logger.error('WALLET_DEPOSIT_FAILED', {
        userId,
        amount,
        error: error.message
      });

      throw error;
    } finally {
      // Always release the client
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

      return {
        success: true,
        newBalance: parseFloat(newBalance)
      };

    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
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

      // Check current balance with explicit locking
      const balanceQuery = `
        SELECT balance 
        FROM wallets 
        WHERE wallet_id = $1 
        FOR UPDATE SKIP LOCKED
      `;
      const balanceResult = await client.query(balanceQuery, [walletId]);

      // Validate wallet exists
      if (balanceResult.rowCount === 0) {
        throw new Error('USER_WALLET_NOT_FOUND');
      }

      const currentBalance = parseFloat(balanceResult.rows[0].balance);

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

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance - $1, 
            updated_at = NOW() 
        WHERE wallet_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [betAmountFloat, walletId]);
      const newBalance = updateResult.rows[0].balance;

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
        return 0;
      }

      return parseFloat(balanceResult.rows[0].balance);
    } catch (error) {
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
        INSERT INTO wallet_transactions 
        (wallet_id, user_id, transaction_type, amount, description, transaction_id, status) 
        VALUES ($1, $2, $3, $4, $5, $6, 'completed')
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

      throw error;
    } finally {
      // Release the client back to the pool
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

      return {
        id: transactionResult.rows[0].transaction_id,
        walletId,
        newBalance
      };

    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

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

      return {
        success: true,
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id
      };

    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

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

      return {
        success: true,
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id
      };

    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

      throw error;
    } finally {
      // Release client back to pool
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
        // If no transaction history, use current wallet balance
        const walletQuery = 'SELECT balance FROM wallets WHERE user_id = $1';
        const walletResult = await client.query(walletQuery, [userId]);

        if (!walletResult.rows || walletResult.rows.length === 0) {
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

      // Determine if balance needs correction
      const balanceDifference = Math.abs(currentBalance - calculatedBalance);
      const BALANCE_TOLERANCE = 0.01; // Allow small floating-point discrepancies

      if (balanceDifference > BALANCE_TOLERANCE || calculatedBalance < 0) {
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
        // If no transaction history, use current wallet balance
        const walletQuery = 'SELECT balance FROM wallets WHERE user_id = $1';
        const walletResult = await client.query(walletQuery, [userId]);

        if (!walletResult.rows || walletResult.rows.length === 0) {
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

      // Determine if balance needs correction
      const balanceDifference = Math.abs(currentBalance - calculatedBalance);
      const BALANCE_TOLERANCE = 0.01; // Allow small floating-point discrepancies

      if (balanceDifference > BALANCE_TOLERANCE || calculatedBalance < 0) {
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

      throw error;
    } finally {
      // Release client
      client.release();
    }
  }

  // Find wallet by user ID
  static async findWalletByUserId(userId) {
    const client = await pool.connect();
    try {
      const query = `
        SELECT * FROM wallets 
        WHERE user_id = $1
      `;
      const result = await client.query(query, [userId]);
      
      if (result.rows.length === 0) {
        return null;
      }
      
      return result.rows[0];
    } catch (error) {
      logger.error('FIND_WALLET_ERROR', {
        userId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // Update wallet balance
  static async updateWalletBalance(userId, balanceChange) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // First get current wallet to check balance
      const currentWalletQuery = 'SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE';
      const currentWalletResult = await client.query(currentWalletQuery, [userId]);

      if (currentWalletResult.rows.length === 0) {
        throw new Error('Wallet not found');
      }

      const currentWallet = currentWalletResult.rows[0];
      const newBalance = parseFloat(currentWallet.balance) + parseFloat(balanceChange);

      if (newBalance < 0) {
        await client.query('ROLLBACK');
        throw new Error('Insufficient balance');
      }

      // Update the balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = $1, 
            updated_at = CURRENT_TIMESTAMP 
        WHERE wallet_id = $2 
        RETURNING *
      `;
      const updateResult = await client.query(updateQuery, [newBalance, currentWallet.wallet_id]);

      if (updateResult.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('Failed to update wallet balance');
      }

      // Record the transaction
      const transactionQuery = `
        INSERT INTO wallet_transactions (
          wallet_id, 
          user_id, 
          transaction_type, 
          amount, 
          description, 
          status
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `;
      await client.query(transactionQuery, [
        currentWallet.wallet_id,
        userId,
        balanceChange < 0 ? 'bet' : 'win',
        Math.abs(balanceChange),
        balanceChange < 0 ? 'Bet placement' : 'Game win',
        'completed'
      ]);

      // Log the successful transaction
      logger.info('WALLET_BALANCE_UPDATED', {
        userId,
        walletId: currentWallet.wallet_id,
        previousBalance: currentWallet.balance,
        balanceChange,
        newBalance,
        transactionType: balanceChange < 0 ? 'bet' : 'win'
      });

      await client.query('COMMIT');

      // Return the updated wallet
      return updateResult.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('WALLET_BALANCE_UPDATE_ERROR', {
        userId,
        balanceChange,
        error: error.message,
        stack: error.stack
      });
      throw error;
    } finally {
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
      
      const result = await pool.query(query, [userId]);

      if (result.rowCount === 0) {
        throw new Error(`No wallet found for user ID: ${userId}`);
      }

      const walletId = result.rows[0].wallet_id;

      return walletId;
    } catch (error) {
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
        return null;
      }

      const wallet = result.rows[0];

      return {
        walletId: wallet.wallet_id,
        userId: userId,
        balance: parseFloat(wallet.balance),
        currency: wallet.currency,
        createdAt: wallet.created_at,
        updatedAt: wallet.updated_at
      };
    } catch (error) {
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
        return null;
      }

      return result.rows[0].wallet_id;
    } catch (error) {
      throw error;
    } finally {
      client.release();
    }
  }

  // Deduct bet amount from wallet
  static async deductBetAmount(userId, betAmount, betId) {
    const client = await this.getPoolClient();
    try {
      // Start transaction
      await client.query('BEGIN');

      // Fetch wallet for the user
      const walletQuery = `
        SELECT wallet_id, user_id, balance 
        FROM wallets 
        WHERE user_id = $1
        FOR UPDATE
      `;
      const walletResult = await client.query(walletQuery, [userId]);

      // Check if wallet exists
      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found for user');
      }

      const wallet = walletResult.rows[0];
      const currentBalance = parseFloat(wallet.balance);
      const walletId = wallet.wallet_id;

      // Check sufficient balance
      if (currentBalance < betAmount) {
        throw new Error('Insufficient wallet balance');
      }

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance - $1, 
            updated_at = NOW() 
        WHERE wallet_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [betAmount, walletId]);
      const newBalance = parseFloat(updateResult.rows[0].balance);

      // Record transaction
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (wallet_id, user_id, transaction_type, amount, description, 
         payment_method, currency, status, reference_id) 
        VALUES ($1, $2, $3, $4, $5, 
                'internal', 'KSH', 'completed', $6)
        RETURNING transaction_id
      `;
      const transactionResult = await client.query(transactionQuery, [
        walletId, 
        userId, 
        'bet', 
        betAmount, 
        'Bet Placement',
        betId
      ]);

      // Commit transaction
      await client.query('COMMIT');

      // Emit wallet update if socket is available
      this.safeEmitWalletUpdate({
        userId,
        walletId,
        balance: newBalance,
        transactionType: 'bet',
        amount: betAmount
      });

      return {
        walletId,
        oldBalance: currentBalance,
        newBalance,
        transactionId: transactionResult.rows[0].transaction_id
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('WALLET_BET_DEDUCTION_ERROR', {
        userId,
        betAmount,
        errorMessage: error.message
      });

      throw error;
    } finally {
      // Release the client back to the pool
      client.release();
    }
  }

  // Remove Redis-related methods
  // Commented out to preserve the method signature if needed elsewhere
  static async acquireLock(lockKey, lockValue, lockDuration) {
    // Placeholder method, no-op
    return true;
  }

  // Placeholder method for lock release
  static async releaseLock(lockKey, lockValue, unlockScript) {
    // Placeholder method, no-op
    return true;
  }

  // Get comprehensive wallet details for real-time updates
  static async getWalletDetails(userId) {
    const client = await this.getPoolClient();
    try {
      // Fetch wallet information
      const walletQuery = `
        SELECT 
          wallet_id,
          user_id,
          balance, 
          currency, 
          created_at
        FROM wallets
        WHERE user_id = $1
      `;
      const walletResult = await client.query(walletQuery, [userId]);
      
      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found');
      }

      const wallet = walletResult.rows[0];

      // Fetch recent transactions
      const transactionsQuery = `
        SELECT 
          transaction_id as "transactionId",
          amount,
          description,
          transaction_type as "transactionType",
          created_at as "createdAt"
        FROM wallet_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 10
      `;
      const transactionsResult = await client.query(transactionsQuery, [userId]);

      // Log wallet details retrieval
      logger.info('WALLET_DETAILS_RETRIEVED', {
        userId,
        balance: wallet.balance,
        currency: wallet.currency
      });

      return {
        userId,
        walletId: wallet.wallet_id,
        balance: parseFloat(wallet.balance),
        currency: wallet.currency || 'KSH',
        createdAt: wallet.created_at,
        recentTransactions: transactionsResult.rows
      };
    } catch (error) {
      logger.error('WALLET_DETAILS_RETRIEVAL_ERROR', {
        userId,
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  }
}

export default WalletRepository;
