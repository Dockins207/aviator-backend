import redisConnection from '../config/redisConfig.js';
import logger from '../config/logger.js';
import { v4 as uuidv4 } from 'uuid';
import WalletRepository from '../repositories/walletRepository.js';
import pool from '../config/database.js';

class RedisRepository {
  constructor() {
    // Do not get client immediately, defer until first use
    this._client = null;
  }

  // Lazy client retrieval
  async getClient() {
    if (!this._client) {
      // Ensure connection is established
      const connection = await import('../config/redisConfig.js');
      await connection.default.connect();
      this._client = connection.default.getClient();
    }
    return this._client;
  }

  // Store a bet in Redis with expiration
  async storeBet(gameId, betData, expirationSeconds = 3600) {
    try {
      const client = await this.getClient();
      
      // Validate and sanitize bet data
      if (!gameId || !betData) {
        logger.error('REDIS_BET_STORAGE_INVALID_INPUT', {
          gameId,
          betData: JSON.stringify(betData)
        });
        throw new Error('Invalid bet data or game ID');
      }

      // Ensure bet has a unique identifier
      const betId = betData.id || betData.betId || uuidv4();
      
      // Prepare bet data for storage
      const sanitizedBetData = {
        id: betId,
        userId: betData.userId,
        betAmount: betData.betAmount,
        gameSessionId: gameId,
        status: betData.status || 'placed',
        timestamp: Date.now(),
        ...betData
      };

      // Use a hash to store bet details
      const betKey = `game:${gameId}:bets`;
      
      // Store bet as a JSON string
      await client.hSet(
        betKey, 
        betId, 
        JSON.stringify(sanitizedBetData)
      );
      
      // Set expiration for the entire hash
      await client.expire(betKey, expirationSeconds);

      logger.info('REDIS_BET_STORED', {
        gameId,
        betId,
        betAmount: sanitizedBetData.betAmount
      });

      return sanitizedBetData;
    } catch (error) {
      logger.error('REDIS_BET_STORAGE_ERROR', {
        gameId,
        errorMessage: error.message,
        betData: JSON.stringify(betData)
      });
      throw error;
    }
  }

  // Get bet by specific ID
  async getBetById(gameId, betId) {
    try {
      const client = await this.getClient();
      const betKey = `game:${gameId}:bets`;
      const betJson = await client.hGet(betKey, betId);
      
      if (betJson) {
        return JSON.parse(betJson);
      }
      
      return null;
    } catch (error) {
      logger.error(error);
      return null;
    }
  }

  // Atomic bet status update with optimistic locking
  async updateBetStatusAtomic(gameId, betId, expectedStatus, newStatus) {
    try {
      const client = await this.getClient();
      const betKey = `game:${gameId}:bets`;
      const betJson = await client.hGet(betKey, betId);
      
      if (!betJson) {
        return false;
      }
      
      const bet = JSON.parse(betJson);
      
      // Optimistic locking: only update if current status matches expected
      if (bet.status !== expectedStatus) {
        return false;
      }
      
      bet.status = newStatus;
      await client.hSet(betKey, betId, JSON.stringify(bet));
      
      return true;
    } catch (error) {
      logger.error(error);
      return false;
    }
  }

  // Track game-level metrics in Redis
  async incrementGameMetrics(gameId, metricKey, incrementValue = 1) {
    try {
      const client = await this.getClient();
      const key = `game:${gameId}:metrics:${metricKey}`;
      
      // Special handling for crash_points to convert to integer
      let finalIncrementValue = incrementValue;
      if (metricKey === 'crash_points') {
        // Convert to integer by multiplying by 100 to preserve 2 decimal places
        finalIncrementValue = Math.round(incrementValue * 100);
      }
      
      // Ensure the value is an integer
      const currentValue = await client.get(key) || '0';
      const numericValue = parseInt(currentValue, 10);
      
      const result = await client.incrBy(key, finalIncrementValue);
      
      // Set expiration to prevent metric accumulation
      await client.expire(key, 3600);  // 1 hour expiration
      
      return result;
    } catch (error) {
      logger.error(error);
      return 0;
    }
  }

