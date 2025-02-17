import logger from '../config/logger.js';
import redisRepository from '../repositories/redisRepository.js';
import pkg from 'pg';
const { Pool } = pkg;
import { v4 as uuidv4 } from 'uuid';

class BetTrackingService {
  constructor() {
    // In-memory storage for bets in different states
    this.bettingStateBets = [];  // Bets during betting phase
    this.preparedBets = [];      // Bets prepared for activation
    this.activeBets = [];        // Active bets during flying phase
    this.readyForCashoutBets = []; // Bets ready for cashout
    
    // Session-level bet tracking
    this.sessionBetMetrics = {
      totalBetAmount: 0,
      totalBetCount: 0,
      userBetDetails: {}
    };
  }

  /**
   * Collect bets from the betting state
   * @param {Array} players - List of players who placed bets
   */
  collectBetsFromBettingState(players) {
    // Transfer bets from betting state to prepared bets
    this.preparedBets = this.bettingStateBets.map(bet => ({
      ...bet,
      status: 'ready_to_activate'
    }));

    // Calculate and log total bet amount
    const totalBetAmount = this.calculateTotalBetAmount();

    // Log collected bets with comprehensive metrics
    logger.info('BETS_COLLECTED_IN_BETTING_STATE', {
      totalBets: this.preparedBets.length,
      totalBetAmount,
      betsDetails: this.preparedBets.map(bet => ({
        userId: bet.userId,
        betAmount: bet.betAmount
      })),
      userBetDetails: this.sessionBetMetrics.userBetDetails
    });

    // Clear betting state bets
    this.bettingStateBets = [];
  }

  /**
   * Prepare bets for last-second activation
   * @param {Object} gameState - Current game state
   */
  prepareBetsForLastSecondActivation(gameState) {
    // Ensure bets are prepared just before flying phase
    if (this.bettingStateBets.length > 0) {
      this.preparedBets = this.bettingStateBets.map(bet => ({
        ...bet,
        gameSessionId: gameState.gameId,
        status: 'ready_to_activate'
      }));

      // Calculate and log total bet amount
      const totalBetAmount = this.calculateTotalBetAmount();

      logger.info('BETS_PREPARED_FOR_LAST_SECOND_ACTIVATION', {
        totalPreparedBets: this.preparedBets.length,
        totalBetAmount,
        gameSessionId: gameState.gameId
      });
    }
  }

  /**
   * Activate prepared bets when entering flying phase
   * @param {Object} gameState - Current game state
   */
  activatePreparedBets(gameState) {
    // Activate prepared bets and push to active bets
    this.activeBets = this.preparedBets.map(bet => ({
      ...bet,
      status: 'active',
      activationMultiplier: 1.00,
      gameSessionId: gameState.gameId
    }));

    // Calculate and log total bet amount
    const totalBetAmount = this.calculateTotalBetAmount();

    // Log activated bets with session metrics
    logger.info('PREPARED_BETS_ACTIVATED_IN_FLYING_STATE', {
      totalActivatedBets: this.activeBets.length,
      totalBetAmount,
      gameSessionId: gameState.gameId,
      gameMultiplier: gameState.multiplier,
      userBetDetails: this.sessionBetMetrics.userBetDetails
    });

    // Attempt to push bets to Redis if needed
    this.pushActiveBetsToRedis(gameState);

    // Clear prepared bets
    this.preparedBets = [];
  }

  /**
   * Add a bet to the betting state and track session metrics
   * @param {Object} betDetails - Details of the bet to be added
   */
  addBetToBettingState(betDetails) {
    // Generate a unique bet ID
    const betId = uuidv4();

    // Create bet object
    const newBet = {
      betId,
      userId: betDetails.userId,
      betAmount: betDetails.betAmount,
      status: 'placed',
      timestamp: Date.now()
    };

    // Add to betting state bets
    this.bettingStateBets.push(newBet);

    // Update session-level bet metrics
    this.updateSessionBetMetrics(newBet);

    logger.info('BET_ADDED_TO_BETTING_STATE', {
      userId: newBet.userId,
      betAmount: newBet.betAmount,
      betId: newBet.betId,
      sessionTotalBetAmount: this.sessionBetMetrics.totalBetAmount,
      sessionTotalBetCount: this.sessionBetMetrics.totalBetCount
    });

    return newBet;
  }

