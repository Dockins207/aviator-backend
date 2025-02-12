import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import { balanceService } from '../services/authService.js';

export class WalletRepository {
  // Create wallet for a new user
  static async createWallet(userId) {
    const query = `
      INSERT INTO wallets (user_id, currency) 
      VALUES ($1, 'KSH') 
      RETURNING *
    `;
    try {
      const result = await pool.query(query, [userId]);
      return result.rows[0];
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
      return result.rows[0];
    } catch (error) {
      logger.error('Error fetching wallet', { 
        userId, 
        errorMessage: error.message 
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

      // Insert transaction record
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (user_id, wallet_id, amount, currency, transaction_type, description) 
        VALUES (
          $1, 
          (SELECT id FROM wallets WHERE user_id = $1), 
          $2, 
          'KSH',
          'deposit', 
          $3
        ) RETURNING *
      `;
      const transactionResult = await client.query(transactionQuery, [
        userId, 
        amount, 
        description
      ]);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET 
          balance = balance + $2,
          total_deposited = total_deposited + $2,
          last_transaction_date = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
        RETURNING *
      `;
      const walletResult = await client.query(updateQuery, [userId, amount]);

      // Sync wallet balance to users table
      await balanceService.syncWalletBalanceToUser(userId);

      // Commit transaction
      await client.query('COMMIT');

      return {
        transaction: {
          ...transactionResult.rows[0],
          currency: 'KSH'
        },
        wallet: {
          ...walletResult.rows[0],
          currency: 'KSH'
        }
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

      // Check current balance
      const balanceQuery = `
        SELECT balance FROM wallets 
        WHERE user_id = $1
      `;
      const balanceResult = await client.query(balanceQuery, [userId]);
      const currentBalance = balanceResult.rows[0].balance;

      if (currentBalance < amount) {
        throw new Error('Insufficient funds');
      }

      // Insert transaction record
      const transactionQuery = `
        INSERT INTO wallet_transactions 
        (user_id, wallet_id, amount, currency, transaction_type, description) 
        VALUES (
          $1, 
          (SELECT id FROM wallets WHERE user_id = $1), 
          $2, 
          'KSH',
          'withdrawal', 
          $3
        ) RETURNING *
      `;
      const transactionResult = await client.query(transactionQuery, [
        userId, 
        amount, 
        description
      ]);

      // Update wallet balance
      const updateQuery = `
        UPDATE wallets 
        SET 
          balance = balance - $2,
          total_withdrawn = total_withdrawn + $2,
          last_transaction_date = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
        RETURNING *
      `;
      const walletResult = await client.query(updateQuery, [userId, amount]);

      // Sync wallet balance to users table
      await balanceService.syncWalletBalanceToUser(userId);

      // Commit transaction
      await client.query('COMMIT');

      return {
        transaction: {
          ...transactionResult.rows[0],
          currency: 'KSH'
        },
        wallet: {
          ...walletResult.rows[0],
          currency: 'KSH'
        }
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
          total_bet_amount = total_bet_amount + $2,
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
          amount, 
          type, 
          description, 
          status
        ) VALUES ($1, $2, 'BET', 'Game Bet', 'COMPLETED')
      `;
      await client.query(transactionQuery, [userId, betAmount]);

      // Commit the transaction
      await client.query('COMMIT');

      return result.rows[0].balance;
    } catch (error) {
      // Rollback the transaction in case of error
      await client.query('ROLLBACK');
      console.error('Error placing bet:', error);
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
}
