const gameUtils = require('../utils/gameUtils');
const gameConfig = require('../config/gameConfig');
const GameRepository = require('../repositories/gameRepository');

class GameBoardService {
  constructor() {
    this.resetGameState();
    this.countdownInterval = null;
    this.multiplierInterval = null;
    this.gameLoopActive = false;
  }

  // Reset game state to initial betting phase
  resetGameState() {
    this.gameState = {
      status: 'betting',
      gameId: gameUtils.generateGameUUID(),
      multiplier: 1,
      countdown: 5,
      crashPoint: null,
      startTime: null,
      players: []
    };
  }

  // Start game cycle
  async startGameCycle() {
    if (this.gameLoopActive) {
      return;
    }

    this.gameLoopActive = true;

    try {
      // Start betting phase
      await this.startBettingPhase();

      // Start flying phase
      await this.startFlyingPhase();
    } catch (error) {
      console.error('Game cycle error:', error);
    } finally {
      this.gameLoopActive = false;
    }
  }

  // Start betting phase with 5-second countdown
  startBettingPhase() {
    // Reset game state
    this.resetGameState();

    // Start countdown
    return new Promise((resolve) => {
      this.countdownInterval = setInterval(() => {
        // Decrease countdown
        this.gameState.countdown--;

        // Check if countdown is complete
        if (this.gameState.countdown <= 0) {
          // Stop countdown
          clearInterval(this.countdownInterval);
          
          // Automatically transition to flying phase
          resolve(this.gameState);
        }
      }, 1000);
    });
  }

  // Start flying phase with multiplier progression
  startFlyingPhase() {
    // Generate crash point
    this.gameState.status = 'flying';
    this.gameState.startTime = Date.now();
    this.gameState.multiplier = 1;
    this.gameState.crashPoint = gameUtils.generateCrashPoint();

    // Start multiplier progression
    return new Promise((resolve) => {
      this.multiplierInterval = setInterval(() => {
        // Generate a dynamic increment with randomness
        const baseIncrement = 0.02;
        const randomFactor = 1 + (Math.random() * 0.1 - 0.05); // +/- 5% variation
        const exponentialFactor = Math.pow(1.03, this.gameState.multiplier); // Slower exponential growth
        
        // Calculate new increment with multiple factors
        const increment = baseIncrement * randomFactor * exponentialFactor;
        
        // Ensure precision and prevent extreme values
        this.gameState.multiplier = Number(Math.min(this.gameState.multiplier + increment, 100).toFixed(2));
        
        // Check if game has crashed
        if (this.gameState.multiplier >= this.gameState.crashPoint) {
          clearInterval(this.multiplierInterval);
          this.crashGame();
          resolve(this.gameState);
        }
      }, gameConfig.MULTIPLIER_UPDATE_INTERVAL);
    });
  }

  // Crash the game
  crashGame() {
    // Set game state to crashed
    this.gameState.status = 'crashed';
    
    // Ensure final multiplier matches the crash point
    this.gameState.multiplier = this.gameState.crashPoint;
    
    // Log the final multiplier
    console.log(`Game crashed at multiplier: ${this.gameState.multiplier}`);
    
    // Settle bets for players
    this.gameState.players = this.gameState.players.map(player => {
      if (player.status === 'in_game') {
        player.status = player.autoCashout && player.autoCashout <= this.gameState.multiplier 
          ? 'won' 
          : 'lost';
      }
      return player;
    });

    // Save game result to repository
    GameRepository.saveGameResult(this.gameState);

    return this.gameState;
  }

  // Add player during betting phase
  addPlayerToBetting(playerId, betAmount) {
    if (this.gameState.status !== 'betting') {
      throw new Error('Cannot add players outside of betting phase');
    }

    // Check for duplicate players
    const existingPlayerIndex = this.gameState.players.findIndex(p => p.playerId === playerId);
    if (existingPlayerIndex !== -1) {
      // Update existing player's bet
      this.gameState.players[existingPlayerIndex].betAmount = betAmount;
    } else {
      // Add new player
      this.gameState.players.push({
        playerId,
        betAmount,
        status: 'in_game',
        autoCashout: null
      });
    }

    return this.gameState;
  }

  // Player cash out during flying phase
  playerCashOut(playerId, autoCashout) {
    if (this.gameState.status !== 'flying') {
      throw new Error('Cannot cash out outside of flying phase');
    }

    const playerIndex = this.gameState.players.findIndex(p => p.playerId === playerId);
    if (playerIndex === -1) {
      throw new Error('Player not found in current game');
    }

    this.gameState.players[playerIndex].autoCashout = autoCashout;
    
    return this.gameState;
  }

  // Get current game state
  getGameState() {
    return this.gameState;
  }

  // Cleanup method
  destroy() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
    if (this.multiplierInterval) {
      clearInterval(this.multiplierInterval);
    }
  }
}

module.exports = new GameBoardService();