import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import ValidationError from '../utils/validationError.js';
import notificationService from './notificationService.js';
import { authService } from './authService.js';
import gameService from './gameService.js';
import redisRepository from '../redis-services/redisRepository.js';
import walletService from './walletService.js';
import logger from '../config/logger.js';
import pool from '../config/database.js';
import GameRepository from '../repositories/gameRepository.js';
import WalletRepository from '../repositories/walletRepository.js';
import { PlayerBetRepository } from '../repositories/playerBetRepository.js';
import betTrackingService from '../redis-services/betTrackingService.js';
import gameUtils from '../utils/gameUtils.js';
import { formatCurrency } from '../utils/gameUtils.js';

class BetService {
  constructor(betTrackingService, redisRepository, walletService, notificationService, gameService, authService, playerBetRepository) {
    this.betTrackingService = betTrackingService;
    this.notificationService = notificationService;
    this.gameService = gameService;
    this.authService = authService;
    this.redisRepository = redisRepository;
    this.walletService = walletService;
    this.playerBetRepository = playerBetRepository;
  }

  /**
   * Validate and authenticate user before placing bet
   * @param {Object} betDetails - Bet details 
   * @param {Object} req - Express request object containing user
   * @returns {Object} Authenticated user details
   */
  async authenticateUserForBet(betDetails, req = {}) {
    const { userId } = betDetails;

    // Support both Express req and socket authentication
    const user = req.user || req.socket?.user;

    if (!user || !userId) {
      logger.error('USER_AUTHENTICATION_FAILED', {
        message: 'User authentication failed',
        hasUser: !!user,
        hasUserId: !!userId,
        requestType: req.socket ? 'socket' : 'http'
      });

      throw new ValidationError('UNAUTHORIZED', {
        message: 'User must be authenticated to place a bet'
      });
    }

    // Verify user matches the authenticated user
    if (user.id !== userId && user.user_id !== userId) {
      logger.warn('USER_ID_MISMATCH', {
        providedUserId: userId,
        authenticatedUserId: user.id || user.user_id
      });
      throw new ValidationError('UNAUTHORIZED', {
        message: 'User ID mismatch'
      });
    }

    // Additional user profile validation
    try {
      const userProfile = await this.authService.getUserProfile(userId);
      
      if (!userProfile) {
        throw new ValidationError('USER_NOT_FOUND', {
          message: 'User profile not found',
          userId
        });
      }

      if (!userProfile.is_active) {
        throw new ValidationError('USER_INACTIVE', {
          message: 'User account is not active',
          userId
        });
      }

      return userProfile;
    } catch (error) {
      logger.error('USER_PROFILE_RETRIEVAL_ERROR', {
        userId,
        errorMessage: error.message
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
    // Log incoming bet details for audit trail
    logger.info('BET_DETAILS_VALIDATION', {
      incomingBetDetails: JSON.stringify(betDetails)
    });

    // Destructure and validate user from request
    const user = betDetails.user;
    if (!user || !user.id) {
      logger.error('BET_VALIDATION_USER_MISSING', {
        message: 'User authentication failed',
        betDetails: JSON.stringify(betDetails)
      });
      
      throw new ValidationError('USER_AUTHENTICATION_FAILED', {
        message: 'User must be authenticated to place a bet',
        details: 'No valid user found in bet details'
      });
    }

    // Validate bet amount (support both 'amount' and 'betAmount')
    const betAmount = parseFloat(betDetails.betAmount || betDetails.amount);
    if (isNaN(betAmount) || betAmount <= 0) {
      logger.error('BET_VALIDATION_AMOUNT_INVALID', {
        message: 'Invalid bet amount',
        providedAmount: betDetails.betAmount || betDetails.amount
      });
      
      throw new ValidationError('INVALID_BET_AMOUNT', {
        message: 'Bet amount must be a positive number',
        details: `Provided amount: ${betDetails.betAmount || betDetails.amount}`
      });
    }

    // Reject any client-provided game session ID
    if (betDetails.gameSessionId) {
      logger.warn('CLIENT_GAME_SESSION_ID_REJECTED', {
        message: 'Client-provided game session ID is not allowed',
        providedGameSessionId: betDetails.gameSessionId
      });
    }

    // Return validated user ID and bet amount
    return {
      userId: user.id,
      betAmount: betAmount
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
        logger.error('WALLET_NOT_FOUND', {
          userId,
          message: 'No wallet found for the user'
        });
        throw new ValidationError('WALLET_NOT_FOUND', {
          message: 'User wallet does not exist',
          userId
        });
      }

      return walletResult.rows[0].wallet_id;
    } catch (error) {
      logger.error('WALLET_ID_RETRIEVAL_ERROR', {
        userId,
        errorMessage: error.message
      });
      throw error;
    }
  }

  /**
   * Validate game state for bet placement
   * @param {Object} gameState - Current game state
   * @throws {ValidationError} If bet is not allowed in current game state
   */
  validateGameStateForBet(gameState) {
    // Define invalid bet placement states
    const INVALID_BET_STATES = ['flying', 'crashed'];

    // Strict game state validation
    if (!gameState || INVALID_BET_STATES.includes(gameState.status)) {
      logger.warn('BET_PLACEMENT_INVALID_GAME_STATE', {
        currentGameState: gameState ? gameState.status : 'undefined',
        message: 'Bet not allowed in current game state',
        invalidStates: INVALID_BET_STATES
      });

      throw new ValidationError('INVALID_GAME_STATE', {
        message: 'Bet can only be placed during betting phase',
        currentGameState: gameState ? gameState.status : 'undefined',
        allowedState: 'betting'
      });
    }

    // Optional: Add additional validation like countdown time remaining
    if (gameState.status === 'betting' && gameState.countdown <= 0) {
      logger.warn('BET_PLACEMENT_COUNTDOWN_EXPIRED', {
        countdown: gameState.countdown,
        message: 'Bet placement window has closed'
      });

      throw new ValidationError('BET_WINDOW_CLOSED', {
        message: 'Betting window has closed',
        countdown: gameState.countdown
      });
    }
  }

  /**
   * Place a bet with user authentication, game ID, and unique bet ID
   * @param {Object} betDetails - Details of the bet to be placed
   * @param {Object} req - Express request object
   * @returns {Object} Placed bet with unique identifiers
   */
  async placeBet(betDetails, req) {
    // Log incoming bet placement request
    logger.info('BET_PLACEMENT_REQUEST', {
      betDetails: JSON.stringify(betDetails),
      requestUser: req?.user ? JSON.stringify(Object.keys(req.user)) : 'No user object'
    });

    // Get current game state
    const currentGameState = this.gameService.gameState;

    // Validate game state before processing bet
    this.validateGameStateForBet(currentGameState);

    // Validate bet details and get normalized bet amount and user ID
    const { userId, betAmount } = this.validateBetData({
      ...betDetails,
      user: req?.user
    });

    // Authenticate user using request object
    const authenticatedUser = await this.authenticateUserForBet(
      { userId, betAmount }, 
      req
    );

    // Retrieve wallet ID for the user
    const walletId = await this._getWalletIdForUser(userId);

    // Generate unique bet ID
    const betId = uuidv4();

    // Use ONLY the game ID from game service
    const gameSessionId = currentGameState.gameId;

    // Attempt to place bet in bet tracking service
    const placedBet = this.betTrackingService.placeBet({
      betId,
      userId,
      gameSessionId,
      betAmount,
      betDataType: typeof betAmount,
      betDataValue: betAmount
    });

    // Debit wallet for bet amount using the correct method
    const walletDebitResult = await this.walletService.placeBet(
      userId, 
      betAmount, 
      walletId
    );

    // Log successful bet placement
    logger.info('WALLET_BET_PLACED', {
      userId,
      betAmount,
      gameId: gameSessionId,
      newBalance: walletDebitResult.newBalance,
      walletId
    });

    // Broadcast bet placement event
    this.notificationService.broadcastNotification('bet_placed', {
      userId,
      betAmount,
      gameSessionId,
      betId: placedBet.betId
    });

    // Return comprehensive bet placement result
    return {
      success: true,
      betId: placedBet.betId,
      userId,
      gameSessionId,
      betAmount,
      newBalance: walletDebitResult.newBalance
    };
  }

  /**
   * Validate user for cashout
   * @param {Object} req - Express request object
   * @returns {Object} Validated user details
   */
  async _validateUserForCashout(req) {
    // Extract user from authenticated request
    const userId = req.user?.user_id || req.user?.userId;
    
    if (!userId) {
      throw new ValidationError('UNAUTHORIZED', {
        message: 'User authentication required'
      });
    }

    // Fetch user profile with additional validation
    try {
      const userProfile = await this.authService.getUserProfile(userId);
      
      // Additional user validation checks
      if (!userProfile) {
        throw new ValidationError('USER_NOT_FOUND', {
          message: 'User profile not found',
          userId
        });
      }

      if (!userProfile.is_active) {
        throw new ValidationError('USER_INACTIVE', {
          message: 'User account is not active',
          userId
        });
      }

      return {
        userId,
        username: userProfile.username,
        role: userProfile.role
      };
    } catch (error) {
      logger.error('USER_VALIDATION_ERROR', {
        errorMessage: error.message,
        userId
      });
      throw error;
    }
  }

  /**
   * Validate bet for cashout
   * @param {string} userId - User ID
   * @param {string} gameSessionId - Current game session ID
   * @returns {Object} Validated active bet
   */
  async _validateBetForCashout(userId, gameSessionId) {
    // Retrieve active bets for the user in current game session
    const activeBets = await this.betTrackingService.getUserActiveBets(
      userId, 
      gameSessionId
    );

    // Validate active bets exist
    if (!activeBets || activeBets.length === 0) {
      throw new ValidationError('NO_ACTIVE_BETS', {
        message: 'No active bets found for the current game',
        userId,
        gameSessionId
      });
    }

    // If multiple active bets, implement selection logic
    if (activeBets.length > 1) {
      logger.warn('MULTIPLE_ACTIVE_BETS', {
        userId,
        gameSessionId,
        activeBetCount: activeBets.length
      });
    }

    // Select the first active bet (can be enhanced with more sophisticated selection)
    const activeBet = activeBets[0];

    // Additional bet validation
    if (!activeBet.betAmount || activeBet.betAmount <= 0) {
      throw new ValidationError('INVALID_BET_AMOUNT', {
        message: 'Invalid bet amount',
        betId: activeBet.id,
        betAmount: activeBet.betAmount
      });
    }

    return activeBet;
  }

  /**
   * Cash out a bet during the flying phase
   * @param {Object} req - Express request object
   * @param {number} multiplier - Cashout multiplier
   * @returns {Object} Cashout result
   */
  async cashOut(req, multiplier) {
    // Validate multiplier
    if (!multiplier || multiplier <= 0) {
      throw new ValidationError('INVALID_MULTIPLIER', {
        message: 'Invalid cashout multiplier',
        multiplier
      });
    }

    // Validate user
    const { userId, username } = await this._validateUserForCashout(req);

    // Retrieve wallet ID for the user
    const walletId = await this._getWalletIdForUser(userId);

    // Retrieve current game state
    const currentGameState = this.gameService.gameState;

    // STRICT VALIDATION: Cashout ONLY during flying phase
    if (currentGameState.status !== 'flying') {
      throw new ValidationError('INVALID_CASHOUT_PHASE', {
        message: 'Cashout is ONLY allowed during flying phase',
        currentGameStatus: currentGameState.status
      });
    }

    // Validate cashout multiplier
    const currentMultiplier = currentGameState.multiplier;
    if (!this._validateCashoutMultiplier(currentMultiplier, multiplier)) {
      throw new ValidationError('INVALID_CASHOUT_MULTIPLIER', {
        message: 'Invalid cashout multiplier',
        currentMultiplier,
        requestedMultiplier: multiplier
      });
    }

    // Retrieve active bets for the user
    const activeBets = await this.betTrackingService.getUserActiveBets(
      userId, 
      currentGameState.gameId
    );

    // STRICT VALIDATION: Only allow cashout of active bets
    const cashoutEligibleBets = activeBets.filter(
      bet => bet.status === this.betTrackingService.BET_STATES.ACTIVE
    );

    if (cashoutEligibleBets.length === 0) {
      throw new ValidationError('NO_ACTIVE_BETS', {
        message: 'No active bets available for cashout',
        userId,
        gameSessionId: currentGameState.gameId,
        activeBetsCount: activeBets.length
      });
    }

    // If multiple active bets, use the first one
    const activeBet = cashoutEligibleBets[0];

    // Calculate winnings
    const winnings = activeBet.betAmount * multiplier;

    // Credit wallet for cashout
    try {
      const cashoutResult = await this.walletService.processWinnings(
        userId, 
        winnings, 
        currentGameState.gameId
      );
    } catch (walletError) {
      logger.error('CASHOUT_WALLET_CREDIT_ERROR', {
        userId,
        walletId,
        winnings,
        errorMessage: walletError.message
      });
      throw new ValidationError('WALLET_CREDIT_FAILED', {
        message: 'Failed to credit wallet',
        details: walletError.message
      });
    }

    // Get wallet details for precise balance tracking
    const walletDetails = await this.walletService.getWallet(userId);

    // Prepare comprehensive wallet update payload
    const walletUpdatePayload = {
      userId: userId,
      walletId: walletDetails.wallet_id,
      balance: walletDetails.balance,
      formattedBalance: walletDetails.formattedBalance,
      displayBalance: walletDetails.displayBalance,
      currency: walletDetails.currency || 'KSH',
      transactionType: 'cashout',
      amount: winnings,
      multiplier,
      timestamp: new Date().toISOString()
    };

    // Broadcast wallet update
    this.notificationService.sendUserNotification(
      userId, 
      'wallet:balance_updated', 
      walletUpdatePayload
    );

    // Cash out the bet
    const cashedOutBet = await this.betTrackingService.cashoutBet(
      activeBet.id, 
      currentGameState.gameId, 
      multiplier
    );

    // Publish cashout event
    await this.publishBetEvent({
      type: 'bet_cashed_out',
      userId,
      username,
      betAmount: activeBet.betAmount,
      cashoutAmount: winnings,
      multiplier,
      gameSessionId: currentGameState.gameId,
      betId: activeBet.id
    });

    // Log successful cashout
    logger.info('BET_CASHOUT_SUCCESS', {
      userId,
      username,
      betId: activeBet.id,
      multiplier,
      winnings
    });

    return {
      success: true,
      betId: activeBet.id,
      multiplier,
      winnings
    };
  }

  /**
   * Validate cashout multiplier against current game state
   * @param {number} currentMultiplier - Current game multiplier
   * @param {number} requestedMultiplier - Multiplier user wants to cashout at
   * @returns {boolean} Whether cashout is valid
   */
  _validateCashoutMultiplier(currentMultiplier, requestedMultiplier) {
    // Log raw input values for debugging
    logger.info('CASHOUT_MULTIPLIER_VALIDATION', {
      currentMultiplier: currentMultiplier,
      requestedMultiplier: requestedMultiplier,
      currentMultiplierType: typeof currentMultiplier,
      requestedMultiplierType: typeof requestedMultiplier
    });

    // Convert to numbers to ensure proper comparison
    const currentMultiplierNum = Number(currentMultiplier || 1.00);
    const requestedMultiplierNum = Number(requestedMultiplier);

    // Ensure requested multiplier is not higher than current multiplier
    if (requestedMultiplierNum > currentMultiplierNum) {
      logger.warn('CASHOUT_MULTIPLIER_TOO_HIGH', {
        currentMultiplier: currentMultiplierNum,
        requestedMultiplier: requestedMultiplierNum
      });
      return false;
    }

    // Additional validation can be added here
    // For example, minimum cashout multiplier
    const MIN_CASHOUT_MULTIPLIER = 1.00;
    if (requestedMultiplierNum < MIN_CASHOUT_MULTIPLIER) {
      logger.warn('CASHOUT_MULTIPLIER_TOO_LOW', {
        currentMultiplier: currentMultiplierNum,
        requestedMultiplier: requestedMultiplierNum,
        minMultiplier: MIN_CASHOUT_MULTIPLIER
      });
      return false;
    }

    return true;
  }

  /**
   * Deactivate bets when game crashes
   * @param {string} gameSessionId - Current game session ID
   */
  deactivateBetsOnCrash() {
    const activeBets = this.betTrackingService.activeBets;
    const currentGameState = this.gameService.gameState;

    activeBets.forEach(bet => {
      this.betTrackingService.finalizeBet(
        bet.betId, 
        'expired', 
        currentGameState.multiplier
      );
    });
  }

  /**
   * Reset bets between game cycles
   */
  resetBetsBetweenCycles() {
    // Reset bet tracking service metrics
    this.betTrackingService.sessionBetMetrics = {
      totalBetAmount: 0,
      totalBetCount: 0,
      userBetDetails: {}
    };
  }

  /**
   * Get session bet metrics
   * @returns {Object} Session bet metrics
   */
  getSessionBetMetrics() {
    return this.betTrackingService.getSessionBetMetrics();
  }

  /**
   * Publish bet event and send WebSocket notification
   * @param {Object} betEvent - Bet event details
   */
  async publishBetEvent(betEvent) {
    logger.info('BET_EVENT', betEvent);

    // Prepare comprehensive notification payload
    const notificationPayload = {
      type: betEvent.type,
      userId: betEvent.userId,
      betId: betEvent.betId,
      betAmount: betEvent.betAmount,
      gameSessionId: betEvent.gameSessionId,
      timestamp: new Date().toISOString(),
      status: 'success'  // Add status for clarity
    };

    // Send user-specific notification about bet
    try {
      await this.notificationService.sendUserNotification(
        betEvent.userId, 
        'bet_update', 
        notificationPayload
      );

      // Get wallet details for precise balance tracking
      const walletDetails = await this.walletService.getWallet(betEvent.userId);
      
      // Prepare comprehensive wallet update payload
      const walletUpdatePayload = {
        userId: betEvent.userId,
        walletId: walletDetails.wallet_id,
        balance: walletDetails.balance,
        formattedBalance: walletDetails.formattedBalance,
        displayBalance: walletDetails.displayBalance,
        currency: walletDetails.currency || 'KSH',
        transactionType: 'bet',
        amount: betEvent.betAmount,
        timestamp: new Date().toISOString()
      };

      // Broadcast wallet update
      await this.notificationService.sendUserNotification(
        betEvent.userId, 
        'wallet:balance_updated', 
        walletUpdatePayload
      );

    } catch (error) {
      logger.error('USER_NOTIFICATION_SEND_FAILED', {
        userId: betEvent.userId,
        errorMessage: error.message
      });
    }

    // Remove broadcast notification
    // this.notificationService.broadcastNotification('bet_update', notificationPayload);
  }
}

export default new BetService(
  betTrackingService,
  redisRepository,
  walletService,
  notificationService,
  gameService,
  authService,
  new PlayerBetRepository()
);
