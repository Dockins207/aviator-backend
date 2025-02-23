import WalletRepository from '../repositories/walletRepository.js';
import RedisRepository from '../redis-services/redisRepository.js';
import logger from '../config/logger.js';
import { v4 as uuidv4 } from 'uuid';
import socketManager from '../sockets/socketManager.js';

// Distributed locking configuration
const WALLET_LOCK_DURATION = 10000; // 10 seconds
const WALLET_LOCK_RETRY_DELAY = 500; // 500ms between retries

class WalletService {
  // Acquire a distributed lock for a wallet transaction
  async acquireWalletLock(userId, lockReason) {
    const lockKey = `wallet_lock:${userId}`;
    const lockValue = uuidv4();
    const redisClient = await RedisRepository.getClient();

    try {
      // Try to acquire lock with NX (only if not exists) and PX (expiry in milliseconds)
      const lockAcquired = await redisClient.set(lockKey, lockValue, {
        NX: true,
        PX: WALLET_LOCK_DURATION
      });

      if (!lockAcquired) {
        throw new Error('Wallet transaction in progress');
      }

      return { lockKey, lockValue };
    } catch (error) {
      throw error;
    }
  }

  // Release a distributed wallet lock
  async releaseWalletLock(lockKey, lockValue) {
    const redisClient = await RedisRepository.getClient();

    try {
      // Lua script to ensure we only release our own lock
      const unlockScript = `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        else
          return 0
        end
      `;

      await redisClient.eval(unlockScript, {
        keys: [lockKey],
        arguments: [lockValue]
      });
    } catch (error) {
      throw error;
    }
  }

