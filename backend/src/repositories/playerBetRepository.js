import logger from '../config/logger.js';

export class PlayerBetRepository {
  // Prevent any direct database interactions
  static async placeBet() {
    logger.info('Direct bet placement prevented');
    return null;
  }

  static async countActiveBets() {
    logger.info('Active bets count retrieval prevented');
    return 0;
  }

  static async cashoutBet() {
    logger.info('Direct bet cashout prevented');
    return null;
  }

  static async settleBet() {
    logger.info('Direct bet settlement prevented');
    return null;
  }
}