  // Get game-level metrics
  async getGameMetrics(gameId, metricKey) {
    try {
      const client = await this.getClient();
      const key = `game:${gameId}:metrics:${metricKey}`;
      const value = await client.get(key);
      
      // Special handling for crash_points to convert back to float
      if (metricKey === 'crash_points' && value) {
        return parseFloat((parseInt(value, 10) / 100).toFixed(2));
      }
      
      return value ? parseInt(value, 10) : 0;
    } catch (error) {
      logger.error(error);
      return 0;
    }
  }

  // Update bet status
  async updateBetStatus(gameId, betId, status) {
    try {
      const client = await this.getClient();
      const betKey = `game:${gameId}:bets`;
      const betJson = await client.hGet(betKey, betId);
      
      if (betJson) {
        const bet = JSON.parse(betJson);
        bet.status = status;
        
        await client.hSet(betKey, betId, JSON.stringify(bet));
      }
    } catch (error) {
      logger.error(error);
    }
  }

  // Clear all bets for a game
  async clearGameBets(gameId) {
    try {
      const client = await this.getClient();
      await client.del(`game:${gameId}:bets`);
    } catch (error) {
      logger.error(error);
    }
  }

  // Get total bet amount for a game
  async getTotalBetAmount(gameId) {
    try {
      const client = await this.getClient();
      const bets = await client.hGetAll(`game:${gameId}:bets`);
      
      const totalBetAmount = Object.values(bets)
        .map(betJson => JSON.parse(betJson))
        .reduce((total, bet) => total + bet.amount, 0);

      return totalBetAmount;
    } catch (error) {
      logger.error(error);
      return 0;
    }
  }

  // Get all bets for a specific game
  async getAllGameBets(gameId) {
    try {
      const client = await this.getClient();
      const betKey = `game:${gameId}:bets`;
      
      // Get all bets in the hash
      const betEntries = await client.hGetAll(betKey);
      
      // Convert hash entries to bet objects
      const bets = Object.entries(betEntries).map(([betId, betJson]) => {
        try {
          const bet = JSON.parse(betJson);
          return { ...bet, id: betId };
        } catch (parseError) {
          logger.error('BET_PARSE_ERROR', {
            gameId,
            betId,
            errorMessage: parseError.message
          });
          return null;
        }
      }).filter(bet => bet !== null);
      
      return bets;
    } catch (error) {
      logger.error('GET_ALL_GAME_BETS_ERROR', {
        gameId,
        errorMessage: error.message
      });
      return [];
    }
  }

  /**
   * Push a bet to a specific game session
   * @param {string} gameSessionId - Game session ID
   * @param {string} userId - User ID who placed the bet
   * @param {number} betAmount - Amount of the bet
   * @param {string} status - Status of the bet
   */
  async pushBetToGameSession(gameSessionId, userId, betAmount, status) {
    try {
      const client = await this.getClient();
      const betId = uuidv4(); // Generate unique bet ID
      
      // Prepare bet data
      const betData = {
        id: betId,
        userId,
        amount: betAmount,
        status,
        timestamp: Date.now()
      };

      // Store bet in game session hash
      const betKey = `game:${gameSessionId}:bets`;
      await client.hSet(betKey, betId, JSON.stringify(betData));
      
      // Set expiration for the bet hash
      await client.expire(betKey, 3600); // 1 hour expiration

      // Track bet metrics
      redisConnection.trackBetMetrics(gameSessionId, betAmount);

      logger.info('BET_PUSHED_TO_REDIS', {
        gameSessionId,
        userId,
        betAmount,
        betId,
        status
      });

      return betId;
    } catch (error) {
      logger.error('REDIS_BET_PUSH_FAILED', {
        errorMessage: error.message,
        gameSessionId,
        userId,
        betAmount
      });
      throw error;
    }
  }

