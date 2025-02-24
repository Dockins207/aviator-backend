import logger from '../config/logger.js';
import redisRepository from './redisRepository.js';
import { v4 as uuidv4 } from 'uuid';
import gameService from '../services/gameService.js';
import { EventEmitter } from 'events';
import { BetState } from '../betEnum.js';

class BetTrackingService extends EventEmitter {
  constructor(redisRepository) {
    super();
    if (!redisRepository) {
      throw new Error('REDIS_REPOSITORY_REQUIRED');
    }
    this.redisRepository = redisRepository;

    // Define comprehensive bet states with explicit lifecycle
    this.BET_STATES = BetState;

    // Define game states to match game service
    this.GAME_STATES = {
      // Game is in betting phase
      BETTING: 'betting',   
      
      // Game is in flying state
      FLYING: 'flying',     
      
      // Game has crashed
      CRASHED: 'crashed'    
    };

    // Current game state tracking
    this.currentGameState = this.GAME_STATES.BETTING;

    // Track the game session number
    this.currentGameSessionNumber = 0;

    // Persistent game session ID for the current game lifecycle
    this.currentGameSessionId = null;
  }

  /**
   * Transition bet to a new state with comprehensive validation
   * @param {string} betId - Unique bet identifier
   * @param {string} gameSessionId - Game session identifier
   * @param {string} newState - New state to transition to
   * @param {Object} additionalDetails - Optional additional bet details
   * @returns {Object} Updated bet details
   */
  async transitionBetState(betId, gameSessionId, newState, additionalDetails = {}) {
    try {
      // Validate inputs
      if (!betId || !gameSessionId) {
        throw new Error('INVALID_TRANSITION_PARAMETERS');
      }

      // Get current game state
      const currentGameState = await gameService.getCurrentGameState();

      // Get existing bet
      const existingBet = await this.redisRepository.getBetById(gameSessionId, betId);
      if (!existingBet) {
        throw new Error('BET_NOT_FOUND');
      }

      // Normalize existing bet status
      const currentStatus = existingBet.status || this.BET_STATES.PLACED;

      // Define state transition rules
      const validTransitions = {
        [this.BET_STATES.PLACED]: [this.BET_STATES.ACTIVE, this.BET_STATES.EXPIRED],
        [this.BET_STATES.QUEUED]: [this.BET_STATES.ACTIVE, this.BET_STATES.EXPIRED],
        [this.BET_STATES.ACTIVE]: [this.BET_STATES.COMPLETE, this.BET_STATES.EXPIRED],
        [this.BET_STATES.COMPLETE]: [], // Terminal state
        [this.BET_STATES.EXPIRED]: [], // Terminal state,
      };

      // Validate transition
      if (!validTransitions[currentStatus]?.includes(newState)) {
        throw new Error(`INVALID_STATE_TRANSITION: ${currentStatus} -> ${newState}`);
      }

      // Prepare updated bet with current session ID
      const updatedBet = {
        ...existingBet,
        ...additionalDetails,
        id: betId,
        userId: existingBet.userId,
        status: newState,
        gameSessionId: currentGameState.gameId, // Always use current session ID
        updatedAt: new Date().toISOString(),
        previousState: currentStatus,
        stateHistory: [
          ...(existingBet.stateHistory || []),
          {
            from: currentStatus,
            to: newState,
            timestamp: new Date().toISOString()
          }
        ]
      };

      // Store updated bet
      await this.redisRepository.storeBet(currentGameState.gameId, updatedBet);

      logger.info('BET_STATE_TRANSITION_SUCCESS', {
        betId,
        userId: existingBet.userId,
        fromState: currentStatus,
        toState: newState,
        gameSessionId: currentGameState.gameId
      });

      return updatedBet;
    } catch (error) {
      logger.error('BET_STATE_TRANSITION_ERROR', {
        error: error.message,
        betId,
        gameSessionId
      });
      throw error;
    }
  }

  /**
   * Activate a placed bet, moving it to active state
   * @param {string} betId - Unique bet identifier
   * @param {string} gameSessionId - Game session identifier
   * @returns {Object} Activated bet details
   */
  async activateBet(betId, gameSessionId) {
    try {
      // Validate game session ID
      if (!gameSessionId) {
        throw new Error('INVALID_GAME_SESSION_ID');
      }

      // Log activation attempt
      logger.info('BET_ACTIVATION_ATTEMPT', {
        betId,
        gameSessionId,
        timestamp: new Date().toISOString()
      });

      // First verify bet exists and validate state
      const existingBet = await this.redisRepository.getBetById(gameSessionId, betId);
      if (!existingBet) {
        const error = new Error('BET_NOT_FOUND');
        logger.error('BET_NOT_FOUND_DURING_ACTIVATION', {
          betId,
          gameSessionId,
          errorMessage: error.message
        });
        throw error;
      }

      // Pre-activation validation
      if (existingBet.status !== this.BET_STATES.PLACED) {
        const error = new Error('INVALID_BET_STATE_FOR_ACTIVATION');
        logger.error('INVALID_BET_STATE_FOR_ACTIVATION', {
          betId,
          gameSessionId,
          currentState: existingBet.status,
          expectedState: this.BET_STATES.PLACED
        });
        throw error;
      }

      // Validate bet amount and user details
      if (!existingBet.amount || !existingBet.userId) {
        const error = new Error('INVALID_BET_DETAILS');
        logger.error('INVALID_BET_DETAILS', {
          betId,
          gameSessionId,
          amount: existingBet.amount,
          userId: existingBet.userId
        });
        throw error;
      }

      // Attempt to transition bet to active state
      let activatedBet;
      try {
        activatedBet = await this.transitionBetState(
          betId,
          gameSessionId,
          this.BET_STATES.ACTIVE
        );
      } catch (transitionError) {
        // Attempt recovery if transition fails
        logger.warn('BET_ACTIVATION_TRANSITION_FAILED', {
          betId,
          gameSessionId,
          error: transitionError.message
        });

        // Verify bet state again
        const currentBet = await this.redisRepository.getBetById(gameSessionId, betId);
        if (currentBet && currentBet.status === this.BET_STATES.ACTIVE) {
          // Bet was actually activated despite the error
          logger.info('BET_ALREADY_ACTIVATED', {
            betId,
            gameSessionId
          });
          activatedBet = currentBet;
        } else {
          // Rethrow if recovery failed
          throw transitionError;
        }
      }

      // Log successful activation
      logger.info('BET_ACTIVATED', {
        betId,
        userId: activatedBet.userId,
        amount: activatedBet.amount,
        gameSessionId,
        timestamp: new Date().toISOString()
      });

      return activatedBet;
    } catch (error) {
      // Log activation failure with detailed context
      logger.error('BET_ACTIVATION_FAILED', {
        betId,
        gameSessionId,
        errorType: error.constructor.name,
        errorMessage: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString(),
        context: 'activateBet'
      });
      throw error;
    }
  }

