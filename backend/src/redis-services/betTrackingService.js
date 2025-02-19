import logger from '../config/logger.js';
import redisRepository from './redisRepository.js';
import { v4 as uuidv4 } from 'uuid';

class BetTrackingService {
  constructor(redisRepository) {
    this.redisRepository = redisRepository;
    
    // Define valid bet states with explicit lifecycle
    this.BET_STATES = {
      PLACED: 'placed',     // Initial state when bet is created
      ACTIVE: 'active',     // Bet is active during game
      CASHED_OUT: 'cashed_out', // Bet successfully cashed out
      EXPIRED: 'expired'    // Bet lost or invalidated
    };
  }

  /**
   * Place a new bet
   * @param {Object} betDetails - Details of the bet to be placed
   * @returns {Object} Placed bet details
   */
  placeBet(betDetails) {
    // Validate bet details
    this.validateBetPlacement(betDetails);

    // Create bet with initial 'placed' state
    const placedBet = {
      ...betDetails,
      status: this.BET_STATES.PLACED,
      placedAt: new Date().toISOString()
    };

    // Store bet in Redis with 'placed' status
    this.redisRepository.storeBet(
      betDetails.gameSessionId, 
      placedBet
    );

    logger.info('BET_PLACED', {
      userId: placedBet.userId,
      betAmount: placedBet.betAmount,
      gameSessionId: placedBet.gameSessionId
    });

    return placedBet;
  }

  /**
   * Activate a placed bet
   * @param {string} betId - Unique bet identifier
   * @param {string} gameSessionId - Game session identifier
   * @returns {Object} Activated bet details
   */
  activateBet(betId, gameSessionId) {
    // Retrieve bet from Redis
    const bet = this.redisRepository.getBetById(gameSessionId, betId);
    
    if (!bet) {
      throw new Error('Bet not found');
    }

    // Only activate bets in 'placed' state
    if (bet.status !== this.BET_STATES.PLACED) {
      throw new Error('Invalid bet state for activation');
    }

    // Update bet status to 'active'
    const activatedBet = {
      ...bet,
      status: this.BET_STATES.ACTIVE,
      activatedAt: new Date().toISOString()
    };

    // Store updated bet in Redis
    this.redisRepository.updateBetStatus(
      gameSessionId, 
      betId, 
      this.BET_STATES.ACTIVE
    );

    logger.info('BET_ACTIVATED', {
      betId,
      gameSessionId,
      userId: bet.userId
    });

    return activatedBet;
  }

  /**
   * Activate placed bets when entering game phase
   * @param {Object} gameState - Current game state
   * @returns {Array} Activated bets
   */
  async activateBets(gameState) {
    try {
      // Retrieve all placed bets
      const allBets = await this.redisRepository.getAllGameBets(gameState.gameId);
      const placedBets = Array.isArray(allBets) 
        ? allBets.filter(bet => bet.status === this.BET_STATES.PLACED)
        : [];

      // Activate each bet
      const activatedBets = placedBets.map(bet => {
        const activatedBet = {
          ...bet,
          status: this.BET_STATES.ACTIVE,
          gameSessionId: gameState.gameId,
          activationMultiplier: 1.00,
          activatedAt: new Date().toISOString()
        };

        // Update bet status in Redis
        this.redisRepository.updateBetStatus(
          gameState.gameId, 
          bet.id, 
          this.BET_STATES.ACTIVE
        );

        return activatedBet;
      });

      logger.info('BETS_ACTIVATED', {
        totalActivatedBets: activatedBets.length,
        gameSessionId: gameState.gameId
      });

      return activatedBets;
    } catch (error) {
      logger.error('BET_ACTIVATION_ERROR', {
        errorMessage: error.message,
        gameSessionId: gameState.gameId
      });
      throw error;
    }
  }