  // Initialize wallet for a new user during registration
  async initializeWallet(userId) {
    try {
      const walletId = uuidv4();
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_id:${userId}`;

      // Create wallet in PostgreSQL
      const createWalletQuery = `
        INSERT INTO wallets (wallet_id, user_id, balance, currency) 
        VALUES ($1, $2, 0, 'KSH')
        RETURNING *
      `;
      const client = await WalletRepository.getPoolClient();
      const walletResult = await client.query(createWalletQuery, [walletId, userId]);

      // Cache wallet ID in Redis
      await redisClient.set(redisCacheKey, walletId, { 
        EX: 24 * 60 * 60 // 24 hours expiration 
      });

      return walletResult.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Get user wallet details with Redis caching
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
      // First try to get balance from Redis cache
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      const cachedBalance = await redisClient.get(redisCacheKey);

      if (cachedBalance !== null) {
        return parseFloat(cachedBalance);
      }

      // If not in cache, get from database
      const wallet = await WalletRepository.getWalletByUserId(userId);
      
      if (!wallet) {
        throw new Error('WALLET_NOT_FOUND');
      }

      // Cache the balance for future use
      await redisClient.set(redisCacheKey, wallet.balance.toString(), {
        EX: 60 // Cache for 1 minute
      });

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

  // Deposit funds with distributed transaction and caching
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

      // Update Redis cache
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(redisCacheKey, result.newBalance);

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

  // Place bet with distributed transaction and caching
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

      // Update Redis cache
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(redisCacheKey, result.newBalance);

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

  // Process game winnings with distributed transaction and caching
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

      // Update Redis cache
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(redisCacheKey, result.newBalance);

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

  // Withdraw funds with distributed transaction and caching
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

      // Update Redis cache
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(redisCacheKey, result.newBalance);

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

  // Get transaction history with optional Redis caching
  async getTransactionHistory(userId, limit = 50, offset = 0) {
    try {
      // Fetch transaction history from PostgreSQL
      const transactions = await WalletRepository.getTransactionHistory(
        userId, 
        limit, 
        offset
      );

      // Optional: Cache recent transaction history in Redis
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `transaction_history:${userId}:${limit}:${offset}`;
      await redisClient.set(
        redisCacheKey, 
        JSON.stringify(transactions), 
        { EX: 3600 }  // 1-hour cache expiration
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

      // Cache wallet in Redis
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(redisCacheKey, wallet.balance);

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

      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      
      // Verify and sync balance
      const balanceVerification = await WalletRepository.verifyAndSyncBalance(userId);

      // Prepare consistent response structure
      const balanceResponse = {
        userId,
        balance: balanceVerification.calculatedBalance,
        currency: 'KSH',  // Default currency
        formattedBalance: `KSH ${balanceVerification.calculatedBalance.toFixed(2)}`,
        balanceVerified: balanceVerification.corrected,
        balanceCorrectionReason: balanceVerification.reason || null
      };

      // Cache in Redis
      await redisClient.set(redisCacheKey, balanceResponse.balance);

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

      // First, get the wallet ID for the user
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_id:${userId}`;
      const balanceCacheKey = `wallet_balance:${userId}`;
      
      // Cache expiration time (24 hours)
      const CACHE_EXPIRATION = 24 * 60 * 60; // 24 hours in seconds

      let walletId = await redisClient.get(redisCacheKey);

      // Perform deposit in PostgreSQL
      const result = await WalletRepository.deposit(
        userId, 
        walletId || undefined,  // Pass undefined if walletId is null
        amount, 
        description
      );

      // Update Redis cache with new balance and set expiration
      await redisClient.set(balanceCacheKey, result.newBalance, { 
        EX: CACHE_EXPIRATION 
      });

      // Cache wallet ID if not already cached and set expiration
      if (!walletId) {
        await redisClient.set(redisCacheKey, result.walletId, { 
          EX: CACHE_EXPIRATION 
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

      // Cache expiration time (24 hours)
      const CACHE_EXPIRATION = 24 * 60 * 60; // 24 hours in seconds

      // Perform withdrawal in PostgreSQL
      const result = await WalletRepository.withdraw(userId, amount, description);

      // Update Redis cache
      const redisClient = await RedisRepository.getClient();
      const balanceCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(balanceCacheKey, result.newBalance, { 
        EX: CACHE_EXPIRATION 
      });

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

      // Update Redis cache
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      await redisClient.set(redisCacheKey, result.newBalance);

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

  // Clear outdated Redis entries for a specific user
  async clearOutdatedRedisEntries(userId) {
    try {
      const redisClient = await RedisRepository.getClient();
      
      // Define keys to clean
      const keyPatterns = [
        `wallet_balance:${userId}`,
        `wallet_id:${userId}`,
        `transaction_history:${userId}:*`,
        `user_token:${userId}`,
        `bet_history:${userId}:*`
      ];

      // Iterate and delete matching keys
      for (const pattern of keyPatterns) {
        const keys = await redisClient.keys(pattern);
        
        if (keys.length > 0) {
          await redisClient.del(...keys);
        }
      }
    } catch (error) {
      throw error;
    }
  }

  // Periodic cleanup of user's Redis data
  async scheduleRedisCleanup(userId, intervalMinutes = 60) {
    try {
      const redisClient = await RedisRepository.getClient();
      const cleanupKey = `redis_cleanup:${userId}`;

      // Check if cleanup is already scheduled
      const existingCleanup = await redisClient.get(cleanupKey);
      if (existingCleanup) return;

      // Schedule cleanup
      await redisClient.set(
        cleanupKey, 
        'scheduled', 
        { 
          EX: intervalMinutes * 60, // Convert minutes to seconds
          NX: true // Only set if not exists
        }
      );

      // Perform cleanup
      await this.clearOutdatedRedisEntries(userId);
    } catch (error) {
      throw error;
    }
  }

  // Manual cleanup method for immediate use
  async manualRedisCleanup(userId) {
    try {
      await this.clearOutdatedRedisEntries(userId);
      return true;
    } catch (error) {
      return false;
    }
  }

  async verifyUserBalance(userId) {
    try {
      const redisClient = await RedisRepository.getClient();
      const redisCacheKey = `wallet_balance:${userId}`;
      
      // Verify and sync balance
      const balanceVerification = await WalletRepository.verifyAndSyncBalance(userId);

      // Prepare consistent response structure
      const balanceResponse = {
        userId,
        walletId: balanceVerification.walletId,
        balance: balanceVerification.currentBalance,
        balanceVerified: balanceVerification.corrected,
        currency: 'KSH'
      };

      // Cache in Redis
      await redisClient.set(redisCacheKey, balanceResponse.balance);

      return balanceResponse;
    } catch (error) {
      throw error;
    }
  }

  // Get user balance for bet placement validation
  async getUserBalance(userId) {
    try {
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
