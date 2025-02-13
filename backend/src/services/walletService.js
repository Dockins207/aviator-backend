import { WalletRepository } from '../repositories/walletRepository.js';
import logger from '../config/logger.js';

export const walletService = {
  // Initialize wallet for a new user during registration
  async initializeWallet(userId) {
    try {
      const wallet = await WalletRepository.createWallet(userId);
      logger.info('Wallet initialized', { userId, walletId: wallet.id });
      return wallet;
    } catch (error) {
      logger.error('Wallet initialization failed', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    }
  },

  // Get user wallet details
  async getWallet(userId) {
    try {
      const wallet = await WalletRepository.getWalletByUserId(userId);
      
      if (!wallet) {
        logger.error('Wallet retrieval failed', { 
          userId, 
          errorMessage: 'Wallet not found' 
        });
        throw new Error('Wallet not found');
      }

      return wallet;
    } catch (error) {
      logger.error('Wallet retrieval failed', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    }
  },

  // Deposit funds
  async deposit(userId, amount, description) {
    try {
      // Validate amount
      if (amount <= 0) {
        throw new Error('Deposit amount must be positive');
      }

      const result = await WalletRepository.deposit(userId, amount, description);
      logger.info('Deposit successful', { 
        userId, 
        amount, 
        currency: 'KSH',
        newBalance: result.wallet.balance 
      });
      return result;
    } catch (error) {
      logger.error('Deposit failed', { 
        userId, 
        amount, 
        currency: 'KSH',
        errorMessage: error.message 
      });
      throw error;
    }
  },

  // Withdraw funds
  async withdraw(userId, amount, description) {
    try {
      // Validate amount
      if (amount <= 0) {
        throw new Error('Withdrawal amount must be positive');
      }

      const result = await WalletRepository.withdraw(userId, amount, description);
      logger.info('Withdrawal successful', { 
        userId, 
        amount, 
        currency: 'KSH',
        newBalance: result.wallet.balance 
      });
      return result;
    } catch (error) {
      logger.error('Withdrawal failed', { 
        userId, 
        amount, 
        currency: 'KSH',
        errorMessage: error.message 
      });
      throw error;
    }
  },

  // Place bet
  async placeBet(userId, betAmount, gameId) {
    try {
      // Validate bet amount
      if (betAmount <= 0) {
        throw new Error('Bet amount must be positive');
      }

      const result = await WalletRepository.placeBet(userId, betAmount, gameId);
      logger.info('Bet placed successfully', { 
        userId, 
        betAmount, 
        currency: 'KSH',
        gameId,
        newBalance: result.wallet.balance 
      });
      return result;
    } catch (error) {
      logger.error('Bet placement failed', { 
        userId, 
        betAmount, 
        currency: 'KSH',
        gameId,
        errorMessage: error.message 
      });
      throw error;
    }
  },

  // Process game winnings
  async processWinnings(userId, winAmount, gameId) {
    try {
      // Validate win amount
      if (winAmount <= 0) {
        throw new Error('Win amount must be positive');
      }

      const result = await WalletRepository.processWinnings(userId, winAmount, gameId);
      logger.info('Winnings processed successfully', { 
        userId, 
        winAmount, 
        currency: 'KSH',
        gameId,
        newBalance: result.wallet.balance 
      });
      return result;
    } catch (error) {
      logger.error('Winnings processing failed', { 
        userId, 
        winAmount, 
        currency: 'KSH',
        gameId,
        errorMessage: error.message 
      });
      throw error;
    }
  },

  // Get transaction history
  async getTransactionHistory(userId, limit = 50, offset = 0) {
    try {
      // Validate input
      if (!userId) {
        throw new Error('User ID is required');
      }

      if (typeof limit !== 'number' || limit < 1) {
        limit = 50; // Default limit
      }

      if (typeof offset !== 'number' || offset < 0) {
        offset = 0; // Default offset
      }

      // Retrieve transaction history
      const transactions = await WalletRepository.getTransactionHistory(
        userId, 
        limit, 
        offset
      );
      
      logger.info('Wallet transaction history retrieved', { 
        userId, 
        transactionCount: transactions.length,
        limit,
        offset
      });

      return {
        userId,
        transactions: transactions.map(transaction => ({
          transactionId: transaction.transaction_id,
          amount: transaction.amount,
          currency: transaction.currency,
          type: transaction.transaction_type,
          description: transaction.description,
          paymentMethod: transaction.payment_method,
          timestamp: transaction.created_at
        })),
        pagination: {
          limit,
          offset,
          total: transactions.length
        }
      };
    } catch (error) {
      logger.error('Failed to retrieve transaction history', { 
        userId, 
        limit,
        offset,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  },

  // Get real-time wallet balance for user profile
  async getUserProfileBalance(userId) {
    try {
      console.log('DEBUG: getUserProfileBalance - Fetching wallet', { userId });
      
      const wallet = await this.getWallet(userId);
      
      console.log('DEBUG: getUserProfileBalance - Wallet retrieved', { 
        userId, 
        wallet: wallet ? {
          id: wallet.id,
          userId: wallet.userId,
          balance: wallet.balance,
          currency: wallet.currency
        } : null 
      });
      
      const balanceResponse = {
        userId: wallet.userId,
        balance: wallet.balance,
        currency: wallet.currency,
        lastUpdated: new Date().toISOString()
      };

      logger.info('User profile balance retrieved', { 
        userId, 
        balance: wallet.balance,
        currency: wallet.currency
      });

      return balanceResponse;
    } catch (error) {
      console.error('DEBUG: getUserProfileBalance - Full error', error);
      
      logger.error('Failed to retrieve user profile balance', { 
        userId, 
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  },

  // Deposit funds into user wallet
  async depositFunds(userId, amount, description = 'Manual Deposit') {
    try {
      // Validate input
      if (!userId) {
        throw new Error('User ID is required');
      }
      
      if (typeof amount !== 'number' || amount <= 0) {
        throw new Error('Invalid deposit amount. Must be a positive number.');
      }

      // Perform deposit
      const updatedWallet = await WalletRepository.deposit(userId, amount, description);
      
      logger.info('Funds deposited successfully', { 
        userId, 
        amount,
        newBalance: updatedWallet.balance,
        currency: updatedWallet.currency
      });

      return {
        userId: updatedWallet.userId,
        balance: updatedWallet.balance,
        currency: updatedWallet.currency,
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Deposit failed', { 
        userId, 
        amount,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  },

  // Withdraw funds from user wallet
  async withdrawFunds(userId, amount, description = 'Manual Withdrawal') {
    try {
      // Validate input
      if (!userId) {
        throw new Error('User ID is required');
      }
      
      if (typeof amount !== 'number' || amount <= 0) {
        throw new Error('Invalid withdrawal amount. Must be a positive number.');
      }

      // Perform withdrawal
      const updatedWallet = await WalletRepository.withdraw(userId, amount, description);
      
      logger.info('Funds withdrawn successfully', { 
        userId, 
        amount,
        newBalance: updatedWallet.balance,
        currency: updatedWallet.currency
      });

      return {
        userId: updatedWallet.userId,
        balance: updatedWallet.balance,
        currency: updatedWallet.currency,
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Withdrawal failed', { 
        userId, 
        amount,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  },
};