  /**
   * Update session-level bet metrics
   * @param {Object} bet - Bet object to update metrics
   */
  updateSessionBetMetrics(bet) {
    // Increment total bet amount and count
    this.sessionBetMetrics.totalBetAmount += bet.betAmount;
    this.sessionBetMetrics.totalBetCount++;

    // Track user-specific bet details
    if (!this.sessionBetMetrics.userBetDetails[bet.userId]) {
      this.sessionBetMetrics.userBetDetails[bet.userId] = {
        betCount: 0,
        totalBetAmount: 0
      };
    }

    const userBetDetails = this.sessionBetMetrics.userBetDetails[bet.userId];
    userBetDetails.betCount++;
    userBetDetails.totalBetAmount += bet.betAmount;
  }

  /**
   * Push active bets to Redis
   * @param {Object} gameState - Current game state
   */
  pushActiveBetsToRedis(gameState) {
    if (this.activeBets.length === 0) {
      logger.warn('NO_BETS_TO_PUSH_TO_REDIS');
      return;
    }

    try {
      // Use redisRepository to push bets
      this.activeBets.forEach(bet => {
        redisRepository.pushBetToGameSession(
          gameState.gameId, 
          bet.userId, 
          bet.betAmount, 
          bet.status
        );
      });

      logger.info('ACTIVE_BETS_PUSHED_TO_REDIS', {
        totalBetsPushed: this.activeBets.length,
        gameSessionId: gameState.gameId
      });
    } catch (error) {
      logger.error('REDIS_BET_PUSH_FAILED', {
        errorMessage: error.message,
        gameSessionId: gameState.gameId
      });
    }
  }

  /**
   * Generate a unique Redis key for game session bets
   * @param {string} gameSessionId - Game session ID
   * @returns {string} Redis key
   */
  _generateBetKey(gameSessionId) {
    return `game:${gameSessionId}:bets`;
  }

  /**
   * Clear all bets for a specific game session after game crash
   * @param {string} gameSessionId - Game session ID
   * @param {number} crashPoint - Point at which the game crashed
   * @returns {Promise<boolean>} Whether bets were successfully cleared
   */
  async clearBetsForGameSession(gameSessionId, crashPoint) {
    try {
      const redisClient = await redisRepository.getClient();
      const betKey = this._generateBetKey(gameSessionId);
      
      // Retrieve all bets for this game session
      const betEntries = await redisClient.hGetAll(betKey);
      const bets = Object.values(betEntries).map(betStr => JSON.parse(betStr));
      
      // Process and finalize each bet
      const processedBets = bets.map(bet => ({
        ...bet,
        status: bet.cashoutMultiplier && bet.cashoutMultiplier < crashPoint ? 'won' : 'lost',
        finalCrashPoint: crashPoint
      }));

      // Optional: Store finalized bets in database
      await this.storeFinalizedBetsInDatabase(processedBets);

      // Clear the Redis key for this game session
      await redisClient.del(betKey);

      logger.info('Cleared bets for game session', {
        gameSessionId,
        crashPoint,
        totalBets: bets.length
      });

      return true;
    } catch (error) {
      logger.error('Error clearing bets for game session', {
        gameSessionId,
        crashPoint,
        errorMessage: error.message
      });
      return false;
    }
  }

