import PlayerBetRepository from '../repositories/playerBetRepository.js';
import WalletRepository from '../repositories/walletRepository.js';
import GameRepository from '../repositories/gameRepository.js';
import logger from '../config/logger.js';
import crypto from 'crypto';

class BetService {
  constructor() {
    this.gameRepository = new GameRepository();
    this.walletRepository = WalletRepository;

    // Configurable bet limits
    this.MIN_BET_AMOUNT = 10;
    this.MAX_BET_AMOUNT = 50000;

    // In-memory store for bet tokens and bet references (consider using Redis in production)
    this.betTokens = new Map();
    this.betReferences = new Map(); // Maps reference IDs to actual bet IDs
    this.reverseBetReferences = new Map(); // Maps actual bet IDs to reference IDs
  }

  /**
   * Place a bet
   * @param {Object} betDetails - Bet details
   * @returns {Promise<Object>} - Bet placement result
   */
  async placeBet(betDetails) {
    try {
      // Validate bet details
      const { userId, betAmount, betType, autoCashoutMultiplier, gameSessionId } = betDetails;
      
      // Validate bet amount
      if (!betAmount || isNaN(betAmount) || betAmount < this.MIN_BET_AMOUNT || betAmount > this.MAX_BET_AMOUNT) {
        return { 
          success: false, 
          error: `Bet amount must be between ${this.MIN_BET_AMOUNT} and ${this.MAX_BET_AMOUNT}` 
        };
      }

      // Validate auto-cashout multiplier for auto bets
      if (betType === 'auto' && (!autoCashoutMultiplier || autoCashoutMultiplier <= 1)) {
        return { 
          success: false, 
          error: 'Auto-cashout multiplier must be greater than 1' 
        };
      }

      // Get current game session if not provided
      const activeGameSessionId = gameSessionId || await this.gameRepository.getCurrentActiveGameSession();
      if (!activeGameSessionId) {
        return { 
          success: false, 
          error: 'No active game session available' 
        };
      }

      // Place bet in database
      const result = await PlayerBetRepository.placeBet({
        userId,
        betAmount,
        gameSessionId: activeGameSessionId,
        autocashoutMultiplier: autoCashoutMultiplier,
        betType: betType || 'manual'
      });

      if (!result || !result.bet_id) {
        return { 
          success: false, 
          error: 'Failed to place bet' 
        };
      }

      // Generate a secure reference ID for this bet
      const betReferenceId = this.generateBetReference(result.bet_id, userId);

      // Log successful bet placement
      logger.info('BET_PLACED', {
        service: 'aviator-backend',
        userId,
        actualBetId: result.bet_id,
        betReferenceId,
        betAmount,
        betType,
        autoCashoutMultiplier,
        timestamp: new Date().toISOString()
      });

      return {
        success: true,
        betId: betReferenceId, // Return the reference ID instead of actual bet ID
        betAmount,
        betType,
        autoCashoutMultiplier
      };
    } catch (error) {
      logger.error('BET_PLACEMENT_ERROR', {
        service: 'aviator-backend',
        userId: betDetails.userId,
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      return { 
        success: false, 
        error: 'An error occurred while placing your bet' 
      };
    }
  }

  /**
   * Process cashout for a bet
   * @param {Object} options - Cashout options
   * @param {string} options.userId - User ID
   * @param {string} options.betId - Bet reference ID
   * @param {number} options.cashoutMultiplier - Cashout multiplier
   * @returns {Promise<Object>} - Cashout result
   */
  async processCashout(options) {
    const { userId, betId, cashoutMultiplier } = options;

    // Minimal input validation
    if (!userId || !betId || cashoutMultiplier <= 1) {
      return {
        success: false,
        error: 'Invalid cashout parameters'
      };
    }

    try {
      // Translate reference ID to actual bet ID
      const actualBetId = this.getActualBetId(betId, userId);
      if (!actualBetId) {
        return {
          success: false,
          error: 'Invalid bet reference'
        };
      }

      // Single repository method for cashout
      const result = await PlayerBetRepository.cashoutBet({
        betId: actualBetId,
        userId,
        currentMultiplier: cashoutMultiplier
      });

      return {
        success: true,
        betId,  // Return reference ID
        payoutAmount: result.winAmount,
        newBalance: result.newBalance
      };
    } catch (error) {
      logger.error('CASHOUT_ERROR', {
        userId,
        betId,
        errorMessage: error.message
      });

      return {
        success: false,
        error: 'Cashout failed'
      };
    }
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

  /**
   * Generate a secure reference ID for a bet
   * @param {string} betId - Actual database bet ID
   * @param {string} userId - User ID
   * @returns {string} - Secure reference ID
   */
  generateBetReference(betId, userId) {
    // Generate a random reference ID
    const referenceId = crypto.randomBytes(12).toString('hex');
    
    // Store the mapping
    this.betReferences.set(referenceId, { betId, userId, createdAt: Date.now() });
    this.reverseBetReferences.set(betId, referenceId);
    
    // Log the mapping (for debugging only, remove in production)
    logger.debug('BET_REFERENCE_CREATED', {
      service: 'aviator-backend',
      referenceId,
      actualBetId: betId,
      userId,
      timestamp: new Date().toISOString()
    });
    
    return referenceId;
  }

  /**
   * Get the actual bet ID from a reference ID
   * @param {string} referenceId - Reference ID
   * @param {string} userId - User ID for validation
   * @returns {string|null} - Actual bet ID or null if not found/unauthorized
   */
  getActualBetId(referenceId, userId) {
    const mapping = this.betReferences.get(referenceId);
    
    // Check if mapping exists and belongs to the user
    if (!mapping || mapping.userId !== userId) {
      logger.warn('INVALID_BET_REFERENCE', {
        service: 'aviator-backend',
        referenceId,
        userId,
        found: !!mapping,
        authorized: mapping && mapping.userId === userId,
        timestamp: new Date().toISOString()
      });
      return null;
    }
    
    return mapping.betId;
  }

  /**
   * Get reference ID for a bet
   * @param {string} betId - Actual bet ID
   * @returns {string|null} - Reference ID or null if not found
   */
  getBetReferenceId(betId) {
    return this.reverseBetReferences.get(betId) || null;
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

  /**
   * Get current active bets
   * @returns {Promise<Array>} - List of current active bets
   */
  async getCurrentBets() {
    try {
      // Get current game session
      const gameSessionId = await this.gameRepository.getCurrentActiveGameSession();
      if (!gameSessionId) {
        logger.warn('NO_ACTIVE_GAME_SESSION_FOR_CURRENT_BETS', {
          service: 'aviator-backend',
          timestamp: new Date().toISOString()
        });
        return [];
      }

      // Get active bets from database
      const activeBets = await PlayerBetRepository.getActiveBetsByGameSession(gameSessionId);
      
      // Map the bets to use reference IDs instead of actual bet IDs
      const mappedBets = activeBets.map(bet => {
        // Generate a reference ID if one doesn't exist
        let betReferenceId = this.getBetReferenceId(bet.bet_id);
        if (!betReferenceId) {
          betReferenceId = this.generateBetReference(bet.bet_id, bet.user_id);
        }
        
        // Return a sanitized version with reference ID instead of actual ID
        return {
          betId: betReferenceId,
          userId: bet.user_id,
          betAmount: bet.bet_amount,
          betType: bet.bet_type,
          autoCashoutMultiplier: bet.autocashout_multiplier,
          status: bet.status,
          createdAt: bet.created_at
        };
      });

      return mappedBets;
    } catch (error) {
      logger.error('GET_CURRENT_BETS_ERROR', {
        service: 'aviator-backend',
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }
}

export default BetService;