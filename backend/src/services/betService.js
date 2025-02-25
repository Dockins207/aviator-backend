import logger from '../config/logger.js';

class BetService {
  async placeBet(betDetails, req = {}) {
    // Logic for placing a bet
    try {
      // Validate bet details and user
      const validatedBetDetails = await this.validateBetData(betDetails);
      const authenticatedUser = await this.extractAuthenticatedUser(betDetails, req);

      // Store the bet in the database
      const betId = await this.gameRepository.storeBet({
        userId: authenticatedUser.user_id,
        amount: validatedBetDetails.amount,
        status: 'PLACED',
        createdAt: new Date().toISOString()
      });

      logger.info('BET_PLACED', { betId, userId: authenticatedUser.user_id });
      return { success: true, betId };
    } catch (error) {
      logger.error('BET_PLACEMENT_FAILED', { error: error.message });
      throw error;
    }
  }

  async processCashout(betId, currentMultiplier, socket) {
    try {
      // Validate bet ID and multiplier
      if (!betId || !currentMultiplier) {
        throw new Error('Invalid bet ID or multiplier');
      }

      // Fetch the bet details from the database
      const betDetails = await this.getBetDetails(betId);
      if (!betDetails) {
        throw new Error('Bet not found');
      }

      // Calculate the cashout amount
      const cashoutAmount = betDetails.amount * currentMultiplier;

      // Update the user's wallet balance
      const userId = betDetails.userId;
      await this.walletService.updateWalletBalance(userId, cashoutAmount);

      // Log cashout result
      logger.info('CASHOUT_PROCESSED', { betId, cashoutAmount });
      return {
        success: true,
        cashoutAmount,
        message: 'Cashout processed successfully'
      };
    } catch (error) {
      logger.error('CASHOUT_PROCESSING_ERROR', { error: error.message, betId });
      throw error;
    }
  }
}

export default new BetService();