  /**
   * Cash out a bet
   * @param {string} betId - Unique bet identifier
   * @param {string} gameSessionId - Game session identifier
   * @param {number} multiplier - Cashout multiplier
   * @returns {Object} Cashed out bet details
   */
  async cashoutBet(betId, gameSessionId, multiplier) {
    // Retrieve bet from Redis
    const bet = await this.redisRepository.getBetById(gameSessionId, betId);
    
    if (!bet) {
      throw new Error('Bet not found');
    }

    // STRICT VALIDATION: Only allow cashout of active bets
    if (bet.status !== this.BET_STATES.ACTIVE) {
      logger.warn('CASHOUT_INVALID_BET_STATE', {
        betId,
        gameSessionId,
        currentStatus: bet.status,
        expectedStatus: this.BET_STATES.ACTIVE
      });
      throw new Error('Only active bets can be cashed out');
    }

    // Calculate winnings
    const winnings = bet.betAmount * multiplier;

    // Update bet status to 'cashed_out'
    const cashedOutBet = {
      ...bet,
      status: this.BET_STATES.CASHED_OUT,
      cashedOutAt: new Date().toISOString(),
      multiplier,
      winnings
    };

    // Store updated bet in Redis
    await this.redisRepository.updateBetStatus(
      gameSessionId, 
      betId, 
      this.BET_STATES.CASHED_OUT
    );

    logger.info('BET_CASHED_OUT', {
      betId,
      gameSessionId,
      userId: bet.userId,
      winnings
    });

    return cashedOutBet;
  }

  /**
   * Expire a bet
   * @param {string} betId - Unique bet identifier
   * @param {string} gameSessionId - Game session identifier
   * @returns {Object} Expired bet details
   */
  expireBet(betId, gameSessionId) {
    // Retrieve bet from Redis
    const bet = this.redisRepository.getBetById(gameSessionId, betId);
    
    if (!bet) {
      throw new Error('Bet not found');
    }

    // Only expire active or placed bets
    if (![this.BET_STATES.PLACED, this.BET_STATES.ACTIVE].includes(bet.status)) {
      throw new Error('Invalid bet state for expiration');
    }

    // Update bet status to 'expired'
    const expiredBet = {
      ...bet,
      status: this.BET_STATES.EXPIRED,
      expiredAt: new Date().toISOString()
    };

    // Store updated bet in Redis
    this.redisRepository.updateBetStatus(
      gameSessionId, 
      betId, 
      this.BET_STATES.EXPIRED
    );

    logger.info('BET_EXPIRED', {
      betId,
      gameSessionId,
      userId: bet.userId
    });

    return expiredBet;
  }

  /**
   * Validate bet placement
   * @param {Object} betDetails - Details of the bet to be validated
   * @throws {Error} If bet details are invalid
   */
  validateBetPlacement(betDetails) {
    // Validate required fields
    if (!betDetails.userId) {
      throw new Error('User ID is required');
    }

    if (!betDetails.betAmount || betDetails.betAmount <= 0) {
      throw new Error('Invalid bet amount');
    }

    if (!betDetails.gameSessionId) {
      throw new Error('Game session ID is required');
    }
  }

  /**
   * Get active bets for a user
   * @param {string} userId - User identifier
   * @param {string} gameSessionId - Game session identifier
   * @returns {Promise<Array>} List of active bets
   */
  async getUserActiveBets(userId, gameSessionId) {
    try {
      // Retrieve all bets for the game session
      const gameBets = await this.redisRepository.getAllGameBets(gameSessionId);

      // If gameBets is not an array, return empty array
      if (!Array.isArray(gameBets)) {
        logger.warn('GAME_BETS_NOT_ARRAY', {
          userId,
          gameSessionId,
          gameBetsType: typeof gameBets
        });
        return [];
      }

      // Filter active bets for the specific user
      const activeBets = gameBets.filter(bet => 
        bet.userId === userId && bet.status === this.BET_STATES.ACTIVE
      );

      logger.info('USER_ACTIVE_BETS_RETRIEVED', {
        userId,
        gameSessionId,
        activeBetsCount: activeBets.length
      });

      return activeBets;
    } catch (error) {
      logger.error('USER_ACTIVE_BETS_RETRIEVAL_ERROR', {
        userId,
        gameSessionId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      return [];
    }
  }
}

const betTrackingService = new BetTrackingService(
  redisRepository
);

export default betTrackingService;
