import { v4 as uuidv4 } from 'uuid';
import gameService from './gameService.js';
import gameUtils from '../utils/gameUtils.js';
import logger from '../config/logger.js';
import { WalletRepository } from '../repositories/walletRepository.js';
import GameRepository from '../repositories/gameRepository.js';
import RedisRepository from '../repositories/redisRepository.js';

// Custom validation error class
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

class BetService {
  constructor() {
    // Current game bets
    this.currentBets = [];
    // Successful bets that can be cashed out
    this.activeBets = [];
  }

  /**
   * Place a bet with user-triggered activation flag
   * @param {Object} betData - Bet details
   * @returns {Object} Bet placement result
   */
  async placeBet(betData) {
    try {
      const currentGameState = gameService.getCurrentGameState();

      // STRICT: Only allow bets during BETTING or CRASHED states
      const allowedStates = ['betting', 'crashed'];
      if (!allowedStates.includes(currentGameState.status)) {
        const errorMsg = `Betting not allowed in ${currentGameState.status} state`;
        logger.error(errorMsg, { 
          currentState: currentGameState.status,
          allowedStates: allowedStates
        });
        throw new ValidationError(errorMsg);
      }

      // Validate user ID and bet amount
      if (!betData.user) {
        throw new ValidationError('User ID is required');
      }

      const MIN_BET = 10;  // Minimum bet amount
      const MAX_BET = 1000;  // Maximum bet amount
      if (!betData.amount || betData.amount < MIN_BET) {
        throw new ValidationError(`Minimum bet amount is ${MIN_BET}`);
      }

      if (betData.amount > MAX_BET) {
        throw new ValidationError(`Maximum bet amount is ${MAX_BET}`);
      }

      // Generate unique bet ID
      const betId = v4();

      // Validate user's wallet balance
      const walletRepository = new WalletRepository();
      const userWallet = await walletRepository.getWalletByUserId(betData.user);

      if (!userWallet || userWallet.balance < betData.amount) {
        throw new ValidationError('Insufficient wallet balance');
      }

      // Deduct bet amount from wallet
      await walletRepository.deductBalance(betData.user, betData.amount);

      // Create bet record
      const gameRepository = new GameRepository();
      const currentGameSession = await gameRepository.getCurrentGameSession();

      const betRecord = {
        playerBetId: betId,
        userId: betData.user,
        gameSessionId: currentGameSession.gameSessionId,
        betAmount: betData.amount,
        status: 'placed',
        cashoutMultiplier: null,
        payoutAmount: null
      };

      // Save bet to database
      const savedBet = await gameRepository.createPlayerBet(betRecord);

      // Add to active bets tracking
      this.currentBets.push(savedBet);

      logger.info('Bet placed successfully', { 
        userId: savedBet.userId, 
        gameType: currentGameSession.gameType,
        betAmount: savedBet.betAmount 
      });

      return savedBet;
    } catch (error) {
      // Handle and log errors
      logger.error('BET_PLACEMENT_ERROR', {
        errorMessage: error.message,
        userId: betData.user,
        betAmount: betData.amount
      });

      // Rethrow or handle specific error types
      if (error instanceof ValidationError) {
        throw error;
      }

      throw new Error('Bet placement failed');
    }
  }

  async cashoutBet(betId, userId) {
    try {
      const gameRepository = new GameRepository();
      const bet = await gameRepository.getPlayerBetById(betId);

      if (!bet || bet.userId !== userId) {
        throw new ValidationError('Invalid bet or unauthorized access');
      }

      // Implement cashout logic
      const currentGameState = gameService.getCurrentGameState();
      const cashoutMultiplier = currentGameState.currentMultiplier;

      const updateBetRecord = {
        playerBetId: betId,
        status: 'cashout',
        cashoutMultiplier: cashoutMultiplier,
        payoutAmount: bet.betAmount * cashoutMultiplier
      };

      const updatedBet = await gameRepository.updatePlayerBet(updateBetRecord);

      // Credit wallet with cashout amount
      const walletRepository = new WalletRepository();
      await walletRepository.creditBalance(userId, updatedBet.payoutAmount);

      return updatedBet;
    } catch (error) {
      logger.error('BET_CASHOUT_ERROR', {
        playerBetId: betId,
        userId,
        errorMessage: error.message
      });

      throw error;
    }
  }

  /**
   * Get active bets based on user-triggered activation
   * @returns {Array} List of active bets
   */
  async getActiveBets() {
    const currentGameState = gameService.getCurrentGameState();
    
    // Only return user-activated bets during flying state
    if (currentGameState.status === 'flying') {
      // Fetch active bets from Redis
      const activeBets = await RedisRepository.getActiveBets(currentGameState.gameId);
      
      return activeBets.filter(bet => 
        bet.isUserActivated === true
      );
    }
    
    return [];
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
        throw new ValidationError('Bet activation only allowed during flying state');
      }

      // Find the bet in current bets
      const betIndex = this.currentBets.findIndex(b => b.id === betId);
      
      if (betIndex === -1) {
        logger.warn('Attempt to activate non-existent bet', { betId });
        throw new ValidationError('Bet not found');
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

  static async placeBet(userId, betAmount, gameType) {
    try {
      // Deduct bet amount from wallet
      const remainingBalance = await WalletRepository.placeBet(userId, betAmount);

      // Create game record
      const gameId = await GameRepository.createGameRecord(userId, gameType, betAmount);

      logger.info('Bet placed successfully', { 
        userId, 
        gameType,
        betAmount 
      });

      return {
        success: true,
        remainingBalance,
        gameId
      };
    } catch (error) {
      logger.error('Bet placement failed', { 
        userId, 
        betAmount, 
        gameType,
        errorMessage: error.message 
      });
      throw error;
    }
  }

  static async resolveGameOutcome(userId, gameId, winAmount) {
    try {
      // If user won
      if (winAmount > 0) {
        const newBalance = await WalletRepository.processWinnings(userId, winAmount);
        
        // Update game record
        await GameRepository.updateGameOutcome(gameId, 'WIN', winAmount);

        logger.info('Game won successfully', { 
          userId, 
          gameId, 
          winAmount 
        });

        return {
          success: true,
          winAmount,
          newBalance
        };
      }

      // If user lost, just update game record
      await GameRepository.updateGameOutcome(gameId, 'LOSS', 0);

      logger.info('Game lost', { 
        userId, 
        gameId 
      });

      return {
        success: true,
        winAmount: 0
      };
    } catch (error) {
      logger.error('Game resolution failed', { 
        userId, 
        gameId, 
        winAmount,
        errorMessage: error.message 
      });
      throw error;
    }
  }
}

export default new BetService();