  /**
   * Acquire a distributed lock for wallet transactions
   * @param {string} walletId - Wallet identifier
   * @param {string} lockReason - Reason for the lock
   * @param {number} lockDuration - Lock duration in milliseconds
   * @returns {Promise<Object>} Lock details
   */
  async acquireWalletLock(walletId, lockReason, lockDuration = 5000) {
    try {
      const client = await this.getClient();
      const lockKey = `wallet_lock:${walletId}`;
      const lockValue = uuidv4();

      // Attempt to acquire lock using Redis SET with NX (only if not exists) and PX (expiry in milliseconds)
      const lockAcquired = await client.set(lockKey, lockValue, {
        NX: true,  // Only set if not exists
        PX: lockDuration  // Expire after specified duration
      });

      if (!lockAcquired) {
        logger.warn('WALLET_LOCK_CONTENTION', {
          walletId,
          lockReason,
          message: 'Unable to acquire wallet lock'
        });
        throw new Error('Wallet transaction in progress');
      }

      logger.info('WALLET_LOCK_ACQUIRED', {
        walletId,
        lockReason,
        lockValue: lockValue.slice(0, 8) + '...'  // Partial value for logging
      });

      return { lockKey, lockValue };
    } catch (error) {
      logger.error('WALLET_LOCK_ACQUISITION_FAILED', {
        walletId,
        lockReason,
        errorMessage: error.message
      });
      throw error;
    }
  }

  /**
   * Release a distributed wallet lock
   * @param {string} lockKey - Lock key
   * @param {string} lockValue - Lock value
   * @returns {Promise<boolean>} Whether lock was successfully released
   */
  async releaseWalletLock(lockKey, lockValue) {
    try {
      const client = await this.getClient();

      // Lua script to ensure we only release our own lock
      const unlockScript = `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        else
          return 0
        end
      `;

      const result = await client.eval(
        unlockScript, 
        { keys: [lockKey], arguments: [lockValue] }
      );

      logger.info('WALLET_LOCK_RELEASED', {
        lockKey,
        lockReleased: result === 1
      });

      return result === 1;
    } catch (error) {
      logger.error('WALLET_LOCK_RELEASE_FAILED', {
        lockKey,
        errorMessage: error.message
      });
      return false;
    }
  }

  /**
   * Debit user wallet for bet placement with distributed locking and PostgreSQL sync
   * @param {string} walletId - Wallet identifier
   * @param {number} betAmount - Amount to debit
   * @returns {Promise<Object>} Wallet transaction result
   */
  async debitWalletForBet(walletId, betAmount) {
    let walletLock = null;
    const client = await pool.connect();

    try {
      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        walletId, 
        'bet_placement'
      );

      // Start database transaction
      await client.query('BEGIN');

      // Retrieve current wallet balance
      const walletQuery = 'SELECT balance FROM wallets WHERE wallet_id = $1 FOR UPDATE';
      const walletResult = await client.query(walletQuery, [walletId]);

      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found');
      }

      const currentBalance = parseFloat(walletResult.rows[0].balance);

      // Validate sufficient balance
      if (currentBalance < betAmount) {
        logger.error('INSUFFICIENT_WALLET_BALANCE', {
          walletId,
          currentBalance,
          betAmount
        });
        throw new Error('Insufficient wallet balance');
      }