  /**
   * Store finalized bets in the database for record-keeping
   * @param {Array} processedBets - Bets with final status
   * @returns {Promise<void>}
   */
  async storeFinalizedBetsInDatabase(processedBets) {
    try {
      for (const bet of processedBets) {
        await this.pool.query(
          'INSERT INTO player_bets (player_bet_id, user_id, game_session_id, bet_amount, cashout_multiplier, status, payout_amount, created_at, updated_at, bet_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [
            bet.playerBetId || null, 
            bet.userId, 
            bet.gameSessionId, 
            bet.amount, 
            bet.cashoutMultiplier || null, 
            bet.status, 
            bet.payoutAmount || null, 
            new Date().toISOString(), 
            new Date().toISOString(), 
            bet.id
          ]
        );
      }
    } catch (error) {
      logger.error('Error storing finalized bets in database', {
        errorMessage: error.message,
        bets: processedBets
      });
      throw error; // Re-throw to allow caller to handle
    }
  }

  /**
   * Update a bet's cashout multiplier in Redis
   * @param {string} gameSessionId - Game session ID
   * @param {string} betId - Bet ID
   * @param {number} cashoutMultiplier - Cashout multiplier
   * @returns {Promise<boolean>} Whether update was successful
   */
  async updateBetCashoutInRedis(gameSessionId, betId, cashoutMultiplier) {
    try {
      const redisClient = await redisRepository.getClient();
      const betKey = this._generateBetKey(gameSessionId);
      
      // Retrieve existing bet data
      const existingBetStr = await redisClient.hGet(betKey, betId);
      if (!existingBetStr) {
        logger.warn('Bet not found in Redis for cashout update', { 
          gameSessionId, 
          betId 
        });
        return false;
      }

      const existingBet = JSON.parse(existingBetStr);
      
      // Update cashout multiplier
      existingBet.cashoutMultiplier = parseFloat(cashoutMultiplier);
      
      // Store updated bet
      await redisClient.hSet(betKey, betId, JSON.stringify(existingBet));

      logger.info('Bet cashout updated in Redis', {
        gameSessionId,
        betId,
        cashoutMultiplier
      });

      return true;
    } catch (error) {
      logger.error('Error updating bet cashout in Redis', {
        gameSessionId,
        betId,
        errorMessage: error.message
      });
      return false;
    }
  }

  /**
   * Track a bet across Redis and other tracking mechanisms
   * @param {Object} betData - Bet details to track
   * @returns {Promise<boolean>} Whether tracking was successful
   */
  async trackBet(betData) {
    try {
      // Validate required bet data
      if (!betData.betId || !betData.userId || !betData.gameSessionId) {
        logger.warn('Invalid bet data for tracking', { betData });
        return false;
      }

      // Store bet in Redis
      const redisStoreResult = await this.storeBetInRedis({
        id: betData.betId,
        userId: betData.userId,
        betAmount: betData.amount,
        status: betData.status || 'placed'
      }, betData.gameSessionId);

      // Additional tracking or logging can be added here
      logger.info('Bet tracked successfully', {
        betId: betData.betId,
        gameSessionId: betData.gameSessionId,
        redisStoreResult
      });

      return redisStoreResult;
    } catch (error) {
      logger.error('Error tracking bet', {
        betData,
        errorMessage: error.message,
        errorStack: error.stack
      });
      return false;
    }
  }

  /**
   * Store a bet in Redis during active game
   * @param {Object} betData - Bet details
   * @param {string} gameSessionId - Current game session ID
   * @returns {Promise<boolean>} Whether bet was successfully stored
   */
  async storeBetInRedis(betData, gameSessionId) {
    logger.info('Redis bet storage prevented');
    return false;
  }

  /**
   * Calculate and log total bet amount across all users
   * @returns {number} Total bet amount across all users
   */
  calculateTotalBetAmount() {
    // Calculate total bet amount by summing individual user bet amounts
    const totalBetAmount = Object.values(this.sessionBetMetrics.userBetDetails)
      .reduce((total, userBets) => total + userBets.totalBetAmount, 0);

    // Log detailed bet breakdown
    logger.info('TOTAL_BET_AMOUNT_BREAKDOWN', {
      totalBetAmount,
      userBetDetails: Object.entries(this.sessionBetMetrics.userBetDetails).map(([userId, details]) => ({
        userId,
        betCount: details.betCount,
        totalBetAmount: details.totalBetAmount
      }))
    });

    return totalBetAmount;
  }

  /**
   * Prepare bets for cashout during flying phase
   * @param {Object} gameState - Current game state
   */
  prepareBetsForCashout(gameState) {
    // Enhanced logging for game state and bet tracking
    logger.info('CASHOUT_PREPARATION_CONTEXT', {
      gameStatus: gameState.status,
      gameMultiplier: gameState.multiplier,
      activeBetsCount: this.activeBets.length
    });

    // More flexible cashout preparation
    if (gameState.status !== 'flying') {
      logger.info('CASHOUT_PREPARATION_SKIPPED', {
        reason: 'Game not in flying phase',
        gameStatus: gameState.status
      });
      return;
    }

    // Dynamic multiplier-based cashout readiness
    this.readyForCashoutBets = this.activeBets.filter(bet => {
      // More sophisticated cashout criteria
      const isReadyForCashout = 
        bet.status === 'active' && 
        gameState.multiplier > 1.00;

      // Log each bet's cashout eligibility
      if (isReadyForCashout) {
        logger.info('BET_CASHOUT_ELIGIBILITY', {
          betId: bet.betId,
          userId: bet.userId,
          betAmount: bet.betAmount,
          gameMultiplier: gameState.multiplier,
          potentialWinnings: bet.betAmount * gameState.multiplier
        });
      }

      return isReadyForCashout;
    });

    // Comprehensive logging of cashout-ready bets
    logger.info('BETS_READY_FOR_CASHOUT', {
      totalReadyBets: this.readyForCashoutBets.length,
      gameMultiplier: gameState.multiplier,
      userBetSummary: this.readyForCashoutBets.reduce((summary, bet) => {
        if (!summary[bet.userId]) {
          summary[bet.userId] = {
            betCount: 0,
            totalBetAmount: 0,
            totalPotentialWinnings: 0
          };
        }
        
        const userSummary = summary[bet.userId];
        userSummary.betCount++;
        userSummary.totalBetAmount += bet.betAmount;
        userSummary.totalPotentialWinnings += bet.betAmount * gameState.multiplier;
        
        return summary;
      }, {})
    });
  }

  /**
   * Get ready-for-cashout bets for a specific user
   * @param {string} userId - User ID to filter bets
   * @param {string} [betId] - Optional specific bet ID
   * @returns {Array} List of ready for cashout bets
   */
  getReadyForCashoutBets(userId, betId) {
    let readyBets = this.readyForCashoutBets;

    // Detailed filtering with comprehensive logging
    logger.info('RETRIEVING_READY_FOR_CASHOUT_BETS', {
      requestedUserId: userId,
      requestedBetId: betId,
      totalReadyBets: readyBets.length
    });

    // Filter by user ID if provided
    if (userId) {
      readyBets = readyBets.filter(bet => bet.userId === userId);
      
      logger.info('USER_SPECIFIC_READY_BETS', {
        userId,
        userReadyBetsCount: readyBets.length
      });
    }

    // Filter by specific bet ID if provided
    if (betId) {
      readyBets = readyBets.filter(bet => bet.betId === betId);
      
      logger.info('SPECIFIC_BET_READY_STATUS', {
        betId,
        betFound: readyBets.length > 0
      });
    }

    return readyBets;
  }

  /**
   * Remove a bet from ready for cashout state
   * @param {string} betId - ID of the bet to remove
   */
  removeCashedOutBet(betId) {
    // Find the index of the bet to remove
    const betIndex = this.readyForCashoutBets.findIndex(bet => bet.betId === betId);
    
    if (betIndex !== -1) {
      // Remove the bet from ready for cashout state
      const removedBet = this.readyForCashoutBets.splice(betIndex, 1)[0];
      
      // Remove the bet from active bets as well
      const activeBetIndex = this.activeBets.findIndex(bet => bet.betId === betId);
      if (activeBetIndex !== -1) {
        this.activeBets.splice(activeBetIndex, 1);
      }

      // Log the bet removal
      logger.info('BET_REMOVED_FROM_CASHOUT_STATE', {
        betId,
        userId: removedBet.userId,
        betAmount: removedBet.betAmount
      });
    } else {
      // Log if bet was not found in ready for cashout state
      logger.warn('BET_NOT_FOUND_IN_CASHOUT_STATE', {
        betId
      });
    }
  }

  /**
   * Clear all cashout-ready bets at the end of a game session
   */
  clearCashoutReadyBets() {
    const clearedBetsCount = this.readyForCashoutBets.length;
    this.readyForCashoutBets = [];

    logger.info('CASHOUT_READY_BETS_CLEARED', {
      totalClearedBets: clearedBetsCount
    });
  }

  /**
   * Synchronize active bets from Redis to in-memory tracking
   * @param {string} gameSessionId - Current game session ID
   */
  async synchronizeActiveBetsFromRedis(gameSessionId) {
    try {
      const client = await redisRepository.getClient();
      const betKey = `game:${gameSessionId}:bets`;
      const bets = await client.hGetAll(betKey);

      // Clear existing active bets
      this.activeBets = [];

      // Populate activeBets from Redis
      for (const [betId, betJson] of Object.entries(bets)) {
        const bet = JSON.parse(betJson);
        
        // Only add active bets
        if (bet.status === 'active') {
          this.activeBets.push({
            betId: bet.id,
            userId: bet.userId,
            betAmount: bet.amount,
            status: bet.status,
            gameSessionId: gameSessionId,
            timestamp: bet.timestamp
          });
        }
      }

      logger.info('ACTIVE_BETS_SYNCHRONIZED_FROM_REDIS', {
        totalActiveBets: this.activeBets.length,
        gameSessionId
      });
    } catch (error) {
      logger.error('REDIS_BET_SYNC_FAILED', {
        errorMessage: error.message,
        gameSessionId
      });
    }
  }
}

export default new BetTrackingService();
