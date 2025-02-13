import gameUtils from '../utils/gameUtils.js';
import gameConfig from '../config/gameConfig.js';
import GameRepository from '../repositories/gameRepository.js';
import RedisRepository from '../repositories/redisRepository.js';
import logger from '../config/logger.js';

// Custom error classes
class GameStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameStateError';
  }
}

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
    this.gameState = {
      gameId: null,
      status: 'idle',
      startTime: null,
      multiplier: 1.00,
      crashPoint: null,
      players: [],  
      countdown: 5  
    };
    
    // Clear any existing intervals
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    
    if (this.multiplierInterval) {
      clearInterval(this.multiplierInterval);
      this.multiplierInterval = null;
    }
  }

  // Enhanced game cycle with Redis metrics
  async startGameCycle() {
    // Prevent multiple game cycles from running simultaneously
    if (this.gameLoopActive) {
      return;
    }

    // Set game loop as active
    this.gameLoopActive = true;

    try {
      while (this.gameLoopActive) {
        // Reset game state to idle
        this.resetGameState();

        // Generate unique game ID
        const gameId = gameUtils.generateGameUUID();
        
        // Initialize game state
        this.gameState = {
          gameId: gameId,
          status: 'betting',
          startTime: Date.now(),
          multiplier: 1.00,
          crashPoint: this.generateCrashPoint(),
          players: [],  
          countdown: 5  
        };

        // Track game metrics in Redis
        await RedisRepository.incrementGameMetrics(
          gameId, 
          'total_games_started', 
          1
        );

        // Betting phase
        await this.runBettingPhase();

        // Flying phase
        try {
          await this.runFlyingPhase();
        } catch (flyingError) {
          // If flying phase fails, log and continue to next game cycle
          logger.error('Flying phase failed', {
            errorMessage: flyingError.message,
            errorStack: flyingError.stack
          });
          continue;
        }

        // Crashed state pause
        this.gameState.status = 'crashed';
        // Pause for 4 seconds in crashed state
        await new Promise(resolve => setTimeout(resolve, 4000));

        // Increment total crashes metric
        RedisRepository.incrementGameMetrics(
          this.gameState.gameId, 
          'total_crashes', 
          1
        );

        // Optional: Add additional pause between game cycles if configured
        if (this.pauseBetweenGames) {
          await new Promise(resolve => setTimeout(resolve, gameConfig.PAUSE_BETWEEN_GAMES || 3000));
        }
      }
    } catch (error) {
      logger.error('Game cycle failed', {
        errorMessage: error.message,
        errorStack: error.stack
      });
      
      // Reset game state and loop active flag
      this.gameLoopActive = false;
      this.resetGameState();
    }
  }

  // Method to stop the game loop
  stopGameCycle() {
    this.gameLoopActive = false;
    
    // Clear any existing intervals
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    
    if (this.multiplierInterval) {
      clearInterval(this.multiplierInterval);
      this.multiplierInterval = null;
    }
  }

  // Start betting phase with 5-second countdown
  runBettingPhase() {
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
  runFlyingPhase() {
    // Set flying state
    this.gameState.status = 'flying';
    this.gameState.startTime = Date.now();
    this.gameState.multiplier = 1.00;

    // Start multiplier progression
    return new Promise((resolve, reject) => {
      this.multiplierInterval = setInterval(() => {
        try {
          // Use the progression method from gameUtils
          const previousMultiplier = this.gameState.multiplier;
          this.gameState.multiplier = gameUtils.simulateMultiplierProgression(
            this.gameState.multiplier, 
            this.gameState.crashPoint
          );
          
          // Check if game has crashed (exactly at crash point)
          if (this.gameState.multiplier >= this.gameState.crashPoint) {
            // Explicitly call crashGame method
            this.crashGame();

            clearInterval(this.multiplierInterval);
            resolve(this.gameState);
          }
        } catch (error) {
          logger.error('Error in flying phase multiplier progression', {
            errorMessage: error.message,
            errorStack: error.stack
          });
          clearInterval(this.multiplierInterval);
          reject(error);
        }
      }, gameConfig.MULTIPLIER_UPDATE_INTERVAL);
    });
  }

  // Crash the game when multiplier reaches crash point
  crashGame() {
    try {
      // Ensure game is in flying state before crashing
      if (this.gameState.status !== 'flying') {
        throw new GameStateError('Cannot crash game outside of flying phase');
      }

      // Set final game state
      this.gameState.status = 'crashed';
      this.gameState.multiplier = this.gameState.crashPoint;

      // Track crash metrics in Redis
      RedisRepository.incrementGameMetrics(
        this.gameState.gameId, 
        'total_crashes', 
        1
      );

      // Broadcast crash event to players
      // Note: This would typically be handled by the socket service
      return this.gameState;
    } catch (error) {
      logger.error('Error in crashGame method', {
        errorMessage: error.message,
        errorStack: error.stack
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
  }

  generateCrashPoint() {
    return gameUtils.generateCrashPoint();
  }
}

export default new GameBoardService();