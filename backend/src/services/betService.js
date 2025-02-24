import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { BetState, GameState } from '../constants/betStates.js';
import ValidationError from '../utils/validationError.js';
import notificationService from './notificationService.js';
import { authService } from './authService.js';
import redisRepository from '../redis-services/redisRepository.js';
import walletService from './walletService.js';
import statsService from './statsService.js';
import wagerMonitorService from './wagerMonitorService.js';
import gameRepository from '../repositories/gameRepository.js';
import logger from '../config/logger.js';
import pool from '../config/database.js';

class BetService {
  // Game and Bet State Constants
  static BET_STATES = {
    PLACED: BetState.PLACED,
    ACTIVE: BetState.ACTIVE,
    WON: BetState.WON,
    LOST: BetState.LOST
  };

  static GAME_STATES = {
    BETTING: GameState.BETTING,
    FLYING: GameState.FLYING,
    CRASHED: GameState.CRASHED
  };

  constructor() {
    this.redisRepository = redisRepository;
    this.walletService = walletService;
    this.statsService = statsService;
    this.wagerMonitorService = wagerMonitorService;
    this.gameRepository = gameRepository;
  }

  async getGameService() {
    if (!this._gameService) {
      const { default: gameService } = await import('./gameService.js');
      this._gameService = gameService;
    }
    return this._gameService;
  }

  // Rest of the class remains the same
  async getBetTrackingService() {
    if (!this._betTrackingService) {
      const { default: betTrackingService } = await import('../redis-services/betTrackingService.js');
      this._betTrackingService = betTrackingService;
    }
    return this._betTrackingService;
  }

  /**
   * Validate and extract authenticated user for bet placement
   * @param {Object} betDetails - Bet details
   * @param {Object} [req={}] - Request context
   * @returns {Object} Authenticated user details
   * @throws {ValidationError} For authentication failures
   */
  async extractAuthenticatedUser(betDetails, req = {}) {
    const { userId, phoneNumber } = betDetails;

    // Validate input parameters
    if (!userId && !phoneNumber) {
      throw new ValidationError('INVALID_USER_IDENTIFICATION', {
        message: 'User ID or phone number must be provided'
      });
    }

    // Fetch user profile based on available identifier
    const userProfile = userId 
      ? await this.authService.getUserProfile(userId)
      : await this.authService.getUserProfile(
          await this._fetchUserIdByPhoneNumber(phoneNumber)
        );

    // Validate user profile
    if (!userProfile || !userProfile.is_active) {
      this.logger.warn('AUTHENTICATION_FAILURE', {
        userId,
        phoneNumber,
        profileExists: !!userProfile,
        isActive: userProfile?.is_active,
        context: 'extractAuthenticatedUser'
      });
      throw new ValidationError('INVALID_USER_PROFILE', {
        message: 'User profile is invalid or inactive'
      });
    }

    // Log successful authentication with expanded context
    this.logger.info('USER_AUTHENTICATION_VERIFIED', {
      userId: userProfile.user_id,
      username: userProfile.username,
      authContextSource: Object.keys(req)[0] || 'unknown',
      timestamp: new Date().toISOString()
    });

    return {
      user: {
        ...req,
        ...userProfile
      }
    };
  }

  /**
   * Bulk place multiple bets with enhanced authentication
   * @param {Array} betDetailsList - List of bet details to place
   * @param {Object} [req={}] - Request context
   * @returns {Object} Bulk placement results
   */
  async bulkPlaceBets(betDetailsList, req = {}) {
    // Validate input
    if (!Array.isArray(betDetailsList) || betDetailsList.length === 0) {
      throw new ValidationError('INVALID_BET_LIST', {
        message: 'Bet list must be a non-empty array'
      });
    }

    // Extract authenticated user for the entire batch
    const { user: authenticatedUser } = await this.extractAuthenticatedUser(
      betDetailsList[0], 
      req
    );

    // Get current game session from game service
    const currentGameSession = await (await this.getGameService()).getCurrentGameSession();

    // Validate session
    if (!currentGameSession || !currentGameSession.id) {
      throw new ValidationError('INVALID_GAME_SESSION', {
        message: 'No valid game session found for bet placement'
      });
    }

    // Use the game session ID directly from game service
    const gameSessionId = currentGameSession.id;

    // Bulk validate and place bets
    const placedBets = [];
    const failedBets = [];

    for (const betDetails of betDetailsList) {
      try {
        // Validate bet details with authenticated user context
        const validatedBetDetails = {
          ...betDetails,
          userId: authenticatedUser.user_id
        };
        
        // Generate unique bet ID
        const betId = uuidv4();
        
        // Create initial bet state
        const initialBet = {
          id: betId,
          userId: authenticatedUser.user_id,
          amount: validatedBetDetails.amount || validatedBetDetails.betAmount,
          status: (await this.getBetTrackingService()).BET_STATES.PLACED,
          gameSessionId,
          createdAt: new Date().toISOString(),
          userDetails: {
            username: authenticatedUser.username,
            role: authenticatedUser.role
          }
        };
        
        // Store bet in Redis with consistent session management
        await this.redisRepository.storeBet(gameSessionId, initialBet);
        
        placedBets.push(initialBet);
      } catch (error) {
        // Log and track failed bets
        failedBets.push({
          details: betDetails,
          error: error.message
        });
        
        logger.error('BULK_BET_PLACEMENT_FAILED', {
          userId: authenticatedUser.user_id,
          betDetails,
          errorMessage: error.message,
          gameSessionId
        });
      }
    }

    // Log bulk placement results
    logger.info('BULK_BET_PLACEMENT_SUMMARY', {
      userId: authenticatedUser.user_id,
      gameSessionId,
      totalBetsAttempted: betDetailsList.length,
      successfulBets: placedBets.length,
      failedBets: failedBets.length
    });

    return {
      gameSessionId,
      userId: authenticatedUser.user_id,
      placedBets,
      failedBets
    };
  }

