import logger from '../config/logger.js';
import GameRepository from '../repositories/gameRepository.js';
import WalletRepository from '../repositories/walletRepository.js';
import PlayerBetRepository from '../repositories/playerBetRepository.js';
import crypto from 'crypto';

class BetService {
  constructor() {
    this.gameRepository = new GameRepository();
    this.walletRepository = WalletRepository;

    // Configurable bet limits
    this.MIN_BET_AMOUNT = 10;
    this.MAX_BET_AMOUNT = 50000;

    // In-memory store for bet tokens (consider using Redis in production)
    this.betTokens = new Map();
  }

  /**
   * Process bet placement
   * @param {Object} betDetails - Bet details including amount and user ID
   * @returns {Promise<Object>} - Bet placement result
   */
  async processBetPlacement(betDetails) {
    try {
      // Ensure userId is a string and extract from object if needed
      const userId = typeof betDetails.userId === 'object' 
        ? betDetails.userId.userId 
        : betDetails.userId;

      // Validate bet details
      await this.validateBetDetails({
        userId,
        amount: betDetails.betAmount || betDetails.amount,
        autoCashoutMultiplier: betDetails.autoCashoutMultiplier
      });

      // Place bet using PlayerBetRepository
      const result = await PlayerBetRepository.placeBet({
        userId,
        betAmount: betDetails.betAmount || betDetails.amount,
        autocashoutMultiplier: betDetails.autoCashoutMultiplier,
        betType: betDetails.autoCashoutMultiplier ? 'auto' : 'manual'
      });

      return {
        success: true,
        message: 'Bet placed successfully'
      };

    } catch (error) {
      logger.error('BET_PLACEMENT_ERROR', {
        userId: betDetails.userId,
        amount: betDetails.betAmount || betDetails.amount,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Validate bet details
   * @param {Object} betDetails - Bet details to validate
   */
  async validateBetDetails(betDetails) {
    // Validate required fields
    if (!betDetails.userId || !betDetails.amount) {
      throw new Error('Missing required bet details');
    }

    // Validate bet amount
    if (betDetails.amount <= 0) {
      throw new Error('Bet amount must be greater than 0');
    }

    // Optional auto-cashout validation
    if (betDetails.autoCashoutMultiplier !== undefined && betDetails.autoCashoutMultiplier !== null) {
      if (typeof betDetails.autoCashoutMultiplier !== 'number') {
        logger.warn('INVALID_AUTO_CASHOUT', {
          userId: betDetails.userId,
          reason: 'Invalid auto-cashout multiplier type',
          value: betDetails.autoCashoutMultiplier
        });
        throw new Error('Invalid auto-cashout multiplier: Must be a number');
      }

      if (betDetails.autoCashoutMultiplier <= 1) {
        throw new Error('Invalid auto-cashout multiplier: Must be greater than 1');
      }
    }

    // Validate bet amount against limits
    if (betDetails.amount < this.MIN_BET_AMOUNT || betDetails.amount > this.MAX_BET_AMOUNT) {
      throw new Error(`Bet amount must be between ${this.MIN_BET_AMOUNT} and ${this.MAX_BET_AMOUNT}`);
    }
  }

  async processCashout(options) {
    const { 
      userId, 
      betId, 
      cashoutMultiplier, 
      autoCashoutMultiplier 
    } = options;

    // Validate input
    if (!userId || !betId) {
      throw new Error('Missing required cashout parameters');
    }

    // Retrieve bet details to determine cashout type
    const betDetails = await PlayerBetRepository.findBetById(betId);
    if (!betDetails) {
      throw new Error('Bet not found');
    }

    // Determine cashout type and validate multiplier
    const isManuallyCashedOut = cashoutMultiplier !== undefined;
    const isAutoCashout = betDetails.betType === 'auto';

    // For auto cashout, use the pre-stored auto-cashout multiplier
    const finalCashoutMultiplier = isManuallyCashedOut 
      ? cashoutMultiplier 
      : (isAutoCashout 
          ? betDetails.autoCashoutMultiplier  // Use stored auto-cashout multiplier
          : null);

    // Validate multipliers
    if (finalCashoutMultiplier !== null && finalCashoutMultiplier <= 1) {
      throw new Error('Cashout multiplier must be greater than 1');
    }

    // Log cashout attempt with detailed context
    logger.info('PROCESSING_CASHOUT', {
      userId,
      betId,
      betType: betDetails.betType,
      cashoutMethod: isManuallyCashedOut ? 'manual' : 'auto',
      storedAutoCashoutMultiplier: betDetails.autoCashoutMultiplier,
      finalCashoutMultiplier
    });

    // Ensure we have a valid cashout multiplier
    if (finalCashoutMultiplier === null) {
      throw new Error('No valid cashout multiplier found');
    }

    // Process cashout through repository
    const result = await PlayerBetRepository.cashoutBet({
      betId,
      userId,
      cashoutMultiplier: finalCashoutMultiplier,
      betType: betDetails.betType
    });

    // Prepare detailed cashout response
    return {
      success: true,
      betId,
      winAmount: result.winAmount,
      cashoutMultiplier: finalCashoutMultiplier,
      betType: betDetails.betType,
      originalAutoCashoutMultiplier: betDetails.autoCashoutMultiplier
    };
  }

  async findBetAcrossStores(betId, gameSessionId) {
    // Validate input parameters
    if (!betId) {
      logger.error('FIND_BET_ACROSS_STORES_INVALID_INPUT', {
        message: 'Bet ID is null or undefined',
        gameSessionId,
        timestamp: new Date().toISOString()
      });
      throw new Error('INVALID_BET_ID');
    }

    if (!gameSessionId) {
      logger.error('FIND_BET_ACROSS_STORES_INVALID_INPUT', {
        message: 'Game Session ID is null or undefined',
        betId,
        timestamp: new Date().toISOString()
      });
      throw new Error('INVALID_GAME_SESSION_ID');
    }

    try {
      // Log the synchronization attempt
      logger.debug('BET_CROSS_STORE_SYNC_ATTEMPT', {
        betId,
        gameSessionId,
        timestamp: new Date().toISOString()
      });

      // 1. Check Redis first
      const redisBet = await this.redisService.getBet(betId);
      
      if (redisBet) {
        logger.debug('REDIS_BET_FOUND', {
          betId,
          redisBetDetails: {
            gameSessionId: redisBet.gameSessionId,
            status: redisBet.status
          }
        });

        // Validate Redis bet against game session
        if (redisBet.gameSessionId !== gameSessionId) {
          logger.warn('REDIS_BET_GAME_SESSION_MISMATCH', {
            betId,
            redisBetSessionId: redisBet.gameSessionId,
            expectedSessionId: gameSessionId
          });
        }
      }

      // 2. Check Database
      const databaseBet = await this.playerBetRepository.findBetById(betId);
      
      if (databaseBet) {
        logger.debug('DATABASE_BET_FOUND', {
          betId,
          databaseBetDetails: {
            gameSessionId: databaseBet.game_session_id,
            status: databaseBet.status
          }
        });
      }

      // 3. Cross-verification and synchronization
      if (redisBet && !databaseBet) {
        // Attempt to recreate bet in database if only exists in Redis
        logger.warn('REDIS_BET_MISSING_IN_DATABASE', {
          betId,
          redisBetDetails: redisBet
        });

        try {
          const recreatedBet = await this.playerBetRepository.createBetFromRedis(redisBet);
          logger.info('BET_RECREATED_IN_DATABASE', {
            betId: recreatedBet.bet_id,
            recreatedFromRedis: true
          });
        } catch (recreationError) {
          logger.error('BET_RECREATION_FAILED', {
            betId,
            errorMessage: recreationError.message,
            errorStack: recreationError.stack
          });
        }
      }

      // 4. Prioritize database bet if both exist
      const prioritizedBet = databaseBet || redisBet;

      if (!prioritizedBet) {
        logger.warn('BET_NOT_FOUND_IN_ANY_STORE', {
          betId,
          gameSessionId
        });
        throw new Error('BET_NOT_FOUND');
      }

      return prioritizedBet;
    } catch (error) {
      logger.error('BET_CROSS_STORE_SYNC_ERROR', {
        betId,
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async checkBetReadinessForCashout(betId, gameSessionId) {
    // Validate input parameters
    if (!betId) {
      logger.error('CASHOUT_READINESS_INVALID_INPUT', {
        message: 'Bet ID is null or undefined',
        gameSessionId,
        timestamp: new Date().toISOString()
      });
      throw new Error('INVALID_BET_ID');
    }

    if (!gameSessionId) {
      logger.error('CASHOUT_READINESS_INVALID_INPUT', {
        message: 'Game Session ID is null or undefined',
        betId,
        timestamp: new Date().toISOString()
      });
      throw new Error('INVALID_GAME_SESSION_ID');
    }

    try {
      // Enhanced bet readiness check with cross-store synchronization
      const bet = await this.findBetAcrossStores(betId, gameSessionId);

      // Additional validation checks
      if (bet.status !== 'active') {
        logger.warn('CASHOUT_INVALID_BET_STATUS', {
          betId,
          currentStatus: bet.status,
          expectedStatus: 'active'
        });
        throw new Error('INVALID_BET_STATUS');
      }

      // Validate game session
      if (bet.gameSessionId !== gameSessionId) {
        logger.warn('CASHOUT_GAME_SESSION_MISMATCH', {
          betId,
          currentGameSessionId: bet.gameSessionId,
          expectedGameSessionId: gameSessionId
        });
        throw new Error('GAME_SESSION_MISMATCH');
      }

      return bet;
    } catch (error) {
      logger.error('BET_READINESS_CHECK_FAILED', {
        betId,
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  // Enhanced token generation to capture original bet details
  generateBetToken(betId, userId, additionalContext = {}) {
    const token = crypto.randomBytes(32).toString('hex');
    
    // Store comprehensive token data
    const tokenData = {
      betId,
      userId,
      createdAt: Date.now(),
      ...additionalContext  // Capture original bet details
    };

    this.betTokens.set(token, tokenData);

    // Enhanced logging for cashout token generation
    logger.info('CASHOUT_TOKEN_GENERATED', {
      token: token.substring(0, 10) + '...', // Partially mask token for security
      betId,
      userId,
      tokenCreatedAt: new Date().toISOString(),
      additionalContextKeys: Object.keys(additionalContext),
      isCashoutToken: additionalContext.isCashoutToken || false
    });

    return token;
  }

  // Enhanced token validation to return more context
  validateBetToken(token, userId) {
    const tokenData = this.betTokens.get(token);
    
    if (!tokenData) {
      // Log failed token validation
      logger.warn('INVALID_BET_TOKEN', {
        userId,
        tokenHash: crypto.createHash('md5').update(token).digest('hex'), // Hash for tracking without exposing full token
        errorType: 'TOKEN_NOT_FOUND',
        timestamp: new Date().toISOString()
      });
      throw new Error('Invalid bet token');
    }

    // Verify user matches
    if (tokenData.userId !== userId) {
      // Log unauthorized token access attempt
      logger.warn('UNAUTHORIZED_TOKEN_ACCESS', {
        requestedUserId: userId,
        tokenOwnerUserId: tokenData.userId,
        betId: tokenData.betId,
        tokenCreatedAt: new Date(tokenData.createdAt).toISOString(),
        errorType: 'USER_MISMATCH',
        timestamp: new Date().toISOString()
      });
      throw new Error('Unauthorized bet token');
    }

    // Log successful token validation
    logger.info('BET_TOKEN_VALIDATED', {
      userId,
      betId: tokenData.betId,
      tokenCreatedAt: new Date(tokenData.createdAt).toISOString(),
      tokenAge: Date.now() - tokenData.createdAt,
      additionalContextKeys: Object.keys(tokenData).filter(key => 
        !['betId', 'userId', 'createdAt'].includes(key)
      )
    });

    // Remove token immediately to prevent reuse
    this.betTokens.delete(token);

    // Return full token data for more context
    return {
      betId: tokenData.betId,
      additionalContext: tokenData
    };
  }
}

export default new BetService();