      // Perform debit transaction in PostgreSQL
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance - $1, 
            updated_at = CURRENT_TIMESTAMP 
        WHERE wallet_id = $2
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [betAmount, walletId]);
      const newBalance = parseFloat(updateResult.rows[0].balance);

      // Commit transaction
      await client.query('COMMIT');

      // Update Redis cache
      const redisClient = await this.getClient();
      const walletKey = `wallet:${walletId}`;
      await redisClient.hSet(walletKey, {
        balance: newBalance.toFixed(2),
        lastTransactionType: 'bet_placement',
        lastTransactionAmount: betAmount.toFixed(2),
        lastTransactionTimestamp: new Date().toISOString()
      });

      logger.info('WALLET_BET_DEBIT', {
        walletId,
        betAmount,
        previousBalance: currentBalance,
        newBalance
      });

      return {
        walletId,
        previousBalance: currentBalance,
        betAmount,
        newBalance
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

      logger.error('WALLET_DEBIT_ERROR', {
        walletId,
        betAmount,
        errorMessage: error.message
      });
      throw error;
    } finally {
      // Always release client to the pool
      client.release();

      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  /**
   * Credit user wallet for bet cashout with distributed locking and PostgreSQL sync
   * @param {string} walletId - Wallet identifier
   * @param {number} winnings - Amount to credit
   * @returns {Promise<Object>} Wallet transaction result
   */
  async creditWalletForCashout(walletId, winnings) {
    let walletLock = null;
    const client = await pool.connect();

    try {
      // Acquire distributed lock
      walletLock = await this.acquireWalletLock(
        walletId, 
        'bet_cashout'
      );

      // Start database transaction
      await client.query('BEGIN');

      // Retrieve current wallet balance
      const walletQuery = 'SELECT balance FROM wallets WHERE wallet_id = $1 FOR UPDATE';
      const walletResult = await client.query(walletQuery, [walletId]);

      if (walletResult.rows.length === 0) {
        throw new Error('Wallet not found');
      }

      const currentBalance = parseFloat(walletResult.rows[0].balance);

      // Perform credit transaction in PostgreSQL
      const updateQuery = `
        UPDATE wallets 
        SET balance = balance + $1, 
            updated_at = CURRENT_TIMESTAMP 
        WHERE wallet_id = $2
        RETURNING balance
      `;
      const updateResult = await client.query(updateQuery, [winnings, walletId]);
      const newBalance = parseFloat(updateResult.rows[0].balance);

      // Commit transaction
      await client.query('COMMIT');

      // Update Redis cache
      const redisClient = await this.getClient();
      const walletKey = `wallet:${walletId}`;
      await redisClient.hSet(walletKey, {
        balance: newBalance.toFixed(2),
        lastTransactionType: 'bet_cashout',
        lastTransactionAmount: winnings.toFixed(2),
        lastTransactionTimestamp: new Date().toISOString()
      });

      logger.info('WALLET_CASHOUT_CREDIT', {
        walletId,
        winnings,
        previousBalance: currentBalance,
        newBalance
      });

      return {
        walletId,
        previousBalance: currentBalance,
        winnings,
        newBalance
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');

      logger.error('WALLET_CREDIT_ERROR', {
        walletId,
        winnings,
        errorMessage: error.message
      });
      throw error;
    } finally {
      // Always release client to the pool
      client.release();

      // Always attempt to release lock
      if (walletLock) {
        await this.releaseWalletLock(
          walletLock.lockKey, 
          walletLock.lockValue
        );
      }
    }
  }

  /**
   * Get user wallet balance from PostgreSQL
   * @param {string} walletId - Wallet identifier
   * @returns {Promise<number>} Current wallet balance
   */
  async getWalletBalance(walletId) {
    try {
      const client = await pool.connect();
      
      try {
        // Retrieve wallet by wallet_id
        const walletQuery = `
          SELECT balance 
          FROM wallets 
          WHERE wallet_id = $1
        `;
        const walletResult = await client.query(walletQuery, [walletId]);
        
        if (walletResult.rows.length === 0) {
          throw new Error('Wallet not found');
        }

        const balance = parseFloat(walletResult.rows[0].balance);

        // Update Redis cache
        const redisClient = await this.getClient();
        const walletKey = `wallet:${walletId}`;
        await redisClient.hSet(walletKey, {
          balance: balance.toFixed(2),
          lastRetrieved: new Date().toISOString()
        });

        logger.info('WALLET_BALANCE_RETRIEVED', {
          walletId,
          balance
        });

        return balance;
      } finally {
        // Always release client to the pool
        client.release();
      }
    } catch (error) {
      logger.error('WALLET_BALANCE_RETRIEVAL_ERROR', {
        walletId,
        errorMessage: error.message
      });
      throw error;
    }
  }
}

export default new RedisRepository();