  /**
   * Activate bets for the current game session
   * @param {Object} gameState - Current game state
   * @returns {Object} Bet activation results
   */
  async activateBets(gameState) {
    try {
      // Validate game state
      if (!gameState || !gameState.gameId) {
        throw new ValidationError('INVALID_GAME_STATE', {
          message: 'Game state is required for bet activation'
        });
      }

      // Retrieve current game session
      const currentGameSession = await this.gameRepository.getCurrentGameSession();

      // Validate game session
      if (!currentGameSession || currentGameSession.id !== gameState.gameId) {
        throw new ValidationError('GAME_SESSION_MISMATCH', {
          message: 'Game session ID does not match current active session',
          gameStateId: gameState.gameId,
          currentSessionId: currentGameSession?.id
        });
      }

      // Activate bets using bet tracking service with session ID
      const activationResult = await (await this.getBetTrackingService()).activateBets(
        gameState, 
        currentGameSession.id,  // Pass session ID for strict validation
        gameState.sessionId  // Pass session ID
      );

      // Log activation results
      logger.info('BETS_ACTIVATION_COMPLETED', {
        gameSessionId: currentGameSession.id,
        activatedBetsCount: activationResult.activatedBets.length,
        failedBetsCount: activationResult.failedBets.length
      });

      return activationResult;
    } catch (error) {
      logger.error('BET_ACTIVATION_FAILED', {
        errorMessage: error.message,
        errorStack: error.stack,
        gameStateId: gameState?.gameId
      });
      throw error;
    }
  }

  /**
   * Authenticate user for bet placement with ABSOLUTE STRICT validation
   * @param {Object} betDetails - Bet details containing user ID
   * @param {Object} req - Request context with authentication information
   * @throws {Error} For any deviation from strict security requirements
   * @returns {Object} Fully validated and authenticated user details
   */
  async authenticateUserForBet(betDetails, req = {}) {
    try {
      // Log authentication attempt
      this.logger.info('AUTHENTICATING_USER_FOR_BET', {
        timestamp: new Date().toISOString(),
        hasUser: !!req.user,
        userId: req.user?.user_id
      });

      // Always use the authenticated user from the request context
      if (!req.user || !req.user.user_id) {
        throw new ValidationError('AUTHENTICATION_REQUIRED', 'Valid authentication is required for bet placement');
      }

      // Verify that the user exists and is active
      const userProfile = await this.authService.getUserProfile(req.user.user_id);
      if (!userProfile || !userProfile.is_active) {
        throw new ValidationError('INVALID_USER', 'User not found or inactive');
      }

      // Return the authenticated user
      return {
        user: {
          user_id: req.user.user_id,
          username: req.user.username,
          role: req.user.role
        }
      };
    } catch (error) {
      this.logger.error('AUTHENTICATION_FAILED', {
        timestamp: new Date().toISOString(),
        error: error.message,
        userId: req.user?.user_id
      });
      throw error;
    }
  }

  /**
   * Validate bet details before placement
   * @param {Object} betDetails - Details of the bet to be validated
   * @throws {ValidationError} If bet details are invalid
   * @returns {Object} Validated bet amount and auto cashout settings
   */
  async validateBetData(betDetails) {
    const { amount, autoCashoutAt } = betDetails;

    // Validate bet amount
    if (!amount || isNaN(amount) || amount <= 0) {
      throw new ValidationError('INVALID_BET_AMOUNT', {
        message: 'Bet amount must be a positive number',
        amount
      });
    }

    // Validate auto cashout settings if provided
    let autoCashoutEnabled = false;
    let autoCashoutMultiplier = null;

    if (autoCashoutAt) {
      const multiplier = parseFloat(autoCashoutAt);
      if (isNaN(multiplier) || multiplier <= 1.0) {
        throw new ValidationError('INVALID_AUTO_CASHOUT_MULTIPLIER', {
          message: 'Auto cashout multiplier must be greater than 1.0',
          autoCashoutAt
        });
      }
      autoCashoutEnabled = true;
      autoCashoutMultiplier = multiplier;
    }

    return {
      amount: parseFloat(amount),
      autoCashoutEnabled,
      autoCashoutMultiplier
    };
  }

