import { v4 as uuidv4 } from 'uuid'; 
import gameUtils from '../utils/gameUtils.js';
import gameConfig from '../config/gameConfig.js';
import GameRepository from '../repositories/gameRepository.js';
import RedisRepository from '../repositories/redisRepository.js';
import GameSessionRepository from '../repositories/gameSessionRepository.js'; 
import logger from '../config/logger.js';
import betTrackingService from './betTrackingService.js'; 

// Custom error classes
class GameStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameStateError';
  }
}

class GameBoardService {
  static _instance = null;

  constructor() {
    // Check if an instance already exists
    if (GameBoardService._instance) {
      return GameBoardService._instance;
    }

    this.resetGameState();
    this.countdownInterval = null;
    this.multiplierInterval = null;
    this.gameLoopActive = false;
    this.pauseBetweenGames = false;
    this.gameLoopInitialized = false;

    // Store the instance
    GameBoardService._instance = this;

    // Prevent multiple game cycle starts
    this.initializeGameCycle().catch(error => {
      logger.error('Failed to initialize game cycle', {
        errorMessage: error.message,
        errorStack: error.stack
      });
    });
  }

  // Static method to get the singleton instance
  static getInstance() {
    if (!this._instance) {
      this._instance = new GameBoardService();
    }
    return this._instance;
  }

  // Separate initialization method
  async initializeGameCycle() {
    // Prevent multiple initializations
    if (this.gameLoopInitialized) {
      return;
    }

    this.gameLoopInitialized = true;

    // Start game cycle
    await this.startGameCycle().catch(error => {
      logger.error('Failed to start initial game cycle', {
        errorMessage: error.message,
        errorStack: error.stack
      });
      this.gameLoopInitialized = false;
    });
  }

  // Prevent further instantiation
  static preventMultipleInstances() {
    if (this._instance) {
      logger.warn('Attempted to create multiple game service instances');
      return this._instance;
    }
  }

  // Reset game state to initial betting phase
  resetGameState() {
    this.gameState = {
      gameId: null,
      status: 'betting',
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
      logger.warn('Game cycle already in progress');
      return;
    }

    this.gameLoopActive = true;

    try {
      while (this.gameLoopActive) {
        // Reset game state to preparing
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
  async runBettingPhase() {
    // Set betting state
    this.gameState.status = 'betting';
    this.gameState.countdown = 5;

    // Start countdown
    return new Promise((resolve) => {
      this.countdownInterval = setInterval(() => {
        // Decrease countdown
        this.gameState.countdown--;

        // Prepare bets for activation in the last second
        if (this.gameState.countdown === 1) {
          betTrackingService.prepareBetsForLastSecondActivation(this.gameState);
        }

        // Check if countdown is complete
        if (this.gameState.countdown <= 0) {
          // Stop countdown
          clearInterval(this.countdownInterval);
          
          // Collect bets from betting state
          betTrackingService.collectBetsFromBettingState(this.gameState.players || []);
          
          resolve(this.gameState);
        }
      }, 1000);
    });
  }

  // Start flying phase with multiplier progression
  async runFlyingPhase() {
    // Set flying state
    this.gameState.status = 'flying';
    this.gameState.startTime = Date.now();
    this.gameState.multiplier = 1.00;

    // Generate crash point
    this.gameState.crashPoint = this.generateCrashPoint();

    // Start multiplier progression
    return new Promise((resolve, reject) => {
      // Activate prepared bets
      betTrackingService.activatePreparedBets(this.gameState);

      // Prepare bets for potential cashout
      betTrackingService.prepareBetsForCashout(this.gameState);

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
            this.crashGame().then(crashDetails => {
              clearInterval(this.multiplierInterval);
              resolve(crashDetails);
            }).catch(error => {
              clearInterval(this.multiplierInterval);
              reject(error);
            });
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
  async crashGame() {
    try {
      // Ensure game is in flying state before crashing
      if (this.gameState.status !== 'flying') {
        throw new GameStateError('Cannot crash game outside of flying phase');
      }

      this.gameState.status = 'crashed';
      this.gameState.multiplier = this.gameState.crashPoint;

      // Optional: Log crash details
      logger.info('Game crashed', {
        gameId: this.gameState.gameId,
        crashPoint: this.gameState.crashPoint
      });

      // Stop multiplier progression
      if (this.multiplierInterval) {
        clearInterval(this.multiplierInterval);
      }

      // Start countdown for next game
      this.startCountdown();

      // Return crash details for potential external use
      return {
        gameId: this.gameState.gameId,
        crashPoint: this.gameState.crashPoint,
        timestamp: Date.now()
      };

    } catch (error) {
      logger.error('Error in crashGame method', {
        error: error.message,
        stack: error.stack
      });
      
      // Ensure game state is reset even if there's an error
      this.resetGameState();

      throw error;
    }
  }

  // Get current game state
  getCurrentGameState() {
    return this.gameState;
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

  // Start countdown for next game
  startCountdown() {
    // Optional method to add any specific countdown logic
    // This can be used to prepare for the next game cycle
    logger.info('Preparing for next game cycle');
  }

  /**
   * Transition game to flying phase
   * @param {number} multiplier - Current game multiplier
   */
  transitionToFlyingPhase(multiplier) {
    // Update game state
    this.gameState.status = 'flying';
    this.gameState.multiplier = multiplier;

    // Prepare bets for activation
    betTrackingService.prepareBetsForLastSecondActivation(this.gameState);

    // Activate prepared bets
    betTrackingService.activatePreparedBets(this.gameState);

    // Prepare bets for potential cashout
    betTrackingService.prepareBetsForCashout(this.gameState);

    // Log game state transition
    logger.info('GAME_TRANSITIONED_TO_FLYING_PHASE', {
      gameId: this.gameState.gameId,
      multiplier: multiplier,
      status: this.gameState.status
    });
  }
}

export default GameBoardService.getInstance();