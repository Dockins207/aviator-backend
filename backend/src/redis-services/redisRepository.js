import redisServer from '../redis-server.js';
import logger from '../config/logger.js';
import { v4 as uuidv4 } from 'uuid';
import WalletRepository from '../repositories/walletRepository.js';
import { pool } from '../config/database.js';

// Session Management Configuration
const SESSION_MANAGEMENT_CONFIG = {
  MAX_RETAINED_SESSIONS: 10,
  SESSION_EXPIRY_SECONDS: 3600, // 1 hour
  CONSOLIDATION_THRESHOLD_MINUTES: 60
};

class RedisRepository {
  constructor() {
    this._client = null;
    this.sessionCleanupInterval = null;
    this.gameSessionValidator = null;
    this.betCleanupInterval = null;
    this.loggedGameSessions = new Set(); // Initialize the logged game sessions set
    
    // Use async IIFE to handle initialization
    (async () => {
      await this.initializeClient();
      
      // Set up periodic bet queue cleanup
      this.betCleanupInterval = setInterval(() => {
        this._cleanupExpiredQueuedBets().catch(error => {
          logger.error('BET_CLEANUP_INTERVAL_ERROR', {
            errorMessage: error.message,
            context: 'betCleanupInterval'
          });
        });
      }, SESSION_MANAGEMENT_CONFIG.SESSION_EXPIRY_SECONDS * 500); // Run twice per expiry period
    })();
  }

  // Method to set a custom game session validator
  setGameSessionValidator(validatorFn) {
    this.gameSessionValidator = validatorFn;
  }

