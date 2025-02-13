import { v4 as uuidv4 } from 'uuid';

export class PlayerBet {
  constructor(playerBetId, userId, gameSessionId, betAmount, cashoutMultiplier, status, payoutAmount) {
    this.playerBetId = playerBetId || uuidv4();
    this.userId = userId;
    this.gameSessionId = gameSessionId;
    this.betAmount = betAmount;
    this.cashoutMultiplier = cashoutMultiplier;
    this.status = status;
    this.payoutAmount = payoutAmount;
  }

  static fromRow(row) {
    return new PlayerBet(
      row.player_bet_id,
      row.user_id,
      row.game_session_id,
      row.bet_amount,
      row.cashout_multiplier,
      row.status,
      row.payout_amount
    );
  }

  toJSON() {
    return {
      playerBetId: this.playerBetId,
      userId: this.userId,
      gameSessionId: this.gameSessionId,
      betAmount: this.betAmount,
      cashoutMultiplier: this.cashoutMultiplier,
      status: this.status,
      payoutAmount: this.payoutAmount
    };
  }
}
