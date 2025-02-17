import { WalletRepository } from '../repositories/walletRepository.js';
import logger from '../config/logger.js';

export const walletService = {
  // Initialize wallet for a new user during registration
  async initializeWallet(userId) {
    try {
      const wallet = await WalletRepository.createWallet(userId);
      return wallet;
    } catch (error) {
      logger.error('Wallet initialization failed', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    }
  },

  // Create wallet for a user if not exists
  async createWallet(userId) {
    try {
      const wallet = await WalletRepository.createWallet(userId);
      
      if (!wallet) {
        logger.error('Wallet creation failed', { 
          userId, 
          errorMessage: 'Unable to create wallet' 
        });
        throw new Error('Unable to create wallet');
      }

      return wallet;
    } catch (error) {
      logger.error('Wallet creation failed', { 
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
      
      // Track wallet event via socket if WalletRepository has socket reference
      if (WalletRepository.walletSocket) {
        await WalletRepository.walletSocket.trackWalletEvent(
          userId, 
          'deposit', 
          amount, 
          description || 'Manual Deposit'
        );
      }

      return result;
    } catch (error) {
      logger.error('Deposit failed', { 
        userId, 
        amount,
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
      
      // Track wallet event via socket if WalletRepository has socket reference
      if (WalletRepository.walletSocket) {
        await WalletRepository.walletSocket.trackWalletEvent(
          userId, 
          'withdrawal', 
          amount, 
          description || 'Manual Withdrawal'
        );
      }

      return result;
    } catch (error) {
      logger.error('Withdrawal failed', { 
        userId, 
        amount,
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
      logger.error('Transaction history retrieval failed', { 
        userId, 
        limit, 
        offset,
        errorMessage: error.message 
      });
      throw error;
    }
  },

  // Get real-time wallet balance for user profile
  async getUserProfileBalance(userId) {
    try {
      const wallet = await WalletRepository.getWalletByUserId(userId);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      return {
        userId: wallet.userId,
        balance: parseFloat(wallet.balance),
        currency: wallet.currency,
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      logger.error('User profile balance retrieval failed', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    }
  },

  // Deposit funds into user wallet
  async depositFunds(userId, amount, description = 'Manual Deposit') {
    try {
      if (amount <= 0) {
        throw new Error('Deposit amount must be positive');
      }

      const result = await WalletRepository.deposit(userId, amount, description);
      return result;
    } catch (error) {
      logger.error('Funds deposit failed', { 
        userId, 
        amount, 
        errorMessage: error.message 
      });
      throw error;
    }
  },

  // Withdraw funds from user wallet
  async withdrawFunds(userId, amount, description = 'Manual Withdrawal') {
    try {
      if (amount <= 0) {
        throw new Error('Withdrawal amount must be positive');
      }

      const result = await WalletRepository.withdraw(userId, amount, description);
      return result;
    } catch (error) {
      logger.error('Funds withdrawal failed', { 
        userId, 
        amount, 
        errorMessage: error.message 
      });
      throw error;
    }
  }
};
