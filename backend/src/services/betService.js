import gameService from './gameService.js';
import gameUtils from '../utils/gameUtils.js';

class BetService {
  constructor() {
    // Current game bets
    this.currentBets = [];
  }

  /**
   * Place a bet for the current game
   * @param {Object} betData - Bet details
   * @returns {Object} Bet placement result
   */
  placeBet(betData) {
    const currentGameState = gameService.getCurrentGameState();

    // Only allow bets during betting phase
    if (currentGameState.status !== 'betting') {
      throw new Error('Betting is closed');
    }

    // Basic bet validation
    if (!betData.amount || betData.amount <= 0) {
      throw new Error('Invalid bet amount');
    }

    // Create bet object
    const bet = {
      id: gameUtils.generateGameUUID(),
      gameId: currentGameState.gameId,
      amount: betData.amount,
      user: betData.user || 'Anonymous',
      timestamp: Date.now(),
      status: 'pending'
    };

    // Add bet to current game
    this.currentBets.push(bet);

    return {
      success: true,
      betId: bet.id,
      message: 'Bet placed successfully'
    };
  }

  /**
   * Cashout a bet during the flying phase
   * @param {Object} cashoutData - Cashout details
   * @returns {Object} Cashout result
   */
  cashoutBet(cashoutData) {
    const currentGameState = gameService.getCurrentGameState();

    // Only allow cashout during flying phase
    if (currentGameState.status !== 'flying') {
      throw new Error('Cashout is not available');
    }

    // Find the specific bet
    const betIndex = this.currentBets.findIndex(
      bet => bet.id === cashoutData.betId
    );

    if (betIndex === -1) {
      throw new Error('Bet not found');
    }

    // Calculate winnings based on current multiplier
    const bet = this.currentBets[betIndex];
    const winnings = bet.amount * currentGameState.multiplier;

    // Update bet status
    bet.status = 'cashed_out';
    bet.winnings = winnings;

    return {
      success: true,
      betId: bet.id,
      winnings,
      multiplier: currentGameState.multiplier,
      message: 'Bet cashed out successfully'
    };
  }

  /**
   * Get current active bets
   * @returns {Array} List of current bets
   */
  getCurrentBets() {
    return this.currentBets;
  }

  /**
   * Reset bets between game cycles
   */
  resetBets() {
    this.currentBets = [];
  }
}

export default new BetService();
