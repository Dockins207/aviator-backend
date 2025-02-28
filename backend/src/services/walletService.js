import logger from '../config/logger.js';
import { v4 as uuidv4 } from 'uuid';
import socketManager from '../sockets/socketManager.js';
import WalletRepository from '../repositories/walletRepository.js';

// Distributed locking configuration
const WALLET_LOCK_DURATION = 10000; // 10 seconds
const WALLET_LOCK_RETRY_DELAY = 500; // 500ms between retries

class WalletService {
  // In-memory lock tracking
  static walletLocks = new Map();

  // Acquire a distributed lock for a wallet transaction
  async acquireWalletLock(userId, lockReason) {
    const lockKey = `wallet_lock:${userId}`;
    const lockValue = uuidv4();
    const currentTime = Date.now();

    // Check if the lock exists and is still valid
    const existingLock = WalletService.walletLocks.get(lockKey);
    if (existingLock && (currentTime - existingLock.timestamp) < WALLET_LOCK_DURATION) {
      throw new Error('Wallet transaction in progress');
    }

    // Acquire the lock
    WalletService.walletLocks.set(lockKey, {
      value: lockValue,
      timestamp: currentTime
    });

    return { lockKey, lockValue };
  }

  // Release a wallet lock
  async releaseWalletLock(lockKey, lockValue) {
    const existingLock = WalletService.walletLocks.get(lockKey);
    
    // Only release if the lock exists and matches the value
    if (existingLock && existingLock.value === lockValue) {
      WalletService.walletLocks.delete(lockKey);
    }
  }

  // Clean up expired locks periodically
  static cleanupExpiredLocks() {
    const currentTime = Date.now();
    for (const [key, lock] of this.walletLocks.entries()) {
      if ((currentTime - lock.timestamp) >= WALLET_LOCK_DURATION) {
        this.walletLocks.delete(key);
      }
    }
  }