  /**
   * Mark bet as cashed out with comprehensive validation
   * @param {string} betId - Unique bet identifier
   * @param {string} gameSessionId - Current game session identifier
   * @param {number} cashoutMultiplier - Multiplier at cash out
   * @param {Object} [options={}] - Additional cashout options
   * @returns {Object} Cashed out bet details
   */
  async cashoutBet(betId, gameSessionId, cashoutMultiplier, options = {}) {
    try {
      const currentGameServiceSessionId = gameService.gameState.gameId;

      // ABSOLUTE STRICT session ID validation
      if (!gameSessionId || gameSessionId !== currentGameServiceSessionId) {
        logger.error('CASHOUT_SESSION_ID_MISMATCH', {
          betId,
          providedSessionId: gameSessionId,
          currentSessionId: currentGameServiceSessionId,
          reason: 'Cashout session ID must exactly match gameService session'
        });
        throw new Error('INVALID_GAME_SESSION_ID: Cashout session ID mismatch');
      }

      // Retrieve bet details for comprehensive validation
      const betDetails = await this.redisRepository.getBetById(
        gameSessionId, 
        betId
      );

      // Validate bet existence and status
      if (!betDetails) {
        logger.error('BET_NOT_FOUND', {
          betId,
          gameSessionId,
          context: 'cashoutBet'
        });
        throw new ValidationError('BET_NOT_FOUND', {
          message: 'Bet not found or invalid',
          betId,
          gameSessionId
        });
      }

      // Validate bet is in active state
      if (betDetails.status !== this.BET_STATES.ACTIVE) {
        logger.error('INVALID_BET_STATE_FOR_CASHOUT', {
          betId,
          currentStatus: betDetails.status,
          expectedStatus: this.BET_STATES.ACTIVE
        });
        throw new ValidationError('INVALID_BET_STATE', {
          message: 'Bet must be in ACTIVE state to cashout',
          betId,
          currentStatus: betDetails.status
        });
      }

      // Validate cashout multiplier
      if (cashoutMultiplier <= 1.00) {
        logger.warn('LOW_CASHOUT_MULTIPLIER', {
          betId,
          cashoutMultiplier,
          minimumMultiplier: 1.00
        });
        throw new ValidationError('INVALID_CASHOUT_MULTIPLIER', {
          message: 'Cashout multiplier must be greater than 1.00',
          cashoutMultiplier
        });
      }

      // Calculate potential payout
      const potentialPayout = betDetails.amount * cashoutMultiplier;

      // Prepare cashout transaction details
      const cashoutDetails = {
        id: betId,
        gameSessionId,
        userId: betDetails.userId,
        originalAmount: betDetails.amount,
        cashoutMultiplier,
        payoutAmount: potentialPayout,
        status: this.BET_STATES.COMPLETE,
        cashoutTimestamp: new Date().toISOString(),
        ...options
      };

      // Perform cashout transaction
      const updatedBet = await this.redisRepository.updateBetStatus(
        gameSessionId, 
        betId, 
        this.BET_STATES.COMPLETE,
        cashoutDetails
      );

      // Log successful cashout
      logger.info('BET_CASHED_OUT', {
        betId,
        userId: betDetails.userId,
        gameSessionId,
        cashoutMultiplier,
        payoutAmount: potentialPayout
      });

      // Trigger wallet update (async)
      this.walletService.updateWalletAfterCashout(
        betDetails.userId, 
        potentialPayout
      ).catch(error => {
        logger.error('WALLET_UPDATE_FAILED', {
          userId: betDetails.userId,
          betId,
          errorMessage: error.message
        });
      });

      return updatedBet;
    } catch (error) {
      // Comprehensive error logging
      logger.error('CASHOUT_FAILED', {
        betId,
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Mark bet as completed (won or lost)
   * @param {string} betId - Unique bet identifier
   * @param {string} gameSessionId - Game session identifier
   * @param {boolean} isWin - Whether the bet is a win
   * @param {number} finalMultiplier - Final game multiplier
   * @returns {Object} Completed bet details
   */
  completeBet(betId, gameSessionId, isWin, finalMultiplier) {
    return this.transitionBetState(
      betId, 
      gameSessionId, 
      this.BET_STATES.COMPLETE,
      { 
        finalMultiplier,
        result: isWin ? 'win' : 'loss'
      }
    );
  }

  /**
   * Expire an inactive or invalid bet
   * @param {string} betId - Unique bet identifier
   * @param {string} gameSessionId - Game session identifier
   * @param {string} reason - Reason for expiration
   * @returns {Object} Expired bet details
   */
  expireBet(betId, gameSessionId, reason = 'timeout') {
    return this.transitionBetState(
      betId, 
      gameSessionId, 
      this.BET_STATES.EXPIRED,
      { expirationReason: reason }
    );
  }

  /**
   * Update the current game state
   * @param {string} newState - New game state
   * @returns {Object} Updated game state details
   */
  async updateGameState(newState) {
    try {
      const previousState = this.currentGameState;
      
      // Update game state
      this.currentGameState = newState;

      // If game has crashed or completed, clear game cycle data
      if (newState === this.GAME_STATES.CRASHED || 
          (previousState === this.GAME_STATES.FLYING && newState === this.GAME_STATES.BETTING)) {
        await this.clearGameCycleData(this.currentGameSessionId);
      }

      logger.info('GAME_STATE_UPDATED', {
        previousState,
        newState,
        gameSessionId: this.currentGameSessionId
      });

      return {
        previousState,
        currentState: newState,
        gameSessionId: this.currentGameSessionId
      };
    } catch (error) {
      logger.error('GAME_STATE_UPDATE_FAILED', {
        newState,
        errorMessage: error.message
      });
      throw error;
    }
  }

  /**
   * Track a new bet with STRICT validation
   * @param {Object} betDetails - Comprehensive bet tracking information
   * @throws {Error} For any deviation from strict requirements
   * @returns {Object} Tracked bet details
   */
  async trackBet(betDetails) {
    // MANDATORY session ID initialization - WITH FALLBACK
    if (!this.currentGameSessionId) {
      // Use sessionId from betDetails if available
      await this.initializeGameSessionId(
        betDetails.sessionId || 
        betDetails.gameSessionId
      );
    }

    // ABSOLUTE STRICT VALIDATION - NO EXCEPTIONS
    if (!betDetails) {
      logger.error('CRITICAL_SECURITY_VIOLATION: Attempt to track undefined bet', {
        context: 'trackBet',
        timestamp: new Date().toISOString()
      });
      throw new Error('SECURITY_VIOLATION_UNDEFINED_BET');
    }

    // Mandatory field validation with ZERO tolerance
    const MANDATORY_FIELDS = ['userId', 'betId', 'amount', 'username'];
    for (const field of MANDATORY_FIELDS) {
      if (!betDetails[field]) {
        logger.error('CRITICAL_VALIDATION_FAILURE', {
          missingField: field,
          providedDetails: Object.keys(betDetails),
          context: 'trackBet'
        });
        throw new Error(`VALIDATION_FAILED_MISSING_${field.toUpperCase()}`);
      }
    }

    // Type checking with extreme prejudice
    if (typeof betDetails.userId !== 'string' || 
        typeof betDetails.betId !== 'string' || 
        typeof betDetails.amount !== 'number' ||
        betDetails.amount <= 0) {
      logger.error('CRITICAL_TYPE_VIOLATION', {
        providedTypes: {
          userId: typeof betDetails.userId,
          betId: typeof betDetails.betId,
          amount: typeof betDetails.amount
        },
        context: 'trackBet'
      });
      throw new Error('SECURITY_VIOLATION_INVALID_BET_TYPES');
    }

    // STRICT game state validation
    if (this.currentGameState !== this.GAME_STATES.BETTING) {
      logger.error('CRITICAL_BET_STATE_VIOLATION', {
        currentGameState: this.currentGameState,
        allowedState: this.GAME_STATES.BETTING,
        context: 'trackBet'
      });
      throw new Error('SECURITY_VIOLATION_INVALID_GAME_STATE');
    }

    // Prepare bet with ABSOLUTE precision
    const trackedBet = {
      id: betDetails.betId,
      userId: betDetails.userId,
      username: betDetails.username,
      amount: betDetails.amount,
      status: this.BET_STATES.PLACED,
      sessionId: this.currentGameSessionId,
      placedAt: new Date().toISOString(),
      gameStateAtPlacement: this.currentGameState,
      targetSessionNumber: this.currentGameSessionNumber
    };

    // Conditionally add cashoutMultiplier ONLY if explicitly provided
    if (betDetails.cashoutMultiplier !== undefined && 
        betDetails.cashoutMultiplier !== null) {
      trackedBet.cashoutMultiplier = betDetails.cashoutMultiplier;
    }

    // ATOMIC bet storage with comprehensive error handling
    try {
      const storageResult = this.redisRepository.storeBet(
        this.currentGameSessionId, 
        trackedBet
      );

      // Verify storage success
      if (!storageResult) {
        logger.error('CRITICAL_STORAGE_FAILURE', {
          betId: trackedBet.id,
          context: 'trackBet'
        });
        throw new Error('SECURITY_VIOLATION_BET_STORAGE_FAILED');
      }
    } catch (error) {
      logger.error('CRITICAL_BET_TRACKING_EXCEPTION', {
        errorMessage: error.message,
        betDetails: trackedBet,
        context: 'trackBet'
      });
      throw new Error('SECURITY_VIOLATION_BET_TRACKING_FAILED');
    }

    // Hyper-detailed, non-repudiable logging
    const logData = {
      userId: trackedBet.userId,
      betId: trackedBet.id,
      amount: trackedBet.amount,
      sessionId: trackedBet.sessionId,
      verificationTimestamp: new Date().toISOString()
    };

    // Conditionally add cashoutMultiplier to log ONLY if it exists
    if (trackedBet.cashoutMultiplier !== undefined) {
      logData.cashoutMultiplier = trackedBet.cashoutMultiplier;
    }

    logger.info('BET_TRACKED_STRICT_VERIFICATION', logData);

    return trackedBet;
  }

  /**
   * Activate queued bets for the current game session with ABSOLUTE STRICT validation
   * @returns {Object} Comprehensive activation summary
   * @throws {Error} For any deviation from strict activation requirements
   */
  activateQueuedBets() {
    // MANDATORY Game State Validation
    if (this.currentGameState !== this.GAME_STATES.FLYING) {
      logger.error('CRITICAL_BET_ACTIVATION_STATE_VIOLATION', {
        currentGameState: this.currentGameState,
        expectedState: this.GAME_STATES.FLYING,
        context: 'activateQueuedBets'
      });
      throw new Error('SECURITY_VIOLATION_INVALID_GAME_STATE_FOR_ACTIVATION');
    }

    // MANDATORY Session ID Validation
    if (!this.currentGameSessionId) {
      logger.error('CRITICAL_SESSION_VIOLATION', {
        context: 'activateQueuedBets',
        details: 'No active game session for bet activation',
        timestamp: new Date().toISOString()
      });
      throw new Error('SECURITY_VIOLATION_NO_ACTIVE_SESSION');
    }

    // Retrieve bets with STRICT filtering
    const queuedBets = this.redisRepository.getBetsBySessionNumber(
      this.currentGameSessionNumber
    );

    // ABSOLUTE Validation of Queued Bets
    if (!queuedBets || queuedBets.length === 0) {
      logger.warn('NO_QUEUED_BETS_FOR_ACTIVATION', {
        gameSessionNumber: this.currentGameSessionNumber,
        context: 'activateQueuedBets'
      });
      return {
        totalBets: 0,
        successCount: 0,
        failedCount: 0,
        processingTime: 0
      };
    }

    // Performance and Security Tracking
    const activationStartTime = Date.now();
    const activationResults = {
      totalBets: queuedBets.length,
      successCount: 0,
      failedCount: 0,
      failedBetIds: []
    };

    // ATOMIC Bet Activation with Comprehensive Error Handling
    const activatedBets = queuedBets.map(bet => {
      try {
        // STRICT Bet Validation Before Activation
        if (!bet.id || !bet.userId || !bet.amount) {
          throw new Error('INVALID_BET_STRUCTURE');
        }

        const activatedBet = this.transitionBetState(
          bet.id, 
          bet.sessionId, 
          this.BET_STATES.ACTIVE
        );

        activationResults.successCount++;
        return activatedBet;
      } catch (activationError) {
        logger.error('BET_ACTIVATION_FAILURE', {
          betId: bet.id,
          errorMessage: activationError.message,
          context: 'activateQueuedBets'
        });

        activationResults.failedCount++;
        activationResults.failedBetIds.push(bet.id);
        return null;
      }
    }).filter(Boolean);

    // Calculate Processing Time
    const processingTime = Date.now() - activationStartTime;

    // COMPREHENSIVE Activation Summary Logging
    logger.info('BULK_BET_ACTIVATION_SUMMARY', {
      service: 'aviator-backend',
      totalBets: activationResults.totalBets,
      successCount: activationResults.successCount,
      failedCount: activationResults.failedCount,
      processingTime: processingTime,
      failedBetIds: activationResults.failedBetIds
    });

    // Throw error if NO bets were successfully activated
    if (activationResults.successCount === 0) {
      throw new Error('CRITICAL_BET_ACTIVATION_COMPLETE_FAILURE');
    }

    return {
      totalBets: activationResults.totalBets,
      successCount: activationResults.successCount,
      failedCount: activationResults.failedCount,
      processingTime: processingTime,
      activatedBets
    };
  }

  /**
   * Bulk activate all placed bets for the current game session
   * @param {string} gameSessionId - Current game session identifier
   * @returns {Array} List of activated bets
   */
  bulkActivatePlacedBets(gameSessionId) {
    // Retrieve all placed bets for the current game session
    const allBets = this.redisRepository.getBetsForSession(
      gameSessionId, 
      this.BET_STATES.PLACED
    );
    
    // Filter only placed bets
    const placedBets = allBets.filter(
      bet => bet.status === this.BET_STATES.PLACED
    );

    // Bulk activate placed bets
    const activatedBets = placedBets.map(bet => {
      try {
        // Transition bet to active state
        const activatedBet = this.transitionBetState(
          bet.id, 
          gameSessionId, 
          this.BET_STATES.ACTIVE
        );

        // Log successful activation
        logger.info('BET_ACTIVATED', {
          betId: bet.id,
          userId: bet.userId,
          amount: bet.amount
        });

        return activatedBet;
      } catch (error) {
        // Log activation failures
        logger.error('BET_ACTIVATION_FAILED', {
          betId: bet.id,
          errorMessage: error.message
        });

        return null;
      }
    }).filter(Boolean); // Remove any null entries from failed activations

    // Log bulk activation summary
    logger.info('BULK_BET_ACTIVATION_SUMMARY', {
      totalPlacedBets: placedBets.length,
      activatedBets: activatedBets.length,
      gameSessionId
    });

    return activatedBets;
  }

  /**
   * Validate the provided session ID against the current game session
   * @param {string} providedSessionId - Session ID to validate
   * @returns {boolean} Whether the session ID is valid
   * @throws {Error} If session validation fails
   */
  async validateGameSessionId(providedSessionId) {
    try {
      const gameService = await import('../services/gameService.js');
      const currentGameServiceSessionId = gameService.default.gameState.gameId;

      // STRICT VALIDATION: Exact match required
      if (!providedSessionId || providedSessionId !== currentGameServiceSessionId) {
        logger.error('GAME_SESSION_VALIDATION_FAILED', {
          providedSessionId,
          currentGameServiceSessionId,
          reason: 'Session ID does not match gameService'
        });
        throw new Error('INVALID_GAME_SESSION_ID: Provided session ID does not match current game session');
      }

      return true;
    } catch (error) {
      logger.error('SESSION_VALIDATION_ERROR', {
        errorMessage: error.message,
        providedSessionId
      });
      throw new Error('Failed to validate game session ID');
    }
  }

  /**
   * Activate bets for a given game state with strict session ID validation
   * @param {Object} gameState - Current game state
   * @param {Array} [providedBets=null] - Optional bets to activate
   * @param {string} [providedSessionId=null] - Session ID from bet service
   * @returns {Object} Activation result with activated and failed bets
   * @throws {Error} For session ID validation or activation failures
   */
  async activateBets(gameState, providedBets = null, providedSessionId = null) {
    try {
      // Validate game state
      if (!gameState || !gameState.gameId) {
        throw new Error('INVALID_GAME_STATE');
      }

      // Validate session ID if provided
      if (providedSessionId && providedSessionId !== gameState.gameId) {
        throw new Error('SESSION_ID_MISMATCH');
      }

      const gameId = gameState.gameId;
      
      // Get both placed and queued bets
      const [placedBets, queuedBets] = await Promise.all([
        this.redisRepository.getPlacedBets(gameId),
        this.redisRepository.getQueuedBets(gameId)
      ]);

      // Combine all bets to activate
      const betsToActivate = [
        ...placedBets,
        ...queuedBets,
        ...(providedBets || [])
      ].filter(bet => bet !== null);

      if (!betsToActivate.length) {
        logger.info('NO_BETS_TO_ACTIVATE', {
          gameId,
          placedCount: placedBets.length,
          queuedCount: queuedBets.length,
          providedCount: providedBets?.length || 0
        });
        return {
          activatedBets: [],
          failedBets: []
        };
      }

      // Process bets in batches for better performance
      const batchSize = 50;
      const results = {
        activatedBets: [],
        failedBets: []
      };

      // Process bets in batches
      for (let i = 0; i < betsToActivate.length; i += batchSize) {
        const batch = betsToActivate.slice(i, i + batchSize);
        const batchPromises = batch.map(async (bet) => {
          try {
            // Transition bet to active state
            const activatedBet = await this.activateBet(bet.id, gameId);
            return { success: true, bet: activatedBet };
          } catch (error) {
            logger.error('BET_ACTIVATION_FAILED', {
              betId: bet.id,
              gameId,
              userId: bet.userId,
              error: error.message
            });
            return { 
              success: false, 
              bet,
              error: error.message 
            };
          }
        });

        const batchResults = await Promise.all(batchPromises);

        // Separate successful and failed activations
        batchResults.forEach(result => {
          if (result.success) {
            results.activatedBets.push(result.bet);
          } else {
            results.failedBets.push({
              betId: result.bet.id,
              userId: result.bet.userId,
              error: result.error
            });
          }
        });
      }

      // Log activation results
      logger.info('BETS_ACTIVATION_COMPLETED', {
        gameId,
        totalBets: betsToActivate.length,
        activatedCount: results.activatedBets.length,
        failedCount: results.failedBets.length,
        timestamp: new Date().toISOString()
      });

      return results;
    } catch (error) {
      logger.error('BETS_ACTIVATION_ERROR', {
        gameId: gameState?.gameId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Fallback method to activate bets individually if bulk fails
   * @param {Object} gameState - Current game state
   * @returns {Object} Fallback activation results
   */
  async fallbackActivateBets(gameState) {
    try {
      // Validate game state
      if (!gameState || !gameState.gameId) {
        throw new Error('Invalid game state for bet activation');
      }

      // Determine the game session ID with priority
      const gameSessionId = gameState.gameId;
      
      // Retrieve all placed bets for the current game session
      const allBets = await this.redisRepository.getBetsForSession(
        gameSessionId, 
        this.BET_STATES.PLACED
      );
      
      // Filter only placed bets
      const placedBets = allBets.filter(
        bet => bet.status === this.BET_STATES.PLACED
      );

      const activationResults = {
        totalPlacedBets: placedBets.length,
        successCount: 0,
        failedCount: 0,
        failedBetIds: []
      };

      // Activate bets one by one
      for (const bet of placedBets) {
        try {
          // Transition bet to active state
          const activatedBet = this.transitionBetState(
            bet.id, 
            gameSessionId, 
            this.BET_STATES.ACTIVE
          );

          activationResults.successCount++;
          activationResults.activatedBets.push({
            betId: bet.id,
            userId: bet.userId,
            gameSessionId,
            details: activatedBet
          });
        } catch (activationError) {
          // Log and track failed bet activations
          logger.error('INDIVIDUAL_BET_ACTIVATION_FAILED', {
            betId: bet.id,
            gameSessionId,
            errorMessage: activationError.message
          });

          activationResults.failedCount++;
          activationResults.failedBetIds.push(bet.id);
        }
      }

      // Log fallback activation summary
      logger.info('FALLBACK_BET_ACTIVATION_SUMMARY', {
        gameSessionId,
        totalPlacedBets: placedBets.length,
        activatedBetsCount: activationResults.successCount,
        failedBetsCount: activationResults.failedCount
      });

      return {
        success: activationResults.failedCount === 0,
        gameSessionId,
        activatedBets: activationResults.activatedBets,
        failedBetIds: activationResults.failedBetIds
      };
    } catch (error) {
      // Comprehensive error handling
      logger.error('FALLBACK_BET_ACTIVATION_ERROR', {
        gameId: gameState?.gameId,
        errorMessage: error.message,
        errorStack: error.stack
      });

      return {
        success: false,
        error: true,
        gameSessionId: gameState?.gameId,
        errorMessage: error.message
      };
    }
  }

  /**
   * Recover placed bets during unexpected failures
   * @param {string} gameSessionId - Current game session ID
   * @returns {Array} Recovered bets
   */
  async recoverPlacedBets(gameSessionId) {
    try {
      // Attempt to recover bets from multiple potential sources
      const recoveryStrategies = [
        () => this.redisRepository.getPlacedBetsByGameSession(gameSessionId),
        () => this.redisRepository.getNextSessionBets(),
        () => this.redisRepository.getOrphanedBets()
      ];

      for (const strategy of recoveryStrategies) {
        try {
          const recoveredBets = await strategy();
          
          if (recoveredBets && recoveredBets.length > 0) {
            logger.info('Bets recovered successfully', {
              recoveryStrategy: strategy.name,
              recoveredBetsCount: recoveredBets.length
            });
            return recoveredBets;
          }
        } catch (strategyError) {
          logger.warn('Bet recovery strategy failed', {
            strategy: strategy.name,
            errorMessage: strategyError.message
          });
        }
      }

      // If no bets recovered
      logger.warn('No bets could be recovered', { gameSessionId });
      return [];
    } catch (error) {
      logger.error('Catastrophic bet recovery failure', {
        errorMessage: error.message,
        gameSessionId
      });
      return [];
    }
  }

  /**
   * Initialize or set game session ID with STRICT validation
   * @param {string} [externalGameSessionId] - Optional external game session ID
   * @returns {string} Current game session ID
   */
  async initializeGameSessionId(externalGameSessionId = null) {
    const gameService = await import('../services/gameService.js');
    const currentGameServiceSessionId = gameService.default.gameState.gameId;

    // STRICT VALIDATION: Use ONLY gameService's game ID
    if (!currentGameServiceSessionId) {
      logger.error('GAME_SESSION_INITIALIZATION_FAILED', {
        reason: 'No valid game session ID from gameService',
        externalSessionId: externalGameSessionId
      });
      throw new Error('INVALID_GAME_SESSION_ID: Cannot initialize without gameService session');
    }

    // Ignore external session ID, use ONLY gameService's ID
    this.currentGameSessionId = currentGameServiceSessionId;
    
    logger.info('GAME_SESSION_INITIALIZED', {
      gameSessionId: this.currentGameSessionId
    });

    return this.currentGameSessionId;
  }

  /**
   * Reset game session ID with STRICT validation
   * @returns {string} New game session ID
   */
  async resetGameSessionId() {
    const currentGameServiceSessionId = gameService.gameState.gameId;

    // STRICT VALIDATION: Use ONLY gameService's game ID
    if (!currentGameServiceSessionId) {
      logger.error('GAME_SESSION_RESET_FAILED', {
        reason: 'No valid game session ID from gameService'
      });
      throw new Error('INVALID_GAME_SESSION_ID: Cannot reset without gameService session');
    }

    this.currentGameSessionId = currentGameServiceSessionId;
    
    logger.info('GAME_SESSION_RESET', {
      gameSessionId: this.currentGameSessionId
    });

    return this.currentGameSessionId;
  }

  /**
   * Validate game session ID with ABSOLUTE STRICT checks
   * @param {string} providedSessionId - Session ID to validate
   * @returns {boolean} Whether the session ID is valid
   * @throws {Error} If session validation fails
   */
  async validateGameSessionId(providedSessionId) {
    const gameService = await import('../services/gameService.js');
    const currentGameServiceSessionId = gameService.default.gameState.gameId;

    // STRICT VALIDATION: Exact match required
    if (!providedSessionId || providedSessionId !== currentGameServiceSessionId) {
      logger.error('GAME_SESSION_VALIDATION_FAILED', {
        providedSessionId,
        currentGameServiceSessionId,
        reason: 'Session ID does not match gameService'
      });
      throw new Error('INVALID_GAME_SESSION_ID: Provided session ID does not match current game session');
    }

    return true;
  }

  /**
   * Clear all game-related data after game cycle completion
   * @param {string} gameSessionId - Game session ID to clear
   * @returns {Object} Clearance result
   */
  async clearGameCycleData(gameSessionId) {
    try {
      // Validate game session ID
      if (!gameSessionId) {
        logger.warn('INVALID_GAME_SESSION_ID_FOR_CLEARANCE');
        return { success: false, reason: 'Invalid game session ID' };
      }

      // Clear data using Redis repository method
      const clearResult = await this.redisRepository.clearGameCycleData(gameSessionId);

      // Reset internal game tracking state
      this.currentGameSessionId = null;
      this.currentGameSessionNumber = 0;
      this.currentGameState = this.GAME_STATES.BETTING;

      logger.info('GAME_CYCLE_COMPLETED_AND_CLEARED', {
        gameSessionId,
        deletedKeysCount: clearResult.deletedKeysCount
      });

      return clearResult;
    } catch (error) {
      logger.error('GAME_CYCLE_CLEARANCE_FAILED', {
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Clear all session data when game crashes
   * @param {string} gameSessionId - Game session identifier to clear
   * @returns {Promise<Object>} Clearing operation results
   */
  async clearGameSessionData(gameSessionId) {
    try {
      // Validate game session ID
      if (!gameSessionId) {
        logger.warn('INVALID_GAME_SESSION_CLEAR', {
          message: 'No game session ID provided',
          context: 'clearGameSessionData'
        });
        return { success: false, reason: 'INVALID_SESSION_ID' };
      }

      // Log the start of session clearing
      logger.info('GAME_SESSION_CLEARING_STARTED', {
        gameSessionId,
        currentGameState: this.currentGameState,
        currentGameSessionNumber: this.currentGameSessionNumber
      });

      // Clear all bets in the current session
      const activeBets = await this.getActiveBetsForSession(gameSessionId);
      
      // Mark all active bets as expired
      for (const bet of activeBets) {
        await this.expireBet(
          bet.id, 
          gameSessionId, 
          'game_crashed'
        );
      }

      // Clear session data in Redis
      const clearResult = await this.redisRepository.clearGameSessionData(gameSessionId);

      // Reset game tracking state
      this.currentGameState = this.GAME_STATES.BETTING;
      this.currentGameSessionNumber++;
      this.currentGameSessionId = null;

      // Log successful session clearing
      logger.info('GAME_SESSION_CLEARED_SUCCESSFULLY', {
        gameSessionId,
        newGameSessionNumber: this.currentGameSessionNumber,
        clearedKeysCount: clearResult.deletedKeysCount
      });

      return {
        success: true,
        gameSessionId,
        clearedKeysCount: clearResult.deletedKeysCount,
        newGameSessionNumber: this.currentGameSessionNumber
      };
    } catch (error) {
      // Comprehensive error logging
      logger.error('GAME_SESSION_CLEAR_FAILED', {
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack,
        context: 'clearGameSessionData'
      });

      // Throw or return error based on context
      throw new Error(`Failed to clear game session: ${error.message}`);
    }
  }

  /**
   * Handle game crash event and queue active bets
   * @param {Object} crashDetails - Details of the game crash
   * @returns {Promise<Object>} Crash handling results
   */
  async handleGameCrash(crashDetails = {}) {
    try {
      // Validate current game state
      if (this.currentGameState !== this.GAME_STATES.FLYING) {
        logger.warn('INVALID_CRASH_STATE', {
          currentState: this.currentGameState,
          expectedState: this.GAME_STATES.FLYING
        });
        return { success: false, reason: 'INVALID_GAME_STATE' };
      }

      // Update game state to crashed
      this.currentGameState = this.GAME_STATES.CRASHED;

      let activeBets = [];
      let processedBetsCount = 0;
      let processedLossesCount = 0;
      let queuedBetIds = [];

      try {
        // Get all active bets for this game session
        activeBets = await this.redisRepository.getActiveBetsForSession(
          this.currentGameSessionId
        );
      } catch (retrievalError) {
        logger.warn('ACTIVE_BETS_RETRIEVAL_FAILED', {
          gameSessionId: this.currentGameSessionId,
          errorMessage: retrievalError.message
        });
      }

      // Process all uncashed bets as lost and queue them for next session
      for (const bet of activeBets) {
        try {
          // Mark bet as lost
          await this.completeBet(
            bet.id, 
            this.currentGameSessionId, 
            false,  // isWin = false 
            crashDetails.multiplier || 1.00
          );
          processedBetsCount++;

          // Queue bet for next session
          try {
            await this.redisRepository.queueBetForNextSession({
              ...bet,
              status: this.BET_STATES.EXPIRED,
              originalSessionId: this.currentGameSessionId
            });
            queuedBetIds.push(bet.id);
          } catch (queueError) {
            logger.error('FAILED_TO_QUEUE_BET_AFTER_CRASH', {
              betId: bet.id,
              errorMessage: queueError.message
            });
          }

          // Process wallet loss - with separate error handling
          try {
            await this.walletService.processBetLoss(
              bet.userId, 
              bet.amount
            );
            processedLossesCount++;
          } catch (walletError) {
            logger.error('WALLET_LOSS_PROCESSING_FAILED', {
              betId: bet.id,
              userId: bet.userId,
              errorMessage: walletError.message
            });
          }
        } catch (betProcessingError) {
          logger.error('BET_PROCESSING_FAILED', {
            betId: bet.id,
            errorMessage: betProcessingError.message
          });
        }
      }

      // Log crash details
      logger.info('GAME_CRASHED', {
        gameSessionId: this.currentGameSessionId,
        crashMultiplier: crashDetails.multiplier || 1.00,
        totalBetsCount: activeBets.length,
        processedBetsCount,
        processedLossesCount,
        queuedBetsCount: queuedBetIds.length,
        timestamp: new Date().toISOString()
      });

      // CRITICAL: Always clear game session data, regardless of bet processing
      let clearResult = { clearedKeysCount: 0 };
      try {
        clearResult = await this.clearGameSessionData(this.currentGameSessionId);
      } catch (clearError) {
        logger.error('GAME_SESSION_CLEAR_FAILED', {
          gameSessionId: this.currentGameSessionId,
          errorMessage: clearError.message
        });
      }

      return {
        success: true,
        gameSessionId: this.currentGameSessionId,
        crashMultiplier: crashDetails.multiplier || 1.00,
        totalBetsCount: activeBets.length,
        processedBetsCount,
        processedLossesCount,
        queuedBetIds,
        clearedKeysCount: clearResult.clearedKeysCount
      };
    } catch (error) {
      logger.error('GAME_CRASH_HANDLING_FAILED', {
        errorMessage: error.message,
        errorStack: error.stack,
        context: 'handleGameCrash'
      });

      // Attempt to clear session data even if main crash handling fails
      try {
        await this.clearGameSessionData(this.currentGameSessionId);
      } catch (clearError) {
        logger.error('EMERGENCY_SESSION_CLEAR_FAILED', {
          gameSessionId: this.currentGameSessionId,
          errorMessage: clearError.message
        });
      }

      throw error;
    }
  }

  /**
   * Schedule autocashout for a specific bet
   * @param {Object} params - Autocashout scheduling parameters
   * @param {string} params.betId - Unique bet identifier
   * @param {string} params.userId - User who placed the bet
   * @param {string} params.gameSessionId - Current game session ID
   * @param {number} params.cashoutMultiplier - Multiplier to trigger cashout
   * @returns {Promise<void>}
   */
  async scheduleAutoCashout({ betId, userId, gameSessionId, cashoutMultiplier }) {
    try {
      // Validate input parameters
      if (!betId || !userId || !gameSessionId || !cashoutMultiplier) {
        throw new Error('INVALID_AUTOCASHOUT_PARAMETERS');
      }

      // Ensure RedisRepository client is ready and retrieved
      const redisClient = this.redisRepository.getClient();

      // Create a unique key for idempotency check
      const idempotencyKey = `aviator:autocashout:idempotency:${betId}`;
      
      // Check if this bet has already been scheduled for autocashout
      const existingSchedule = await redisClient.get(idempotencyKey);
      if (existingSchedule) {
        logger.warn('AUTOCASHOUT_ALREADY_SCHEDULED', {
          betId,
          userId,
          gameSessionId,
          message: 'Skipping duplicate autocashout scheduling'
        });
        return;
      }

      // Store autocashout details in Redis
      const autocashoutKey = `aviator:autocashout:${gameSessionId}:${betId}`;
      await redisClient.set(autocashoutKey, JSON.stringify({
        betId,
        userId,
        gameSessionId,
        cashoutMultiplier,
        scheduledAt: Date.now()
      }), {
        EX: 3600  // Expire after 1 hour
      });

      // Set idempotency flag to prevent duplicate scheduling
      await redisClient.set(idempotencyKey, 'scheduled', {
        EX: 3600  // Expire after 1 hour
      });

      // Log successful autocashout scheduling
      logger.info('AUTOCASHOUT_SCHEDULED', {
        betId,
        userId,
        gameSessionId,
        cashoutMultiplier
      });
    } catch (error) {
      // Log and rethrow error for upstream handling
      logger.error('AUTOCASHOUT_SCHEDULING_ERROR', {
        betId,
        userId,
        gameSessionId,
        cashoutMultiplier,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Handle bet placement during non-betting game states
   * @param {Object} betDetails - Details of the bet to queue
   * @param {Object} cashoutStrategy - Cashout strategy for the bet
   * @returns {Promise<Object>} Queued bet details
   */
  async handleBetInNonBettingState(betDetails, cashoutStrategy) {
    try {
      // Validate input parameters
      if (!betDetails) {
        throw new Error('INVALID_BET_DETAILS');
      }

      // Validate bet ID from BetService
      if (!betDetails.id) {
        logger.error('BET_ID_REQUIRED', {
          message: 'Bet ID must be generated by BetService',
          betDetails
        });
        throw new Error('BET_ID_MUST_BE_PROVIDED_BY_BETSERVICE');
      }

      // Validate current game state
      if (this.currentGameState === this.GAME_STATES.BETTING) {
        logger.warn('INVALID_BET_QUEUING_STATE', {
          message: 'Bet cannot be queued during betting state',
          betDetails
        });
        throw new Error('BET_PLACEMENT_NOT_ALLOWED_IN_BETTING_STATE');
      } else if (this.currentGameState === this.GAME_STATES.FLYING || this.currentGameState === this.GAME_STATES.CRASHED) {
        // Queue the bet for future processing
        return await this.redisRepository.queueBetForNextSession(betDetails);
      } else {
        throw new Error('INVALID_GAME_STATE');
      }
    } catch (error) {
      logger.error('BET_PLACEMENT_ERROR', { error });
      throw error;
    }
  }

  /**
   * Process queued bets for a new game session
   * @param {string} newGameSessionId - ID of the new game session
   * @returns {Promise<Object>} Processing results
   */
  async processQueuedBets(newGameSessionId) {
    try {
      // Validate input
      if (!newGameSessionId) {
        throw new Error('INVALID_GAME_SESSION_ID');
      }

      // Retrieve queued bets
      const queuedBets = await this.redisRepository.getNextSessionBets();

      const processingResults = {
        totalQueuedBets: queuedBets.length,
        processedBets: [],
        failedBets: []
      };

      // Process each queued bet
      for (const queuedBet of queuedBets) {
        try {
          // Transfer bet to new session
          const transferredBet = await this.transferQueuedBetsToNewSession(
            queuedBet, 
            newGameSessionId
          );

          processingResults.processedBets.push(transferredBet);
        } catch (transferError) {
          logger.warn('Failed to transfer queued bet', {
            betId: queuedBet.id,
            errorMessage: transferError.message
          });
          processingResults.failedBets.push(queuedBet);
        }
      }

      // Clean up processed bets
      if (processingResults.processedBets.length > 0) {
        await this.redisRepository.removeProcessedQueuedBets(
          processingResults.processedBets.map(bet => bet.id)
        );
      }

      logger.info('Queued bets processing completed', processingResults);

      return processingResults;
    } catch (error) {
      logger.error('Failed to process queued bets', {
        errorMessage: error.message,
        newGameSessionId
      });
      throw error;
    }
  }

  /**
   * Transfer queued bets to a new game session
   * @param {Object} queuedBet - Bet to transfer
   * @param {string} newGameSessionId - ID of the new game session
   * @returns {Promise<Object>} Transferred bet details
   */
  async transferQueuedBetsToNewSession(queuedBet, newGameSessionId) {
    try {
      // Validate bet and new session
      if (!queuedBet || !newGameSessionId) {
        throw new Error('INVALID_TRANSFER_PARAMETERS');
      }

      // Prepare bet for new session
      const transferredBet = {
        ...queuedBet,
        originalSessionId: queuedBet.gameSessionId, // Keep track of original session
        gameSessionId: newGameSessionId, // Assign new session ID
        transferredAt: new Date().toISOString(),
        status: this.BET_STATES.PLACED,
        queuedInState: queuedBet.queuedInState || 'unknown' // Preserve queued state info
      };

      // Store bet in new session
      await this.redisRepository.storeBet(
        newGameSessionId, 
        transferredBet, 
        this.BET_STATES.PLACED
      );

      logger.info('Queued bet transferred to new session', {
        betId: transferredBet.id,
        newGameSessionId
      });

      return transferredBet;
    } catch (error) {
      logger.error('Failed to transfer queued bet', {
        errorMessage: error.message,
        queuedBet,
        newGameSessionId
      });
      throw error;
    }
  }

  /**
   * Retrieve queued bets for a specific game session
   * @param {string} gameSessionId - Game session identifier
   * @returns {Promise<Array>} List of queued bets
   */
  async getQueuedBets(gameSessionId) {
    try {
      // Retrieve queued bets from both global and session-specific queues
      const globalQueuedBets = await this.redisRepository.retrieveQueuedBets(null);
      const sessionQueuedBets = await this.redisRepository.retrieveQueuedBets(gameSessionId);

      // Combine and deduplicate bets
      const combinedQueuedBets = [
        ...globalQueuedBets,
        ...sessionQueuedBets.filter(
          sessionBet => !globalQueuedBets.some(
            globalBet => globalBet.id === sessionBet.id
          )
        )
      ];

      // Enhanced logging with comprehensive bet details
      logger.debug('QUEUED_BETS_COMPREHENSIVE_RETRIEVAL', {
        gameSessionId,
        globalQueuedBetsCount: globalQueuedBets.length,
        sessionQueuedBetsCount: sessionQueuedBets.length,
        combinedQueuedBetsCount: combinedQueuedBets.length,
        globalQueuedBetIds: globalQueuedBets.map(bet => bet.id),
        sessionQueuedBetIds: sessionQueuedBets.map(bet => bet.id),
        combinedQueuedBetDetails: combinedQueuedBets.map(bet => ({
          id: bet.id,
          userId: bet.userId,
          amount: bet.amount,
          queuedAt: bet.queuedAt,
          status: bet.status,
          gameSessionId: bet.gameSessionId
        }))
      });

      return combinedQueuedBets;
    } catch (error) {
      logger.error('QUEUED_BETS_RETRIEVAL_COMPREHENSIVE_FAILURE', {
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack,
        errorDetails: {
          name: error.name,
          code: error.code
        }
      });

      // Return an empty array with detailed error logging
      return [];
    }
  }

  /**
   * Remove a bet from the queue after processing
   * @param {string} betId - Unique bet identifier
   * @param {string} gameSessionId - Game session identifier
   */
  async removeBetFromQueue(betId, gameSessionId) {
    try {
      await this.redisRepository.removeQueuedBet(gameSessionId, betId);

      logger.info('BET_REMOVED_FROM_QUEUE', {
        betId,
        gameSessionId
      });
    } catch (error) {
      logger.error('QUEUED_BET_REMOVAL_FAILURE', {
        betId,
        gameSessionId,
        errorMessage: error.message
      });
    }
  }

  /**
   * Validate a queued bet for transfer between game sessions
   * @param {Object} queuedBet - Queued bet details
   * @param {string} currentGameSessionId - Current game session identifier
   * @returns {Object} Validation result
   */
  async validateQueuedBetTransfer(queuedBet, currentGameSessionId) {
    try {
      // Check if bet is within valid transfer window (5 minutes)
      const currentTime = Date.now();
      const betQueuedTime = new Date(queuedBet.queuedAt).getTime();
      const TRANSFER_WINDOW_MS = 5 * 60 * 1000; // 5 minutes in milliseconds

      if (currentTime - betQueuedTime > TRANSFER_WINDOW_MS) {
        logger.warn('QUEUED_BET_TRANSFER_WINDOW_EXPIRED', {
          betId: queuedBet.id,
          queuedAt: queuedBet.queuedAt,
          currentGameSessionId
        });

        return {
          isValid: false,
          reason: 'BET_TRANSFER_WINDOW_EXPIRED'
        };
      }

      // Verify user's wallet balance (placeholder, replace with actual wallet service)
      const walletService = await import('../services/walletService.js');
      const userWallet = await walletService.getUserWallet(queuedBet.userId);

      if (userWallet.balance < queuedBet.amount) {
        logger.warn('QUEUED_BET_INSUFFICIENT_BALANCE', {
          betId: queuedBet.id,
          userId: queuedBet.userId,
          betAmount: queuedBet.amount,
          walletBalance: userWallet.balance
        });

        return {
          isValid: false,
          reason: 'INSUFFICIENT_BALANCE'
        };
      }

      // Optional: Additional validation checks
      const userBetHistory = await this.getUserBetHistory(queuedBet.userId);
      const suspiciousBetPattern = userBetHistory.some(bet => 
        bet.amount > queuedBet.amount * 2 || bet.amount < queuedBet.amount / 2
      );

      if (suspiciousBetPattern) {
        logger.warn('QUEUED_BET_SUSPICIOUS_PATTERN', {
          betId: queuedBet.id,
          userId: queuedBet.userId,
          betAmount: queuedBet.amount
        });
      }

      return {
        isValid: true,
        reason: 'VALID_BET_TRANSFER'
      };
    } catch (error) {
      logger.error('QUEUED_BET_TRANSFER_VALIDATION_ERROR', {
        betId: queuedBet.id,
        errorMessage: error.message,
        currentGameSessionId
      });

      return {
        isValid: false,
        reason: 'VALIDATION_ERROR'
      };
    }
  }

  /**
   * Retrieve user's bet history for validation
   * @param {string} userId - User identifier
   * @returns {Array} User's recent bet history
   */
  async getUserBetHistory(userId) {
    try {
      if (!userId || typeof userId !== 'string') {
        throw new Error('INVALID_USER_ID');
      }

      // Use the instance redisRepository instead of importing
      return await this.redisRepository.getUserRecentBetHistory(userId, 10);
    } catch (error) {
      logger.error('USER_BET_HISTORY_RETRIEVAL_ERROR', {
        userId,
        error: error.message,
        stack: error.stack
      });
      return [];
    }
  }

  /**
   * Handle bet placement in non-betting game states
   * @param {Object} betDetails - Bet details to process
   * @param {string} [cashoutStrategy='default'] - Strategy for handling bet
   * @returns {Promise<Object>} Processed bet details
   */

  async handleBetInNonBettingState(betDetails, cashoutStrategy = 'default') {
    try {
      // Validate input parameters
      if (!betDetails || !betDetails.userId) {
        throw new Error('INVALID_BET_DETAILS');
      }

      // Determine appropriate action based on current game state and cashout strategy
      switch (this.currentGameState) {
        case this.GAME_STATES.FLYING:
          switch (cashoutStrategy) {
            case 'auto':
              // Automatically queue bet for cashout
              return await this.redisRepository.queueBetForNextSession(betDetails);
            case 'queue':
              // Queue bet for next session
              return await this.redisRepository.queueBetForNextSession(betDetails);
            default:
              // Reject bet if not in betting state
              logger.warn('BET_PLACED_IN_NON_BETTING_STATE', {
                gameState: this.currentGameState,
                userId: betDetails.userId,
                strategy: cashoutStrategy
              });
              throw new Error('INVALID_GAME_STATE_FOR_BET');
          }

        case this.GAME_STATES.CRASHED:
          // Queue bet for next session
          return await this.redisRepository.queueBetForNextSession(betDetails);

        default:
          logger.error('UNEXPECTED_GAME_STATE', {
            gameState: this.currentGameState,
            context: 'handleBetInNonBettingState'
          });
          throw new Error('UNEXPECTED_GAME_STATE');
      }
    } catch (error) {
      logger.error('HANDLE_BET_IN_NON_BETTING_STATE_ERROR', {
        errorMessage: error.message,
        betDetails,
        cashoutStrategy,
        gameState: this.currentGameState
      });
      throw error;
    }
  }

  /**
   * Process queued bets for a new game session
   * @param {string} newGameSessionId - ID of the new game session
   * @returns {Promise<Array>} Processed bets
   */
  async processQueuedBets(newGameSessionId) {
    try {
      // Validate input
      if (!newGameSessionId) {
        throw new Error('INVALID_GAME_SESSION_ID');
      }

      // Retrieve queued bets
      const queuedBets = await this.redisRepository.getNextSessionBets();

      // Process each queued bet
      const processedBets = [];
      const processedBetIds = [];

      for (const queuedBet of queuedBets) {
        try {
          // Activate bet in the new session
          const activatedBet = await this.activateBet(
            queuedBet.betId, 
            newGameSessionId
          );

          processedBets.push(activatedBet);
          processedBetIds.push(queuedBet.betId);
        } catch (betProcessingError) {
          logger.error('QUEUED_BET_PROCESSING_ERROR', {
            betId: queuedBet.betId,
            errorMessage: betProcessingError.message
          });
          // Optionally, handle failed bet processing (e.g., requeue or notify)
        }
      }

      // Remove processed bets from the queue
      await this.redisRepository.removeProcessedQueuedBets(processedBetIds);

      logger.info('QUEUED_BETS_PROCESSED', {
        totalBets: processedBets.length,
        gameSessionId: newGameSessionId
      });

      return processedBets;
    } catch (error) {
      logger.error('PROCESS_QUEUED_BETS_ERROR', {
        errorMessage: error.message,
        gameSessionId: newGameSessionId
      });
      throw error;
    }
  }

  /**
   * Transfer queued bets to a new session
   * @returns {Promise<Object>} Transfer result
   */
  async transferQueuedBetsToNewSession() {
    try {
      // Generate new game session ID
      const newGameSessionId = uuidv4();

      // Process queued bets
      const processedBets = await this.processQueuedBets(newGameSessionId);

      return {
        gameSessionId: newGameSessionId,
        processedBets,
        totalBetCount: processedBets.length
      };
    } catch (error) {
      logger.error('TRANSFER_QUEUED_BETS_ERROR', {
        errorMessage: error.message
      });
      throw error;
    }
  }

  /**
   * Update handleGameCrash to support bet queuing
   * @param {Object} crashDetails - Details of the game crash
   * @returns {Promise<Object>} Game crash handling result
   */


  async handleGameCrash(crashDetails = {}) {
    try {
      // Validate current game state
      if (this.currentGameState !== this.GAME_STATES.FLYING) {
        logger.warn('INVALID_CRASH_STATE', {
          currentState: this.currentGameState,
          expectedState: this.GAME_STATES.FLYING
        });
        return null;
      }

      // Update game state
      this.currentGameState = this.GAME_STATES.CRASHED;

      // Queue any active bets for next session
      const activeBets = await this.redisRepository.getActiveBets(
        this.currentGameSessionId
      );

      const queuedBetIds = [];
      for (const bet of activeBets) {
        try {
          // Queue bet for next session
          await this.redisRepository.queueBetForNextSession({
            ...bet,
            status: this.BET_STATES.EXPIRED
          });
          queuedBetIds.push(bet.betId);
        } catch (queueError) {
          logger.error('FAILED_TO_QUEUE_BET_AFTER_CRASH', {
            betId: bet.betId,
            errorMessage: queueError.message
          });
        }
      }

      logger.info('GAME_CRASH_BET_QUEUING', {
        queuedBetCount: queuedBetIds.length,
        gameSessionId: this.currentGameSessionId
      });

      return {
        queuedBetIds
      };
    } catch (error) {
      logger.error('HANDLE_GAME_CRASH_WITH_QUEUING_ERROR', {
        errorMessage: error.message,
        crashDetails
      });
      throw error;
    }
  }

  /**
   * Modify scheduleAutoCashout to handle queued bets
   * @param {Object} betDetails - Bet details
   * @param {number} autoCashoutMultiplier - Multiplier for auto cashout
   * @returns {Promise<Object>} Scheduled cashout result
   */
  async scheduleAutoCashout(betDetails, autoCashoutMultiplier) {
    try {
      // Check if bet is in a non-betting state
      if (this.currentGameState !== this.GAME_STATES.BETTING) {
        // Queue cashout for next session
        return await this.redisRepository.queueBetForNextSession(betDetails);
      }

      // Existing auto cashout logic
      return await this.originalScheduleAutoCashout(
        betDetails, 
        autoCashoutMultiplier
      );
    } catch (error) {
      logger.error('SCHEDULE_AUTO_CASHOUT_WITH_QUEUING_ERROR', {
        errorMessage: error.message,
        betDetails,
        autoCashoutMultiplier
      });
      throw error;
    }
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
      if (!gameSessionId || !betDetails) {
        throw new Error('INVALID_STORAGE_PARAMETERS');
      }

      // Get current game state
      const currentGameState = await gameService.getCurrentGameState();

      // Determine bet state based on game state
      let betState;
      if (currentGameState.status === this.GAME_STATES.BETTING) {
        betState = this.BET_STATES.PLACED;
      } else {
        betState = this.BET_STATES.QUEUED;
      }

      // Prepare bet for storage
      const normalizedBet = {
        ...betDetails,
        id: betDetails.id || uuidv4(),
        gameSessionId: currentGameState.gameId, // Always use current session ID
        status: betState,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      // Store bet with Redis
      await this.redisRepository.storeBet(currentGameState.gameId, normalizedBet);

      logger.info('BET_STORED_SUCCESSFULLY', {
        betId: normalizedBet.id,
        userId: normalizedBet.userId,
        status: betState,
        gameSessionId: currentGameState.gameId
      });

      return normalizedBet;
    } catch (error) {
      logger.error('BET_STORAGE_ERROR', {
        error: error.message,
        gameSessionId,
        betDetails
      });
      throw error;
    }
  }

  /**
   * Retrieve bets for a specific game session
   * @param {string} gameSessionId - Game session ID to retrieve bets for
   * @returns {Promise<Array>} List of bets for the game session
   */
  async getBetsForGameSession(gameSessionId) {
    try {
      const betsKey = `game_session_bets:${gameSessionId}`;
      const bets = await this.redisRepository.getAllBetsForGameSession(betsKey);

      return bets.map(bet => ({
        ...bet,
        // Additional parsing or transformation if needed
        metadata: {
          ...bet.metadata,
          retrievedAt: Date.now()
        }
      }));
    } catch (error) {
      logger.error('RETRIEVE_BETS_ERROR', {
        gameSessionId,
        errorMessage: error.message
      });

      return [];
    }
  }

  /**
   * Bulk activate both placed and queued bets for a given game session
   * @param {string} gameSessionId - Current game session identifier
   * @returns {Promise<Object>} Combined activation results
   */
  async bulkActivateAllBets(gameSessionId) {
    try {
      // Get start time for performance tracking
      const startTime = Date.now();

      // Fetch both placed and queued bets
      const [placedBets, queuedBets] = await Promise.all([
        this.redisRepository.getPlacedBets(gameSessionId),
        this.redisRepository.getQueuedBets(gameSessionId)
      ]);

      // Log bet counts for debugging
      logger.debug('BETS_FOUND_FOR_ACTIVATION', {
        gameSessionId,
        placedBetsCount: placedBets.length,
        queuedBetsCount: queuedBets.length,
        timestamp: new Date().toISOString()
      });

      // Early return if no bets to activate
      if (placedBets.length === 0 && queuedBets.length === 0) {
        logger.info('NO_BETS_TO_ACTIVATE', {
          gameSessionId,
          timestamp: new Date().toISOString()
        });
        return {
          totalBets: 0,
          successCount: 0,
          failedCount: 0,
          processingTime: Date.now() - startTime
        };
      }

      // Prepare bets for activation
      const allBets = [...placedBets, ...queuedBets].map(bet => ({
        ...bet,
        id: bet.id || bet.betId,  // Normalize ID field
        gameSessionId,  // Ensure session ID is set
        status: 'active'  // Set target status
      }));

      // Bulk activate all bets
      const activationResult = await this.redisRepository.bulkActivateBets(
        allBets,
        this.BET_STATES.ACTIVE
      );

      // Clean up successfully activated bets
      if (activationResult.successCount > 0) {
        const successfulBetIds = activationResult.successfulBetIds || [];

        // Remove from placed bets
        const placedBetIds = placedBets
          .filter(bet => successfulBetIds.includes(bet.id || bet.betId))
          .map(bet => bet.id || bet.betId);

        // Remove from queued bets
        const queuedBetIds = queuedBets
          .filter(bet => successfulBetIds.includes(bet.id || bet.betId))
          .map(bet => bet.id || bet.betId);

        // Execute cleanup in parallel
        await Promise.all([
          placedBetIds.length > 0
            ? this.redisRepository.removeProcessedPlacedBets(placedBetIds, gameSessionId)
            : Promise.resolve(),
          queuedBetIds.length > 0
            ? this.redisRepository.removeProcessedQueuedBets(queuedBetIds, gameSessionId)
            : Promise.resolve()
        ]);
      }

      // Calculate processing time
      const processingTime = Date.now() - startTime;

      // Log activation results
      logger.info('BETS_ACTIVATED', {
        gameSessionId,
        totalBets: allBets.length,
        successCount: activationResult.successCount,
        failedCount: activationResult.failedCount,
        processingTime
      });

      return {
        ...activationResult,
        processingTime
      };
    } catch (error) {
      logger.error('BULK_BET_ACTIVATION_ERROR', {
        gameSessionId,
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }
}

const betTrackingService = new BetTrackingService(
  redisRepository
);

export default betTrackingService;
