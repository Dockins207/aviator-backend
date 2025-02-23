import crypto from 'crypto';

class WagerMonitor {
  constructor(
    userId, 
    gameId, 
    betAmount, 
    cashoutPoint = null, 
    cashoutAmount = null, 
    status = 'active',
    multiplier = null
  ) {
    this.id = crypto.randomUUID();
    this.userId = userId;
    this.gameId = gameId;
    this.betAmount = this.validateBetAmount(betAmount);
    this.cashoutPoint = cashoutPoint;
    this.cashoutAmount = cashoutAmount;
    this.status = status;
    this.multiplier = multiplier;
    this.createdAt = new Date().toISOString();
    this.updatedAt = null;
    this.gameCrashed = false;
  }

  // Validate bet amount to ensure it's a positive number
  validateBetAmount(amount) {
    const parsedAmount = parseFloat(amount);
    
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new Error('Invalid bet amount. Must be a positive number.');
    }
    
    return parsedAmount;
  }

  // Update cashout details with multiplier
  updateCashout(cashoutPoint, multiplier) {
    if (this.status !== 'active') {
      throw new Error('Cannot update cashout for a non-active wager');
    }

    this.cashoutPoint = cashoutPoint;
    this.multiplier = this.validateMultiplier(multiplier);
    this.cashoutAmount = this.calculateCashoutAmount();
    this.status = 'completed';
    this.updatedAt = new Date().toISOString();

    return this;
  }

  // Validate multiplier
  validateMultiplier(multiplier) {
    const parsedMultiplier = parseFloat(multiplier);
    
    if (isNaN(parsedMultiplier) || parsedMultiplier < 1) {
      throw new Error('Invalid multiplier. Must be a number greater than or equal to 1.');
    }
    
    return parsedMultiplier;
  }

  // Calculate cashout amount based on multiplier
  calculateCashoutAmount() {
    if (!this.multiplier) {
      return null;
    }
    return this.betAmount * this.multiplier;
  }

  // Validate cashout amount
  validateCashoutAmount(amount) {
    const parsedAmount = parseFloat(amount);
    
    if (isNaN(parsedAmount) || parsedAmount < 0) {
      throw new Error('Invalid cashout amount. Must be a non-negative number.');
    }
    
    return parsedAmount;
  }

  // Check if wager is profitable
  isProfitable() {
    if (!this.cashoutAmount) return null;
    return this.cashoutAmount > this.betAmount;
  }

  // Calculate profit/loss
  calculateProfit() {
    if (!this.cashoutAmount) return null;
    return this.cashoutAmount - this.betAmount;
  }

  // Handle game crash scenario
  handleGameCrash() {
    if (this.status !== 'active') {
      throw new Error('Cannot handle game crash for a non-active wager');
    }

    this.status = 'crashed';
    this.gameCrashed = true;
    this.cashoutPoint = 'x';
    this.cashoutAmount = 'x';
    this.multiplier = null;
    this.updatedAt = new Date().toISOString();

    return this;
  }

  // Convert to plain object for storage/transmission
  toJSON() {
    return {
      id: this.id,
      userId: this.userId,
      gameId: this.gameId,
      betAmount: this.betAmount,
      cashoutPoint: this.gameCrashed ? 'x' : this.cashoutPoint,
      cashoutAmount: this.gameCrashed ? 'x' : this.cashoutAmount,
      status: this.status,
      multiplier: this.multiplier,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      gameCrashed: this.gameCrashed
    };
  }

  // Static method to create from database row or existing object
  static fromRow(row) {
    const wager = new WagerMonitor(
      row.userId, 
      row.gameId, 
      row.betAmount, 
      row.cashoutPoint, 
      row.cashoutAmount, 
      row.status,
      row.multiplier
    );
    
    // Preserve the original ID if provided
    if (row.id) {
      wager.id = row.id;
    }
    
    // Set game crash status if applicable
    wager.gameCrashed = row.gameCrashed || false;
    
    // Set timestamps if provided
    if (row.createdAt) wager.createdAt = row.createdAt;
    if (row.updatedAt) wager.updatedAt = row.updatedAt;

    return wager;
  }
}

export default WagerMonitor;
