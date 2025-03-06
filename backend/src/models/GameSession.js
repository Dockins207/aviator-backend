export class GameSession {
  constructor(id, gameType, status, totalBetAmount, crashPoint, createdAt, updatedAt) {
    this.id = id;
    this.gameType = gameType;
    this.status = status;
    this.totalBetAmount = totalBetAmount;
    this.crashPoint = crashPoint;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  static fromRow(row) {
    return new GameSession({
      id: row.game_session_id,
      gameType: row.game_type,
      status: row.status,
      totalBetAmount: parseFloat(row.total_bet_amount || 0),
      crashPoint: row.crash_point ? parseFloat(row.crash_point) : null,
      createdAt: row.created_at,
    });
  }
}
