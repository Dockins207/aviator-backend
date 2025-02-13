import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import { Wallet } from '../models/Wallet.js';

export class WalletRepository {
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
      console.log('DEBUG: Fetching wallet for userId', { userId });
      
      const result = await pool.query(query, [userId]);
      
      console.log('DEBUG: Wallet query result', { 
        rowCount: result.rows.length,
        rows: result.rows 
      });

      return result.rows.length > 0 ? Wallet.fromRow(result.rows[0]) : null;
    } catch (error) {
      console.error('DEBUG: Full error in getWalletByUserId', error);
      
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

      // First, get the wallet details
      const walletQuery = `
        SELECT wallet_id FROM wallets 
        WHERE user_id = $1
      `;
      const walletResult = await client.query(walletQuery, [userId]);
      
      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found for user');
      }
      
      const walletId = walletResult.rows[0].wallet_id;

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance + $1 
        WHERE user_id = $2 
        RETURNING *
      `;
      const updateResult = await client.query(updateQuery, [amount, userId]);

      // Insert transaction record
      const transactionQuery = `
        INSERT INTO wallet_transactions (
          transaction_id,
          user_id, 
          wallet_id, 
          amount, 
          currency, 
          transaction_type, 
          payment_method,
          description
        ) VALUES (
          gen_random_uuid(),
          $1, 
          $2, 
          $3, 
          'KSH', 
          'deposit', 
          $4,
          $5
        )
      `;
      await client.query(transactionQuery, [
        userId, 
        walletId, 
        amount, 
        description,
        description
      ]);

      // Commit transaction
      await client.query('COMMIT');

      return Wallet.fromRow(updateResult.rows[0]);
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Error processing deposit', { 
        userId, 
        amount,
        errorMessage: error.message,
        errorStack: error.stack
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

      // First, get the wallet details
      const walletQuery = `
        SELECT wallet_id, balance FROM wallets 
        WHERE user_id = $1
      `;
      const walletResult = await client.query(walletQuery, [userId]);
      
      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found for user');
      }
      
      const walletId = walletResult.rows[0].wallet_id;
      const currentBalance = parseFloat(walletResult.rows[0].balance);

      // Check if sufficient balance
      if (currentBalance < amount) {
        throw new Error('Insufficient funds');
      }

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance - $1 
        WHERE user_id = $2 
        RETURNING *
      `;
      const updateResult = await client.query(updateQuery, [amount, userId]);

      // Insert transaction record
      const transactionQuery = `
        INSERT INTO wallet_transactions (
          transaction_id,
          user_id, 
          wallet_id, 
          amount, 
          currency, 
          transaction_type, 
          payment_method,
          description
        ) VALUES (
          gen_random_uuid(),
          $1, 
          $2, 
          $3, 
          'KSH', 
          'withdrawal', 
          $4,
          $5
        )
      `;
      await client.query(transactionQuery, [
        userId, 
        walletId, 
        amount, 
        description,
        description
      ]);

      // Commit transaction
      await client.query('COMMIT');

      return Wallet.fromRow(updateResult.rows[0]);
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      logger.error('Error processing withdrawal', { 
        userId, 
        amount,
        errorMessage: error.message,
        errorStack: error.stack
      });
      
      throw error;
    } finally {
      client.release();
    }
  }

  // Place a bet and update wallet
  static async placeBet(userId, betAmount) {
    const client = await pool.connect();
    
    try {
      // Start a transaction
      await client.query('BEGIN');

      // Deduct bet amount from wallet
      const updateQuery = `
        UPDATE wallets 
        SET 
          balance = balance - $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND balance >= $2
        RETURNING balance
      `;
      
      const result = await client.query(updateQuery, [userId, betAmount]);

      // Check if bet was successful
      if (result.rows.length === 0) {
        throw new Error('Insufficient balance');
      }

      // Record bet transaction
      const transactionQuery = `
        INSERT INTO wallet_transactions (
          user_id, 
          wallet_id,
          amount, 
          transaction_type, 
          description, 
          status
        ) VALUES ($1, 
          (SELECT wallet_id FROM wallets WHERE user_id = $1), 
          $2, 
          'bet', 
          'Game Bet', 
          'completed')
      `;
      await client.query(transactionQuery, [userId, betAmount]);

      // Commit the transaction
      await client.query('COMMIT');

      return result.rows[0].balance;
    } catch (error) {
      // Rollback the transaction in case of error
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Process game winnings
  static async processWinnings(userId, winAmount) {
    const client = await pool.connect();
    
    try {
      // Start a transaction
      await client.query('BEGIN');

      // Update wallet with winnings
      const updateQuery = `
        UPDATE wallets 
        SET 
          balance = balance + $2,
          total_winnings = total_winnings + $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
        RETURNING balance
      `;
      
      const result = await client.query(updateQuery, [userId, winAmount]);

      // Record winning transaction
      const transactionQuery = `
        INSERT INTO wallet_transactions (
          user_id, 
          amount, 
          type, 
          description, 
          status
        ) VALUES ($1, $2, 'WIN', 'Game Winnings', 'COMPLETED')
      `;
      await client.query(transactionQuery, [userId, winAmount]);

      // Commit the transaction
      await client.query('COMMIT');

      return result.rows[0].balance;
    } catch (error) {
      // Rollback the transaction in case of error
      await client.query('ROLLBACK');
      console.error('Error processing winnings:', error);
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
      return result.rows;
    } catch (error) {
      console.error('Error syncing all user balances with wallets:', error);
      throw error;
    }
  }

  // Get user balance
  static async getUserBalance(userId) {
    try {
      const query = `
        SELECT balance 
        FROM wallets 
        WHERE user_id = $1
      `;
      
      const result = await pool.query(query, [userId]);
      
      if (result.rows.length === 0) {
        throw new Error('Wallet not found for user');
      }
      
      return result.rows[0].balance;
    } catch (error) {
      console.error('Error fetching user balance:', error);
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
}