  /**
   * Retrieve wallet ID for a given user
   * @param {string} userId - User identifier
   * @returns {Promise<string>} Wallet ID
   */
  async _getWalletIdForUser(userId) {
    try {
      const walletQuery = `
        SELECT wallet_id 
        FROM wallets 
        WHERE user_id = $1
      `;
      const walletResult = await pool.query(walletQuery, [userId]);

      if (walletResult.rows.length === 0) {
        throw new ValidationError('WALLET_NOT_FOUND', {
          message: 'User wallet does not exist',
          userId
        });
      }

      return walletResult.rows[0].wallet_id;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Validate game state for bet placement
   * @param {Object} gameState - Current game state
   * @throws {ValidationError} If bet is not allowed in current game state
   */
  validateGameStateForBet(gameState) {
    // Validate game state
    if (!gameState || !gameState.state) {
      throw new ValidationError('INVALID_GAME_STATE', 'Game state is undefined');
    }

    // Log bet state validation
    this.logger.debug('BET_STATE_VALIDATION', {
      currentState: gameState.state,
      timestamp: new Date().toISOString()
    });

    // Allow betting in all states, with special handling for FLYING state
    return {
      placementAllowed: true,
      queuingRequired: gameState.state === this.GAME_STATES.FLYING
    };
  }

  /**
   * Fetch the actual user ID from the database for bet placement
   * @param {string} phoneNumber - User's phone number
   * @returns {Promise<string>} Verified user ID from database
   */
  async _fetchUserIdByPhoneNumber(phoneNumber) {
    try {
      // Validate phone number format
      if (!phoneNumber) {
        throw new ValidationError('INVALID_PHONE_NUMBER', {
          message: 'Phone number is required'
        });
      }

      // Query to find user ID by phone number
      const query = `
        SELECT user_id 
        FROM users 
        WHERE phone_number = $1
      `;

      const result = await global.pool.query(query, [phoneNumber]);

      // Check if user exists
      if (result.rows.length === 0) {
        throw new ValidationError('USER_NOT_FOUND', {
          message: 'No user found with the provided phone number',
          phoneNumber
        });
      }

      // Return the first (and should be only) user ID
      const userId = result.rows[0].user_id;

      // Log successful user ID retrieval
      this.logger.info('USER_ID_RETRIEVED_BY_PHONE', {
        phoneNumber,
        userId,
        context: '_fetchUserIdByPhoneNumber'
      });

      return userId;

    } catch (error) {
      // Enhanced error logging
      this.logger.error('USER_ID_RETRIEVAL_FAILED', {
        phoneNumber,
        errorMessage: error.message,
        context: '_fetchUserIdByPhoneNumber',
        errorStack: error.stack
      });
      throw error;
    }
  }

  /**
   * Place a bet with ABSOLUTE STRICT authentication and validation
   * @param {Object} betDetails - Comprehensive bet placement details
   * @param {Object} req - Authenticated request context
   * @throws {Error} For any deviation from strict security requirements
   * @returns {Object} Validated and processed bet
   */
  async placeBet(betDetails, req = {}) {
    try {
      // Validate bet details
      if (!betDetails || typeof betDetails !== 'object') {
        throw new ValidationError('INVALID_BET_DETAILS', {
          message: 'Invalid bet details provided'
        });
      }

      // Ensure user is authenticated
      if (!req.user || !req.user.user_id) {
        throw new ValidationError('AUTHENTICATION_REQUIRED', {
          message: 'User authentication required'
        });
      }

      // Get current game session
      const gameService = await this.getGameService();
      const currentGameSession = gameService.getCurrentGameSession();

      // Validate session
      if (!currentGameSession || !currentGameSession.id) {
        throw new ValidationError('INVALID_GAME_SESSION', {
          message: 'No valid game session found'
        });
      }

      // Validate bet data including auto cashout
      const validatedData = await this.validateBetData(betDetails);
      const { amount, autoCashoutEnabled, autoCashoutMultiplier } = validatedData;

      // Verify wallet balance
      const wallet = await this.walletService.getWallet(req.user.user_id);
      if (!wallet) {
        throw new ValidationError('WALLET_NOT_FOUND', {
          message: 'User wallet not found'
        });
      }

      if (wallet.balance < amount) {
        throw new ValidationError('INSUFFICIENT_BALANCE', {
          message: 'Insufficient wallet balance'
        });
      }

      // Generate unique bet ID
      const betId = uuidv4();

      // Create initial bet state
      const bet = {
        id: betId,
        userId: req.user.user_id,
        amount: amount,
        status: 'PLACED',
        gameSessionId: currentGameSession.id,
        createdAt: new Date().toISOString(),
        autoCashoutEnabled,
        autoCashoutAt: autoCashoutEnabled ? autoCashoutMultiplier : null,
        userDetails: {
          username: req.user.username,
          role: req.user.role
        }
      };

      // Check game state and store bet accordingly
      if (currentGameSession.status === 'betting') {
        // Store as active bet
        bet.status = 'ACTIVE';
        await this.redisRepository.storeBet(currentGameSession.id, bet);
        await this.redisRepository.addActiveBetToSet(currentGameSession.id, betId);

        // Start auto-cashout monitoring if enabled
        if (autoCashoutEnabled) {
          await this._startAutoCashoutMonitoring(currentGameSession.id);
        }
      } else {
        // Store as placed bet for next session
        await this.redisRepository.storePlacedBet(bet);
      }

      // Update wallet balance
      await this.walletService.placeBet(req.user.user_id, amount, currentGameSession.id);

      // Log successful bet placement
      logger.info('BET_PLACED_SUCCESSFULLY', {
        betId,
        userId: req.user.user_id,
        amount,
        gameSessionId: currentGameSession.id,
        status: bet.status,
        autoCashoutEnabled,
        autoCashoutAt: bet.autoCashoutAt,
        gameState: currentGameSession.status
      });

      return {
        success: true,
        betId,
        status: bet.status,
        autoCashoutEnabled,
        autoCashoutAt: bet.autoCashoutAt,
        message: bet.status === 'ACTIVE' ? 
          'Bet placed and activated for current session' : 
          'Bet placed and will be activated in next betting phase'
      };

    } catch (error) {
      logger.error('BET_PLACEMENT_ERROR', {
        errorType: error.constructor.name,
        errorMessage: error.message,
        errorStack: error.stack,
        userId: req?.user?.user_id,
        betDetails
      });

      const formattedError = {
        success: false,
        message: error.message || 'Failed to place bet',
        code: error.code || 'BET_PLACEMENT_ERROR'
      };

      if (error instanceof ValidationError) {
        formattedError.status = 400;
      } else {
        formattedError.status = 500;
      }

      throw formattedError;
    }
  }

  /**
   * Helper method to normalize bet details consistently across the service
   * @param {Object} betDetails - Bet details to normalize
   * @param {Object} authenticatedUser - Authenticated user details
   * @param {string} gameSessionId - Game session ID
   * @param {string} [status] - Optional bet status
   * @returns {Object} Normalized bet details
   */
  async _normalizeBetDetails(betDetails, authenticatedUser, gameSessionId, status) {
    // Get default status if not provided
    if (!status) {
      const betTrackingService = await this.getBetTrackingService();
      status = betTrackingService.BET_STATES.PLACED;
    }

    // Always use the authenticated user's ID
    return {
      id: uuidv4(),
      userId: authenticatedUser.user_id,
      amount: betDetails.amount,
      status,
      gameSessionId,
      createdAt: new Date().toISOString(),
      userDetails: {
        username: authenticatedUser.username
      }
    };
  }

  async handleBetInNonBettingState(betDetails, authenticatedUser, cashoutStrategy = 'default') {
    const gameState = await (await this.getGameService()).getCurrentGameState();
    const betId = uuidv4();
    
    const normalizedBet = await this._normalizeBetDetails(
      betDetails,
      authenticatedUser,
      gameState.gameId,
      (await this.getBetTrackingService()).BET_STATES.QUEUED
    );

    try {
      // Deduct amount from wallet
      await this.walletService.deductAmount(
        authenticatedUser.user_id,
        betDetails.amount,
        'BET_PLACEMENT'
      );

      // Store queued bet
      const queuedBet = await this.storeBet(normalizedBet, true);
      await this.redisRepository.sadd(
        `game:${gameState.gameId}:queuedBets`,
        betId
      );

      return {
        ...queuedBet,
        status: 'queued',
        message: 'Bet queued for next betting phase'
      };
    } catch (error) {
      this.logger.error('BET_QUEUING_FAILED', {
        error: error.message,
        betId,
        userId: authenticatedUser.user_id
      });
      throw error;
    }
  }

  async placeBetInBettingState(betDetails, authenticatedUser) {
    const gameState = await (await this.getGameService()).getCurrentGameState();
    const betId = uuidv4();
    
    const normalizedBet = await this._normalizeBetDetails(
      betDetails,
      authenticatedUser,
      gameState.gameId,
      (await this.getBetTrackingService()).BET_STATES.PLACED
    );

    try {
      // Deduct amount and store bet
      await this.walletService.deductAmount(
        authenticatedUser.user_id,
        betDetails.amount,
        'BET_PLACEMENT'
      );

      const placedBet = await this.storeBet(normalizedBet);
      await this.redisRepository.sadd(
        `game:${gameState.gameId}:activeBets`,
        betId
      );

      // Setup auto cashout if enabled
      if (betDetails.autoCashoutEnabled && betDetails.autoCashoutMultiplier) {
        await this.redisRepository.hset(
          `bet:${betId}:autoCashout`,
          {
            multiplier: betDetails.autoCashoutMultiplier,
            enabled: true
          }
        );
      }

      return {
        ...placedBet,
        status: 'placed',
        message: 'Bet placed successfully'
      };
    } catch (error) {
      this.logger.error('BET_PLACEMENT_FAILED', {
        error: error.message,
        betId,
        userId: authenticatedUser.user_id
      });
      throw error;
    }
  }

  /**
   * Process wallet transaction for bet or cashout
   * @param {string} userId - User ID
   * @param {number} amount - Transaction amount
   * @param {string} type - Transaction type (debit/credit)
   * @param {string} betId - Associated bet ID
   * @private
   */
  async _processWalletTransaction(userId, amount, type, betId) {
    try {
      const transaction = {
        userId,
        amount,
        type,
        betId,
        timestamp: Date.now(),
        status: 'pending'
      };

      // Store transaction record
      const transactionId = await this.redisRepository.incr('transaction:id');
      await this.redisRepository.hmset(
        `transaction:${transactionId}`,
        transaction
      );

      // Update wallet balance
      const walletKey = `wallet:${userId}`;
      const pipeline = this.redisRepository.pipeline();

      // Lock wallet for atomic operation
      pipeline.watch(walletKey);

      const currentBalance = parseFloat(await this.redisRepository.hget(walletKey, 'balance') || '0');
      let newBalance;

      if (type === 'debit') {
        if (currentBalance < amount) {
          throw new ValidationError('INSUFFICIENT_BALANCE', 'Insufficient wallet balance');
        }
        newBalance = currentBalance - amount;
      } else {
        newBalance = currentBalance + amount;
      }

      // Update balance and record transaction
      pipeline.hset(walletKey, 'balance', newBalance.toString());
      pipeline.sadd(`wallet:${userId}:transactions`, transactionId);
      
      // Update transaction status
      pipeline.hset(`transaction:${transactionId}`, 'status', 'completed');

      await pipeline.exec();

      // Emit wallet update event
      this.io.to(userId).emit('walletUpdate', {
        balance: newBalance,
        transaction: {
          id: transactionId,
          type,
          amount,
          timestamp: transaction.timestamp
        }
      });

      return { transactionId, newBalance };
    } catch (error) {
      this.logger.error('WALLET_TRANSACTION_FAILED', {
        userId,
        amount,
        type,
        betId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Process cashout with wallet update
   */
  async processCashout(req, multiplier, isAutoCashout = false) {
    const userId = req.user.user_id;
    const gameState = await (await this.getGameService()).getCurrentGameState();
    
    try {
      // Validate game state and get bet
      if (gameState.status !== this.GAME_STATES.FLYING) {
        throw new ValidationError('INVALID_GAME_STATE', 'Game is not in flying state');
      }

      const bet = await this.findActiveBet(userId);
      await this.validateBetForCashout(bet, gameState, userId);

      // Calculate winnings
      const winnings = parseFloat((bet.amount * multiplier).toFixed(2));

      // Process wallet credit
      await this._processWalletTransaction(
        userId,
        winnings,
        'credit',
        bet.id
      );

      // Update bet status
      await this.redisRepository.hmset(`bet:${bet.id}`, {
        status: (await this.getBetTrackingService()).BET_STATES.WON,
        cashoutMultiplier: multiplier,
        winnings,
        cashedOutAt: Date.now()
      });

      // Remove from active bets
      await this.redisRepository.srem(
        `game:${gameState.gameId}:activeBets`,
        bet.id
      );

      // Stop auto cashout monitoring if enabled
      if (bet.autoCashoutEnabled) {
        await this._stopAutoCashoutMonitoring(gameState.gameId, bet.id);
      }

      return {
        success: true,
        betId: bet.id,
        multiplier,
        winnings,
        isAutoCashout
      };
    } catch (error) {
      this.logger.error('CASHOUT_FAILED', {
        userId,
        multiplier,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Process queued bets for a new game session
   */
  async processQueuedBets(newGameSessionId) {
    try {
      const queuedBetIds = await this.redisRepository.smembers('queuedBets');
      const results = {
        processed: 0,
        failed: 0,
        errors: []
      };

      for (const betId of queuedBetIds) {
        try {
          const queuedBet = await this.redisRepository.hgetall(`bet:${betId}`);
          if (!queuedBet || !queuedBet.userId) continue;

          // Activate bet in new session
          const normalizedBet = {
            ...queuedBet,
            gameId: newGameSessionId,
            status: (await this.getBetTrackingService()).BET_STATES.PLACED,
            queuedAt: null,
            placedAt: Date.now()
          };

          await this.storeBet(normalizedBet);
          await this.redisRepository.sadd(
            `game:${newGameSessionId}:activeBets`,
            betId
          );
          await this.redisRepository.srem('queuedBets', betId);
          
          results.processed++;
        } catch (error) {
          results.failed++;
          results.errors.push({ betId, error: error.message });
        }
      }

      return results;
    } catch (error) {
      this.logger.error('QUEUED_BETS_PROCESSING_FAILED', {
        error: error.message,
        newGameSessionId
      });
      throw error;
    }
  }

  /**
   * Retrieve wallet ID for a given user
   * @param {string} userId - User identifier
   * @returns {Promise<string>} Wallet ID
   */
  async _getWalletIdForUser(userId) {
    try {
      const walletQuery = `
        SELECT wallet_id 
        FROM wallets 
        WHERE user_id = $1
      `;
      const walletResult = await pool.query(walletQuery, [userId]);

      if (walletResult.rows.length === 0) {
        throw new ValidationError('WALLET_NOT_FOUND', {
          message: 'User wallet does not exist',
          userId
        });
      }

      return walletResult.rows[0].wallet_id;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Handle game crash and manage affected bets
   */
  async handleGameCrash(gameId, crashPoint) {
    try {
      const activeBetIds = await this.redisRepository.smembers(
        `game:${gameId}:activeBets`
      );

      const results = {
        expired: 0,
        queued: 0,
        errors: []
      };

      for (const betId of activeBetIds) {
        try {
          const bet = await this.redisRepository.hgetall(`bet:${betId}`);
          
          // Mark bet as expired
          await this.redisRepository.hset(`bet:${betId}`, {
            status: (await this.getBetTrackingService()).BET_STATES.LOST,
            crashPoint,
            expiredAt: Date.now()
          });

          // Queue for next session if auto-requeue is enabled
          if (bet.autoRequeue) {
            const queuedBet = {
              ...bet,
              status: (await this.getBetTrackingService()).BET_STATES.QUEUED,
              queuedAt: Date.now(),
              previousGameId: gameId
            };

            await this.storeBet(queuedBet, true);
            results.queued++;
          } else {
            results.expired++;
          }

          // Remove from active bets
          await this.redisRepository.srem(
            `game:${gameId}:activeBets`,
            betId
          );

        } catch (error) {
          results.errors.push({ betId, error: error.message });
        }
      }

      // Stop auto-cashout monitoring
      await this._stopAutoCashoutMonitoring(gameId);

      return results;
    } catch (error) {
      this.logger.error('GAME_CRASH_HANDLING_FAILED', {
        gameId,
        crashPoint,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Transfer queued bets to a new session
   */
  async transferQueuedBetsToNewSession(newGameSessionId) {
    try {
      const queuedBetIds = await this.redisRepository.smembers('queuedBets');
      
      const results = {
        transferred: 0,
        failed: 0,
        errors: []
      };

      for (const betId of queuedBetIds) {
        try {
          const bet = await this.redisRepository.hgetall(`bet:${betId}`);
          
          // Update bet with new session ID
          await this.redisRepository.hset(`bet:${betId}`, {
            gameId: newGameSessionId,
            transferredAt: Date.now()
          });

          // Add to new session's queued bets
          await this.redisRepository.sadd(
            `game:${newGameSessionId}:queuedBets`,
            betId
          );

          results.transferred++;
        } catch (error) {
          results.failed++;
          results.errors.push({ betId, error: error.message });
        }
      }

      return results;
    } catch (error) {
      this.logger.error('QUEUED_BETS_TRANSFER_FAILED', {
        error: error.message,
        newGameSessionId
      });
      throw error;
    }
  }

  /**
   * Queue cashout for next session
   */
  async queueCashoutForNextSession(betId, userId, targetMultiplier) {
    try {
      const bet = await this.redisRepository.hgetall(`bet:${betId}`);
      
      if (bet.userId !== userId) {
        throw new ValidationError('UNAUTHORIZED_CASHOUT', 'Not authorized to queue cashout for this bet');
      }

      await this.redisRepository.hset(`bet:${betId}:autoCashout`, {
        enabled: true,
        multiplier: targetMultiplier,
        queuedAt: Date.now()
      });

      this.logger.info('CASHOUT_QUEUED', {
        betId,
        userId,
        targetMultiplier
      });

      return {
        success: true,
        message: 'Cashout queued for next session'
      };
    } catch (error) {
      this.logger.error('CASHOUT_QUEUE_FAILED', {
        error: error.message,
        betId,
        userId
      });
      throw error;
    }
  }

  /**
   * Check auto cashouts
   * @param {string} gameId - Game ID
   * @param {number} currentMultiplier - Current multiplier
   */
  async checkAutoCashouts(gameId, currentMultiplier) {
    const monitoringContexts = await this.redisRepository.hgetall(
      `game:${gameId}:autoCashoutMonitoring`
    );

    for (const [betId, contextStr] of Object.entries(monitoringContexts)) {
      const context = JSON.parse(contextStr);
      
      if (currentMultiplier >= context.targetMultiplier) {
        try {
          await this.processCashout(
            { user: { user_id: context.userId } },
            currentMultiplier,
            true
          );

          await this.redisRepository.hdel(
            `game:${gameId}:autoCashoutMonitoring`,
            betId
          );
        } catch (error) {
          this.logger.error('AUTO_CASHOUT_FAILED', {
            error: error.message,
            betId,
            userId: context.userId
          });
        }
      }
    }
  }

  /**
   * Start monitoring for auto cashouts in a game session
   * @param {string} gameSessionId - Game session to monitor
   * @private
   */
  async _startAutoCashoutMonitoring(gameSessionId) {
    try {
      // Check if monitoring is already active
      if (this._autoCashoutMonitoring?.[gameSessionId]) {
        return;
      }

      // Initialize monitoring state
      if (!this._autoCashoutMonitoring) {
        this._autoCashoutMonitoring = {};
      }

      // Set up monitoring interval
      this._autoCashoutMonitoring[gameSessionId] = setInterval(async () => {
        try {
          const gameService = await this.getGameService();
          const gameState = await gameService.getCurrentGameState();
          
          if (gameState && gameState.multiplier) {
            const currentMultiplier = parseFloat(gameState.multiplier);
            await this.processAutoCashouts(gameSessionId, currentMultiplier);
          }
        } catch (error) {
          logger.error('AUTO_CASHOUT_MONITORING_ERROR', {
            gameSessionId,
            error: error.message,
            stack: error.stack
          });
        }
      }, 100); // Check every 100ms

      logger.info('Started auto cashout monitoring', { gameSessionId });
    } catch (error) {
      logger.error('Failed to start auto cashout monitoring', {
        gameSessionId,
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Process auto cashouts for active bets
   * @param {string} gameSessionId - Game session ID
   * @param {number} currentMultiplier - Current game multiplier
   * @private
   */
  async processAutoCashouts(gameSessionId, currentMultiplier) {
    try {
      // Get all active bets for this session
      const activeBets = await this.redisRepository.getActiveBets(gameSessionId);

      for (const bet of activeBets) {
        try {
          if (bet.autoCashoutEnabled && bet.autoCashoutAt && currentMultiplier >= parseFloat(bet.autoCashoutAt)) {
            // Create cashout request
            const cashoutRequest = {
              betId: bet.id,
              userId: bet.userId,
              multiplier: currentMultiplier
            };

            // Process the auto cashout
            await this.processCashout(cashoutRequest, { user: { user_id: bet.userId } });

            logger.info('Auto cashout processed', {
              betId: bet.id,
              userId: bet.userId,
              targetMultiplier: bet.autoCashoutAt,
              actualMultiplier: currentMultiplier,
              gameSessionId
            });
          }
        } catch (betError) {
          logger.error('Failed to process auto cashout for bet', {
            betId: bet.id,
            userId: bet.userId,
            error: betError.message,
            stack: betError.stack
          });
        }
      }
    } catch (error) {
      logger.error('Failed to process auto cashouts', {
        gameSessionId,
        currentMultiplier,
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Stop auto cashout monitoring for a game session
   * @param {string} gameSessionId - Game session to stop monitoring
   * @private
   */
  async _stopAutoCashoutMonitoring(gameSessionId) {
    try {
      if (this._autoCashoutMonitoring?.[gameSessionId]) {
        clearInterval(this._autoCashoutMonitoring[gameSessionId]);
        delete this._autoCashoutMonitoring[gameSessionId];
        logger.info('Stopped auto cashout monitoring', { gameSessionId });
      }
    } catch (error) {
      logger.error('Failed to stop auto cashout monitoring', {
        gameSessionId,
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Handle game state transitions
   * @param {string} gameSessionId - Game session ID
   * @param {string} newState - New game state
   */
  async handleGameStateTransition(gameSessionId, newState) {
    try {
      logger.info('Game state transition', {
        gameSessionId,
        newState,
        timestamp: new Date().toISOString()
      });

      switch (newState) {
        case 'betting':
          // No clearing needed in betting state
          break;

        case 'flying':
          // Clear placed bets and start monitoring
          await this.redisRepository.clearPlacedBets();
          await this._startAutoCashoutMonitoring(gameSessionId);
          break;
        
        case 'crashed':
          // Stop monitoring and clear active bets
          await this._stopAutoCashoutMonitoring(gameSessionId);
          await this.redisRepository.clearActiveBets(gameSessionId);
          break;
      }

      logger.info('Game state transition completed', {
        gameSessionId,
        newState
      });
    } catch (error) {
      logger.error('GAME_STATE_TRANSITION_ERROR', {
        gameSessionId,
        newState,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Process manual cashout request
   * @param {string} betId - ID of bet to cash out
   * @param {string} userId - User requesting cashout
   * @param {number} currentMultiplier - Current game multiplier
   * @returns {Promise<Object>} Cashout result
   */
  async processCashout(betId, userId, currentMultiplier) {
    try {
      // Get current game session
      const gameService = await this.getGameService();
      const currentGameSession = gameService.getCurrentGameSession();
      
      if (!currentGameSession || !currentGameSession.id) {
        throw new Error('No active game session');
      }

      if (currentGameSession.status !== 'flying') {
        throw new Error('Cashout only available during flying state');
      }

      // Process the cashout
      const result = await this.redisRepository.processManualCashout(
        currentGameSession.id,
        betId,
        currentMultiplier
      );

      // Update wallet balance
      await this.walletService.processCashout(
        userId,
        result.cashoutAmount,
        currentGameSession.id
      );

      // Update stats
      await this.statsService.recordCashout({
        userId,
        betId,
        amount: result.amount,
        cashoutAmount: result.cashoutAmount,
        multiplier: result.multiplier,
        gameSessionId: currentGameSession.id,
        type: 'manual'
      });

      return {
        success: true,
        ...result
      };
    } catch (error) {
      logger.error('CASHOUT_ERROR', {
        betId,
        userId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Process auto cashouts for current game session
   * @param {number} currentMultiplier - Current game multiplier
   * @returns {Promise<Object>} Auto cashout results
   */
  async processAutoCashouts(currentMultiplier) {
    try {
      // Get current game session
      const gameService = await this.getGameService();
      const currentGameSession = gameService.getCurrentGameSession();
      
      if (!currentGameSession || !currentGameSession.id) {
        throw new Error('No active game session');
      }

      // Process auto cashouts
      const results = await this.redisRepository.processAutoCashouts(
        currentGameSession.id,
        currentMultiplier
      );

      // Process successful cashouts
      for (const cashout of results.processed) {
        try {
          // Update wallet balance
          await this.walletService.processCashout(
            cashout.userId,
            cashout.cashoutAmount,
            currentGameSession.id
          );

          // Update stats
          await this.statsService.recordCashout({
            userId: cashout.userId,
            betId: cashout.betId,
            amount: cashout.amount,
            cashoutAmount: cashout.cashoutAmount,
            multiplier: cashout.multiplier,
            gameSessionId: currentGameSession.id,
            type: 'auto'
          });
        } catch (error) {
          logger.error('AUTO_CASHOUT_PROCESSING_ERROR', {
            cashout,
            error: error.message
          });
        }
      }

      return results;
    } catch (error) {
      logger.error('AUTO_CASHOUTS_ERROR', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Manually clear all bets from Redis
   * For testing/maintenance only
   * @returns {Promise<Object>}
   */
  async manualClearAllBets() {
    try {
      await this.redisRepository.manualClearAllBets();
      return {
        success: true,
        message: 'All bets cleared from Redis'
      };
    } catch (error) {
      logger.error('Manual bet clear failed', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Method to store a bet (normal or queued)
   * @param {Object} betDetails - Bet details
   * @param {Boolean} isQueued - Whether the bet is queued or not
   * @returns {Promise<Object>} Stored bet details
   */
  async storeBet(betDetails, isQueued = false) {
    const betId = betDetails.id || uuidv4(); // Generate a new ID if not provided
    const userId = betDetails.userId;
    const betAmount = betDetails.amount;
    const queuedAt = isQueued ? new Date().toISOString() : null;

    // Store the bet in Redis for queued bets
    if (isQueued) {
      await this.redisRepository.queueBetForNextSession({
        id: betId,
        userId: userId,
        amount: betAmount,
        status: 'queued',
        queuedAt: queuedAt
      });
    } else {
      // Logic to store normal bets in the database
      await this.redisRepository.storeBet(betDetails.gameSessionId, betDetails);
    }

    // Log the bet placement
    this.logger.info('BET_PLACED', {
      userId,
      betAmount,
      betId,
      timestamp: new Date().toISOString()
    });

    // Update statistics
    await Promise.all([
      this.statsService.incrementTotalBetsCount(),
      this.statsService.incrementTotalBetAmount(betAmount)
    ]);

    return betId;
  }
}

export default new BetService();