  // Initialize wallet for a new user during registration
  async initializeWallet(userId) {
    try {
      const walletId = uuidv4();
      
      // Create wallet in PostgreSQL
      const createWalletQuery = `
        INSERT INTO wallets (wallet_id, user_id, balance, currency) 
        VALUES ($1, $2, 0, 'KSH')
        RETURNING *
      `;
      const client = await WalletRepository.getPoolClient();
      const walletResult = await client.query(createWalletQuery, [walletId, userId]);

      return walletResult.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Get user wallet details
  async getWallet(userId) {
    try {
      const wallet = await WalletRepository.getWalletByUserId(userId);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }
      
      // Return wallet with formatted balance details
      return {
        ...wallet,
        balance: wallet.balance,
        formattedBalance: wallet.balance.toLocaleString('en-US', { style: 'currency', currency: wallet.currency }),
        displayBalance: `${wallet.currency} ${wallet.balance.toFixed(2)}`
      };
    } catch (error) {
      console.error('Wallet retrieval failed', { userId });
      throw error;
    }
  }

  /**
   * Get current wallet balance for a user
   * @param {string} userId - User ID to get balance for
   * @returns {Promise<number>} Current wallet balance
   * @throws {Error} If wallet not found or other errors
   */
  async getWalletBalance(userId) {
    try {
      // Fetch current wallet
      const wallet = await WalletRepository.getWalletByUserId(userId);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      return wallet.balance;
    } catch (error) {
      logger.error('WALLET_BALANCE_RETRIEVAL_FAILED', {
        userId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  // Deposit funds with distributed transaction
  async deposit(userId, amount, description = 'Manual Deposit', paymentMethod = 'manual', currency = 'KSH') {
    let walletLock = null;
    try {
      // Validate amount
      if (amount <= 0) {
        throw new Error('Deposit amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'deposit_transaction'
      );

      // Perform deposit in PostgreSQL
      const result = await WalletRepository.deposit(
        userId, 
        null,  // Let repository find or create wallet
        amount, 
        description,
        paymentMethod,
        currency
      );

      return result;
    } catch (error) {
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Place bet with distributed transaction
  async placeBet(userId, betAmount, gameId) {
    let walletLock = null;
    try {
      // Validate bet amount
      if (betAmount <= 0) {
        throw new Error('Bet amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'bet_placement_transaction'
      );

      // Perform bet placement in PostgreSQL
      const result = await WalletRepository.deposit(
        userId, 
        null,  // Let repository find wallet
        -betAmount,  // Negative amount for bet
        `Bet Placement for Game ${gameId}`,
        'game_bet',
        'KSH'
      );

      // Broadcast wallet update via socket
      const walletSocket = WalletRepository.getWalletSocket();
      if (walletSocket) {
        walletSocket.emitWalletUpdate({
          userId,
          walletId: result.walletId,
          balance: result.newBalance,
          transactionType: 'bet',
          amount: betAmount,
          gameId,
          timestamp: new Date().toISOString()
        });
      }

      return result;
    } catch (error) {
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Process game winnings with distributed transaction
  async processWinnings(userId, winAmount, gameId) {
    let walletLock = null;
    try {
      // Validate win amount
      if (winAmount <= 0) {
        throw new Error('Win amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'game_winnings_transaction'
      );

      // Process winnings in PostgreSQL
      const result = await WalletRepository.deposit(
        userId, 
        null,  // Let repository find wallet
        winAmount,
        `Game Winnings for Game ${gameId}`,
        'game_win',
        'KSH'
      );

      // Broadcast wallet update via socket
      const walletSocket = WalletRepository.getWalletSocket();
      if (walletSocket) {
        walletSocket.emitWalletUpdate({
          userId,
          walletId: result.walletId,
          balance: result.newBalance,
          transactionType: 'win',
          amount: winAmount,
          gameId,
          timestamp: new Date().toISOString()
        });
      }

      return result;
    } catch (error) {
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Withdraw funds with distributed transaction
  async withdraw(userId, amount, description = 'Manual Withdrawal') {
    let walletLock = null;
    try {
      // Validate amount
      if (amount <= 0) {
        throw new Error('Withdrawal amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'withdrawal_transaction'
      );

      // Perform withdrawal in PostgreSQL
      const result = await WalletRepository.recordTransaction(
        userId, 
        'withdraw', 
        amount, 
        null,  // Will be calculated in the method
        { description }
      );

      return result;
    } catch (error) {
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Get transaction history
  async getTransactionHistory(userId, limit = 50, offset = 0) {
    try {
      // Fetch transaction history from PostgreSQL
      const transactions = await WalletRepository.getTransactionHistory(
        userId, 
        limit, 
        offset
      );

      return transactions;
    } catch (error) {
      throw error;
    }
  }

  // Create wallet for a user if not exists
  async createWallet(userId) {
    let walletLock = null;
    try {
      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'wallet_creation'
      );

      // Create wallet in PostgreSQL
      const wallet = await WalletRepository.createWallet(userId);
      
      if (!wallet) {
        throw new Error('Unable to create wallet');
      }

      return wallet;
    } catch (error) {
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Get user wallet details
  async getUserProfileBalance(userId) {
    try {
      // Validate userId
      if (!userId) {
        throw new Error('Invalid User ID');
      }

      // Fetch current wallet
      const wallet = await WalletRepository.getWalletByUserId(userId);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      // Prepare consistent response structure
      const balanceResponse = {
        userId,
        balance: wallet.balance,
        currency: 'KSH',  // Default currency
        formattedBalance: `KSH ${wallet.balance.toFixed(2)}`,
        balanceVerified: true,
        balanceCorrectionReason: null
      };

      return balanceResponse;
    } catch (error) {
      throw error;
    }
  }

  // Deposit funds into user wallet
  async depositFunds(userId, amount, description = 'Manual Deposit') {
    let walletLock;
    try {
      // Validate input
      if (amount <= 0) {
        throw new Error('Deposit amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'deposit_transaction'
      );

      // Perform deposit in PostgreSQL
      const result = await WalletRepository.deposit(
        userId, 
        null,  // Let repository find or create wallet
        amount, 
        description
      );

      return result;
    } catch (error) {
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Withdraw funds from user wallet
  async withdrawFunds(userId, amount, description = 'Manual Withdrawal') {
    let walletLock = null;
    try {
      // Validate amount
      if (amount <= 0) {
        throw new Error('Withdrawal amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'withdrawal_transaction'
      );

      // Perform withdrawal in PostgreSQL
      const result = await WalletRepository.withdraw(userId, amount, description);

      return result;
    } catch (error) {
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Cashout method with real-time balance update
  async cashout(userId, cashoutAmount, gameId) {
    let walletLock = null;
    try {
      // Validate cashout amount
      if (cashoutAmount <= 0) {
        throw new Error('Cashout amount must be positive');
      }

      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        userId, 
        'cashout_transaction'
      );

      // Perform cashout in PostgreSQL
      const result = await WalletRepository.deposit(
        userId, 
        null,  // Let repository find wallet
        cashoutAmount,  // Positive amount for cashout
        `Game Cashout for Game ${gameId}`,
        'game_cashout',
        'KSH'
      );

      // Broadcast wallet update via socket
      const walletSocket = WalletRepository.getWalletSocket();
      if (walletSocket) {
        walletSocket.emitWalletUpdate({
          userId,
          walletId: result.walletId,
          balance: result.newBalance,
          transactionType: 'cashout',
          amount: cashoutAmount,
          gameId,
          timestamp: new Date().toISOString()
        });
      }

      return result;
    } catch (error) {
      throw error;
    } finally {
      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  // Manual cleanup method for immediate use
  async manualRedisCleanup(userId) {
    try {
      // No-op since Redis caching is removed
      return true;
    } catch (error) {
      return false;
    }
  }

  async verifyUserBalance(userId) {
    try {
      // Fetch current wallet
      const wallet = await WalletRepository.getWalletByUserId(userId);
      
      if (!wallet) {
        throw new Error('Wallet not found');
      }

      // Prepare consistent response structure
      const balanceResponse = {
        userId,
        walletId: wallet.id,
        balance: wallet.balance,
        balanceVerified: true,
        currency: 'KSH'
      };

      return balanceResponse;
    } catch (error) {
      throw error;
    }
  }

  // Get user balance for bet placement validation
  async getUserBalance(userId) {
    try {
      // Fetch current wallet
      const wallet = await this.getWallet(userId);
      
      if (!wallet || wallet.balance === undefined) {
        logger.error('WALLET_BALANCE_RETRIEVAL_FAILED', {
          userId,
          context: 'getUserBalance'
        });
        throw new Error('Unable to retrieve user wallet balance');
      }

      // Validate wallet currency and balance
      if (wallet.currency !== 'KSH') {
        logger.warn('UNSUPPORTED_WALLET_CURRENCY', {
          userId,
          currency: wallet.currency,
          context: 'getUserBalance'
        });
        throw new Error('Unsupported wallet currency');
      }

      if (wallet.balance < 0) {
        logger.error('NEGATIVE_WALLET_BALANCE', {
          userId,
          balance: wallet.balance,
          context: 'getUserBalance'
        });
        throw new Error('Invalid wallet balance');
      }

      return wallet.balance;
    } catch (error) {
      logger.error('USER_BALANCE_RETRIEVAL_ERROR', {
        userId,
        errorMessage: error.message,
        context: 'getUserBalance'
      });
      throw error;
    }
  }

  // Deduct balance from user's wallet with distributed locking
  async deductWalletBalance(userId, amount) {
    if (!userId || amount <= 0) {
      throw new Error('Invalid user ID or amount for wallet deduction');
    }

    let lock = null;
    try {
      // Acquire distributed lock for wallet transaction
      lock = await this.acquireWalletLock(userId, 'bet_placement');

      // Fetch current wallet
      const wallet = await WalletRepository.findWalletByUserId(userId);

      if (!wallet) {
        throw new Error(`Wallet not found for user ${userId}`);
      }

      // Check sufficient balance
      if (wallet.balance < amount) {
        throw new Error('Insufficient wallet balance');
      }

      // Deduct balance
      const updatedWallet = await WalletRepository.updateWalletBalance(userId, -amount);

      // Log transaction
      logger.info('WALLET_BALANCE_DEDUCTED', {
        userId,
        amount,
        newBalance: updatedWallet.balance
      });

      // Emit real-time wallet update
      const io = socketManager.getIO();
      if (io) {
        const walletSocket = io.of('/wallet');
        walletSocket.to(userId).emit('wallet:update', {
          userId,
          walletId: updatedWallet.id,
          balance: updatedWallet.balance,
          transactionType: 'deduction',
          amount: amount,
          timestamp: new Date().toISOString()
        });
      }

      return updatedWallet;
    } catch (error) {
      logger.error('WALLET_DEDUCTION_ERROR', {
        userId,
        amount,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    } finally {
      // Release the lock
      if (lock) {
        await this.releaseWalletLock(lock.lockKey, lock.lockValue);
      }
    }
  }

  // Credit balance back to user's wallet (for refunds/winnings)
  async creditWalletBalance(userId, amount, description = 'Refund') {
    if (!userId || amount <= 0) {
      throw new Error('Invalid user ID or amount for wallet credit');
    }

    let lock = null;
    try {
      // Acquire distributed lock for wallet transaction
      lock = await this.acquireWalletLock(userId, 'wallet_credit');

      // Fetch current wallet
      const wallet = await WalletRepository.findWalletByUserId(userId);

      if (!wallet) {
        throw new Error(`Wallet not found for user ${userId}`);
      }

      // Credit balance
      const updatedWallet = await WalletRepository.updateWalletBalance(userId, amount);

      // Log transaction
      logger.info('WALLET_BALANCE_CREDITED', {
        userId,
        amount,
        description,
        newBalance: updatedWallet.balance
      });

      // Emit real-time wallet update
      const io = socketManager.getIO();
      if (io) {
        const walletSocket = io.of('/wallet');
        walletSocket.to(userId).emit('wallet:update', {
          userId,
          walletId: updatedWallet.id,
          balance: updatedWallet.balance,
          transactionType: 'credit',
          amount: amount,
          description,
          timestamp: new Date().toISOString()
        });
      }

      return updatedWallet;
    } catch (error) {
      logger.error('WALLET_CREDIT_ERROR', {
        userId,
        amount,
        description,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    } finally {
      // Release the lock
      if (lock) {
        await this.releaseWalletLock(lock.lockKey, lock.lockValue);
      }
    }
  }
}

export default new WalletService();