  async initializeClient() {
    try {
      console.log('RedisRepository initializing client...');
      this._client = await redisServer.getClient();
      console.log('RedisRepository client initialized successfully');
    } catch (error) {
      logger.error('REDIS_REPOSITORY_INITIALIZATION_ERROR', {
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async multi() {
    try {
      const client = await this.ensureClientReady();
      return client.multi();
    } catch (error) {
      logger.error('REDIS_MULTI_ERROR', {
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async sadd(key, value) {
    try {
      const client = await this.ensureClientReady();
      return await client.sAdd(key, value);
    } catch (error) {
      logger.error('REDIS_SADD_ERROR', {
        key,
        value,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async srem(key, value) {
    try {
      const client = await this.ensureClientReady();
      return await client.sRem(key, value);
    } catch (error) {
      logger.error('REDIS_SREM_ERROR', {
        key,
        value,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async smembers(key) {
    try {
      const client = await this.ensureClientReady();
      return await client.sMembers(key);
    } catch (error) {
      logger.error('REDIS_SMEMBERS_ERROR', {
        key,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async hset(key, value) {
    try {
      const client = await this.ensureClientReady();
      const flatValue = {};
      
      // Flatten and stringify objects for Redis
      Object.entries(value).forEach(([k, v]) => {
        flatValue[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
      });

      return await client.hSet(key, flatValue);
    } catch (error) {
      logger.error('REDIS_HSET_ERROR', {
        key,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async hgetall(key) {
    try {
      const client = await this.ensureClientReady();
      return await client.hGetAll(key);
    } catch (error) {
      logger.error('REDIS_HGETALL_ERROR', {
        key,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async expire(key, seconds) {
    try {
      const client = await this.ensureClientReady();
      return await client.expire(key, seconds);
    } catch (error) {
      logger.error('REDIS_EXPIRE_ERROR', {
        key,
        seconds,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async hdel(key) {
    try {
      const client = await this.ensureClientReady();
      return await client.hDel(key);
    } catch (error) {
      logger.error('REDIS_HDEL_ERROR', {
        key,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async ensureClientReady() {
    try {
      if (!this._client || !this.isClientReady()) {
        logger.info('Redis client not ready, attempting to initialize...');
        this._client = redisServer.getClient();
        
        // Wait for client to be ready
        const maxRetries = 3;
        let retries = 0;
        while (!this.isClientReady() && retries < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          retries++;
          logger.info(`Waiting for Redis client to be ready (attempt ${retries}/${maxRetries})`);
        }
        
        if (!this.isClientReady()) {
          throw new Error('Failed to initialize Redis client after multiple attempts');
        }
      }
      
      // Verify client is connected
      const pingResult = await this._client.ping();
      if (pingResult !== 'PONG') {
        throw new Error('Redis client failed ping check');
      }
      
      return this._client;
    } catch (error) {
      logger.error('REDIS_CLIENT_UNAVAILABLE', {
        errorMessage: error.message,
        context: 'ensureClientReady',
        stack: error.stack
      });
      throw new Error(`Redis connection error: ${error.message}`);
    }
  }

  isClientReady() {
    return this._client && redisServer.isConnected;
  }

  async connect() {
    try {
      // Ensure client is initialized
      if (!this._client) {
        this.initializeClient();
      }

      // Comprehensive connection attempt with multiple safeguards
      const connectionAttempt = async (attempt = 1, maxAttempts = 3) => {
        try {
          logger.info(`Redis Connection Attempt ${attempt}`, {
            url: this._client.options.url,
            timestamp: new Date().toISOString()
          });

          // Set connection timeout
          const connectionPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              reject(new Error('Redis connection timeout'));
            }, 10000); // 10 seconds timeout

            this._client.connect()
              .then(() => {
                clearTimeout(timeoutId);
                resolve(true);
              })
              .catch(err => {
                clearTimeout(timeoutId);
                reject(err);
              });
          });

          await connectionPromise;

          // Verify connection with ping
          await this._client.ping();

          logger.info('Redis Connection Established Successfully', {
            url: this._client.options.url,
            attempt: attempt,
            timestamp: new Date().toISOString()
          });

          return true;
        } catch (error) {
          logger.warn(`Redis Connection Attempt ${attempt} Failed`, {
            errorMessage: error.message,
            errorName: error.name,
            attempt: attempt,
            timestamp: new Date().toISOString()
          });

          throw error;
        }
      };

      return await connectionAttempt();
    } catch (error) {
      logger.error('Redis Connection Ultimately Failed', {
        errorMessage: error.message,
        errorName: error.name,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async cleanup() {
    try {
      if (this.betCleanupInterval) {
        clearInterval(this.betCleanupInterval);
      }
      if (this._client) {
        await this._client.quit();
        logger.info('Redis Client Disconnected Successfully', {
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      logger.error('Redis Cleanup Failed', {
        errorMessage: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
    } finally {
      this._client = null;
    }
  }

  get client() {
    if (!this._client) {
      this.initializeClient();
    }
    return this._client;
  }

  // Ensure client is ready before operations
  async ensureClientReady() {
    if (!this._client) {
      await this.initializeClient();
    }
    
    if (this._client.isOpen === false) {
      await this._client.connect();
    }

    return this._client;
  }

  // Retrieve the Redis client with strict validation
  getClient() {
    if (!this._client) {
      logger.error('CRITICAL_REDIS_CLIENT_INITIALIZATION_FAILURE', {
        context: 'getClient',
        details: 'Redis client not initialized',
        timestamp: new Date().toISOString()
      });
      throw new Error('SECURITY_VIOLATION_REDIS_CLIENT_NOT_INITIALIZED');
    }

    if (!this._client.isOpen) {
      logger.error('CRITICAL_REDIS_CONNECTION_CLOSED', {
        context: 'getClient',
        details: 'Redis client connection is closed',
        timestamp: new Date().toISOString()
      });
      throw new Error('SECURITY_VIOLATION_REDIS_CONNECTION_CLOSED');
    }

    return this._client;
  }

  // Check if Redis client is ready and connected
  isClientReady() {
    return this._client && this._client.isOpen;
  }

  /**
   * Store a bet with consistent format and storage strategy
   * @param {string} gameSessionId - Current game session ID
   * @param {Object} betDetails - Bet details to store
   * @returns {Promise<Object>} Stored bet details
   */
  async storeBet(gameSessionId, betDetails) {
    try {
      // Validate required fields
      if (!gameSessionId || !betDetails || !betDetails.id || !betDetails.userId) {
        throw new Error('INVALID_BET_DETAILS');
      }

      // Store bet in appropriate Redis key based on state
      const betKey = `bet:${betDetails.id}`;
      const gameSessionKey = `game_session_bets:${gameSessionId}`;
      const userBetsKey = `aviator:user_wagers:${betDetails.userId}`;

      // Store bet details
      await this.multi()
        .hSet(betKey, {
          ...betDetails,
          gameSessionId,
          updatedAt: new Date().toISOString()
        })
        .sAdd(gameSessionKey, betDetails.id)
        .sAdd(userBetsKey, betDetails.id)
        .exec();

      // If bet is PLACED or QUEUED, add to appropriate tracking set
      if (betDetails.status === 'PLACED') {
        await this.client.sAdd(`placed_bets:${gameSessionId}`, betDetails.id);
      } else if (betDetails.status === 'QUEUED') {
        await this.client.sAdd(`queued_bets:${gameSessionId}`, betDetails.id);
      }

      // Store wager details for analytics
      await this.hSet(`aviator:wager_details:${betDetails.id}`, {
        userId: betDetails.userId,
        amount: betDetails.amount,
        status: betDetails.status,
        gameSessionId,
        createdAt: betDetails.createdAt || new Date().toISOString()
      });

      return betDetails;
    } catch (error) {
      logger.error('REDIS_BET_STORAGE_ERROR', {
        error: error.message,
        gameSessionId,
        betId: betDetails?.id
      });
      throw error;
    }
  }

  /**
   * Get all placed bets for a game session
   * @param {string} gameId - Game session identifier
   * @returns {Promise<Array>} List of placed bets
   */
  async getPlacedBets(gameId) {
    try {
      const client = await this.ensureClientReady();
      const statusKey = `placed_bets:${gameId}`;
      
      // Get all placed bet IDs
      const placedBetIds = await client.sMembers(statusKey);
      if (!placedBetIds.length) {
        return [];
      }
      
      // Get bet details for each ID
      const betKey = `game:${gameId}:bets`;
      const multi = client.multi();
      placedBetIds.forEach(betId => {
        multi.hGet(betKey, betId);
      });
      
      const results = await multi.exec();
      const bets = results
        .map(result => {
          try {
            return result ? JSON.parse(result) : null;
          } catch (e) {
            return null;
          }
        })
        .filter(bet => bet !== null);
      
      return bets;
    } catch (error) {
      logger.error('GET_PLACED_BETS_ERROR', {
        gameId,
        error: error.message,
        stack: error.stack
      });
      return [];
    }
  }

  /**
   * Store a bet in Redis with expiration and proper key management
   * @param {string} gameId - Game session identifier
   * @param {Object} betData - Bet data to store
   * @param {number} [expirationSeconds=3600] - Expiration time in seconds
   * @returns {Promise<Object>} Stored bet data
   */
  async storeBet(gameId, betData, expirationSeconds = 3600) {
    try {
      const client = await this.ensureClientReady();
      
      // Validate and sanitize bet data
      if (!gameId || !betData) {
        logger.error('REDIS_BET_STORAGE_INVALID_INPUT', {
          gameId,
          betData: JSON.stringify(betData)
        });
        throw new Error('Invalid bet data or game ID');
      }

      // Verify game session exists
      const currentSession = await this.getCurrentGameSessionId();
      if (currentSession !== gameId) {
        logger.error('GAME_SESSION_MISMATCH', {
          providedId: gameId,
          currentSession,
          betData: JSON.stringify(betData)
        });
        throw new Error('Invalid game session ID');
      }

      // Ensure bet has a unique identifier
      const betId = betData.id || betData.betId || uuidv4();
      
      // Prepare bet data for storage with strict session ID
      const sanitizedBetData = {
        id: betId,
        userId: betData.userId,
        amount: betData.amount || betData.betAmount,
        gameSessionId: currentSession, // Always use current session ID
        status: betData.status || 'placed',
        timestamp: Date.now(),
        originalSessionId: gameId, // Store original session ID for tracking
        ...betData
      };

      // Store bet in multiple indices for efficient retrieval
      const betKey = `game:${gameId}:bets`;
      const userBetKey = `user:${betData.userId}:bets`;
      const statusKey = `placed_bets:${gameId}`;
      const allBetsKey = `game:${gameId}:all_bets`;
      
      // Use multi to ensure atomic operations
      const multi = client.multi();
      
      // Store bet in game index
      multi.hSet(betKey, betId, JSON.stringify(sanitizedBetData));
      
      // Store bet in user index
      multi.hSet(userBetKey, betId, JSON.stringify(sanitizedBetData));
      
      // Store bet in status index
      multi.sAdd(statusKey, betId);
      
      // Store in all bets index
      multi.sAdd(allBetsKey, betId);
      
      // Set expirations
      multi.expire(betKey, expirationSeconds);
      multi.expire(userBetKey, expirationSeconds);
      multi.expire(statusKey, expirationSeconds);
      multi.expire(allBetsKey, expirationSeconds);
      
      // Execute all operations atomically
      await multi.exec();
      
      // Log detailed bet storage information
      logger.info('BET_STORED_SUCCESSFULLY', {
        gameId,
        betId,
        userId: betData.userId,
        status: sanitizedBetData.status,
        amount: sanitizedBetData.amount,
        timestamp: new Date().toISOString()
      });

      return sanitizedBetData;
    } catch (error) {
      logger.error('REDIS_BET_STORAGE_ERROR', {
        gameId,
        errorMessage: error.message,
        errorStack: error.stack,
        betData: JSON.stringify(betData)
      });
      throw error;
    }
  }

  /**
   * Get bet by specific ID with enhanced retrieval
   * @param {string} gameId - Game session identifier
   * @param {string} betId - Bet identifier
   * @returns {Promise<Object|null>} Retrieved bet data or null if not found
   */
  async getBetById(gameId, betId) {
    try {
      const client = await this.ensureClientReady();
      const betKey = `game:${gameId}:bets`;
      const betJson = await client.hGet(betKey, betId);
      
      if (!betJson) {
        logger.debug('BET_NOT_FOUND', {
          gameId,
          betId,
          betKey
        });
        return null;
      }
      
      const bet = JSON.parse(betJson);
      
      // Verify bet belongs to correct game session
      if (bet.gameSessionId !== gameId) {
        logger.error('BET_SESSION_MISMATCH', {
          betId,
          expectedSession: gameId,
          actualSession: bet.gameSessionId
        });
        return null;
      }
      
      return bet;
    } catch (error) {
      logger.error('BET_RETRIEVAL_ERROR', {
        gameId,
        betId,
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }

  /**
   * Get all queued bets for a game session
   * @param {string} gameSessionId - Game session identifier
   * @returns {Promise<Array>} List of queued bets
   */
  async getQueuedBets(gameSessionId = null) {
    try {
      const client = await this.ensureClientReady();
      const key = `queued_bets:${gameSessionId}`;
      
      // Get all queued bet IDs
      const queuedBetIds = await client.sMembers(key);
      if (!queuedBetIds.length) {
        return [];
      }
      
      // Get bet details for each ID
      const betKey = `game:${gameSessionId}:bets`;
      const multi = client.multi();
      queuedBetIds.forEach(betId => {
        multi.hGet(betKey, betId);
      });
      
      const results = await multi.exec();
      const bets = results
        .map(result => {
          try {
            return result ? JSON.parse(result) : null;
          } catch (e) {
            return null;
          }
        })
        .filter(bet => bet !== null);
      
      logger.debug('QUEUED_BETS_RETRIEVED', {
        gameSessionId,
        count: bets.length,
        betIds: queuedBetIds
      });
      
      return bets;
    } catch (error) {
      logger.error('GET_QUEUED_BETS_ERROR', {
        gameSessionId,
        error: error.message,
        stack: error.stack
      });
      return [];
    }
  }

  /**
   * Bulk activate queued bets for a new game session
   * @param {string} gameId - Current game session identifier
   * @returns {Promise<{success: Array, failed: Array}>} Results of bulk activation
   */
  async bulkActivateQueuedBets(newGameId) {
    try {
      const client = await this.ensureClientReady();
      const queuedBets = await this.getQueuedBets();
      
      if (!queuedBets.length) {
        logger.info('NO_QUEUED_BETS_TO_ACTIVATE', { newGameId });
        return { success: [], failed: [] };
      }
      
      const results = {
        success: [],
        failed: []
      };
      
      // Process bets in batches of 50
      const batchSize = 50;
      for (let i = 0; i < queuedBets.length; i += batchSize) {
        const batch = queuedBets.slice(i, i + batchSize);
        const multi = client.multi();
        
        batch.forEach(bet => {
          // Prepare updated bet with new session ID
          const updatedBet = {
            ...bet,
            gameSessionId: newGameId, // Assign new session ID
            status: 'active',
            activatedAt: new Date().toISOString(),
            previousStatus: bet.status,
            originalSessionId: bet.originalSessionId, // Preserve original session ID
            stateTransitions: [
              ...(bet.stateTransitions || []),
              {
                from: 'queued',
                to: 'active',
                timestamp: new Date().toISOString(),
                previousSessionId: bet.originalSessionId,
                newSessionId: newGameId
              }
            ]
          };
          
          // Remove from global queued bets
          multi.hDel('global:queued_bets', bet.id);
          
          // Add to new game session's active bets
          const newSessionKey = this._getBetStorageKey(newGameId, 'active');
          multi.hSet(newSessionKey, bet.id, JSON.stringify(updatedBet));
          
          // Add to active bets index
          multi.sAdd(`game:${newGameId}:active_bets`, bet.id);
        });
        
        try {
          await multi.exec();
          results.success.push(...batch.map(b => ({ 
            id: b.id, 
            userId: b.userId,
            originalSessionId: b.originalSessionId,
            newSessionId: newGameId
          })));
        } catch (error) {
          results.failed.push(...batch.map(b => ({ 
            id: b.id, 
            userId: b.userId,
            originalSessionId: b.originalSessionId, 
            error: error.message 
          })));
        }
      }
      
      logger.info('BULK_BET_ACTIVATION_RESULTS', {
        newGameId,
        totalBets: queuedBets.length,
        successCount: results.success.length,
        failedCount: results.failed.length,
        timestamp: new Date().toISOString()
      });
      
      return results;
    } catch (error) {
      logger.error('BULK_ACTIVATE_QUEUED_BETS_ERROR', {
        newGameId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Remove a bet from all indices
   * @param {string} gameId - Game session identifier
   * @param {string} betId - Bet identifier to remove
   * @returns {Promise<boolean>} Whether the removal was successful
   */
  async removeBet(gameId, betId) {
    try {
      const client = await this.ensureClientReady();
      
      // First get the bet to know its user and status
      const bet = await this.getBetById(gameId, betId);
      if (!bet) {
        return false;
      }
      
      const betKey = `game:${gameId}:bets`;
      const userBetKey = `user:${bet.userId}:bets`;
      const statusKey = `placed_bets:${gameId}`;
      
      // Remove from all indices atomically
      const multi = client.multi();
      multi.hDel(betKey, betId);
      multi.hDel(userBetKey, betId);
      multi.sRem(statusKey, betId);
      
      await multi.exec();
      
      logger.info('BET_REMOVED_SUCCESSFULLY', {
        gameId,
        betId,
        userId: bet.userId,
        status: bet.status
      });
      
      return true;
    } catch (error) {
      logger.error('BET_REMOVAL_ERROR', {
        gameId,
        betId,
        error: error.message,
        stack: error.stack
      });
      return false;
    }
  }

  // Atomic bet status update with optimistic locking
  async updateBetStatusAtomic(gameId, betId, expectedStatus, newStatus) {
    try {
      const client = await this.ensureClientReady();
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
      const client = await this.ensureClientReady();
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
      const client = await this.ensureClientReady();
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
      const client = await this.ensureClientReady();
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
      const client = await this.ensureClientReady();
      await client.del(`game:${gameId}:bets`);
    } catch (error) {
      logger.error(error);
    }
  }

  // Get total bet amount for a game
  async getTotalBetAmount(gameId) {
    try {
      const client = await this.ensureClientReady();
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
      const client = await this.ensureClientReady();
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
      const client = await this.ensureClientReady();
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
      await this.hSet(betKey, betId, JSON.stringify(betData));
      
      // Set expiration for the bet hash
      await this.expire(betKey, 3600); // 1 hour expiration

      // Track bet metrics
      redisServer.trackBetMetrics(gameSessionId, betAmount);

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
      const client = await this.ensureClientReady();
      const lockKey = `wallet_lock:${walletId}`;
      const lockValue = uuidv4();

      // Attempt to acquire lock using Redis SET with NX (only if not exists) and PX (expiry in milliseconds)
      const lockAcquired = await client.set(lockKey, lockValue, {
        NX: true,  // Only set if not exists
        PX: lockDuration  // Expire after specified duration
      });

      if (!lockAcquired) {
        throw new Error('Wallet transaction in progress');
      }

      return { lockKey, lockValue };
    } catch (error) {
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
      const client = await this.ensureClientReady();

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

      return result === 1;
    } catch (error) {
      throw error;
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
      const redisClient = await this.ensureClientReady();
      const walletKey = `wallet:${walletId}`;
      await redisClient.hSet(walletKey, {
        balance: newBalance.toFixed(2),
        lastTransactionType: 'bet_placement',
        lastTransactionAmount: betAmount.toFixed(2),
        lastTransactionTimestamp: new Date().toISOString()
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
      const redisClient = await this.ensureClientReady();
      const walletKey = `wallet:${walletId}`;
      await redisClient.hSet(walletKey, {
        balance: newBalance.toFixed(2),
        lastTransactionType: 'bet_cashout',
        lastTransactionAmount: winnings.toFixed(2),
        lastTransactionTimestamp: new Date().toISOString()
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
        const redisClient = await this.ensureClientReady();
        const walletKey = `wallet:${walletId}`;
        await redisClient.hSet(walletKey, {
          balance: balance.toFixed(2),
          lastRetrieved: new Date().toISOString()
        });

        return balance;
      } finally {
        // Always release client to the pool
        client.release();
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * Bulk activate bets with atomic and resilient operations
   * @param {Array} bulkActivationData - Array of bet activation details
   * @param {string} targetState - Target bet state (e.g., ACTIVE)
   * @returns {Object} Bulk activation result summary
   */
  async bulkActivateBets(bulkActivationData, targetState) {
    // Defensive initialization of results with default empty state
    const activationResults = {
      successCount: 0,
      failedCount: 0,
      successfulBetIds: [],
      failedBetIds: [],
      processingTime: 0,
      error: false,
      errorMessage: null
    };

    const startTime = Date.now();

    try {
      // Validate Redis client initialization
      if (!this._client) {
        logger.error('REDIS_CLIENT_NOT_INITIALIZED', {
          method: 'bulkActivateBets',
          message: 'Redis client is undefined or not properly initialized'
        });
        throw new Error('Redis client not initialized');
      }

      // Comprehensive input validation
      if (!bulkActivationData) {
        logger.warn('BULK_ACTIVATION_NO_DATA', {
          message: 'Bulk activation data is null or undefined',
          targetState
        });
        return activationResults;
      }

      // Ensure bulkActivationData is an array
      const activationDataArray = Array.isArray(bulkActivationData) 
        ? bulkActivationData 
        : [bulkActivationData];

      // Filter out invalid bet data entries
      const validBetData = activationDataArray.filter(bet => 
        bet && bet.betId && bet.sessionId
      );

      if (validBetData.length === 0) {
        logger.warn('BULK_ACTIVATION_NO_VALID_BETS', {
          inputDataLength: activationDataArray.length,
          targetState
        });
        return activationResults;
      }

      // Validate target state
      if (!targetState || typeof targetState !== 'string') {
        logger.error('INVALID_TARGET_STATE', { targetState });
        throw new Error('Invalid target state for bet activation');
      }

      // Safely process each bet for activation
      for (const betData of validBetData) {
        try {
          // Use game session key for bet storage
          const betKey = `game:${betData.sessionId}:bets`;
          
          // Retrieve existing bet with error handling
          let existingBetJson;
          try {
            existingBetJson = await this._client.hGet(betKey, betData.betId);
          } catch (retrievalError) {
            logger.error('BET_RETRIEVAL_ERROR', {
              betId: betData.betId,
              sessionId: betData.sessionId,
              errorMessage: retrievalError.message,
              errorStack: retrievalError.stack
            });
            activationResults.failedCount++;
            activationResults.failedBetIds.push(betData.betId);
            continue;
          }
          
          if (!existingBetJson) {
            logger.warn('BET_NOT_FOUND_FOR_ACTIVATION', {
              betId: betData.betId,
              sessionId: betData.sessionId
            });
            activationResults.failedCount++;
            activationResults.failedBetIds.push(betData.betId);
            continue;
          }

          // Parse existing bet
          let existingBet;
          try {
            existingBet = JSON.parse(existingBetJson);
          } catch (parseError) {
            logger.error('BET_PARSING_ERROR', {
              betId: betData.betId,
              sessionId: betData.sessionId,
              rawBetData: existingBetJson,
              errorMessage: parseError.message
            });
            activationResults.failedCount++;
            activationResults.failedBetIds.push(betData.betId);
            continue;
          }
          
          // Update bet status
          const updatedBet = {
            ...existingBet,
            status: targetState,
            activatedAt: new Date().toISOString(),
            ...betData.additionalDetails
          };

          // Acquire lock for atomic bet activation
          const lockKey = `lock:bet:${betData.betId}`;
          const lockValue = uuidv4();
          const lockAcquired = await this._client.set(
            lockKey,
            lockValue,
            'NX',
            'PX',
            5000 // 5 second lock timeout
          );

          if (!lockAcquired) {
            logger.warn('BET_ACTIVATION_LOCK_FAILED', {
              betId: betData.betId,
              sessionId: betData.sessionId
            });
            activationResults.failedCount++;
            activationResults.failedBetIds.push(betData.betId);
            continue;
          }

          try {
            // Verify bet is in valid state for activation
            if (existingBet.status !== 'placed') {
              throw new Error(`Invalid bet state for activation: ${existingBet.status}`);
            }

            // Verify game state allows activation
            const gameStateKey = `game:${betData.sessionId}:state`;
            const currentGameState = await this._client.get(gameStateKey);
            if (currentGameState !== 'betting') {
              throw new Error(`Invalid game state for activation: ${currentGameState}`);
            }

            // Store updated bet atomically
            const result = await this._client.eval(
              `
              local betKey = KEYS[1]
              local betId = ARGV[1]
              local currentStatus = ARGV[2]
              local newBetData = ARGV[3]
              
              -- Get current bet
              local currentBet = redis.call('hget', betKey, betId)
              if not currentBet then
                return {err = 'Bet not found'}
              end
              
              -- Parse current bet
              local success, current = pcall(cjson.decode, currentBet)
              if not success then
                return {err = 'Failed to parse current bet'}
              end
              
              -- Verify current status
              if current.status ~= currentStatus then
                return {err = 'Invalid current status'}
              end
              
              -- Update bet
              local success = redis.call('hset', betKey, betId, newBetData)
              return {ok = success}
              `,
              1,
              betKey,
              betData.betId,
              'placed',
              JSON.stringify(updatedBet)
            );

            if (result.err) {
              throw new Error(`Atomic bet update failed: ${result.err}`);
            }

          } catch (storageError) {
            logger.error('BET_STORAGE_ERROR', {
              betId: betData.betId,
              sessionId: betData.sessionId,
              errorMessage: storageError.message,
              errorStack: storageError.stack
            });
            activationResults.failedCount++;
            activationResults.failedBetIds.push(betData.betId);
            continue;
          } finally {
            // Release lock
            await this._client.del(lockKey);
          }

          // Track successful activation
          activationResults.successCount++;
          activationResults.successfulBetIds.push(betData.betId);

          logger.debug('BET_ACTIVATED', {
            betId: betData.betId,
            sessionId: betData.sessionId,
            newStatus: targetState
          });

        } catch (betActivationError) {
          logger.error('INDIVIDUAL_BET_ACTIVATION_FAILED', {
            betId: betData.betId,
            errorMessage: betActivationError.message,
            errorStack: betActivationError.stack
          });

          activationResults.failedCount++;
          activationResults.failedBetIds.push(betData.betId);
        }
      }

      // Calculate processing time
      activationResults.processingTime = Date.now() - startTime;

      // Log activation summary
      logger.info('BULK_BET_ACTIVATION_SUMMARY', {
        totalBets: validBetData.length,
        successCount: activationResults.successCount,
        failedCount: activationResults.failedCount,
        processingTime: activationResults.processingTime
      });

      return activationResults;

    } catch (error) {
      // Comprehensive error handling
      const errorMessage = error?.message || 'Unhandled bulk activation error';
      
      logger.error('BULK_BET_ACTIVATION_CATASTROPHIC_ERROR', {
        errorMessage,
        errorStack: error?.stack || 'No stack trace',
        inputDataLength: bulkActivationData ? 
          (Array.isArray(bulkActivationData) ? bulkActivationData.length : 1) : 0
      });

      // Return a fully populated error response
      return {
        ...activationResults,
        failedCount: bulkActivationData ? 
          (Array.isArray(bulkActivationData) 
            ? bulkActivationData.length : 1) : 0,
        failedBetIds: bulkActivationData ? 
          (Array.isArray(bulkActivationData) 
            ? bulkActivationData.map(bet => bet?.betId || 'unknown') 
            : ['unknown']) 
          : [],
        error: true,
        errorMessage
      };
    }
  }

  /**
   * Single attempt bet activation
   * @param {Array} bulkActivationData - Array of bet activation details
   * @param {string} targetState - Target bet state
   * @returns {Promise<Object>} Activation results with individual processing
   */
  async activateBets(bulkActivationData, targetState) {
    const startTime = Date.now();
    const results = {
      successCount: 0,
      failedCount: 0,
      successfulBetIds: [],
      failedBetIds: [],
      processingTime: 0
    };

    try {
      // Process bets individually
      for (const betData of bulkActivationData) {
        try {
          const betKey = `bet:${betData.betId}`;
          
          // Single attempt bet activation
          const updatePayload = {
            status: targetState,
            ...betData.additionalDetails,
            updatedAt: new Date().toISOString()
          };

          // Atomic bet state update
          const result = await this.redisClient.hmset(betKey, updatePayload);

          if (result) {
            results.successCount++;
            results.successfulBetIds.push(betData.betId);
          } else {
            results.failedCount++;
            results.failedBetIds.push(betData.betId);
          }
        } catch (individualError) {
          results.failedCount++;
          results.failedBetIds.push(betData.betId);
          
          this.logger.error('Individual Bet Activation Failed', {
            betId: betData.betId,
            error: individualError.message
          });
        }
      }

      // Calculate processing time
      results.processingTime = Date.now() - startTime;

      // Log activation summary
      this.logger.info('Bet Activation Summary', {
        totalBets: bulkActivationData.length,
        successCount: results.successCount,
        failedCount: results.failedCount,
        processingTime: results.processingTime
      });

      return results;
    } catch (error) {
      this.logger.error('Bulk Activation Error', {
        errorMessage: error.message,
        errorStack: error.stack
      });

      throw error;
    }
  }

  /**
   * Retrieve placed bets for a specific game session
   * @param {string} gameSessionId - Game session identifier
   * @returns {Array} List of placed bets for the session
   */
  async getPlacedBetsByGameSession(gameSessionId) {
    try {
      // Construct Redis key for game session bets
      const gameSessionBetsKey = `placed_bets:${gameSessionId}`;
      
      // Retrieve bets from Redis
      const placedBets = await this._client.hGetAll(gameSessionBetsKey);
      
      // Convert Redis hash to array of bet objects
      const betsArray = Object.entries(placedBets || {}).map(([betId, betData]) => {
        try {
          return {
            id: betId,
            ...JSON.parse(betData),
            status: this.BET_STATES.PLACED
          };
        } catch (parseError) {
          this.logger.warn('Failed to parse bet data', { 
            betId, 
            errorMessage: parseError.message 
          });
          return null;
        }
      }).filter(bet => bet !== null);

      this.logger.info('Retrieved placed bets by game session', {
        gameSessionId,
        betsCount: betsArray.length
      });

      return betsArray;
    } catch (error) {
      this.logger.error('Error retrieving placed bets', {
        gameSessionId,
        errorMessage: error.message
      });
      return [];
    }
  }

  /**
   * Retrieve bets queued for next game session
   * @returns {Array} List of bets waiting for next session
   */
  async getNextSessionBets() {
    try {
      // Construct Redis key for next session bets
      const nextSessionBetsKey = 'game:next_session:bets';
      
      // Retrieve bets from Redis
      const nextSessionBets = await this._client.hGetAll(nextSessionBetsKey);
      
      // Convert Redis hash to array of bet objects
      const betsArray = Object.entries(nextSessionBets || {}).map(([betId, betData]) => {
        try {
          return {
            id: betId,
            ...JSON.parse(betData),
            status: this.BET_STATES.NEXT_SESSION
          };
        } catch (parseError) {
          this.logger.error('Failed to parse next session bet data', { 
            betId, 
            errorMessage: parseError.message 
          });
          return null;
        }
      }).filter(bet => bet !== null);
      
      this.logger.info('Retrieved next session bets', {
        betsCount: betsArray.length
      });

      return betsArray;
    } catch (error) {
      this.logger.error('Error retrieving next session bets', {
        errorMessage: error.message
      });
      return [];
    }
  }

  /**
   * Retrieve orphaned bets that might have been lost during game transitions
   * @returns {Array} List of orphaned bets
   */
  async getOrphanedBets() {
    try {
      // Construct Redis key for orphaned bets
      const orphanedBetsKey = 'game:orphaned_bets';
      
      // Retrieve bets from Redis
      const orphanedBets = await this._client.hGetAll(orphanedBetsKey);
      
      // Convert Redis hash to array of bet objects
      const betsArray = Object.entries(orphanedBets || {}).map(([betId, betData]) => {
        try {
          const parsedBet = JSON.parse(betData);
          return {
            id: betId,
            ...parsedBet,
            status: parsedBet.status || this.BET_STATES.PLACED
          };
        } catch (parseError) {
          this.logger.error('Failed to parse orphaned bet data', { 
            betId, 
            errorMessage: parseError.message 
          });
          return null;
        }
      }).filter(bet => bet !== null);
      
      this.logger.info('Retrieved orphaned bets', {
        betsCount: betsArray.length
      });

      return betsArray;
    } catch (error) {
      this.logger.error('Error retrieving orphaned bets', {
        errorMessage: error.message
      });
      return [];
    }
  }

  /**
   * Add a bet to the orphaned bets collection for potential recovery
   * @param {Object} betData - Bet data to be added to orphaned collection
   * @returns {boolean} Whether the bet was successfully added
   */
  async addBetToOrphanedCollection(betData) {
    try {
      const orphanedBetsKey = 'game:orphaned_bets';
      
      // Ensure bet has a unique identifier
      const betId = betData.id || uuidv4();
      
      // Store bet in orphaned collection
      await this._client.hset(
        orphanedBetsKey, 
        betId, 
        JSON.stringify({
          ...betData,
          orphanedAt: new Date().toISOString()
        })
      );

      this.logger.info('Bet added to orphaned collection', { 
        betId, 
        gameSessionId: betData.gameSessionId 
      });

      return true;
    } catch (error) {
      this.logger.error('Failed to add bet to orphaned collection', {
        errorMessage: error.message,
        betData
      });
      return false;
    }
  }

  // Get all game session bet keys in Redis
  async getAllGameSessionBetKeys() {
    try {
      const client = await this.ensureClientReady();
      
      // Use KEYS pattern to find all game bet keys
      const gameSessionBetKeys = await client.keys('game:*:bets');
      
      logger.debug('GAME_SESSION_BET_KEYS_RETRIEVED', {
        gameSessionBetKeys
      });

      return gameSessionBetKeys;
    } catch (error) {
      logger.error('GET_ALL_GAME_SESSION_KEYS_ERROR', {
        errorMessage: error.message
      });
      return [];
    }
  }

  // Retrieve bets for a specific game session key
  async getBetsBySessionKey(sessionKey) {
    try {
      const client = await this.ensureClientReady();
      
      // Get all bets in the hash
      const betEntries = await client.hGetAll(sessionKey);
      
      // Convert hash entries to bet objects
      const bets = Object.entries(betEntries).map(([betId, betJson]) => {
        try {
          const bet = JSON.parse(betJson);
          return { ...bet, id: betId };
        } catch (parseError) {
          logger.error('BET_PARSE_ERROR_IN_SESSION_KEY', {
            sessionKey,
            betId,
            errorMessage: parseError.message
          });
          return null;
        }
      }).filter(bet => bet !== null);
      
      logger.debug('BETS_RETRIEVED_BY_SESSION_KEY', {
        sessionKey,
        betCount: bets.length
      });

      return bets;
    } catch (error) {
      logger.error('GET_BETS_BY_SESSION_KEY_ERROR', {
        sessionKey,
        errorMessage: error.message
      });
      return [];
    }
  }

  // Store the current game session ID
  async storeCurrentGameSessionId(gameSessionId) {
    try {
      const client = await this.ensureClientReady();
      
      // Store game session ID with a long expiration
      await client.set('current_game_session_id', gameSessionId, {
        EX: 3600 * 24 // 24 hours expiration
      });

      logger.debug('CURRENT_GAME_SESSION_ID_STORED', {
        gameSessionId
      });

      return true;
    } catch (error) {
      logger.error('STORE_GAME_SESSION_ID_ERROR', {
        errorMessage: error.message
      });
      return false;
    }
  }

  // Retrieve the current game session ID
  async getCurrentGameSessionId() {
    try {
      const client = await this.ensureClientReady();
      
      const gameSessionId = await client.get('current_game_session_id');

      logger.debug('CURRENT_GAME_SESSION_ID_RETRIEVED', {
        gameSessionId
      });

      return gameSessionId;
    } catch (error) {
      logger.error('GET_GAME_SESSION_ID_ERROR', {
        errorMessage: error.message
      });
      return null;
    }
  }

  async initializeSessionManagement() {
    // Setup periodic cleanup and consolidation
    this.sessionCleanupInterval = setInterval(() => {
      this.cleanupExpiredGameSessions().catch(error => {
        logger.error('SESSION_CLEANUP_ERROR', {
          errorMessage: error.message,
          errorStack: error.stack
        });
      });
    }, 30 * 60 * 1000); // Run every 30 minutes

    // Ensure cleanup on class destruction
    process.on('exit', () => {
      if (this.sessionCleanupInterval) {
        clearInterval(this.sessionCleanupInterval);
      }
    });
  }

  async cleanupExpiredGameSessions() {
    try {
      // Retrieve all game session bet keys
      const allSessionKeys = await this.getAllGameSessionBetKeys();

      // Sort session keys by age (assuming keys contain timestamp or can be sorted)
      const sortedSessionKeys = allSessionKeys.sort((a, b) => {
        // Extract timestamp from session key or use creation time
        const extractTimestamp = (key) => {
          const match = key.match(/game:([^:]+):bets/);
          return match ? this.getSessionKeyTimestamp(match[1]) : 0;
        };

        return extractTimestamp(a) - extractTimestamp(b);
      });

      // Keep only the most recent sessions
      if (sortedSessionKeys.length > SESSION_MANAGEMENT_CONFIG.MAX_RETAINED_SESSIONS) {
        const keysToRemove = sortedSessionKeys.slice(0, -SESSION_MANAGEMENT_CONFIG.MAX_RETAINED_SESSIONS);
        
        for (const sessionKey of keysToRemove) {
          try {
            // Remove expired session key and associated bets
            await this._client.del(sessionKey);
            
            logger.info('EXPIRED_SESSION_REMOVED', { 
              removedSessionKey: sessionKey,
              remainingSessionCount: sortedSessionKeys.length - keysToRemove.length
            });
          } catch (removalError) {
            logger.warn('SESSION_REMOVAL_FAILED', {
              sessionKey,
              errorMessage: removalError.message
            });
          }
        }
      }
    } catch (error) {
      logger.error('GAME_SESSION_CLEANUP_FAILED', {
        errorMessage: error.message,
        errorStack: error.stack
      });
    }
  }

  async consolidateGameSessions() {
    try {
      const allSessionKeys = await this.getAllGameSessionBetKeys();
      const consolidatedSessions = {};

      // Group sessions within time threshold
      for (const sessionKey of allSessionKeys) {
        const match = sessionKey.match(/game:([^:]+):bets/);
        if (!match) continue;

        const sessionId = match[1];
        const sessionTimestamp = this.getSessionKeyTimestamp(sessionId);
        
        // Find a suitable consolidation group
        let consolidationGroup = Object.keys(consolidatedSessions).find(groupKey => {
          const groupTimestamp = parseInt(groupKey);
          return Math.abs(sessionTimestamp - groupTimestamp) <= 
            (SESSION_MANAGEMENT_CONFIG.CONSOLIDATION_THRESHOLD_MINUTES * 60 * 1000);
        });

        // Create or add to consolidation group
        if (!consolidationGroup) {
          consolidationGroup = sessionTimestamp.toString();
          consolidatedSessions[consolidationGroup] = [];
        }

        consolidatedSessions[consolidationGroup].push(sessionKey);
      }

      // Merge bets for consolidated sessions
      for (const [groupTimestamp, sessionKeys] of Object.entries(consolidatedSessions)) {
        if (sessionKeys.length > 1) {
          await this.mergeSessionBets(sessionKeys);
          
          logger.info('SESSIONS_CONSOLIDATED', {
            groupTimestamp,
            consolidatedSessionCount: sessionKeys.length
          });
        }
      }
    } catch (error) {
      logger.error('SESSION_CONSOLIDATION_FAILED', {
        errorMessage: error.message,
        errorStack: error.stack
      });
    }
  }

  async mergeSessionBets(sessionKeys) {
    if (sessionKeys.length < 2) return;

    try {
      // Retrieve bets from all session keys
      const allSessionBets = {};
      for (const sessionKey of sessionKeys) {
        const sessionBets = await this._client.hGetAll(sessionKey);
        Object.assign(allSessionBets, sessionBets);
      }

      // Choose the most recent session key as the target
      const targetSessionKey = sessionKeys[sessionKeys.length - 1];

      // Store consolidated bets in target session
      if (Object.keys(allSessionBets).length > 0) {
        await this._client.del(...sessionKeys.slice(0, -1)); // Remove old session keys
        await this._client.hSet(targetSessionKey, allSessionBets);
      }
    } catch (error) {
      logger.error('SESSION_MERGE_FAILED', {
        sessionKeys,
        errorMessage: error.message,
        errorStack: error.stack
      });
    }
  }

  getSessionKeyTimestamp(sessionId) {
    try {
      // Extract timestamp from UUID or use current time as fallback
      const timestamp = this.extractTimestampFromUUID(sessionId);
      return timestamp || Date.now();
    } catch (error) {
      logger.warn('SESSION_TIMESTAMP_EXTRACTION_FAILED', {
        sessionId,
        errorMessage: error.message
      });
      return Date.now();
    }
  }

  extractTimestampFromUUID(uuid) {
    // Attempt to extract timestamp from UUID (assuming v1 or v4 with timestamp)
    try {
      // For UUID v1: first 8 hex characters represent timestamp
      const timestampHex = uuid.split('-')[0];
      return parseInt(timestampHex, 16);
    } catch {
      return null;
    }
  }

  async storeCurrentGameSessionId(sessionId) {
    try {
      // Store session with expiration
      await this._client.set('current_game_session_id', sessionId, {
        EX: 3600 * 24 // 24 hours expiration
      });

      // Trigger session management processes
      await this.cleanupExpiredGameSessions();
      await this.consolidateGameSessions();

      return sessionId;
    } catch (error) {
      logger.error('STORE_GAME_SESSION_FAILED', {
        sessionId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  // Delete multiple game session bet keys
  async deleteGameSessionBetKeys(keys) {
    try {
      if (!keys || keys.length === 0) return;

      // Use multi/exec for atomic operation
      const multi = this._client.multi();
      keys.forEach(key => multi.del(key));
      
      const results = await multi.exec();
      
      logger.info('GAME_SESSION_KEYS_DELETED', {
        deletedKeysCount: keys.length,
        deletedKeys: keys
      });

      return results;
    } catch (error) {
      logger.error('GAME_SESSION_KEYS_DELETION_FAILED', {
        errorMessage: error.message,
        keys
      });
      throw error;
    }
  }

  // Completely clear all game-related data after a game cycle
  async clearGameCycleData(gameSessionId) {
    try {
      // Define patterns to match game-related keys
      const gameKeyPatterns = [
        `game:${gameSessionId}:*`,  // All keys for this specific game session
        `bets:${gameSessionId}:*`,  // Bet-related keys
        `players:${gameSessionId}:*`,  // Player-related keys
        `multipliers:${gameSessionId}:*`  // Multiplier-related keys
      ];

      // Use scan to find and delete all matching keys
      const keysToDelete = [];
      for (const pattern of gameKeyPatterns) {
        let cursor = 0;
        do {
          const [newCursor, matchedKeys] = await new Promise((resolve, reject) => {
            this._client.scan(cursor, 'MATCH', pattern, (err, result) => {
              if (err) reject(err);
              else resolve(result);
            });
          });

          keysToDelete.push(...matchedKeys);
          cursor = newCursor;
        } while (cursor !== '0');
      }

      // Perform bulk deletion
      if (keysToDelete.length > 0) {
        const multi = this._client.multi();
        keysToDelete.forEach(key => multi.del(key));
        
        await multi.exec();

        logger.info('GAME_CYCLE_DATA_CLEARED', {
          gameSessionId,
          deletedKeysCount: keysToDelete.length,
          deletedKeyPatterns: gameKeyPatterns
        });
      }

      return {
        success: true,
        deletedKeysCount: keysToDelete.length
      };
    } catch (error) {
      logger.error('GAME_CYCLE_DATA_CLEARANCE_FAILED', {
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Comprehensively clear all session-related data in Redis when game crashes
   * @param {string} gameSessionId - The game session ID to clear
   * @returns {Promise<Object>} Clearing operation results
   */
  async clearGameSessionData(gameSessionId) {
    const redisClient = await this.getClient();
    
    try {
      // Start a Redis transaction
      const multi = redisClient.multi();

      // Define key patterns to clear
      const keyPatterns = [
        `bet:${gameSessionId}:*`,     // All bet-related keys
        `active_bets:${gameSessionId}`,  // Active bets set
        `user_bets:${gameSessionId}:*`,  // User-specific bet keys
        `game_session:${gameSessionId}`, // Game session metadata
        `multiplier:${gameSessionId}`,   // Game multiplier tracking
        `cashout_tracking:${gameSessionId}:*` // Cashout-related keys
      ];

      // Scan and delete keys matching patterns
      for (const pattern of keyPatterns) {
        const stream = redisClient.scanStream({ match: pattern });
        
        stream.on('data', (keys) => {
          if (keys.length) {
            multi.del(...keys);
          }
        });

        await new Promise((resolve, reject) => {
          stream.on('end', resolve);
          stream.on('error', reject);
        });
      }

      // Execute the transaction
      const results = await multi.exec();

      // Comprehensive logging
      logger.info('GAME_SESSION_DATA_CLEARED', {
        gameSessionId,
        keyPatternsCleared: keyPatterns,
        deletedKeysCount: results.filter(r => r === 1).length
      });

      return {
        success: true,
        gameSessionId,
        clearedKeyPatterns: keyPatterns,
        deletedKeysCount: results.filter(r => r === 1).length
      };
    } catch (error) {
      // Error handling with detailed logging
      logger.error('GAME_SESSION_DATA_CLEAR_FAILED', {
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
      });

      throw new Error(`Failed to clear game session data: ${error.message}`);
    }
  }

  /**
   * Generate a unique Redis key for bet storage
   * @param {string} gameSessionId - Game session identifier
   * @param {string} betStatus - Bet status (placed, active)
   * @returns {string} Unique Redis key
   */
  _getBetStorageKey(gameSessionId, betStatus) {
    return `game_session_bets:${gameSessionId}`;
  }

  /**
   * Store a bet in Redis with specific session management
   * @param {string} gameSessionId - Game session identifier
   * @param {Object} betDetails - Bet details to store
   * @param {string} [betStatus='placed'] - Bet status
   * @returns {Promise<Object>} Stored bet details
   */
  async storeBet(gameSessionId, betDetails, betStatus = 'placed') {
    // Import gameService to validate session ID
    const gameService = await import('../services/gameService.js');

    // STRICT VALIDATION: Ensure gameSessionId matches gameService current game ID
    const currentGameServiceSessionId = gameService.default.gameState.gameId;
    
    if (!currentGameServiceSessionId || gameSessionId !== currentGameServiceSessionId) {
      logger.error('GAME_SESSION_ID_MISMATCH', {
        providedSessionId: gameSessionId,
        currentGameServiceSessionId,
        context: 'storeBet'
      });
      throw new Error('INVALID_GAME_SESSION_ID: Session ID must match gameService');
    }

    // Strict validation to ensure new bets always start in 'placed' state
    if (!gameSessionId) {
      logger.error('BET_STORAGE_FAILED', {
        reason: 'No game session ID provided',
        context: 'Bet storage requires valid game session'
      });
      throw new Error('INVALID_GAME_SESSION_ID');
    }

    // Ensure bet has a unique identifier
    const betId = betDetails.id || betDetails.betId || uuidv4();
    
    // Prepare storage keys
    const betKey = `game:${gameSessionId}:bets`;
    const statusKey = `placed_bets:${gameSessionId}`;

    try {
      const client = await this.ensureClientReady();
      const multi = client.multi();

      // Store bet details
      multi.hSet(
        betKey,
        betId,
        JSON.stringify({
          ...betDetails,
          id: betId,
          status: betStatus,
          createdAt: new Date().toISOString(),
          gameSessionId
        })
      );

      // Add to status set
      multi.sAdd(statusKey, betId);

      // Execute transaction
      await multi.exec();

      logger.info('BET_STORED_SUCCESSFULLY', {
        betId,
        gameSessionId,
        status: betStatus
      });

      return {
        ...betDetails,
        id: betId,
        status: betStatus,
        gameSessionId
      };
    } catch (storageError) {
      logger.error('BET_STORAGE_ERROR', {
        betId,
        gameSessionId,
        errorMessage: storageError.message,
        errorStack: storageError.stack
      });
      throw storageError;
    }
  }

  /**
   * Retrieve bets for a specific game session with session ID validation
   * @param {string} gameSessionId - Game session identifier
   * @param {string} [betStatus=null] - Optional bet status filter
   * @returns {Array} List of bets for the given session
   * @throws {Error} If session ID is invalid in production
   */
  async getBetsForSession(gameSessionId, betStatus = 'placed') {
    // Defensive session ID validation
    if (!gameSessionId) {
      logger.error('BET_RETRIEVAL_REJECTED', {
        reason: 'No game session ID provided',
        context: 'getBetsForSession'
      });
      
      // In production, throw an error; in development, allow retrieval
      if (process.env.NODE_ENV === 'production') {
        throw new Error('INVALID_GAME_SESSION_ID');
      }
    }

    try {
      const client = this.getClient();
      
      // STRICT: Always retrieve only 'placed' bets
      const sessionBetKey = this._getBetStorageKey(gameSessionId, 'placed');
      
      const rawBets = await client.hGetAll(sessionBetKey);
      const placedBets = Object.values(rawBets)
        .map(betJson => JSON.parse(betJson))
        .filter(bet => !betStatus || bet.status === betStatus);
      
      logger.info('BET_SESSION_RETRIEVAL_SUMMARY', {
        gameSessionId,
        totalPlacedBetsRetrieved: placedBets.length
      });

      return placedBets;
    } catch (error) {
      logger.error('BET_SESSION_RETRIEVAL_ERROR', {
        errorMessage: error.message,
        gameSessionId
      });
      
      // In production, rethrow the error
      if (process.env.NODE_ENV === 'production') {
        throw error;
      }

      // In development, return an empty array
      return [];
    }
  }

  /**
   * Retrieve active bets for a specific game session
   * @param {string} gameSessionId - Game session identifier
   * @returns {Array} List of active bets for the given session
   * @throws {Error} If session ID is invalid or retrieval fails
   */
  async getActiveBetsForSession(gameSessionId) {
    // Defensive session ID validation
    if (!gameSessionId) {
      logger.error('ACTIVE_BETS_RETRIEVAL_REJECTED', {
        reason: 'No game session ID provided',
        context: 'getActiveBetsForSession'
      });
      
      // In production, throw an error; in development, allow retrieval
      if (process.env.NODE_ENV === 'production') {
        throw new Error('INVALID_GAME_SESSION_ID');
      }
    }

    try {
      const client = this.getClient();
      
      // Retrieve active bets for the specific game session
      const sessionActiveBetKey = this._getBetStorageKey(gameSessionId, 'active');
      
      const rawBets = await client.hGetAll(sessionActiveBetKey);
      const activeBets = Object.values(rawBets)
        .map(betJson => JSON.parse(betJson))
        .filter(bet => bet.status === 'active');
      
      // Comprehensive logging of active bets retrieval
      logger.info('ACTIVE_BETS_SESSION_RETRIEVAL_SUMMARY', {
        gameSessionId,
        totalActiveBetsRetrieved: activeBets.length,
        activeBetDetails: activeBets.map(bet => ({
          betId: bet.id,
          userId: bet.userId,
          amount: bet.amount,
          autocashout: bet.autocashout,
          cashoutMultiplier: bet.cashoutMultiplier
        }))
      });

      return activeBets;
    } catch (error) {
      // Comprehensive error logging
      logger.error('ACTIVE_BETS_RETRIEVAL_ERROR', {
        errorMessage: error.message,
        gameSessionId,
        errorStack: error.stack
      });
      
      // In production, rethrow the error
      if (process.env.NODE_ENV === 'production') {
        throw error;
      }

      // In development, return an empty array
      return [];
    }
  }

  /**
   * Retrieve active bets for a user in a specific game session
   * @param {string} gameSessionId - Game session identifier
   * @param {string} userId - User identifier
   * @returns {Array} List of active bets for the given user and session
   * @throws {Error} If session ID or user ID is invalid
   */
  async getActiveUserBetsForSession(gameSessionId, userId) {
    try {
      const activeBets = await this.retrieveActiveBets(gameSessionId, userId);

      // Check if we have already logged for this game session
      if (!this.loggedGameSessions.has(gameSessionId)) {
        logger.info('ACTIVE_BETS_RETRIEVED', {
          userId,
          activeBetCount: activeBets.length,
          timestamp: new Date().toISOString()
        });

        // Add the game session ID to the logged sessions
        this.loggedGameSessions.add(gameSessionId);
      }

      return activeBets;
    } catch (error) {
      logger.error('ERROR_FINDING_ACTIVE_BETS_IN_REDIS', {
        userId,
        errorMessage: error.message,
        errorName: error.name,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });

      // Return empty array to prevent cascading failures
      return [];
    }
  }

  /**
   * Retrieve active bets for cashout for a specific user in the current game session
   * @param {string} gameSessionId - The current game session ID
   * @param {string} userId - The user ID to retrieve active bets for
   * @returns {Promise<Array>} Array of active bets eligible for cashout
   */
  async getActiveBetsForCashout(gameSessionId, userId) {
    try {
      // Validate input parameters
      if (!gameSessionId || !userId) {
        logger.warn('INVALID_CASHOUT_PARAMS', {
          gameSessionId,
          userId,
          context: 'getActiveBetsForCashout'
        });
        return [];
      }

      // Retrieve all active bets for the game session
      const activeBets = await this.getActiveBetsForSession(gameSessionId);

      // Filter active bets for the specific user
      const userActiveBets = activeBets.filter(bet => 
        bet.userId === userId && 
        bet.status === 'active'
      );

      // Log the number of active bets found for cashout
      logger.info('ACTIVE_BETS_FOR_CASHOUT', {
        userId,
        gameSessionId,
        activeBetstCount: userActiveBets.length
      });

      return userActiveBets;
    } catch (error) {
      logger.error('CASHOUT_BETS_RETRIEVAL_ERROR', {
        gameSessionId,
        userId,
        error: error.message,
        context: 'getActiveBetsForCashout'
      });
      return [];
    }
  }

  /**
   * Queue a bet for the next game session with enhanced metadata and expiration
   * @param {Object} betDetails - Bet details to queue
   * @param {Object} cashoutStrategy - Cashout strategy details
   * @param {number} [expirationTime=3600] - Expiration time in seconds
   * @returns {Promise<Object>} Queued bet details
   */
  async queueBetForNextSession(betDetails, cashoutStrategy, expirationTime = 3600) {
    try {
      const client = await this.ensureClientReady();
      
      // Get current session for tracking
      const currentSession = await this.getCurrentGameSessionId();
      if (!currentSession) {
        throw new Error('No active game session found');
      }
      
      const betId = betDetails.id || uuidv4();
      
      // Always use global queue key for queued bets
      const queueKey = 'global:queued_bets';

      // Add expiration timestamp to bet details
      const queuedBet = {
        ...betDetails,
        id: betId,  // Ensure consistent ID key
        queuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + expirationTime * 1000).toISOString(),
        status: 'queued',
        originalSessionId: currentSession, // Track which session it was queued from
        gameSessionId: null // Will be updated when activated in next session
      };

      // Store bet in queued bets index with session tracking
      await client.hSet(queueKey, betId, JSON.stringify(queuedBet));
      
      // Add to queued bets set for efficient retrieval
      await client.sAdd(`game:${currentSession}:queued_set`, betId);
      
      // Set expiration on both keys
      await client.expire(queueKey, expirationTime);
      await client.expire(`game:${currentSession}:queued_set`, expirationTime);

      logger.info('Bet queued for next session', { 
        betId, 
        userId: betDetails.userId,
        cashoutType: cashoutStrategy.type
      });

      return {
        betId,
        queuedAt: new Date().toISOString(),
        sessionId: 'global'
      };
    } catch (error) {
      logger.error('Failed to queue bet for next session', {
        errorMessage: error.message,
        betDetails,
        cashoutStrategy
      });
      return false;
    }
  }

  /**
   * Retrieve queued bets with specific cashout strategy
   * @param {string} cashoutType - 'manual' or 'auto'
   * @returns {Promise<Array>} List of queued bets with specified cashout type
   */
  async getQueuedBetsByCashoutType(cashoutType) {
    try {
      const client = await this.ensureClientReady();
      const nextSessionBetsKey = 'game:next_session:bets';
      
      // Retrieve all queued bets
      const queuedBets = await this.getNextSessionBets();
      
      // Filter bets by cashout type
      const filteredBets = queuedBets.filter(bet => 
        bet.cashoutStrategy && bet.cashoutStrategy.type === cashoutType
      );

      logger.info('Retrieved queued bets by cashout type', {
        cashoutType,
        betsCount: filteredBets.length
      });

      return filteredBets;
    } catch (error) {
      logger.error('Error retrieving queued bets by cashout type', {
        errorMessage: error.message,
        cashoutType
      });
      return [];
    }
  }

  /**
   * Update queued bet status
   * @param {string} betId - ID of the bet to update
   * @param {string} status - New status of the bet
   * @returns {Promise<boolean>} Update operation status
   */
  async updateQueuedBetStatus(betId, status) {
    try {
      const client = await this.ensureClientReady();
      const nextSessionBetsKey = 'game:next_session:bets';
      
      // Retrieve the current bet data
      const currentBetData = await client.hget(nextSessionBetsKey, betId);
      
      if (!currentBetData) {
        logger.warn('Bet not found in queued bets', { betId });
        return false;
      }

      // Parse and update the bet data
      const parsedBetData = JSON.parse(currentBetData);
      parsedBetData.status = status;

      // Store the updated bet data
      await client.hset(
        nextSessionBetsKey, 
        betId, 
        JSON.stringify(parsedBetData)
      );

      logger.info('Queued bet status updated', { 
        betId, 
        newStatus: status 
      });

      return true;
    } catch (error) {
      logger.error('Failed to update queued bet status', {
        errorMessage: error.message,
        betId,
        status
      });
      return false;
    }
  }

  /**
   * Implement bet expiration mechanism
   * Automatically remove expired queued bets
   * @returns {Promise<number>} Number of expired bets removed
   */
  async cleanupExpiredQueuedBets() {
    try {
      const currentTime = Date.now();
      const queueKey = 'global:queued_bets';

      // Retrieve queued bets using compatible methods
      let queuedBetsRaw = {};
      if (typeof this._client.hgetall === 'function') {
        queuedBetsRaw = await this._client.hgetall(queueKey);
      } else if (typeof this._client.hkeys === 'function' && typeof this._client.hget === 'function') {
        const betKeys = await this._client.hkeys(queueKey);
        for (const betKey of betKeys) {
          const betData = await this._client.hget(queueKey, betKey);
          queuedBetsRaw[betKey] = betData;
        }
      }

      // Identify and remove expired bets
      const expiredBetIds = Object.keys(queuedBetsRaw).filter(betId => {
        try {
          const bet = JSON.parse(queuedBetsRaw[betId]);
          return new Date(bet.expiresAt) < new Date(currentTime);
        } catch (parseError) {
          logger.warn('INVALID_EXPIRED_BET_JSON', { 
            rawBet: queuedBetsRaw[betId], 
            error: parseError.message 
          });
          return false;
        }
      });

      // Remove expired bets using compatible methods
      if (expiredBetIds.length > 0) {
        if (typeof this._client.hdel === 'function') {
          await this._client.hdel(queueKey, ...expiredBetIds);
        } else {
          // Fallback removal method
          for (const betId of expiredBetIds) {
            await this._client.del(`${queueKey}:${betId}`);
          }
        }
      }

      logger.info('EXPIRED_QUEUED_BETS_CLEANED', {
        timestamp: new Date(currentTime).toISOString(),
        expiredBetsCount: expiredBetIds.length
      });

      return expiredBetIds.length;
    } catch (error) {
      logger.error('EXPIRED_BETS_CLEANUP_ERROR', {
        errorMessage: error.message,
        context: '_cleanupExpiredQueuedBets',
        clientMethods: Object.keys(this._client || {})
      });
      return 0;
    }
  }

  /**
   * Clear all queued bets storage
   * @returns {Promise<boolean>} Clearing operation status
   */
  async clearQueuedBetsStorage() {
    try {
      const nextSessionBetsKey = 'game:next_session:bets';
      
      // Delete the entire hash of queued bets
      await this._client.del(nextSessionBetsKey);

      logger.info('Queued bets storage cleared completely');
      return true;
    } catch (error) {
      logger.error('Failed to clear queued bets storage', {
        errorMessage: error.message
      });
      return false;
    }
  }

  /**
   * Remove processed queued bets
   * @param {string[]} processedBetIds - Array of bet IDs to remove
   * @returns {Promise<number>} Number of bets removed
   */
  async removeProcessedQueuedBets(processedBetIds) {
    try {
      const client = await this.ensureClientReady();
      
      // Determine the queue keys to remove from
      const queueKeys = processedBetIds.map(betId => `game:next_session:bets:${betId}`);
      
      let removedCount = 0;
      for (const queueKey of queueKeys) {
        // Remove each processed bet using compatible methods
        let betRemoved = false;
        
        // Try different removal methods
        if (typeof this._client.hdel === 'function') {
          // Modern Redis clients
          const betsToRemove = await this._client.hget(queueKey, betId);
          if (betsToRemove) {
            await this._client.hdel(queueKey, betId);
            betRemoved = true;
          }
        } else if (typeof this._client.del === 'function') {
          // Fallback for simple clients
          const fullKey = `${queueKey}:${betId}`;
          const betExists = await this._client.exists(fullKey);
          
          if (betExists) {
            await this._client.del(fullKey);
            betRemoved = true;
          }
        }

        if (betRemoved) {
          removedCount++;
        }
      }

      logger.info('PROCESSED_BETS_REMOVED', { 
        removedCount, 
        processedBetIds 
      });

      return removedCount;
    } catch (error) {
      logger.error('REMOVE_PROCESSED_BETS_ERROR', {
        errorMessage: error.message,
        context: 'removeProcessedQueuedBets',
        clientMethods: Object.keys(this._client || {})
      });
      return 0;
    }
  }

  /**
   * Safely find active bets for a user in Redis
   * @param {string} userId - User ID to find active bets for
   * @returns {Promise<Array>} Active bets or empty array
   */
  async findActiveBetsByUserId(userId) {
    try {
      // Validate input
      if (!userId || typeof userId !== 'string') {
        logger.warn('INVALID_USER_ID_FOR_ACTIVE_BETS', {
          userId,
          timestamp: new Date().toISOString()
        });
        return [];
      }

      // Ensure Redis client is connected
      if (!this._client) {
        await this.connect();
      }

      // Use a more robust key pattern for active bets
      const activeBetsKey = `user:${userId}:active_bets`;

      // Safely retrieve active bets
      const activeBetsResult = await this.safeRedisOperation(
        async () => {
          // Check key type before attempting retrieval
          const keyType = await this._client.type(activeBetsKey);
          
          if (keyType === 'hash') {
            return await this._client.hGetAll(activeBetsKey);
          } else if (keyType === 'none') {
            // Key doesn't exist
            return {};
          } else {
            // Wrong type of key
            throw new Error(`Unexpected Redis key type for active bets: ${keyType}`);
          }
        },
        'findActiveBetsByUserId'
      );

      // Transform results into an array of active bets
      const activeBets = Object.entries(activeBetsResult).map(([betId, betData]) => {
        try {
          return {
            betId: betId,
            ...JSON.parse(betData),
            status: this.BET_STATES.PLACED
          };
        } catch (parseError) {
          logger.warn('INVALID_BET_DATA_FORMAT', {
            userId,
            betId,
            errorMessage: parseError.message
          });
          return null;
        }
      }).filter(bet => bet !== null);
      
      logger.info('ACTIVE_BETS_RETRIEVED_FROM_REDIS', {
        userId,
        activeBetCount: activeBets.length,
        timestamp: new Date().toISOString()
      });

      return activeBets;
    } catch (error) {
      logger.error('ERROR_FINDING_ACTIVE_BETS_IN_REDIS', {
        userId,
        errorMessage: error.message,
        errorName: error.name,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      
      // Return empty array to prevent cascading failures
      return [];
    }
  }

  /**
   * Safely save an active bet for a user in Redis
   * @param {string} userId - User ID
   * @param {Object} betData - Bet details to save
   * @returns {Promise<boolean>} Whether the bet was successfully saved
   */
  async saveActiveBet(userId, betData) {
    try {
      // Validate inputs
      if (!userId || typeof userId !== 'string') {
        logger.warn('INVALID_USER_ID_FOR_SAVE_BET', {
          userId,
          timestamp: new Date().toISOString()
        });
        return false;
      }

      if (!betData || typeof betData !== 'object') {
        logger.warn('INVALID_BET_DATA_FOR_SAVE', {
          userId,
          betData,
          timestamp: new Date().toISOString()
        });
        return false;
      }

      // Ensure Redis client is connected
      if (!this._client) {
        await this.connect();
      }

      // Use a more robust key pattern for active bets
      const activeBetsKey = `user:${userId}:active_bets`;

      // Safely save bet
      await this.safeRedisOperation(
        async () => {
          // Save bet as a hash entry with JSON-serialized data
          await this._client.hSet(
            activeBetsKey, 
            betData.betId, 
            JSON.stringify(betData)
          );

          // Set an expiration to prevent stale data
          await this._client.expire(activeBetsKey, 3600); // 1 hour
        },
        'saveActiveBet'
      );

      logger.info('ACTIVE_BET_SAVED_TO_REDIS', {
        userId,
        betId: betData.betId,
        timestamp: new Date().toISOString()
      });

      return true;
    } catch (error) {
      logger.error('ERROR_SAVING_ACTIVE_BET_IN_REDIS', {
        userId,
        betId: betData?.betId,
        errorMessage: error.message,
        errorName: error.name,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      
      return false;
    }
  }

  /**
   * Safely remove an active bet for a user in Redis
   * @param {string} userId - User ID
   * @param {string} betId - Bet ID to remove
   * @returns {Promise<boolean>} Whether the bet was successfully removed
   */
  async removeActiveBet(userId, betId) {
    try {
      // Validate inputs
      if (!userId || typeof userId !== 'string') {
        logger.warn('INVALID_USER_ID_FOR_REMOVE_BET', {
          userId,
          timestamp: new Date().toISOString()
        });
        return false;
      }

      if (!betId || typeof betId !== 'string') {
        logger.warn('INVALID_BET_ID_FOR_REMOVE', {
          userId,
          betId,
          timestamp: new Date().toISOString()
        });
        return false;
      }

      // Ensure Redis client is connected
      if (!this._client) {
        await this.connect();
      }

      // Use a more robust key pattern for active bets
      const activeBetsKey = `user:${userId}:active_bets`;

      // Safely remove bet
      await this.safeRedisOperation(
        async () => {
          await this._client.hDel(activeBetsKey, betId);
        },
        'removeActiveBet'
      );

      logger.info('ACTIVE_BET_REMOVED_FROM_REDIS', {
        userId,
        betId,
        timestamp: new Date().toISOString()
      });

      return true;
    } catch (error) {
      logger.error('ERROR_REMOVING_ACTIVE_BET_IN_REDIS', {
        userId,
        betId,
        errorMessage: error.message,
        errorName: error.name,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      
      return false;
    }
  }

  /**
   * Safely execute a Redis operation with error handling
   * @param {Function} operation - Redis operation to execute
   * @param {string} operationName - Name of the operation for logging
   * @returns {Promise<any>} Result of the operation
   */
  async safeRedisOperation(operation, operationName) {
    try {
      return await operation();
    } catch (error) {
      logger.error(`REDIS_OPERATION_FAILED: ${operationName}`, {
        errorMessage: error.message,
        errorName: error.name,
        errorCode: error.code,
        operationName: operationName,
        timestamp: new Date().toISOString()
      });

      // Attempt to reconnect if connection-related error
      if (
        error.code === 'ECONNREFUSED' || 
        error.message.includes('connection') || 
        error.message.includes('disconnected')
      ) {
        try {
          await this.connect();
          return await operation();
        } catch (reconnectError) {
          logger.error('REDIS_RECONNECTION_FAILED', {
            errorMessage: reconnectError.message,
            operationName: operationName,
            timestamp: new Date().toISOString()
          });
          throw reconnectError;
        }
      }

      throw error;
    }
  }

  /**
   * Store a queued bet in Redis
   * @param {string} gameSessionId - Game session identifier
   * @param {Object} queuedBet - Bet details to queue
   */
  async storeQueuedBet(gameSessionId, queuedBet) {
    try {
      const client = await this.ensureClientReady();
      const key = 'global:queued_bets'; // Use a global key for queued bets
      
      // Store bet with unique identifier, preserving original session ID for reference
      const queuedBetData = {
        ...queuedBet,
        id: queuedBet.id || uuidv4(), // Ensure consistent ID key
        queuedAt: new Date().toISOString(),
        status: 'queued',
        originalSessionId: gameSessionId, // Store original session ID for reference
        gameSessionId: null // Will be updated when activated in next session
      };

      // Store bet in queued bets index with session tracking
      await client.hSet(key, queuedBetData.id, JSON.stringify(queuedBetData));
      
      // Add to queued bets set for efficient retrieval
      await client.sAdd(`game:${gameSessionId}:queued_set`, queuedBetData.id);
      
      // Set expiration on both keys
      await client.expire(key, 10 * 60); // 10 minutes
      
      logger.info('QUEUED_BET_STORED', {
        betId: queuedBetData.id,
        originalSessionId: gameSessionId,
        userId: queuedBetData.userId,
        queuedAt: queuedBetData.queuedAt
      });
    } catch (error) {
      logger.error('QUEUED_BET_STORAGE_ERROR', {
        gameSessionId,
        errorMessage: error.message
      });
      throw error;
    }
  }

  /**
   * Retrieve recent bet history for a user
   * @param {string} userId - User identifier
   * @param {number} limit - Number of recent bets to retrieve
   * @returns {Array} User's recent bet history
   */
  async getUserRecentBetHistory(userId, limit = 10) {
    try {
      const client = await this.ensureClientReady();
      const key = `user_bet_history:${userId}`;
      
      // Retrieve recent bets, sorted by timestamp
      const recentBetsRaw = await client.zrevrange(key, 0, limit - 1);
      
      const recentBets = recentBetsRaw.map(betStr => {
        try {
          return JSON.parse(betStr);
        } catch {
          return null;
        }
      }).filter(bet => bet !== null);
      
      logger.info('USER_BET_HISTORY_RETRIEVED', {
        userId,
        recentBetsCount: recentBets.length
      });
      
      return recentBets;
    } catch (error) {
      logger.error('USER_BET_HISTORY_RETRIEVAL_ERROR', {
        userId,
        errorMessage: error.message
      });
      return [];
    }
  }

  async queueBetForNextSession(betDetails, sessionId = null) {
    try {
      const client = await this.ensureClientReady();
      
      // Get current session for tracking
      const currentSession = await this.getCurrentGameSessionId();
      if (!currentSession) {
        throw new Error('No active game session found');
      }
      
      const betId = betDetails.id || uuidv4();
      
      // Always use global queue key for queued bets
      const queueKey = 'global:queued_bets';

      // Add expiration timestamp to bet details
      const queuedBet = {
        ...betDetails,
        id: betId,  // Ensure consistent ID key
        queuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + SESSION_MANAGEMENT_CONFIG.SESSION_EXPIRY_SECONDS * 1000).toISOString(),
        status: 'queued',
        originalSessionId: currentSession, // Track which session it was queued from
        gameSessionId: null // Will be updated when activated in next session
      };

      // Store bet in queued bets index with session tracking
      await client.hSet(queueKey, betId, JSON.stringify(queuedBet));
      
      // Add to queued bets set for efficient retrieval
      await client.sAdd(`game:${currentSession}:queued_set`, betId);
      
      // Set expiration on both keys
      await client.expire(queueKey, SESSION_MANAGEMENT_CONFIG.SESSION_EXPIRY_SECONDS);
      await client.expire(`game:${currentSession}:queued_set`, SESSION_MANAGEMENT_CONFIG.SESSION_EXPIRY_SECONDS);

      logger.info('BET_QUEUED_FOR_SESSION', {
        betId,
        userId: betDetails.userId,
        amount: betDetails.amount,
        queuedAt: new Date().toISOString(),
        sessionId: sessionId || 'global'
      });

      return {
        betId,
        queuedAt: new Date().toISOString(),
        sessionId: sessionId || 'global'
      };
    } catch (error) {
      logger.error('QUEUE_BET_ERROR', {
        errorMessage: error.message,
        betDetails,
        sessionId,
        context: 'queueBetForNextSession',
        clientMethods: Object.keys(this._client || {})
      });
      throw error;
    }
  }

  /**
   * Retrieve queued bets for a specific game session
   * @param {string} sessionId - Game session identifier
   * @returns {Array} List of queued bets
   */
  async getNextSessionBets(sessionId = null) {
    try {
      const client = await this.ensureClientReady();
      
      // Determine the queue keys to search
      const queueKeys = sessionId 
        ? [`${this.REDIS_KEYS.SESSION_BET_QUEUE_PREFIX}:${sessionId}`]
        : [this.REDIS_KEYS.GLOBAL_BET_QUEUE];

      const queuedBets = [];

      // Retrieve bets from specified queue keys
      for (const queueKey of queueKeys) {
        const rawBets = await client.lrange(queueKey, 0, -1);
        
        for (const rawBet of rawBets) {
          try {
            const bet = JSON.parse(rawBet);
            
            // Validate bet structure
            if (!bet.id || !bet.userId) {
              logger.warn('INVALID_QUEUED_BET_STRUCTURE', { 
                queueKey, 
                rawBet 
              });
              continue;
            }

            // Add metadata and only add unique bets
            if (!queuedBets.some(existingBet => existingBet.id === bet.id)) {
              queuedBets.push({
                ...bet,
                queueSource: queueKey,
                status: 'queued'
              });
            }
          } catch (parseError) {
            logger.warn('QUEUED_BET_PARSE_FAILURE', {
              queueKey,
              rawBet,
              errorMessage: parseError.message
            });
          }
        }
      }

      // Log retrieval details
      logger.debug('QUEUED_BETS_RETRIEVED', {
        sessionId,
        totalQueuedBets: queuedBets.length,
        betIds: queuedBets.map(bet => bet.id)
      });

      return queuedBets;
    } catch (error) {
      logger.error('GET_NEXT_SESSION_BETS_ERROR', {
        errorMessage: error.message,
        context: 'getNextSessionBets',
        clientMethods: Object.keys(this._client || {})
      });
      return [];
    }
  }

  async removeProcessedQueuedBets(processedBetIds, sessionId = null) {
    try {
      const client = await this.ensureClientReady();
      
      // Determine the queue keys to remove from
      const queueKeys = sessionId 
        ? [`${this.REDIS_KEYS.SESSION_BET_QUEUE_PREFIX}:${sessionId}`]
        : [this.REDIS_KEYS.GLOBAL_BET_QUEUE];

      let removedCount = 0;
      for (const queueKey of queueKeys) {
        // Remove each processed bet using compatible methods
        for (const betId of processedBetIds) {
          let betRemoved = false;
          
          // Try different removal methods
          if (typeof this._client.hdel === 'function') {
            // Modern Redis clients
            const betsToRemove = await this._client.hget(queueKey, betId);
            if (betsToRemove) {
              await this._client.hdel(queueKey, betId);
              betRemoved = true;
            }
          } else if (typeof this._client.del === 'function') {
            // Fallback for simple clients
            const fullKey = `${queueKey}:${betId}`;
            const betExists = await this._client.exists(fullKey);
            
            if (betExists) {
              await this._client.del(fullKey);
              betRemoved = true;
            }
          }

          if (betRemoved) {
            removedCount++;
          }
        }
      }

      logger.info('PROCESSED_BETS_REMOVED', { 
        removedCount, 
        processedBetIds 
      });

      return removedCount;
    } catch (error) {
      logger.error('REMOVE_PROCESSED_BETS_ERROR', {
        errorMessage: error.message,
        context: 'removeProcessedQueuedBets',
        clientMethods: Object.keys(this._client || {})
      });
      return 0;
    }
  }

  async clearQueuedBetsStorage(sessionId = null) {
    try {
      const client = await this.ensureClientReady();
      
      // Determine the queue keys to clear
      const queueKeys = sessionId 
        ? [`${this.REDIS_KEYS.SESSION_BET_QUEUE_PREFIX}:${sessionId}`]
        : [this.REDIS_KEYS.GLOBAL_BET_QUEUE];

      let betCount = 0;

      // Determine bet count using compatible methods
      for (const queueKey of queueKeys) {
        if (typeof this._client.hlen === 'function') {
          // Modern Redis clients
          betCount = await this._client.hlen(queueKey);
        } else if (typeof this._client.hkeys === 'function') {
          // Fallback for older clients
          const keys = await this._client.hkeys(queueKey);
          betCount = keys.length;
        } else {
          // Fallback to keys method
          const keys = await this._client.keys(`${queueKey}:*`);
          betCount = keys.length;
        }
      }

      // Remove storage using compatible methods
      if (typeof this._client.del === 'function') {
        await this._client.del(...queueKeys);
      } else {
        // Fallback to removing individual keys
        for (const queueKey of queueKeys) {
          const keys = await this._client.keys(`${queueKey}:*`);
          if (keys.length > 0) {
            await this._client.del(...keys);
          }
        }
      }

      logger.info('QUEUED_BETS_STORAGE_CLEARED', {
        clearedBetCount: betCount
      });

      return betCount;
    } catch (error) {
      logger.error('CLEAR_QUEUED_BETS_STORAGE_ERROR', {
        errorMessage: error.message,
        context: 'clearQueuedBetsStorage',
        clientMethods: Object.keys(this._client || {})
      });
      return 0;
    }
  }

  async _cleanupExpiredQueuedBets() {
    try {
      const currentTime = Date.now();
      const queueKey = 'global:queued_bets';

      // Retrieve queued bets using compatible methods
      let queuedBetsRaw = {};
      if (typeof this._client.hgetall === 'function') {
        queuedBetsRaw = await this._client.hgetall(queueKey);
      } else if (typeof this._client.hkeys === 'function' && typeof this._client.hget === 'function') {
        const betKeys = await this._client.hkeys(queueKey);
        for (const betKey of betKeys) {
          const betData = await this._client.hget(queueKey, betKey);
          queuedBetsRaw[betKey] = betData;
        }
      }

      // Identify and remove expired bets
      const expiredBetIds = Object.keys(queuedBetsRaw).filter(betId => {
        try {
          const bet = JSON.parse(queuedBetsRaw[betId]);
          return new Date(bet.expiresAt) < new Date(currentTime);
        } catch (parseError) {
          logger.warn('INVALID_EXPIRED_BET_JSON', { 
            rawBet: queuedBetsRaw[betId], 
            error: parseError.message 
          });
          return false;
        }
      });

      // Remove expired bets using compatible methods
      if (expiredBetIds.length > 0) {
        if (typeof this._client.hdel === 'function') {
          await this._client.hdel(queueKey, ...expiredBetIds);
        } else {
          // Fallback removal method
          for (const betId of expiredBetIds) {
            await this._client.del(`${queueKey}:${betId}`);
          }
        }
      }

      logger.info('EXPIRED_QUEUED_BETS_CLEANED', {
        timestamp: new Date(currentTime).toISOString(),
        expiredBetsCount: expiredBetIds.length
      });

      return expiredBetIds.length;
    } catch (error) {
      logger.error('EXPIRED_BETS_CLEANUP_ERROR', {
        errorMessage: error.message,
        context: '_cleanupExpiredQueuedBets',
        clientMethods: Object.keys(this._client || {})
      });
      return 0;
    }
  }

  /**
   * Store a bet in Redis with expiration and consistent key pattern
   * @param {string} gameSessionId - Game session identifier
   * @param {Object} betDetails - Bet details to store
   * @param {number} [expirationSeconds=3600] - Expiration time in seconds
   * @returns {Promise<Object>} Stored bet details
   */
  async storeBet(gameSessionId, betDetails, expirationSeconds = 3600) {
    try {
      const client = await this.ensureClientReady();
      
      // Validate and sanitize bet data
      if (!gameSessionId || !betDetails) {
        logger.error('REDIS_BET_STORAGE_INVALID_INPUT', {
          gameSessionId,
          betData: JSON.stringify(betDetails)
        });
        throw new Error('Invalid bet data or game ID');
      }

      // Ensure bet has a unique identifier
      const betId = betDetails.id || betDetails.betId || uuidv4();
      
      // Use consistent key pattern for bet storage
      const betKey = `game:${gameSessionId}:bets`;
      
      // Prepare bet data for storage with complete metadata
      const sanitizedBetData = {
        ...betDetails,
        id: betId,
        betId: betId,
        gameSessionId,
        storedAt: new Date().toISOString(),
        state: betDetails.state || 'placed'
      };

      // Store bet data
      await client.hSet(betKey, betId, JSON.stringify(sanitizedBetData));
      
      // Set expiration on the hash
      await client.expire(betKey, expirationSeconds);

      // Also store in the state-specific set for easier retrieval
      const stateKey = `game:${gameSessionId}:${sanitizedBetData.state}`;
      await client.sAdd(stateKey, betId);
      await client.expire(stateKey, expirationSeconds);

      logger.debug('BET_STORED', {
        gameSessionId,
        betId,
        betKey,
        state: sanitizedBetData.state
      });

      return sanitizedBetData;

      try {
        // Create a multi command for atomic operations
        const multi = this._client.multi();

        // Store bet data in hash
        const betData = JSON.stringify({
          ...sanitizedBetData,
          storedAt: Date.now(),
          expiresAt: Date.now() + expirationSeconds * 1000
        });

        // Add commands to transaction
        multi.hSet(betKey, betId, betData);
        multi.expire(betKey, expirationSeconds);

        // Execute all commands atomically
        await multi.exec();

        // Verify bet was stored successfully
        const storedBet = await this._client.hGet(betKey, betId);
        if (!storedBet) {
          throw new Error('BET_STORAGE_VERIFICATION_FAILED');
        }

        logger.info('BET_STORED_SUCCESSFULLY', {
          betId: sanitizedBetData.id,
          gameSessionId,
          status: sanitizedBetData.status,
          verificationStatus: 'success'
        });

        return sanitizedBetData;
      } catch (storageError) {
        logger.error('BET_STORAGE_ERROR', {
          betId: sanitizedBetData.id,
          gameSessionId,
          errorMessage: storageError.message,
          errorStack: storageError.stack
        });
        throw storageError;
      }
    } catch (error) {
      logger.error('BET_STORAGE_ERROR', {
        errorMessage: error.message,
        gameSessionId,
        betDetails,
        context: 'storeBet',
        clientMethods: Object.keys(this._client || {})
      });
      throw error;
    }
  }

  /**
   * Retrieve a bet by its ID within a specific game session with enhanced retrieval
   * @param {string} gameSessionId - Game session identifier
   * @param {string} betId - Unique bet identifier
   * @returns {Promise<Object|null>} Retrieved bet data or null
   */
  async getBetById(gameSessionId, betId) {
    try {
      const client = await this.ensureClientReady();

      // Validate input parameters
      if (!gameSessionId || !betId) {
        throw new Error('INVALID_PARAMETERS');
      }

      // Try both key patterns to ensure backward compatibility
      const keyPatterns = [
        `game:${gameSessionId}:bets`,
        `game_session_bets:${gameSessionId}`
      ];

      for (const betKey of keyPatterns) {
        const rawBetData = await client.hGet(betKey, betId);
        
        if (rawBetData) {
          try {
            const betData = JSON.parse(rawBetData);
            
            // Verify bet belongs to correct game session
            if (betData.gameSessionId === gameSessionId) {
              logger.debug('BET_FOUND', {
                gameSessionId,
                betId,
                betKey,
                state: betData.state
              });
              return betData;
            }
          } catch (parseError) {
            logger.warn('BET_PARSE_ERROR', {
              gameSessionId,
              betId,
              betKey,
              error: parseError.message
            });
          }
        }
      }
      
      // If we get here, the bet was not found in any key pattern
      logger.debug('BET_NOT_FOUND', {
        gameSessionId,
        betId,
        triedKeys: keyPatterns
      });
      return null;
    } catch (error) {
      logger.error('BET_RETRIEVAL_ERROR', {
        gameSessionId,
        betId,
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }

  async smembers(key) {
    try {
      const client = await this.ensureClientReady();
      return await client.sMembers(key);
    } catch (error) {
      logger.error('REDIS_SMEMBERS_ERROR', {
        key,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Helper method for Redis SREM operation
   * @param {string} key - Redis key
   * @param {string} value - Value to remove from set
   * @returns {Promise<number>} Number of elements removed
   */
  async srem(key, value) {
    try {
      const client = await this.ensureClientReady();
      return await client.sRem(key, value);
    } catch (error) {
      logger.error('REDIS_SREM_ERROR', {
        key,
        value,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Bulk activate bets for a new game session
   * @param {string} gameId - Current game session identifier
   * @returns {Promise<{success: Array, failed: Array}>} Results of bulk activation
   */
  async bulkActivateBets(newGameId) {
    try {
      const client = await this.ensureClientReady();
      const queuedBets = await this.getQueuedBets();
      
      if (!queuedBets.length) {
        logger.info('NO_QUEUED_BETS_TO_ACTIVATE', { newGameId });
        return { success: [], failed: [] };
      }
      
      const results = {
        success: [],
        failed: []
      };
      
      // Process bets in batches of 50
      const batchSize = 50;
      for (let i = 0; i < queuedBets.length; i += batchSize) {
        const batch = queuedBets.slice(i, i + batchSize);
        const multi = client.multi();
        
        batch.forEach(bet => {
          // Prepare updated bet with new session ID
          const updatedBet = {
            ...bet,
            gameSessionId: newGameId, // Assign new session ID
            status: 'active',
            activatedAt: new Date().toISOString(),
            previousStatus: bet.status,
            originalSessionId: bet.originalSessionId, // Preserve original session ID
            stateTransitions: [
              ...(bet.stateTransitions || []),
              {
                from: 'queued',
                to: 'active',
                timestamp: new Date().toISOString(),
                previousSessionId: bet.originalSessionId,
                newSessionId: newGameId
              }
            ]
          };
          
          // Remove from global queued bets
          multi.hDel('global:queued_bets', bet.id);
          
          // Add to new game session's active bets
          const newSessionKey = this._getBetStorageKey(newGameId, 'active');
          multi.hSet(newSessionKey, bet.id, JSON.stringify(updatedBet));
          
          // Add to active bets index
          multi.sAdd(`game:${newGameId}:active_bets`, bet.id);
        });
        
        try {
          await multi.exec();
          results.success.push(...batch.map(b => ({ 
            id: b.id, 
            userId: b.userId,
            originalSessionId: b.originalSessionId,
            newSessionId: newGameId
          })));
        } catch (error) {
          results.failed.push(...batch.map(b => ({ 
            id: b.id, 
            userId: b.userId,
            originalSessionId: b.originalSessionId, 
            error: error.message 
          })));
        }
      }
      
      logger.info('BULK_BET_ACTIVATION_RESULTS', {
        newGameId,
        totalBets: queuedBets.length,
        successCount: results.success.length,
        failedCount: results.failed.length,
        timestamp: new Date().toISOString()
      });
      
      return results;
    } catch (error) {
      logger.error('BULK_ACTIVATE_QUEUED_BETS_ERROR', {
        newGameId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Add a bet to the active bets set for a game session
   * @param {string} gameSessionId - Game session ID
   * @param {string} betId - Bet ID to add
   * @returns {Promise<void>}
   */
  async addActiveBetToSet(gameSessionId, betId) {
    try {
      const client = await this.ensureClientReady();
      await client.sAdd(`game:${gameSessionId}:active_bets`, betId);
      
      logger.debug('Added bet to active set', {
        betId,
        gameSessionId
      });
    } catch (error) {
      logger.error('Failed to add bet to active set', {
        betId,
        gameSessionId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get all placed bets that need activation
   * @returns {Promise<Array>} List of placed bets
   */
  async getPlacedBets() {
    try {
      const client = await this.ensureClientReady();
      const placedBetsKey = 'bets:placed';
      const placedBets = await client.sMembers(placedBetsKey);
      
      const bets = [];
      for (const betId of placedBets) {
        const bet = await client.hGetAll(`bet:${betId}`);
        if (bet) {
          bets.push({ ...bet, id: betId });
        }
      }
      
      return bets;
    } catch (error) {
      logger.error('Failed to get placed bets', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Activate placed bets for a new game session
   * @param {string} gameSessionId - New game session ID
   * @returns {Promise<Object>} Activation results
   */
  async activatePlacedBets(gameSessionId) {
    try {
      const client = await this.ensureClientReady();
      const placedBets = await this.getPlacedBets();
      const results = {
        activated: [],
        failed: []
      };

      for (const bet of placedBets) {
        try {
          // Update bet status to active
          await client.hset(`bet:${bet.id}`, 'status', 'ACTIVE');
          await client.hset(`bet:${bet.id}`, 'gameSessionId', gameSessionId);
          
          // Add to active bets set
          await this.addActiveBetToSet(gameSessionId, bet.id);
          
          // Remove from placed bets set
          await client.srem('bets:placed', bet.id);
          
          results.activated.push({
            betId: bet.id,
            userId: bet.userId,
            amount: bet.amount
          });
        } catch (error) {
          results.failed.push({
            betId: bet.id,
            error: error.message
          });
        }
      }

      // Log activation results
      logger.info('Placed bets activation results', {
        gameSessionId,
        activated: results.activated.length,
        failed: results.failed.length
      });

      return results;
    } catch (error) {
      logger.error('Failed to activate placed bets', {
        gameSessionId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Store a placed bet (not yet active)
   * @param {Object} bet - Bet details to store
   * @returns {Promise<void>}
   */
  async storePlacedBet(bet) {
    try {
      const client = await this.ensureClientReady();
      
      // Convert bet object to string values for Redis
      const betData = Object.entries(bet).reduce((acc, [key, value]) => {
        acc[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return acc;
      }, {});

      // Store bet details using hset helper
      await this.hset(`bet:${bet.id}`, {
        ...betData,
        status: 'PLACED'
      });
      
      // Add to placed bets set using sadd helper
      await this.sadd('bets:placed', bet.id);
      
      // Set expiration (24 hours)
      const client2 = await this.ensureClientReady();
      await client2.expire(`bet:${bet.id}`, 24 * 60 * 60);
      
      logger.debug('Stored placed bet', {
        betId: bet.id,
        userId: bet.userId
      });
    } catch (error) {
      logger.error('Failed to store placed bet', {
        betId: bet.id,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get all placed bets that need activation
   * @returns {Promise<Array>} List of placed bets
   */
  async getPlacedBets() {
    try {
      const client = await this.ensureClientReady();
      const placedBetsKey = 'bets:placed';
      const placedBets = await client.sMembers(placedBetsKey);
      
      const bets = [];
      for (const betId of placedBets) {
        const bet = await client.hGetAll(`bet:${betId}`);
        if (bet) {
          bets.push({ ...bet, id: betId });
        }
      }
      
      return bets;
    } catch (error) {
      logger.error('Failed to get placed bets', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Activate placed bets for a new game session
   * @param {string} gameSessionId - New game session ID
   * @returns {Promise<Object>} Activation results
   */
  async activatePlacedBets(gameSessionId) {
    try {
      const client = await this.ensureClientReady();
      const placedBets = await this.getPlacedBets();
      const results = {
        activated: [],
        failed: []
      };

      for (const bet of placedBets) {
        try {
          // Update bet status to active
          await client.hset(`bet:${bet.id}`, 'status', 'ACTIVE');
          await client.hset(`bet:${bet.id}`, 'gameSessionId', gameSessionId);
          
          // Add to active bets set
          await this.addActiveBetToSet(gameSessionId, bet.id);
          
          // Remove from placed bets set
          await client.srem('bets:placed', bet.id);
          
          results.activated.push({
            betId: bet.id,
            userId: bet.userId,
            amount: bet.amount
          });
        } catch (error) {
          results.failed.push({
            betId: bet.id,
            error: error.message
          });
        }
      }

      // Log activation results
      logger.info('Placed bets activation results', {
        gameSessionId,
        activated: results.activated.length,
        failed: results.failed.length
      });

      return results;
    } catch (error) {
      logger.error('Failed to activate placed bets', {
        gameSessionId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Helper method for Redis HGETALL operation
   * @param {string} key - Redis key
   * @returns {Promise<Object>} Hash fields and values
   */
  async hgetall(key) {
    try {
      const client = await this.ensureClientReady();
      const result = await client.hGetAll(key);
      const client2 = await this.ensureClientReady();
      return result;
    } catch (error) {
      logger.error('REDIS_HGETALL_ERROR', {
        key,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Store an active bet for the current game session
   * @param {string} gameSessionId - Current game session ID
   * @param {Object} bet - Bet details
   */
  async storeBet(gameSessionId, bet) {
    try {
      const client = await this.ensureClientReady();
      
      // Convert bet object to string values
      const betData = Object.entries(bet).reduce((acc, [key, value]) => {
        acc[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return acc;
      }, {});

      // Store bet in game session hash
      const betKey = `game:${gameSessionId}:bets`;
      await this.hset(`${betKey}:${bet.id}`, {
        ...betData,
        status: 'ACTIVE',
        gameSessionId
      });
      
      // Add to active bets set
      await this.sadd(`game:${gameSessionId}:active_bets`, bet.id);
      
      // Set expiration (1 hour)
      await this.expire(betKey, 3600);
      
      logger.debug('Stored active bet', {
        betId: bet.id,
        userId: bet.userId,
        gameSessionId,
        status: 'ACTIVE'
      });
    } catch (error) {
      logger.error('Failed to store active bet', {
        betId: bet.id,
        gameSessionId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Add a bet to the active bets set for a game session
   * @param {string} gameSessionId - Game session ID
   * @param {string} betId - Bet ID to activate
   */
  async addActiveBetToSet(gameSessionId, betId) {
    try {
      // Add to active bets set
      await this.sadd(`game:${gameSessionId}:active_bets`, betId);
      
      logger.debug('Added bet to active set', {
        betId,
        gameSessionId
      });
    } catch (error) {
      logger.error('Failed to add bet to active set', {
        betId,
        gameSessionId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Activate placed bets for the current game session
   * @param {string} gameSessionId - Current game session ID
   */
  async activatePlacedBets(gameSessionId) {
    try {
      const client = await this.ensureClientReady();
      
      // Get all placed bets
      const placedBetIds = await this.smembers('bets:placed');
      if (!placedBetIds.length) {
        logger.debug('No placed bets to activate', { gameSessionId });
        return;
      }

      logger.info('Activating placed bets', {
        gameSessionId,
        placedBetCount: placedBetIds.length
      });

      // Process each placed bet
      for (const betId of placedBetIds) {
        try {
          // Get bet details
          const betKey = `bet:${betId}`;
          const betData = await client.hGetAll(betKey);
          
          if (!betData || !betData.id) {
            logger.warn('Invalid bet data found', { betId, gameSessionId });
            continue;
          }

          // Update bet status to active
          await client.hset(`${betKey}`, {
            ...betData,
            status: 'ACTIVE',
            gameSessionId,
            activatedAt: new Date().toISOString()
          });

          // Add to current session's active bets
          await this.sadd(`game:${gameSessionId}:active_bets`, betId);
          
          // Remove from placed bets
          await client.srem('bets:placed', betId);

          logger.debug('Activated placed bet', {
            betId,
            userId: betData.userId,
            gameSessionId
          });
        } catch (error) {
          logger.error('Failed to activate placed bet', {
            betId,
            gameSessionId,
            error: error.message
          });
          // Continue processing other bets
          continue;
        }
      }
    } catch (error) {
      logger.error('Failed to activate placed bets', {
        gameSessionId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get active bet details by ID
   * @param {string} gameSessionId - Current game session ID
   * @param {string} betId - Bet ID to retrieve
   * @returns {Promise<Object>} Bet details if found
   */
  async getActiveBet(gameSessionId, betId) {
    try {
      const client = await this.ensureClientReady();
      const betKey = `game:${gameSessionId}:bets`;
      const betData = await client.hGetAll(`${betKey}:${betId}`);
      
      if (!betData || Object.keys(betData).length === 0) {
        return null;
      }

      // Parse any JSON fields
      Object.entries(betData).forEach(([key, value]) => {
        try {
          betData[key] = JSON.parse(value);
        } catch {
          // Keep as is if not JSON
          betData[key] = value;
        }
      });

      return { ...betData, id: betId };
    } catch (error) {
      logger.error('Failed to get active bet', {
        gameSessionId,
        betId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Process manual cashout for an active bet
   * @param {string} gameSessionId - Current game session ID
   * @param {string} betId - Bet ID to cash out
   * @param {number} multiplier - Current game multiplier
   * @returns {Promise<Object>} Cashout result
   */
  async processManualCashout(gameSessionId, betId, multiplier) {
    try {
      const client = await this.ensureClientReady();
      
      // Get bet details
      const bet = await this.getActiveBet(gameSessionId, betId);
      if (!bet) {
        throw new Error('Bet not found or not active');
      }

      // Calculate cashout amount
      const cashoutAmount = parseFloat(bet.amount) * multiplier;
      
      // Update bet status
      const betKey = `game:${gameSessionId}:bets`;
      await this.hset(`${betKey}:${betId}`, {
        ...bet,
        status: 'WON',
        cashoutMultiplier: multiplier,
        cashoutAmount,
        cashoutTime: new Date().toISOString(),
        cashoutType: 'manual'
      });

      // Remove from active bets
      await this.srem(`game:${gameSessionId}:active_bets`, betId);
      
      // Add to won bets
      await this.sadd(`game:${gameSessionId}:won_bets`, betId);

      logger.info('Manual cashout processed', {
        gameSessionId,
        betId,
        userId: bet.userId,
        multiplier,
        cashoutAmount
      });

      return {
        success: true,
        betId,
        userId: bet.userId,
        amount: bet.amount,
        cashoutAmount,
        multiplier
      };
    } catch (error) {
      logger.error('Failed to process manual cashout', {
        gameSessionId,
        betId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Process auto cashout for active bets
   * @param {string} gameSessionId - Current game session ID
   * @param {number} currentMultiplier - Current game multiplier
   * @returns {Promise<Array>} Array of processed cashouts
   */
  async processAutoCashouts(gameSessionId, currentMultiplier) {
    try {
      const client = await this.ensureClientReady();
      
      // Get all active bets
      const activeBets = await client.sMembers(`game:${gameSessionId}:active_bets`);
      const results = {
        processed: [],
        failed: []
      };

      for (const betId of activeBets) {
        try {
          const bet = await this.getActiveBet(gameSessionId, betId);
          if (!bet || !bet.autoCashoutAt) continue;

          // Check if we should auto cashout
          if (currentMultiplier >= parseFloat(bet.autoCashoutAt)) {
            // Process the auto cashout
            const cashoutAmount = parseFloat(bet.amount) * parseFloat(bet.autoCashoutAt);
            
            // Update bet status
            const betKey = `game:${gameSessionId}:bets`;
            await this.hset(`${betKey}:${betId}`, {
              ...bet,
              status: 'WON',
              cashoutMultiplier: bet.autoCashoutAt,
              cashoutAmount,
              cashoutTime: new Date().toISOString(),
              cashoutType: 'auto'
            });

            // Remove from active bets
            await this.srem(`game:${gameSessionId}:active_bets`, betId);
            
            // Add to won bets
            await this.sadd(`game:${gameSessionId}:won_bets`, betId);

            results.processed.push({
              betId,
              userId: bet.userId,
              amount: bet.amount,
              cashoutAmount,
              multiplier: bet.autoCashoutAt
            });
          }
        } catch (error) {
          logger.error('Failed to process auto cashout for bet', {
            gameSessionId,
            betId,
            error: error.message
          });
          results.failed.push({ betId, error: error.message });
        }
      }

      logger.info('Auto cashouts processed', {
        gameSessionId,
        processedCount: results.processed.length,
        failedCount: results.failed.length
      });

      return results;
    } catch (error) {
      logger.error('Failed to process auto cashouts', {
        gameSessionId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Clear all placed bets from storage
   * @returns {Promise<void>}
   */
  async clearPlacedBets() {
    try {
      const client = await this.ensureClientReady();
      const placedBetsKey = 'bets:placed';
      
      // Get all placed bets first
      const placedBets = await client.sMembers(placedBetsKey);
      
      // Delete each bet's hash
      for (const betId of placedBets) {
        await client.del(`bet:${betId}`);
      }
      
      // Clear the placed bets set
      await client.del(placedBetsKey);

      logger.info('Cleared placed bets', {
        clearedBetsCount: placedBets.length
      });
    } catch (error) {
      logger.error('Failed to clear placed bets', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Clear active bets for a specific game session
   * @param {string} gameSessionId - Game session to clear active bets for
   * @returns {Promise<void>}
   */
  async clearActiveBets(gameSessionId) {
    try {
      const client = await this.ensureClientReady();
      const activeBetsKey = `game:${gameSessionId}:active_bets`;
      
      // Get all active bets first
      const activeBets = await client.sMembers(activeBetsKey);
      
      // Delete each bet's hash
      for (const betId of activeBets) {
        await client.del(`game:${gameSessionId}:bets:${betId}`);
      }
      
      // Clear the active bets set
      await client.del(activeBetsKey);

      logger.info('Cleared active bets for game session', {
        gameSessionId,
        clearedBetsCount: activeBets.length
      });
    } catch (error) {
      logger.error('Failed to clear active bets', {
        gameSessionId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Clear all bet-related keys for a game session
   * @param {string} gameSessionId - Game session to clear
   * @returns {Promise<void>}
   */
  async clearAllGameBets(gameSessionId) {
    try {
      const client = await this.ensureClientReady();
      
      // Get all keys related to this game session
      const gameKeys = await client.keys(`game:${gameSessionId}:*`);
      
      if (gameKeys.length > 0) {
        // Delete all game-related keys
        await client.del(gameKeys);
      }

      logger.info('Cleared all bet keys for game session', {
        gameSessionId,
        clearedKeysCount: gameKeys.length
      });
    } catch (error) {
      logger.error('Failed to clear game session bets', {
        gameSessionId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Clear all placed bets from storage
   * @returns {Promise<void>}
   */
  async clearPlacedBets() {
    try {
      const client = await this.ensureClientReady();
      const placedBetsKey = 'bets:placed';
      
      // Get all placed bets first
      const placedBets = await client.sMembers(placedBetsKey);
      
      // Delete each bet's hash and related keys
      for (const betId of placedBets) {
        await client.del(`bet:${betId}`);
        await client.sRem(placedBetsKey, betId);
      }
      
      // Clear the placed bets set
      await client.del(placedBetsKey);

      logger.info('Cleared placed bets storage', {
        clearedBetsCount: placedBets.length
      });
    } catch (error) {
      logger.error('Failed to clear placed bets', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Clear active bets for a specific game session
   * @param {string} gameSessionId - Game session to clear active bets for
   * @returns {Promise<void>}
   */
  async clearActiveBets(gameSessionId) {
    try {
      const client = await this.ensureClientReady();
      const activeBetsKey = `game:${gameSessionId}:active_bets`;
      const betPrefix = `game:${gameSessionId}:bets`;
      
      // Get all active bets first
      const activeBets = await client.sMembers(activeBetsKey);
      
      // Delete each bet's hash and related keys
      const pipeline = client.multi();
      for (const betId of activeBets) {
        // Delete bet hash
        pipeline.del(`${betPrefix}:${betId}`);
        
        // Remove from active bets set
        pipeline.sRem(activeBetsKey, betId);
        
        // Remove from user's active bets if it exists
        const bet = await client.hGetAll(`${betPrefix}:${betId}`);
        if (bet.userId) {
          pipeline.sRem(`user:${bet.userId}:active_bets`, betId);
        }
      }
      
      // Clear the active bets set
      pipeline.del(activeBetsKey);
      
      // Execute all commands
      await pipeline.exec();

      logger.info('Cleared active bets for game session', {
        gameSessionId,
        clearedBetsCount: activeBets.length
      });
    } catch (error) {
      logger.error('Failed to clear active bets', {
        gameSessionId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Sync Redis bets with database and clear stale bets
   * @param {string} gameSessionId - Current game session ID
   * @returns {Promise<void>}
   */
  async syncBetsWithDatabase(gameSessionId) {
    try {
      const client = await this.ensureClientReady();
      
      // Get all Redis active bets
      const activeBetsKey = `game:${gameSessionId}:active_bets`;
      const activeBets = await client.sMembers(activeBetsKey);
      
      // Get all Redis placed bets
      const placedBetsKey = 'bets:placed';
      const placedBets = await client.sMembers(placedBetsKey);

      // Get all bet details
      const allBets = [...activeBets, ...placedBets];
      const betDetails = [];
      
      for (const betId of allBets) {
        const bet = await client.hGetAll(`game:${gameSessionId}:bets`);
        if (bet) {
          betDetails.push({
            betId,
            ...bet,
            createdAt: new Date(bet.createdAt)
          });
        }
      }

      // Find stale bets (older than 1 hour)
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const staleBets = betDetails.filter(bet => bet.createdAt < oneHourAgo);

      // Clear stale bets
      if (staleBets.length > 0) {
        const pipeline = client.multi();
        
        for (const bet of staleBets) {
          // Remove from active bets
          pipeline.sRem(activeBetsKey, bet.betId);
          
          // Remove from placed bets
          pipeline.sRem(placedBetsKey, bet.betId);
          
          // Remove bet hash
          pipeline.del(`game:${gameSessionId}:bets:${bet.betId}`);
          
          // Remove from user's active bets
          if (bet.userId) {
            pipeline.sRem(`user:${bet.userId}:active_bets`, bet.betId);
          }
        }
        
        await pipeline.exec();

        logger.info('Cleared stale bets', {
          gameSessionId,
          clearedBetsCount: staleBets.length,
          staleBetIds: staleBets.map(b => b.betId)
        });
      }

      // Log sync results
      logger.info('Bet sync completed', {
        gameSessionId,
        activeBetsCount: activeBets.length,
        placedBetsCount: placedBets.length,
        staleBetsCleared: staleBets.length
      });
    } catch (error) {
      logger.error('Failed to sync bets with database', {
        gameSessionId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Manually clear all bets from Redis
   * @returns {Promise<void>}
   */
  async manualClearAllBets() {
    try {
      const client = await this.ensureClientReady();
      
      // Get all game session related keys
      const gameKeys = await client.keys('game:*');
      const placedBetsKey = 'bets:placed';
      const userBetKeys = await client.keys('user:*:active_bets');
      
      // Delete all keys in a pipeline
      if (gameKeys.length > 0 || userBetKeys.length > 0) {
        const pipeline = client.multi();
        
        // Delete all game related keys
        for (const key of gameKeys) {
          pipeline.del(key);
        }
        
        // Delete placed bets set
        pipeline.del(placedBetsKey);
        
        // Delete all user bet keys
        for (const key of userBetKeys) {
          pipeline.del(key);
        }
        
        await pipeline.exec();
      }

      logger.info('Manually cleared all bets from Redis', {
        gameKeysCleared: gameKeys.length,
        userBetKeysCleared: userBetKeys.length
      });
    } catch (error) {
      logger.error('Failed to manually clear bets', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }
}

const redisRepositoryInstance = new RedisRepository();

// Ensure cleanup on process exit
process.on('SIGINT', async () => {
  try {
    await redisRepositoryInstance.cleanup();
    process.exit(0);
  } catch (error) {
    console.error('Cleanup failed:', error);
    process.exit(1);
  }
});

export default redisRepositoryInstance;
