import logger from '../config/logger.js';
import GameRepository from '../repositories/gameRepository.js';
import WalletRepository from '../repositories/walletRepository.js';
import PlayerBetRepository from '../repositories/playerBetRepository.js';

class BetService {
  constructor() {
    this.gameRepository = new GameRepository();
    this.walletRepository = WalletRepository;

    // Configurable bet limits
    this.MIN_BET_AMOUNT = 10;
    this.MAX_BET_AMOUNT = 50000;
  }

  /**
   * Validate bet details before placement
   * @param {Object} betDetails - Details of the bet to validate
   * @returns {boolean} - Whether the bet details are valid
   * @throws {Error} - If bet details are invalid
   */
  validateBetDetails(betDetails) {
    // Comprehensive validation
    if (!betDetails) {
      logger.error('BET_VALIDATION_ERROR', {
        reason: 'No bet details provided',
        betDetails
      });
      throw new Error('Invalid bet details: No details provided');
    }

    // User ID validation
    if (!betDetails.userId) {
      logger.error('BET_VALIDATION_ERROR', {
        reason: 'User ID is required',
        betDetails
      });
      throw new Error('Invalid bet details: User ID is required');
    }

    // Validate userId format (assuming it's a UUID or string)
    if (typeof betDetails.userId !== 'string' || betDetails.userId.trim() === '') {
      logger.error('BET_VALIDATION_ERROR', {
        reason: 'Invalid User ID format',
        userId: betDetails.userId
      });
      throw new Error('Invalid bet details: User ID must be a non-empty string');
    }

    // Bet amount validation
    if (!betDetails.amount || typeof betDetails.amount !== 'number') {
      logger.error('BET_VALIDATION_ERROR', {
        reason: 'Invalid bet amount',
        amount: betDetails.amount
      });
      throw new Error('Invalid bet details: Bet amount must be a number');
    }

    if (betDetails.amount < this.MIN_BET_AMOUNT) {
      logger.warn('BET_VALIDATION_AMOUNT_TOO_LOW', {
        amount: betDetails.amount,
        minAmount: this.MIN_BET_AMOUNT
      });
      throw new Error(`Minimum bet amount is ${this.MIN_BET_AMOUNT}`);
    }

    if (betDetails.amount > this.MAX_BET_AMOUNT) {
      logger.warn('BET_VALIDATION_AMOUNT_TOO_HIGH', {
        amount: betDetails.amount,
        maxAmount: this.MAX_BET_AMOUNT
      });
      throw new Error(`Maximum bet amount is ${this.MAX_BET_AMOUNT}`);
    }

    // Optional auto-cashout validation
    if (betDetails.autoCashoutMultiplier !== undefined && betDetails.autoCashoutMultiplier !== null) {
      if (typeof betDetails.autoCashoutMultiplier !== 'number') {
        logger.error('BET_VALIDATION_ERROR', {
          reason: 'Invalid auto-cashout multiplier type',
          autoCashoutMultiplier: betDetails.autoCashoutMultiplier
        });
        throw new Error('Invalid auto-cashout multiplier: Must be a number');
      }

      if (betDetails.autoCashoutMultiplier <= 1) {
        logger.warn('BET_VALIDATION_AUTOCASHOUT_TOO_LOW', {
          autoCashoutMultiplier: betDetails.autoCashoutMultiplier
        });
        throw new Error('Invalid auto-cashout multiplier: Must be greater than 1');
      }
    }

    return true;
  }

  /**
   * Place a bet for a user
   * @param {Object} betDetails - Details of the bet to place
   * @returns {Promise<Object>} - Bet placement result
   */
  async placeBet(betDetails) {
    try {
      // Validate bet details
      this.validateBetDetails(betDetails);

      // Deduct bet amount from user's wallet using static method
      const walletTransaction = await WalletRepository.deposit(
        betDetails.userId, 
        null, 
        -betDetails.amount, 
        'Bet Placement', 
        'bet'
      );

      // Place the bet using PlayerBetRepository static method
      await PlayerBetRepository.placeBet({
        userId: betDetails.userId,
        betAmount: betDetails.amount,
        cashoutMultiplier: betDetails.cashoutMultiplier || null,
        autocashoutMultiplier: betDetails.autoCashoutMultiplier || null,
        status: 'pending',
        betType: 'standard'
      });

      // Log successful bet placement
      logger.info('BET_PLACED', { 
        userId: betDetails.userId, 
        amount: betDetails.amount,
        autoCashout: betDetails.autoCashoutMultiplier ? 'Yes' : 'No',
        walletBalance: walletTransaction.newBalance
      });

      return {
        success: true,
        message: 'Bet placed successfully',
        amount: betDetails.amount,
        status: 'pending',
        autoCashoutMultiplier: betDetails.autoCashoutMultiplier,
        walletBalance: walletTransaction.newBalance
      };
    } catch (error) {
      // Log bet placement error
      logger.error('BET_PLACEMENT_FAILED', { 
        userId: betDetails.userId,
        amount: betDetails.amount,
        errorMessage: error.message,
        errorStack: error.stack
      });

      throw error;
    }
  }

  /**
   * Process cashout for a bet
   * @param {number} betId - ID of the bet to cashout
   * @param {number} currentMultiplier - Current game multiplier
   * @returns {Promise<Object>} - Cashout result
   */
  async processCashout(betId, currentMultiplier) {
    try {
      // Validate bet ID and multiplier
      if (!betId || !currentMultiplier) {
        throw new Error('Invalid bet ID or multiplier');
      }

      // Fetch the bet details from the database
      const betDetails = await this.gameRepository.getBetDetails(betId);
      if (!betDetails) {
        throw new Error('Bet not found');
      }

      // Check if auto-cashout is triggered
      const isAutoCashout = betDetails.autoCashoutMultiplier && 
                             currentMultiplier >= betDetails.autoCashoutMultiplier;

      // Calculate the cashout amount
      const cashoutAmount = betDetails.amount * currentMultiplier;

      // Update user's wallet balance
      const walletTransaction = await WalletRepository.updateWalletBalance(
        betDetails.userId, 
        cashoutAmount
      );

      // Update bet status
      const updatedBet = await this.gameRepository.updateBetStatus(
        betId, 
        isAutoCashout ? 'auto_cashed_out' : 'cashed_out'
      );

      // Log cashout result
      logger.info('CASHOUT_PROCESSED', { 
        betId, 
        cashoutAmount, 
        currentMultiplier,
        autoCashoutTriggered: isAutoCashout,
        userId: betDetails.userId
      });

      return {
        success: true,
        betId,
        cashoutAmount,
        currentMultiplier,
        autoCashoutTriggered: isAutoCashout,
        walletBalance: walletTransaction.newBalance,
        message: isAutoCashout 
          ? 'Auto-cashout triggered' 
          : 'Cashout processed successfully'
      };
    } catch (error) {
      // Log cashout processing error
      logger.error('CASHOUT_PROCESSING_ERROR', { 
        betId,
        currentMultiplier,
        errorMessage: error.message 
      });

      throw error;
    }
  }
}

export default new BetService();