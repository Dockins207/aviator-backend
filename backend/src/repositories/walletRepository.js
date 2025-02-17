import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import { Wallet } from '../models/Wallet.js';
import WalletSocket from '../sockets/walletSocket.js';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export class WalletRepository {
  static walletSocket = null;

  // Add a method to set the wallet socket
  static setWalletSocket(io) {
    if (!this.walletSocket) {
      this.walletSocket = {
        emitWalletUpdate: (payload) => {
          try {
            const walletNamespace = io.of('/wallet');
            walletNamespace.emit('wallet:update', payload);
            logger.info('WALLET_SOCKET_UPDATE_SENT', { payload });
          } catch (error) {
            logger.error('WALLET_SOCKET_UPDATE_ERROR', {
              errorMessage: error.message,
              payload
            });
          }
        }
      };
    }
  }

  // Create wallet for a new user
  static async createWallet(userId) {
    const query = `
      INSERT INTO wallets (user_id, currency, balance) 
      VALUES ($1, 'KSH', 0.00) 
      ON CONFLICT (user_id) DO NOTHING
      RETURNING *
    `;
    try {
      const result = await pool.query(query, [userId]);
      
      // If no rows returned (wallet already exists), fetch existing wallet
      if (result.rows.length === 0) {
        const existingWalletQuery = `
          SELECT * FROM wallets 
          WHERE user_id = $1
        `;
        const existingResult = await pool.query(existingWalletQuery, [userId]);
        
        if (existingResult.rows.length > 0) {
          return Wallet.fromRow(existingResult.rows[0]);
        }
      }
      
      return result.rows.length > 0 ? Wallet.fromRow(result.rows[0]) : null;
    } catch (error) {
      logger.error('Error creating wallet', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Get user wallet details
  static async getWalletByUserId(userId) {
    const query = `
      SELECT * FROM wallets 
      WHERE user_id = $1
    `;
    try {
      const result = await pool.query(query, [userId]);
      
      return result.rows.length > 0 ? Wallet.fromRow(result.rows[0]) : null;
    } catch (error) {
      logger.error('Error fetching wallet', { 
        userId, 
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  // Deposit funds
  static async deposit(userId, amount, description = 'Manual Deposit') {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Validate and convert amount
      const depositAmount = parseFloat(amount);
      if (isNaN(depositAmount) || depositAmount <= 0) {
        throw new Error('Invalid deposit amount');
      }

      // Fetch wallet_id for the transaction
      const walletQuery = `
        SELECT wallet_id FROM wallets 
        WHERE user_id = $1
      `;
      const walletResult = await client.query(walletQuery, [userId]);
      const walletId = walletResult.rows[0].wallet_id;

      // Generate unique transaction ID
      const transactionId = uuidv4();

      // Insert transaction record
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (user_id, wallet_id, amount, transaction_type, description, transaction_id, status) 
        VALUES ($1, $2, $3, 'deposit', $4, $5, 'completed')
        RETURNING *
      `;
      const transactionResult = await client.query(transactionQuery, [
        userId, 
        walletId,
        depositAmount, 
        description, 
        transactionId
      ]);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance + $1, 
            updated_at = NOW() 
        WHERE user_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [depositAmount, userId]);
      const newBalance = updateResult.rows[0].balance;

      // Commit transaction
      await client.query('COMMIT');

      // Broadcast wallet update if socket is initialized
      await this.broadcastWalletUpdate(userId, 'DEPOSIT', {
        amount: depositAmount,
        description: description,
        transactionId: transactionId
      });

      return {
        success: true,
        amount: depositAmount,
        newBalance: newBalance,
        transactionId: transactionId
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Deposit failed', { 
        userId, 
        amount, 
        errorMessage: error.message 
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  // Withdraw funds
  static async withdraw(userId, amount, description = 'Manual Withdrawal') {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Validate and convert amount
      const withdrawAmount = parseFloat(amount);
      if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
        throw new Error('Invalid withdrawal amount');
      }

      // Check current balance
      const balanceQuery = `
        SELECT balance 
        FROM wallets 
        WHERE user_id = $1 
        FOR UPDATE
      `;
      const balanceResult = await client.query(balanceQuery, [userId]);
      const currentBalance = parseFloat(balanceResult.rows[0].balance);

      // Validate sufficient balance
      if (currentBalance < withdrawAmount) {
        throw new Error('Insufficient balance');
      }

      // Fetch wallet_id for the transaction
      const walletQuery = `
        SELECT wallet_id FROM wallets 
        WHERE user_id = $1
      `;
      const walletResult = await client.query(walletQuery, [userId]);
      const walletId = walletResult.rows[0].wallet_id;

      // Generate unique transaction ID
      const transactionId = uuidv4();

      // Insert transaction record
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (user_id, wallet_id, amount, transaction_type, description, transaction_id, status) 
        VALUES ($1, $2, $3, 'withdrawal', $4, $5, 'completed')
        RETURNING *
      `;
      const transactionResult = await client.query(transactionQuery, [
        userId, 
        walletId,
        withdrawAmount, 
        description, 
        transactionId
      ]);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance - $1, 
            updated_at = NOW() 
        WHERE user_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [withdrawAmount, userId]);
      const newBalance = updateResult.rows[0].balance;

      // Commit transaction
      await client.query('COMMIT');

      // Broadcast wallet update if socket is initialized
      await this.broadcastWalletUpdate(userId, 'WITHDRAWAL', {
        amount: withdrawAmount,
        description: description,
        transactionId: transactionId
      });

      return {
        success: true,
        amount: withdrawAmount,
        newBalance: newBalance,
        transactionId: transactionId
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Withdrawal failed', { 
        userId, 
        amount, 
        errorMessage: error.message 
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  // Place a bet and update wallet
  static async placeBet(userId, betAmount, gameId) {
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
        userId,
        betAmount: betAmountFloat,
        timestamp: new Date().toISOString()
      });

      // Check current balance with explicit locking
      const balanceQuery = `
        SELECT balance 
        FROM wallets 
        WHERE user_id = $1 
        FOR UPDATE SKIP LOCKED
      `;
      const balanceResult = await client.query(balanceQuery, [userId]);

      // Detailed logging of balance check
      if (balanceResult.rows.length === 0) {
        throw new Error('USER_WALLET_NOT_FOUND');
      }

      const currentBalance = parseFloat(balanceResult.rows[0].balance);

      logger.info(`[${traceId}] WALLET_BALANCE_CHECK`, {
        userId,
        currentBalance,
        betAmount: betAmountFloat,
        timestamp: new Date().toISOString()
      });

      // Validate sufficient balance
      if (currentBalance < betAmountFloat) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      // Fetch wallet_id for the transaction
      const walletQuery = `
        SELECT wallet_id FROM wallets 
        WHERE user_id = $1
      `;
      const walletResult = await client.query(walletQuery, [userId]);
      const walletId = walletResult.rows[0].wallet_id;

      // Generate unique transaction ID
      const transactionId = uuidv4();

      // Insert transaction record with comprehensive details
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (user_id, wallet_id, amount, transaction_type, description, transaction_id, status) 
        VALUES ($1, $2, $3, 'bet', $4, $5, 'completed')
        RETURNING *
      `;
      const transactionResult = await client.query(transactionQuery, [
        userId, 
        walletId,
        betAmountFloat, 
        'Game Bet', 
        transactionId
      ]);

      // Update wallet balance with detailed logging
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance - $1, 
            updated_at = NOW() 
        WHERE user_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [betAmountFloat, userId]);
      const newBalance = updateResult.rows[0].balance;

      // Detailed logging of balance update
      logger.info(`[${traceId}] WALLET_BALANCE_UPDATED`, {
        userId,
        oldBalance: currentBalance,
        betAmount: betAmountFloat,
        newBalance,
        transactionId,
        timestamp: new Date().toISOString()
      });

      // Commit transaction
      await client.query('COMMIT');

      // Broadcast wallet update if socket is initialized
      await this.broadcastWalletUpdate(userId, 'BET_PLACED', {
        betAmount: betAmountFloat,
        gameId: gameId,
        transactionId: transactionId,
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
        userId, 
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
  static async processWinnings(userId, winAmount) {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Validate and convert amount
      const winAmountFloat = parseFloat(winAmount);
      if (isNaN(winAmountFloat) || winAmountFloat < 0) {
        throw new Error('Invalid win amount');
      }

      // Fetch wallet_id for the transaction
      const walletQuery = `
        SELECT wallet_id FROM wallets 
        WHERE user_id = $1
      `;
      const walletResult = await client.query(walletQuery, [userId]);
      const walletId = walletResult.rows[0].wallet_id;

      // Generate unique transaction ID
      const transactionId = uuidv4();

      // Insert transaction record
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (user_id, wallet_id, amount, transaction_type, description, transaction_id, status) 
        VALUES ($1, $2, $3, 'win', $4, $5, 'completed')
        RETURNING *
      `;
      await client.query(transactionQuery, [
        userId, 
        walletId,
        winAmountFloat, 
        'Game Winnings', 
        transactionId
      ]);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance + $1, 
            updated_at = NOW() 
        WHERE user_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [winAmountFloat, userId]);
      const newBalance = updateResult.rows[0].balance;

      // Commit transaction
      await client.query('COMMIT');

      // Broadcast wallet update if socket is initialized
      await this.broadcastWalletUpdate(userId, 'WIN', {
        amount: winAmountFloat,
        transactionId: transactionId
      });

      return newBalance;
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Winnings processing failed', { 
        userId, 
        amount: winAmount, 
        errorMessage: error.message 
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  // Get transaction history
  static async getTransactionHistory(userId, limit = 50, offset = 0) {
    const query = `
      SELECT * FROM wallet_transactions 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2 OFFSET $3
    `;
    try {
      const result = await pool.query(query, [userId, limit, offset]);
      return result.rows.map(row => ({ ...row, currency: 'KSH' }));
    } catch (error) {
      logger.error('Error fetching transaction history', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Add balance to a user's wallet
  static async addBalance(userId, amount) {
    try {
      const query = `
        INSERT INTO wallets (user_id, balance, total_deposited, currency)
        VALUES ($1, $2, $2, 'KSH')
        ON CONFLICT (user_id) DO UPDATE 
        SET 
          balance = wallets.balance + $2,
          total_deposited = wallets.total_deposited + $2,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *;
      `;
      
      const result = await pool.query(query, [userId, amount]);

      // Broadcast wallet update if socket is initialized
      await this.broadcastWalletUpdate(userId, 'ADD_BALANCE', {
        amount: amount
      });

      return result.rows[0];
    } catch (error) {
      console.error('Error adding wallet balance:', error);
      throw error;
    }
  }

  // Add this method to synchronize user balance with wallet
  static async syncUserBalanceWithWallet(userId) {
    try {
      const query = `
        UPDATE users u
        SET 
          balance = w.balance,
          total_deposited = w.total_deposited,
          currency = w.currency,
          updated_at = CURRENT_TIMESTAMP
        FROM wallets w
        WHERE u.id = w.user_id AND u.id = $1
        RETURNING u.*;
      `;
      
      const result = await pool.query(query, [userId]);

      // Broadcast wallet update if socket is initialized
      await this.broadcastWalletUpdate(userId, 'SYNC_BALANCE', {
        balance: result.rows[0].balance
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
        WHERE u.id = w.user_id
        RETURNING u.*;
      `;
      
      const result = await pool.query(query);

      // Broadcast wallet update for all users if socket is initialized
      for (const user of result.rows) {
        await this.broadcastWalletUpdate(user.id, 'SYNC_BALANCE', {
          balance: user.balance
        });
      }

      return result.rows;
    } catch (error) {
      console.error('Error syncing all user balances with wallets:', error);
      throw error;
    }
  }

  // Get user balance
  static async getUserBalance(userId) {
    try {
      const balanceQuery = `
        SELECT balance 
        FROM wallets 
        WHERE user_id = $1
      `;
      const balanceResult = await pool.query(balanceQuery, [userId]);
      
      if (balanceResult.rows.length === 0) {
        logger.warn('USER_WALLET_NOT_FOUND', { userId });
        return 0;
      }

      return parseFloat(balanceResult.rows[0].balance);
    } catch (error) {
      logger.error('GET_USER_BALANCE_ERROR', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  // Deduct balance from user's wallet
  static async deductBalance(userId, amount) {
    const query = `
      UPDATE wallets 
      SET balance = balance - $2, 
          updated_at = NOW() 
      WHERE user_id = $1 
      AND balance >= $2 
      RETURNING *
    `;
    try {
      const result = await pool.query(query, [userId, amount]);
      
      if (result.rows.length === 0) {
        throw new Error('Insufficient balance or user wallet not found');
      }
      
      logger.info('Wallet balance deducted', { 
        userId, 
        amount,
        newBalance: result.rows[0].balance 
      });

      // Broadcast wallet update if socket is initialized
      await this.broadcastWalletUpdate(userId, 'DEDUCT_BALANCE', {
        amount: amount,
        newBalance: result.rows[0].balance
      });

      return Wallet.fromRow(result.rows[0]);
    } catch (error) {
      logger.error('Error deducting wallet balance', { 
        userId, 
        amount, 
        errorMessage: error.message 
      });
      throw error;
    }
  }

  // Credit balance to user's wallet
  static async creditBalance(userId, amount) {
    const query = `
      UPDATE wallets 
      SET balance = balance + $2, 
          updated_at = NOW() 
      WHERE user_id = $1 
      RETURNING *
    `;
    try {
      const result = await pool.query(query, [userId, amount]);
      
      if (result.rows.length === 0) {
        throw new Error('User wallet not found');
      }
      
      logger.info('Wallet balance credited', { 
        userId, 
        amount,
        newBalance: result.rows[0].balance 
      });

      // Broadcast wallet update if socket is initialized
      await this.broadcastWalletUpdate(userId, 'CREDIT_BALANCE', {
        amount: amount,
        newBalance: result.rows[0].balance
      });

      return Wallet.fromRow(result.rows[0]);
    } catch (error) {
      logger.error('Error crediting wallet balance', { 
        userId, 
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

  // Credit balance statically
  static async creditBalanceStatic(userId, amount, description = 'Game Win') {
    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Validate and convert amount
      const creditAmount = parseFloat(amount);
      if (isNaN(creditAmount) || creditAmount <= 0) {
        throw new Error('Invalid credit amount');
      }

      // Fetch wallet_id for the transaction
      const walletQuery = `
        SELECT wallet_id FROM wallets 
        WHERE user_id = $1
      `;
      const walletResult = await client.query(walletQuery, [userId]);
      const walletId = walletResult.rows[0].wallet_id;

      // Generate unique transaction ID
      const transactionId = uuidv4();

      // Insert transaction record
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (user_id, wallet_id, amount, transaction_type, description, transaction_id, status) 
        VALUES ($1, $2, $3, 'credit', $4, $5, 'completed')
        RETURNING *
      `;
      const transactionResult = await client.query(transactionQuery, [
        userId, 
        walletId,
        creditAmount, 
        description, 
        transactionId
      ]);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance + $1, 
            updated_at = NOW() 
        WHERE user_id = $2 
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [creditAmount, userId]);
      const newBalance = updateResult.rows[0].balance;

      // Commit transaction
      await client.query('COMMIT');

      // Broadcast wallet update if socket is initialized
      await this.broadcastWalletUpdate(userId, 'CREDIT_BALANCE_STATIC', {
        amount: creditAmount,
        transactionId: transactionId,
        description: description
      });

      return {
        success: true,
        amount: creditAmount,
        newBalance: newBalance,
        transactionId: transactionId
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Credit balance failed', { 
        userId, 
        amount, 
        errorMessage: error.message 
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  // Broadcast wallet update with comprehensive details
  static async broadcastWalletUpdate(userId, transactionType, transactionDetails = {}) {
    try {
      const newBalance = this.getUserBalance(userId);

      const walletUpdatePayload = {
        userId,
        balance: newBalance,
        transactionType,
        transactionDetails: {
          ...transactionDetails,
          timestamp: new Date().toISOString()
        }
      };

      // Broadcast via socket if available
      if (WalletRepository.walletSocket) {
        WalletRepository.walletSocket.emitWalletUpdate(walletUpdatePayload);
      } else {
        logger.warn('WALLET_SOCKET_NOT_INITIALIZED', { userId });
      }

      logger.info('WALLET_UPDATE_BROADCAST', { 
        userId, 
        balance: newBalance, 
        transactionType 
      });

    } catch (error) {
      logger.error('WALLET_UPDATE_BROADCAST_FAILED', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }
}
