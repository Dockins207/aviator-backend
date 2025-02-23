import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import ValidationError from '../utils/validationError.js';
import notificationService from './notificationService.js';
import { authService } from './authService.js';
import betTrackingService from '../redis-services/betTrackingService.js';
import redisRepository from '../redis-services/redisRepository.js';
import walletService from './walletService.js';
import statsService from './statsService.js';
import wagerMonitorService from './wagerMonitorService.js';
import gameService from './gameService.js';
import gameRepository from '../repositories/gameRepository.js';
import logger from '../config/logger.js';
import pool from '../config/database.js';
import { BetState } from '../betEnum.js';

class BetService {
  // Game and Bet State Constants
  static BET_STATES = {
    PLACED: BetState.PLACED,
    ACTIVE: BetState.ACTIVE,
    COMPLETE: BetState.CASHED_OUT,
    EXPIRED: BetState.EXPIRED,
    QUEUED: BetState.QUEUED
  };

  static GAME_STATES = {
    BETTING: 'betting',
    FLYING: 'flying',
    CRASHED: 'crashed'
  };

  constructor(
    betTrackingService, 
    redisRepository, 
    walletService, 
    notificationService, 
    authService, 
    statsService, 
    wagerMonitorService,
    gameService,
    gameRepository
  ) { 
    this.betTrackingService = betTrackingService;
    this.notificationService = notificationService;
    this.authService = authService;
    this.redisRepository = redisRepository;
    this.walletService = walletService;
    this.statsService = statsService;
    this.wagerMonitorService = wagerMonitorService; 
    this.gameService = gameService;
    this.gameRepository = gameRepository;

    // Log gameRepository details
    logger.debug('GameRepository instantiated', { gameRepository });

    // Add logger for consistent logging
    this.logger = logger;

    // Assign static constants to instance for easier access
    this.BET_STATES = BetService.BET_STATES;
    this.GAME_STATES = BetService.GAME_STATES;
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
    const currentGameSession = await this.gameService.getCurrentGameSession();

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
          status: this.betTrackingService.BET_STATES.PLACED,
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
      const activationResult = await this.betTrackingService.activateBets(
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
      // MANDATORY Bet Details Validation
      if (!betDetails || !betDetails.userId) {
        logger.error('CRITICAL_BET_DETAILS_VIOLATION', {
          context: 'authenticateUserForBet',
          details: 'Missing user ID in bet details',
          timestamp: new Date().toISOString()
        });
        throw new Error('SECURITY_VIOLATION_MISSING_USER_ID');
      }

      // ABSOLUTE Authentication Context Validation
      const authContexts = [
        req.user,           // HTTP request user
        req.socket?.user,   // Socket connection user
        req.authentication // Additional authentication context
      ];

      const authenticatedUser = authContexts.find(user => user && user.user_id);

      if (!authenticatedUser) {
        logger.error('CRITICAL_AUTHENTICATION_CONTEXT_VIOLATION', {
          context: 'authenticateUserForBet',
          details: 'No valid authentication context found',
          timestamp: new Date().toISOString()
        });
        throw new Error('SECURITY_VIOLATION_NO_AUTHENTICATION_CONTEXT');
      }

      // STRICT User ID Verification
      if (authenticatedUser.user_id !== betDetails.userId) {
        logger.error('CRITICAL_USER_MISMATCH', {
          service: 'aviator-backend',
          requestedUserId: betDetails.userId,
          authenticatedUserId: authenticatedUser.user_id,
          context: 'authenticateUserForBet'
        });
        throw new Error('SECURITY_VIOLATION_USER_ID_MISMATCH');
      }

      // COMPREHENSIVE User Profile Validation
      try {
        const userProfile = await this.authService.getUserProfile(
          authenticatedUser.user_id
        );

        // STRICT Profile Validation
        if (!userProfile) {
          logger.error('CRITICAL_USER_PROFILE_NOT_FOUND', {
            userId: authenticatedUser.user_id,
            context: 'authenticateUserForBet'
          });
          throw new Error('SECURITY_VIOLATION_USER_PROFILE_NOT_FOUND');
        }

        // Additional Profile Security Checks
        const REQUIRED_PROFILE_FIELDS = [
          'is_active', 
          'role', 
          'username', 
          'wallet.balance'
        ];

        for (const field of REQUIRED_PROFILE_FIELDS) {
          const fieldParts = field.split('.');
          let value = userProfile;
          
          for (const part of fieldParts) {
            value = value?.[part];
          }

          if (value === undefined || value === null) {
            logger.error('CRITICAL_USER_PROFILE_FIELD_MISSING', {
              missingField: field,
              userId: authenticatedUser.user_id,
              context: 'authenticateUserForBet'
            });
            throw new Error(`SECURITY_VIOLATION_MISSING_PROFILE_FIELD_${field.toUpperCase()}`);
          }
        }

        // Verify User Account Status
        if (!userProfile.is_active) {
          logger.error('CRITICAL_USER_ACCOUNT_INACTIVE', {
            userId: authenticatedUser.user_id,
            context: 'authenticateUserForBet'
          });
          throw new Error('SECURITY_VIOLATION_INACTIVE_USER_ACCOUNT');
        }

        // Log successful authentication with expanded context
        logger.info('USER_AUTHENTICATION_VERIFIED', {
          userId: authenticatedUser.user_id,
          username: userProfile.username,
          timestamp: new Date().toISOString()
        });

        return {
          user: {
            ...authenticatedUser,
            ...userProfile
          }
        };

      } catch (profileValidationError) {
        logger.error('CRITICAL_USER_PROFILE_VALIDATION_FAILED', {
          userId: authenticatedUser.user_id,
          errorMessage: profileValidationError.message,
          context: 'authenticateUserForBet'
        });
        throw new Error('SECURITY_VIOLATION_USER_PROFILE_VALIDATION_FAILED');
      }
    } catch (error) {
      logger.error('AUTHENTICATION_FAILED', {
        errorMessage: error.message,
        context: 'authenticateUserForBet'
      });
      throw error;
    }
  }

