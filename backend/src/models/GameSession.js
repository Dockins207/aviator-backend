export class GameSession {
  constructor(id, gameType, status, totalBetAmount, startedAt, endedAt) {
    this.id = id;
    this.gameType = gameType;
    this.status = status;
    this.totalBetAmount = totalBetAmount;
    this.startedAt = startedAt;
    this.endedAt = endedAt;
  }

  static fromRow(row) {
    return new GameSession(
      row.id,
      row.game_type,
      row.status,
      row.total_bet_amount,
      row.started_at,
      row.ended_at
    );
  }
}
