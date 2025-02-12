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
      const transactions = await WalletRepository.getTransactionHistory(
        userId, 
        limit, 
        offset
      );
      return transactions;
    } catch (error) {
      logger.error('Transaction history retrieval failed', { 
        userId, 
        errorMessage: error.message 
      });
      throw error;
    }
  }
};
