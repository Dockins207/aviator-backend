import pkg from 'pg';
const { Pool } = pkg;

import { v4 as uuidv4 } from 'uuid';
import gameService from './gameService.js';
import { WalletRepository } from '../repositories/walletRepository.js';
import logger from '../config/logger.js';
import betTrackingService from './betTrackingService.js';

// Custom validation error class
class ValidationError extends Error {
  constructor(code, details) {
    super(details.message);
    this.name = 'ValidationError';
    this.code = code;
    this.details = details;
  }
}

class BetService {
  constructor(gameService, betTrackingService, pool = null) {
    this.gameService = gameService;
    this.betTrackingService = betTrackingService;
    // Current game bets
    this.currentBets = [];
    // Successful bets that can be cashed out
    this.activeBets = [];
    
    if (pool) {
      this.pool = pool;
    } else {
      this.pool = new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
        database: process.env.DB_NAME || 'aviator_db',
        user: process.env.DB_USER || 'admin',
        password: process.env.DB_PASSWORD || '2020',
        max: 20,  // Maximum number of clients in the pool
        idleTimeoutMillis: 30000,  // How long a client is allowed to remain idle
        connectionTimeoutMillis: 2000  // How long to wait when acquiring a client
      });
    }
  }

  /**
   * Validate bet details before placement
   * @param {Object} betData - Details of the bet to be validated
   * @throws {Error} If bet details are invalid
   */
  validateBetDetails(betData) {
    // Check required fields
    if (!betData.userId) {
      throw new Error('INVALID_USER_ID', {
        message: 'User ID is required for bet placement'
      });
    }

    // Validate bet amount (modify to match incoming request structure)
    if (!betData.amount || betData.amount <= 0) {
      throw new Error('INVALID_BET_AMOUNT', {
        message: 'Bet amount must be a positive number'
      });
    }

    // Return validated bet with standardized structure
    return {
      userId: betData.userId,
      betAmount: betData.amount  // Rename to match existing code
    };
  }

  /**
   * Place a bet during the betting phase
   * @param {Object} betDetails - Details of the bet to be placed
   * @returns {Object} Result of bet placement
   */
  async placeBet(betDetails) {
    try {
      // Get current game state
      const currentGameState = this.gameService.getCurrentGameState();

      // Validate bet placement is possible
      if (currentGameState.status !== 'betting') {
        throw new Error('BETTING_NOT_ALLOWED', {
          message: 'Bets can only be placed during betting phase',
          currentGameState: currentGameState.status
        });
      }

      // Validate bet details
      const validatedBet = this.validateBetDetails(betDetails);

      // Add bet to betting state tracking
      const trackedBet = this.betTrackingService.addBetToBettingState(validatedBet);

      // Optional: Log successful bet placement
      logger.info('BET_PLACED', {
        userId: validatedBet.userId,
        betAmount: validatedBet.betAmount,
        gameId: currentGameState.gameId
      });

      return {
        success: true,
        message: 'Bet placed successfully',
        gameId: currentGameState.gameId,
        betId: trackedBet.betId
      };

    } catch (error) {
      // Log bet placement error
      logger.error('BET_PLACEMENT_FAILED', {
        error: error.message,
        betDetails
      });

      // Throw or return error based on your error handling strategy
      throw error;
    }
  }

  /**
   * Cash out a bet during the flying phase
   * @param {Object} cashOutDetails - Details for cashing out
   * @returns {Object} Result of cash out
   */
  async cashOut(cashOutDetails) {
    try {
      // Get current game state
      const currentGameState = this.gameService.getCurrentGameState();

      // Validate cash out is possible
      if (currentGameState.status !== 'flying') {
        throw new Error('CASHOUT_NOT_ALLOWED', {
          message: 'Cash out is only allowed during flying phase',
          currentGameState: currentGameState.status
        });
      }

      // Retrieve bets ready for cashout from bet tracking service
      const readyForCashoutBets = this.betTrackingService.getReadyForCashoutBets();

      // Find ready for cashout bets for the user
      const userReadyForCashoutBets = readyForCashoutBets
        .filter(bet => bet.userId === cashOutDetails.userId);

      if (userReadyForCashoutBets.length === 0) {
        return {
          success: false,
          message: 'No bets ready for cashout'
        };
      }

      // Process cashout for each bet ready for cashout
      const cashoutResults = userReadyForCashoutBets.map(bet => ({
        betId: bet.betId,
        userId: bet.userId,
        betAmount: bet.betAmount,
        multiplier: currentGameState.multiplier,
        winnings: bet.betAmount * currentGameState.multiplier
      }));

      // Optional: Log successful cash out
      logger.info('BET_CASHED_OUT', {
        userId: cashOutDetails.userId,
        multiplier: currentGameState.multiplier,
        gameId: currentGameState.gameId,
        totalCashedOut: cashoutResults.reduce((sum, result) => sum + result.winnings, 0)
      });

      // Remove cashed out bets from the ready for cashout list
      userReadyForCashoutBets.forEach(bet => {
        this.betTrackingService.removeCashedOutBet(bet.betId);
      });

      return {
        success: true,
        message: 'Bet cashed out successfully',
        results: cashoutResults
      };

    } catch (error) {
      // Log cash out error
      logger.error('CASHOUT_FAILED', {
        error: error.message,
        cashOutDetails
      });

      // Throw or return error based on your error handling strategy
      throw error;
    }
  }

  async checkExistingBets() {
    return { canPlaceBet: true };
  }

  async cashoutBet(cashoutData) {
    const { 
      userId, 
      multiplier,
      betId
    } = cashoutData;

    if (!userId) {
      throw new ValidationError('USER_ID_REQUIRED', {
        message: 'User ID is required for cashout'
      });
    }

    try {
      // Retrieve bets ready for cashout
      const activeBets = this.betTrackingService.getReadyForCashoutBets(
        userId, 
        cashoutData.betId
      );

      if (activeBets.length === 0) {
        logger.warn('No active bets ready for cashout', { 
          userId,
          betId: cashoutData.betId 
        });
        return {
          success: false,
          message: 'No bets ready for cashout',
          results: []
        };
      }

      // Process cashout for each active bet
      const cashoutResults = [];
      for (const bet of activeBets) {
        const cashoutResult = await this.processCashout({
          betId: bet.betId,
          userId,
          currentMultiplier: parseFloat(multiplier),
          betAmount: parseFloat(bet.betAmount),
          gameStatus: 'flying'
        });

        // Remove the bet from cashout-ready state
        this.betTrackingService.removeCashedOutBet(bet.betId);

        cashoutResults.push(cashoutResult);
      }

      return {
        success: true,
        message: 'All active bets cashed out successfully',
        results: cashoutResults
      };
    } catch (error) {
      logger.error('Cashout error', { 
        userId, 
        multiplier, 
        errorMessage: error.message 
      });

      throw error;
    }
  }

  async processCashout(cashoutData) {
    const { 
      betId, 
      userId, 
      currentMultiplier, 
      betAmount, 
      gameStatus 
    } = cashoutData;

    // Validate input parameters
    if (!betId) {
      throw new ValidationError('BET_ID_REQUIRED', {
        message: 'Bet ID is required',
        details: {
          userId,
          currentMultiplier,
          betAmount
        }
      });
    }
    if (!currentMultiplier || currentMultiplier <= 0) {
      throw new ValidationError('INVALID_CURRENT_MULTIPLIER', {
        message: 'Invalid current multiplier',
        details: {
          userId,
          betId,
          currentMultiplier
        }
      });
    }
    if (!betAmount || betAmount <= 0) {
      throw new ValidationError('INVALID_BET_AMOUNT', {
        message: 'Invalid bet amount',
        details: {
          userId,
          betId,
          betAmount
        }
      });
    }

    // Ensure cashout multiplier is always > 1
    const safeCashoutMultiplier = Math.max(1.01, currentMultiplier);

    // Additional verification
    const bet = await GameRepository.getPlayerBetById(betId);
    if (bet.user_id !== userId) {
      logger.error('UNAUTHORIZED_BET_ACCESS', {
        requestedUserId: userId,
        actualBetUserId: bet.user_id,
        betId,
        betDetails: {
          gameSessionId: bet.game_session_id,
          betAmount: bet.bet_amount,
          betStatus: bet.status
        }
      });
      
      throw new ValidationError('UNAUTHORIZED_BET_ACCESS', {
        message: 'Unauthorized bet access',
        details: {
          userId,
          betId,
          betUserId: bet.user_id
        }
      });
    }

    // Calculate payout
    const payoutAmount = betAmount * safeCashoutMultiplier;

    // Update player bet record
    const updateBetRecord = {
      playerBetId: betId,
      status: 'won',
      cashoutMultiplier: safeCashoutMultiplier,
      payoutAmount: payoutAmount,
      originalBetAmount: betAmount,
      userId: userId
    };

    const updatedBet = await GameRepository.updatePlayerBetStatic(updateBetRecord);

    // Credit wallet with cashout amount
    await WalletRepository.creditBalanceStatic(userId, payoutAmount);

    // Log successful cashout
    logger.info('Bet cashed out successfully', {
      userId,
      betId,
      betAmount,
      currentMultiplier,
      payoutAmount,
      gameStatus
    });

    return {
      betId,
      status: 'won',
      userId,
      originalBetAmount: betAmount,
      currentMultiplier,
      payoutAmount,
      gameStatus
    };
  }

  async createGameRecord() {
    // No-op method
    return null;
  }

  async resolveGameOutcome() {
    // No-op method
    return null;
  }

  async placeBetTransaction() {
    return null;
  }

  /**
   * Deactivate bets when game crashes
   * @param {string} gameSessionId - Current game session ID
   * @returns {Promise<void>}
   */
  async deactivateBetsOnCrash(gameSessionId) {
    if (!gameSessionId) {
      logger.warn('Cannot deactivate bets: No game session ID provided');
      return;
    }

    try {
      const deactivationQuery = `
        UPDATE player_bets
        SET status = 'crashed'
        WHERE 
          game_session_id = $1 
          AND status = 'active'
      `;

      const result = await this.pool.query(deactivationQuery, [gameSessionId]);
      
      logger.info('Deactivated bets on game crash', {
        gameSessionId,
        deactivatedBetsCount: result.rowCount
      });
    } catch (error) {
      logger.error('Error deactivating bets on crash', {
        gameSessionId,
        errorMessage: error.message
      });
    }
  }

  /**
   * Reset bets between game cycles
   * @param {string} gameSessionId - Current game session ID
   * @returns {Promise<void>}
   */
  async resetBetsBetweenCycles(gameSessionId) {
    if (!gameSessionId) {
      logger.warn('Cannot reset bets: No game session ID provided');
      return;
    }

    try {
      // Comprehensive reset query to handle all possible bet statuses
      const resetQuery = `
        WITH previous_session_bets AS (
          SELECT game_session_id
          FROM game_sessions
          WHERE 
            status IN ('completed', 'crashed')
            AND game_session_id != $1
        )
        UPDATE player_bets pb
        SET status = 'completed'
        FROM previous_session_bets psb
        WHERE 
          pb.game_session_id = psb.game_session_id
          AND pb.status NOT IN ('completed', 'resolved')
      `;

      const result = await this.pool.query(resetQuery, [gameSessionId]);
      
      logger.info('Comprehensively reset bets from previous sessions', {
        currentGameSessionId: gameSessionId,
        resetBetsCount: result.rowCount
      });

      // Additional cleanup for orphaned bets
      const orphanedBetsQuery = `
        UPDATE player_bets
        SET status = 'completed'
        WHERE 
          status NOT IN ('completed', 'resolved')
          AND game_session_id NOT IN (
            SELECT game_session_id FROM game_sessions
          )
      `;

      const orphanedResult = await this.pool.query(orphanedBetsQuery);

      logger.info('Cleaned up orphaned bets', {
        orphanedBetsCount: orphanedResult.rowCount
      });
    } catch (error) {
      logger.error('Error resetting bets between cycles', {
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      
      // Fallback comprehensive reset
      try {
        const fallbackResetQuery = `
          UPDATE player_bets
          SET status = 'completed'
          WHERE status NOT IN ('completed', 'resolved')
        `;
        
        await this.pool.query(fallbackResetQuery);
      } catch (fallbackError) {
        logger.error('Critical failure in bet reset', {
          fallbackErrorMessage: fallbackError.message
        });
      }
    }
  }

  /**
   * Activate bet for cashout during flying phase
   * @param {string} betId - ID of the bet to activate
   * @returns {Object} Activation result
   */
  activateBetForCashout(betId) {
    try {
      const currentGameState = gameService.getCurrentGameState();

      // STRICT: Only allow bet activation during FLYING state
      if (currentGameState.status !== 'flying') {
        logger.error('Invalid game state for bet activation', { 
          currentState: currentGameState.status,
          expectedState: 'flying'
        });
        throw new ValidationError('BET_ACTIVATION_ONLY_ALLOWED_DURING_FLYING_STATE', {
          message: 'Bet activation only allowed during flying state'
        });
      }

      // Find the bet in current bets
      const betIndex = this.currentBets.findIndex(b => b.id === betId);
      
      if (betIndex === -1) {
        logger.warn('Attempt to activate non-existent bet', { betId });
        throw new ValidationError('BET_NOT_FOUND', {
          message: 'Bet not found'
        });
      }

      // Mark bet as user-activated
      this.currentBets[betIndex].isUserActivated = true;

      return {
        success: true,
        betId: this.currentBets[betIndex].id,
        message: 'Bet activated and ready for cashout'
      };
    } catch (error) {
      logger.error('Error activating bet for cashout', { 
        betId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Get current bets
   * @returns {Array} List of current bets
   */
  getCurrentBets() {
    try {
      return this.currentBets;
    } catch (error) {
      logger.error('Error retrieving current bets', { 
        error: error.message,
        stack: error.stack
      });
      return [];
    }
  }

  /**
   * Reset bets between game cycles
   */
  resetBets() {
    try {
      // Remove all bets when resetting
      this.currentBets = [];
    } catch (error) {
      logger.error('Error resetting bets', { 
        error: error.message,
        stack: error.stack
      });
    }
  }

  /**
   * Validate bet data before processing
   * @param {Object} betData - Bet details to validate
   * @throws {ValidationError} If bet data is invalid
   */
  validateBetData(betData) {
    if (!betData.userId) {
      throw new ValidationError('INVALID_USER', { 
        message: 'User ID is required' 
      });
    }
    if (!betData.gameSessionId) {
      throw new ValidationError('INVALID_GAME_SESSION', { 
        message: 'Game Session ID is required' 
      });
    }
    if (!betData.betAmount || betData.betAmount <= 0) {
      throw new ValidationError('INVALID_BET_AMOUNT', { 
        message: 'Bet amount must be positive' 
      });
    }
  }

  /**
   * Publish bet event to external processing system
   * @param {Object} betEvent - Bet event to publish
   */
  async publishBetEvent(betEvent) {
    logger.info('BET_EVENT_PUBLISHED', {
      betId: betEvent.id,
      gameSessionId: betEvent.gameSessionId
    });
  }

  /**
   * Publish game record event to external processing system
   * @param {Object} gameRecordEvent - Game record event to publish
   */
  async publishGameRecordEvent(gameRecordEvent) {
    logger.info('GAME_RECORD_EVENT_PUBLISHED', {
      gameSessionId: gameRecordEvent.gameSessionId,
      betId: gameRecordEvent.betId
    });
  }

  /**
   * Publish game outcome event to external processing system
   * @param {Object} outcomeEvent - Game outcome event to publish
   */
  async publishGameOutcomeEvent(outcomeEvent) {
    logger.info('GAME_OUTCOME_EVENT_PUBLISHED', {
      gameId: outcomeEvent.gameId,
      userId: outcomeEvent.userId
    });
  }
}

export default new BetService(gameService, betTrackingService);
