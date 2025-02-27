import { v4 as uuidv4 } from 'uuid';

export class PlayerBet {
  constructor(betId, userId, gameSessionId, betAmount, cashoutMultiplier, status, payoutAmount, autoCashoutMultiplier, betType, createdAt) {
    this.betId = betId || uuidv4();
    this.userId = userId;
    this.gameSessionId = gameSessionId;
    this.betAmount = betAmount;
    this.cashoutMultiplier = cashoutMultiplier;
    this.status = status;
    this.payoutAmount = payoutAmount;
    this.autoCashoutMultiplier = autoCashoutMultiplier;
    this.betType = betType;
    this.createdAt = createdAt || new Date();
  }

  static fromRow(row) {
    return new PlayerBet(
      row.bet_id,
      row.user_id,
      row.game_session_id,
      row.bet_amount,
      row.cashout_multiplier,
      row.status,
      row.payout_amount,
      row.autocashout_multiplier,
      row.bet_type,
      row.created_at
    );
  }

  toJSON() {
    return {
      betId: this.betId,
      userId: this.userId,
      gameSessionId: this.gameSessionId,
      betAmount: this.betAmount,
      cashoutMultiplier: this.cashoutMultiplier,
      status: this.status,
      payoutAmount: this.payoutAmount,
      autoCashoutMultiplier: this.autoCashoutMultiplier,
      betType: this.betType,
      createdAt: this.createdAt
    };
  }
}