  /**
   * Validate bet details before placement
   * @param {Object} betDetails - Details of the bet to be validated
   * @throws {ValidationError} If bet details are invalid
   * @returns {Object} Validated user ID and bet amount
   */
  validateBetData(betDetails) {
    // Log incoming bet details for debugging
    this.logger.debug('VALIDATING_BET_DETAILS', {
      service: 'aviator-backend',
      context: 'validateBetData',
      betDetailsKeys: Object.keys(betDetails)
    });

    // Validate bet amount
    const betAmount = betDetails.amount || betDetails.betAmount;
    if (!betAmount || typeof betAmount !== 'number' || betAmount <= 0) {
      throw new ValidationError('INVALID_BET_AMOUNT', 
        'Bet amount must be a positive number'
      );
    }

    // Validate auto-cashout settings if enabled
    let autoCashoutEnabled = false;
    let autoCashoutMultiplier = null;

    if (betDetails.autoCashoutEnabled) {
      autoCashoutEnabled = true;

      // Validate auto-cashout multiplier if enabled
      if (typeof betDetails.autoCashoutMultiplier !== 'number' || betDetails.autoCashoutMultiplier <= 1.0) {
        throw new ValidationError('INVALID_AUTO_CASHOUT_MULTIPLIER', 
          'Auto-cashout multiplier must be a number greater than 1.0'
        );
      }
      autoCashoutMultiplier = betDetails.autoCashoutMultiplier;
    }

    // Return validated bet details
    return {
      // Only include userId if it exists in betDetails
      ...(betDetails.userId && { userId: betDetails.userId }),
      amount: betAmount,
      autoCashoutEnabled,
      autoCashoutMultiplier,
      // Preserve any additional bet details
      ...betDetails
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
  async placeBet(betDetails, req = {}, cashoutStrategy = 'default') {
    try {
      // Extract authenticated user context
      const socketUser = req.socketUser || 
        (req.socket && req.socket.user) || 
        (req.user) || 
        null;

      if (!socketUser) {
        throw new ValidationError('AUTHENTICATION_REQUIRED', 
          'Valid authenticated user context is required for bet placement'
        );
      }

      // Extract user ID
      const userId = socketUser.user_id || 
        socketUser.userId || 
        socketUser.id;

      if (!userId) {
        throw new ValidationError('INVALID_USER_CONTEXT', 
          'Unable to extract user ID from authentication context'
        );
      }

      // Log incoming bet data for debugging
      this.logger.warn('INCOMING_BET_DATA_DIAGNOSTIC', {
        service: 'aviator-backend',
        fullBetData: JSON.stringify(betDetails),
        betDataKeys: Object.keys(betDetails),
        socketUserId: userId,
        socketUsername: socketUser.username,
        socketId: req.socket?.id
      });

      // Log raw auto cashout data
      this.logger.warn('RAW_AUTO_CASHOUT_DATA', {
        service: 'aviator-backend',
        rawEnabled: betDetails.autoCashoutEnabled,
        rawEnabledType: typeof betDetails.autoCashoutEnabled,
        rawEnabledStringified: JSON.stringify(betDetails.autoCashoutEnabled),
        rawMultiplier: betDetails.autoCashoutMultiplier,
        rawMultiplierType: typeof betDetails.autoCashoutMultiplier,
        fullBetDetails: betDetails
      });

      // Normalize auto cashout fields
      const autoCashoutEnabled = Boolean(betDetails.autoCashoutEnabled);
      const autoCashoutMultiplier = autoCashoutEnabled ? Number(betDetails.autoCashoutMultiplier) : undefined;

      this.logger.warn('AUTO_CASHOUT_VALIDATION', {
        service: 'aviator-backend',
        fieldChecks: {
          hasMultiplier,
          multiplierValue,
          autoCashoutEnabled: betDetails.autoCashoutEnabled
        },
        valueChecks: {
          rawMultiplier: betDetails.cashoutMultiplier,
          rawEnabled: betDetails.autoCashoutEnabled,
          finalEnabled: autoCashoutEnabled
        }
      });

      const validatedBetDetails = {
        amount: Number(betDetails.amount),
        userId,
        autoCashoutEnabled,
        autoCashoutMultiplier
      };

      // Validate auto cashout settings if enabled
      if (validatedBetDetails.autoCashoutEnabled) {
        if (!validatedBetDetails.autoCashoutMultiplier || validatedBetDetails.autoCashoutMultiplier <= 1.0) {
          throw new ValidationError('INVALID_AUTO_CASHOUT', 'Auto cashout multiplier must be greater than 1.0');
        }
      }

      // Log normalized auto cashout data
      this.logger.warn('NORMALIZED_AUTO_CASHOUT_DATA', {
        service: 'aviator-backend',
        normalizedEnabled: validatedBetDetails.autoCashoutEnabled,
        normalizedEnabledType: typeof validatedBetDetails.autoCashoutEnabled,
        normalizedMultiplier: validatedBetDetails.autoCashoutMultiplier,
        normalizedMultiplierType: typeof validatedBetDetails.autoCashoutMultiplier,
        fullValidatedDetails: validatedBetDetails
      });

      // Log normalized bet data
      this.logger.debug('NORMALIZED_BET_DATA', {
        service: 'aviator-backend',
        originalBet: betDetails,
        normalizedBet: validatedBetDetails
      });

      // Get current game state
      const currentGameSession = await this.gameService.getCurrentGameState();

      // Prepare full bet details
      const fullBetDetails = {
        ...validatedBetDetails,
        userId,
        gameSessionId: currentGameSession.gameId
      };

      const authenticatedUser = { 
        user_id: userId,
        username: socketUser.username || 'Unknown',
        role: socketUser.role || 'user'
      };

      // Ensure bet details has user ID
      fullBetDetails.userId = authenticatedUser.user_id;
      fullBetDetails.user = authenticatedUser;

      // Handle bets based on game state
      switch (currentGameSession.state) {
        case this.GAME_STATES.BETTING:
          return await this.placeBetInBettingState(fullBetDetails, authenticatedUser);

        case this.GAME_STATES.FLYING:
        case this.GAME_STATES.CRASHED:
          return await this.handleBetInNonBettingState(
            fullBetDetails, 
            authenticatedUser, 
            cashoutStrategy
          );

        default:
          throw new ValidationError('INVALID_GAME_STATE', 
            `Cannot place bets in ${currentGameSession.state} state`
          );
      }
    } catch (error) {
      this.logger.error('BET_PLACEMENT_ERROR', {
        userId,
        gameState: currentGameSession?.state,
        errorMessage: error.message,
        errorStack: error.stack,
        betDetails: {
          amount: betDetails.amount
        }
      });
      
      throw error;
    }
  }

  // Helper method to normalize bet details consistently across the service
  _normalizeBetDetails(betDetails, authenticatedUser, gameSessionId, status = this.BET_STATES.PLACED) {
    // Log incoming auto cashout data
    this.logger.debug('NORMALIZE_INCOMING_AUTO_CASHOUT', {
      service: 'aviator-backend',
      rawEnabled: betDetails.autoCashoutEnabled,
      rawEnabledType: typeof betDetails.autoCashoutEnabled,
      rawMultiplier: betDetails.autoCashoutMultiplier,
      rawMultiplierType: typeof betDetails.autoCashoutMultiplier
    });

    // Normalize auto cashout fields
    const autoCashoutEnabled = Boolean(betDetails.autoCashoutEnabled);
    let autoCashoutMultiplier = undefined;
    
    if (autoCashoutEnabled) {
      autoCashoutMultiplier = Number(betDetails.autoCashoutMultiplier);
      // Validate multiplier when auto cashout is enabled
      if (!autoCashoutMultiplier || autoCashoutMultiplier <= 1.0) {
        throw new ValidationError('INVALID_AUTO_CASHOUT', 'Auto cashout multiplier must be greater than 1.0');
      }
    }

    // Log normalized auto cashout data
    this.logger.debug('NORMALIZE_FINAL_AUTO_CASHOUT', {
      service: 'aviator-backend',
      normalizedEnabled: autoCashoutEnabled,
      normalizedEnabledType: typeof autoCashoutEnabled,
      normalizedMultiplier: autoCashoutMultiplier,
      normalizedMultiplierType: typeof autoCashoutMultiplier
    });
    
    this.logger.debug('NORMALIZING_BET_DETAILS', {
      service: 'aviator-backend',
      betId: betDetails.id,
      userId: authenticatedUser.user_id,
      autoCashoutEnabled,
      autoCashoutMultiplier,
      gameSessionId
    });

    return {
      id: betDetails.id || uuidv4(),
      userId: authenticatedUser.user_id,
      username: authenticatedUser.username || 'Unknown',
      role: authenticatedUser.role || 'user',
      amount: parseFloat(betDetails.amount),
      autoCashoutEnabled,
      autoCashoutMultiplier,
      gameSessionId,
      status,
      createdAt: new Date().toISOString()
    };
  }

  async handleBetInNonBettingState(betDetails, authenticatedUser, cashoutStrategy = 'default') {
    try {
      // Get current game state with strict validation
      const currentGameSession = await this.gameService.getCurrentGameState();
      
      // Log game state for debugging
      this.logger.debug('CURRENT_GAME_STATE', {
        service: 'aviator-backend',
        gameState: currentGameSession.state,
        gameId: currentGameSession.gameId,
        timestamp: new Date().toISOString()
      });

      // Validate game state allows queueing
      if (!currentGameSession || 
          ![this.GAME_STATES.FLYING, this.GAME_STATES.CRASHED].includes(currentGameSession.state)) {
        throw new ValidationError('INVALID_GAME_STATE', 
          `Cannot queue bets in ${currentGameSession?.state || 'unknown'} state`
        );
      }

      // Validate wallet balance before proceeding
      const currentBalance = await this.walletService.getWalletBalance(authenticatedUser.user_id);
      if (currentBalance < betDetails.amount) {
        throw new ValidationError('INSUFFICIENT_BALANCE', {
          message: 'Insufficient wallet balance for bet',
          currentBalance,
          requiredAmount: betDetails.amount
        });
      }

      // Log bet queueing attempt
      this.logger.info('QUEUEING_BET_FOR_NEXT_SESSION', {
        userId: authenticatedUser.user_id,
        gameState: currentGameSession.state,
        gameId: currentGameSession.gameId,
        betAmount: betDetails.amount,
        cashoutStrategy
      });

      try {
        // Use normalized bet details
        const normalizedBet = this._normalizeBetDetails(betDetails, authenticatedUser, currentGameSession.gameId, this.BET_STATES.QUEUED);
        const queuedBet = {
          ...normalizedBet,
          state: this.BET_STATES.QUEUED,
          queuedAt: Date.now(),
          cashoutStrategy
        };

        this.logger.debug('PROCESSING_QUEUED_BET', {
          betId: queuedBet.id,
          queuedBet
        });

        // Queue bet for next session using the dedicated method
        const queueResult = await this.redisRepository.queueBetForNextSession(
          queuedBet,
          currentGameSession.gameId
        );

        // If Redis operations succeed, deduct wallet
        await this.walletService.deductWalletBalance(
          authenticatedUser.user_id, 
          betDetails.amount
        );

        this.logger.info('BET_QUEUED_SUCCESSFULLY', {
          betId: queueResult.betId,
          userId: authenticatedUser.user_id,
          gameState: currentGameSession.state,
          queuedAt: queueResult.queuedAt,
          sessionId: queueResult.sessionId
        });

        return {
          ...queuedBet,
          id: queueResult.betId,
          queuedAt: queueResult.queuedAt
        };
      } catch (error) {
        // Log queueing failure with detailed error info
        this.logger.error('BET_QUEUEING_FAILED', {
          userId: authenticatedUser.user_id,
          error: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString()
        });

        throw error;
      }
    } catch (error) {
      // Log error with detailed context
      this.logger.error('BET_QUEUEING_ERROR', {
        userId: authenticatedUser.user_id,
        gameState: currentGameSession?.state,
        errorMessage: error.message,
        errorStack: error.stack,
        betDetails: {
          amount: betDetails.amount
        }
      });
      
      throw error;
    }
  }

  async placeBetInBettingState(betDetails, authenticatedUser) {
    try {
      // Get current game state with strict validation
      const currentGameSession = await this.gameService.getCurrentGameState();
      
      // Log game state for debugging
      this.logger.debug('CURRENT_GAME_STATE', {
        service: 'aviator-backend',
        gameState: currentGameSession.state,
        gameId: currentGameSession.gameId,
        timestamp: new Date().toISOString()
      });

      // Validate game state allows betting
      if (!currentGameSession || currentGameSession.state !== this.GAME_STATES.BETTING) {
        throw new ValidationError('INVALID_GAME_STATE', 
          `Cannot place bets in ${currentGameSession?.state || 'unknown'} state`
        );
      }

      // Step 1: Create normalized bet details
      const normalizedBet = this._normalizeBetDetails(
        betDetails,
        authenticatedUser,
        currentGameSession.gameId,
        this.BET_STATES.ACTIVE
      );

      // Step 2: Store bet in Redis with ACTIVE state
      const activeBet = await this.redisRepository.storeBet(
        currentGameSession.gameId,
        normalizedBet
      );

      // Step 3: Deduct wallet balance after successful bet storage
      await this.walletService.deductWalletBalance(
        authenticatedUser.user_id, 
        betDetails.amount
      );

      // Log successful activation
      this.logger.info('BET_ACTIVATED_SUCCESSFULLY', {
        betId: activeBet.id,
        userId: authenticatedUser.user_id,
        gameState: currentGameSession.state,
        activatedAt: new Date().toISOString(),
        sessionId: currentGameSession.gameId
      });

      return activeBet;
    } catch (error) {
      // Log error with detailed context
      this.logger.error('BET_PLACEMENT_ERROR', {
        userId: authenticatedUser.user_id,
        gameState: currentGameSession?.state,
        errorMessage: error.message,
        errorStack: error.stack,
        betDetails: {
          amount: betDetails.amount
        }
      });
      throw error;
    }
  }

  async placeBetInBettingState(betDetails, authenticatedUser) {
    let transactionSuccessful = false;
    let walletUpdated = false;
    let betStored = false;
    let betId = null;

    try {
      // Get current game state with strict validation
      const currentGameSession = await this.gameService.getCurrentGameState();
      
      // Log game state for debugging
      this.logger.debug('CURRENT_GAME_STATE', {
        service: 'aviator-backend',
        gameState: currentGameSession.state,
        gameId: currentGameSession.gameId,
        timestamp: new Date().toISOString()
      });

      // Double-check game state before proceeding
      if (currentGameSession.state !== this.GAME_STATES.BETTING) {
        this.logger.warn('GAME_STATE_CHANGED_DURING_BET', {
          expectedState: this.GAME_STATES.BETTING,
          actualState: currentGameSession.state,
          gameId: currentGameSession.gameId
        });
        return await this.handleBetInNonBettingState(betDetails, authenticatedUser);
      }

      // Use normalized bet details
      const normalizedBetDetails = this._normalizeBetDetails(betDetails, authenticatedUser, currentGameSession.gameId, this.BET_STATES.PLACED);
      
      this.logger.debug('AUTO_CASHOUT_FIELDS', {
        received: betDetails,
        normalized: {
          autoCashoutEnabled: normalizedBetDetails.autoCashoutEnabled,
          autoCashoutMultiplier: normalizedBetDetails.autoCashoutMultiplier
        }
      });

      this.logger.debug('PROCESSING_BET_PLACEMENT', {
        betId: normalizedBetDetails.id,
        normalizedBetDetails
      });

      // Step 1: Validate wallet balance before proceeding
      const currentBalance = await this.walletService.getWalletBalance(authenticatedUser.user_id);
      if (currentBalance < betDetails.amount) {
        throw new ValidationError('INSUFFICIENT_BALANCE', {
          message: 'Insufficient wallet balance for bet',
          currentBalance,
          requiredAmount: betDetails.amount
        });
      }

      // Step 2: Deduct wallet balance first (this is atomic and will rollback if failed)
      await this.walletService.deductWalletBalance(
        authenticatedUser.user_id, 
        betDetails.amount
      );
      walletUpdated = true;

      // Step 3: Store bet as ACTIVE immediately in betting state
      try {
        // Use normalized bet details with active state
        const activeBet = {
          ...normalizedBetDetails,
          state: 'active',
          activatedAt: Date.now()
        };
        
        this.logger.debug('STORING_ACTIVE_BET', {
          betId: activeBet.id,
          activeBet,
          gameId: currentGameSession.gameId
        });

        // Store bet in Redis first
        await this.redisRepository.hset(`bet:${activeBet.id}`, activeBet);
        await this.redisRepository.sadd(`game:${currentGameSession.gameId}:activeBets`, activeBet.id);
        betStored = true;
        
        this.logger.info('BET_PLACED_AND_ACTIVATED', {
          betId: activeBet.id,
          userId: authenticatedUser.user_id,
          amount: betDetails.amount,
          gameId: currentGameSession.gameId,
          autoCashoutEnabled: activeBet.autoCashoutEnabled,
          autoCashoutMultiplier: activeBet.autoCashoutMultiplier
        });
        
        return activeBet;
        
      } catch (storageError) {
        this.logger.error('BET_STORAGE_FAILED', {
          error: storageError.message,
          stack: storageError.stack,
          betId: normalizedBetDetails?.id,
          userId: authenticatedUser.user_id,
          gameId: currentGameSession.gameId
        });
        // If storage fails, refund the wallet
        try {
          await this.walletService.creditWalletBalance(
            authenticatedUser.user_id,
            betDetails.amount,
            'Bet storage failed - automatic refund'
          );
          this.logger.info('WALLET_REFUNDED_AFTER_STORAGE_FAILURE', {
            userId: authenticatedUser.user_id,
            betId: normalizedBetDetails?.id,
            amount: betDetails.amount,
            gameId: currentGameSession.gameId
          });
        } catch (refundError) {
          this.logger.error('WALLET_REFUND_FAILED', {
            userId: authenticatedUser.user_id,
            betId: normalizedBetDetails?.id,
            amount: betDetails.amount,
            gameId: currentGameSession.gameId,
            error: refundError.message
          });
        }
        throw new Error('Failed to store bet - wallet refunded');
      }

      // This line should never be reached as we return inside the try block
      throw new Error('Unexpected code path in bet placement');

    } catch (error) {
      this.logger.error('BET_PLACEMENT_ERROR', {
        userId: authenticatedUser.user_id,
        betId,
        walletUpdated,
        betStored,
        error: error.message,
        stack: error.stack
      });

      // Attempt to rollback changes if needed
      if (walletUpdated && !betStored) {
        try {
          // Refund the wallet if we deducted but failed to store bet
          await this.walletService.creditWalletBalance(
            authenticatedUser.user_id,
            betDetails.amount,
            'Bet placement rollback'
          );
          this.logger.info('WALLET_ROLLBACK_SUCCESSFUL', {
            userId: authenticatedUser.user_id,
            betId,
            amount: betDetails.amount
          });
        } catch (rollbackError) {
          this.logger.error('WALLET_ROLLBACK_FAILED', {
            userId: authenticatedUser.user_id,
            betId,
            amount: betDetails.amount,
            error: rollbackError.message
          });
        }
      }

      throw error;
    }
  }

  /**
   * Handle game state transitions and manage bet states
   * @param {string} gameId - Game session identifier
   * @param {string} newState - New game state
   * @returns {Promise<Object>} State transition results
   */
  async handleGameStateTransition(gameId, newState) {
    try {
      this.logger.info('GAME_STATE_TRANSITION', {
        gameId,
        newState,
        timestamp: new Date().toISOString()
      });

      switch (newState) {
        case this.GAME_STATES.BETTING:
          return await this.handleBettingStateStart(gameId);
        
        case this.GAME_STATES.FLYING:
          return await this.handleFlyingStateStart(gameId);
        
        case this.GAME_STATES.CRASHED:
          return await this.handleGameCrash(gameId);
        
        default:
          this.logger.warn('UNHANDLED_GAME_STATE', {
            gameId,
            state: newState
          });
          return { handled: false, state: newState };
      }
    } catch (error) {
      this.logger.error('GAME_STATE_TRANSITION_ERROR', {
        gameId,
        newState,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Handle the start of betting state
   * @param {string} gameId - Game session identifier
   * @returns {Promise<Object>} Betting state initialization results
   */
  async handleBettingStateStart(gameId) {
    try {
      // Step 1: Activate all queued bets from previous session
      const activationResults = await this.redisRepository.bulkActivateQueuedBets(gameId);
      
      // Step 2: Process successful activations
      if (activationResults.success.length > 0) {
        // Update user stats and send notifications in parallel
        const updatePromises = activationResults.success.map(async (bet) => {
          try {
            // Update user betting stats
            await this.statsService.updateUserBettingStats(bet.userId, {
              activeBetsCount: 1,
              lastBetTime: new Date().toISOString()
            });

            // Send notification to user
            await this.notificationService.notifyUser(bet.userId, {
              type: 'BET_ACTIVATED',
              data: {
                betId: bet.id,
                gameId,
                amount: bet.amount,
                timestamp: new Date().toISOString()
              }
            });
          } catch (error) {
            this.logger.error('BET_ACTIVATION_UPDATE_ERROR', {
              betId: bet.id,
              userId: bet.userId,
              error: error.message
            });
          }
        });

        // Wait for all updates to complete
        await Promise.allSettled(updatePromises);
      }

      // Step 3: Handle failed activations
      if (activationResults.failed.length > 0) {
        this.logger.error('QUEUED_BETS_ACTIVATION_FAILURES', {
          gameId,
          failedBets: activationResults.failed
        });

        // Attempt to refund failed bets
        const refundPromises = activationResults.failed.map(async (bet) => {
          try {
            await this.walletService.refundFailedBet(bet.userId, bet.amount);
            this.logger.info('FAILED_BET_REFUNDED', {
              betId: bet.id,
              userId: bet.userId,
              amount: bet.amount
            });
          } catch (refundError) {
            this.logger.error('BET_REFUND_FAILED', {
              betId: bet.id,
              userId: bet.userId,
              amount: bet.amount,
              error: refundError.message
            });
          }
        });

        await Promise.allSettled(refundPromises);
      }

      // Log final results
      this.logger.info('BETTING_STATE_INITIALIZATION_COMPLETE', {
        gameId,
        activatedBets: activationResults.success.length,
        failedBets: activationResults.failed.length,
        timestamp: new Date().toISOString()
      });

      return {
        handled: true,
        state: this.GAME_STATES.BETTING,
        results: activationResults
      };
    } catch (error) {
      this.logger.error('BETTING_STATE_INITIALIZATION_ERROR', {
        gameId,
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

export default new BetService(
  betTrackingService,
  redisRepository,
  walletService,
  notificationService,
  authService,
  statsService,
  wagerMonitorService,
  gameService,
  gameRepository);
