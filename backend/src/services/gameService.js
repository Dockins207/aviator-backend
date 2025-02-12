import gameUtils from '../utils/gameUtils.js';
import gameConfig from '../config/gameConfig.js';
import GameRepository from '../repositories/gameRepository.js';
import logger from '../config/logger.js';

class GameBoardService {
  constructor() {
    this.resetGameState();
    this.countdownInterval = null;
    this.multiplierInterval = null;
    this.gameLoopActive = false;
    this.pauseBetweenGames = false;
  }

  // Reset game state to initial betting phase
  resetGameState() {
    // Generate new crash point
    const newCrashPoint = gameUtils.generateCrashPoint();

    this.gameState = {
      status: 'betting',
      gameId: gameUtils.generateGameUUID(),
      multiplier: 1.00,
      countdown: 5,
      crashPoint: newCrashPoint,
      startTime: null,
      players: [],
      bets: []
    };
  }

  // Start game cycle
  async startGameCycle() {
    // Prevent multiple simultaneous game cycles
    if (this.gameLoopActive) {
      return;
    }

    try {
      // Mark game loop as active
      this.gameLoopActive = true;

      // Reset game state
      this.resetGameState();

      // Start betting phase
      await this.startBettingPhase();

      // Start flying phase
      await this.startFlyingPhase();

      // Crash game
      this.crashGame();
    } catch (error) {
      console.error('Game cycle error:', error);
    } finally {
      // Mark game loop as inactive
      this.gameLoopActive = false;

      // 4-second pause before next game
      await new Promise(resolve => setTimeout(resolve, 4000));

      // Start next game cycle
      this.startGameCycle();
    }
  }

  // Start betting phase with 5-second countdown
  startBettingPhase() {
    // Set betting state
    this.gameState.status = 'betting';
    this.gameState.countdown = 5;

    // Start countdown
    return new Promise((resolve) => {
      this.countdownInterval = setInterval(() => {
        // Decrease countdown
        this.gameState.countdown--;

        // Check if countdown is complete
        if (this.gameState.countdown <= 0) {
          // Stop countdown
          clearInterval(this.countdownInterval);
          
          resolve(this.gameState);
        }
      }, 1000);
    });
  }

  // Start flying phase with multiplier progression
  startFlyingPhase() {
    // Set flying state
    this.gameState.status = 'flying';
    this.gameState.startTime = Date.now();
    this.gameState.multiplier = 1.00;

    // Start multiplier progression
    return new Promise((resolve) => {
      this.multiplierInterval = setInterval(() => {
        try {
          // Use the progression method from gameUtils
          const previousMultiplier = this.gameState.multiplier;
          this.gameState.multiplier = gameUtils.simulateMultiplierProgression(
            this.gameState.multiplier, 
            this.gameState.crashPoint
          );
          
          // Check if game has crashed (exactly at crash point)
          if (this.gameState.multiplier === this.gameState.crashPoint) {
            clearInterval(this.multiplierInterval);
            resolve(this.gameState);
          }
        } catch (error) {
          clearInterval(this.multiplierInterval);
          resolve(this.gameState);
        }
      }, gameConfig.MULTIPLIER_UPDATE_INTERVAL);
    });
  }

  // Crash the game
  crashGame() {
    // Set game state to crashed
    this.gameState.status = 'crashed';
    
    // Ensure final multiplier matches the crash point exactly
    this.gameState.multiplier = this.gameState.crashPoint;

    // Log the entire gameState before calling saveGameResult
    logger.info('Attempting to save game result', { gameState: this.gameState });

    try {
      // Save game result to repository
      GameRepository.saveGameResult(this.gameState);
    } catch (error) {
      logger.error('Failed to save game result in crashGame', { 
        error: error.message,
        gameState: this.gameState
      });
      throw error;
    }
  }

  // Get current game state
  getCurrentGameState() {
    return { ...this.gameState };
  }

  // Placeholder methods to maintain structure
  addPlayer() {}
  placeBet() {}
  cashOut() {}
  addPlayerToBetting() {}
  playerCashOut() {}

  // Cleanup method
  destroy() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
    }
    if (this.multiplierInterval) {
      clearInterval(this.multiplierInterval);
    }
    logger.info('Game service resources cleaned up');
  }
}

export default new GameBoardService();