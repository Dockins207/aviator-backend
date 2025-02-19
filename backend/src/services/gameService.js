import { v4 as uuidv4 } from 'uuid'; 
import gameUtils from '../utils/gameUtils.js';
import gameConfig from '../config/gameConfig.js';
import GameRepository from '../repositories/gameRepository.js';
import RedisRepository from '../redis-services/redisRepository.js';
import GameSessionRepository from '../repositories/gameSessionRepository.js'; 
import logger from '../config/logger.js';
import betTrackingService from '../redis-services/betTrackingService.js'; 

// Custom error classes
class GameStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameStateError';
  }
}

class GameBoardService {
  static _instance = null;
  static _gameCycleInitialized = false;

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
    if (!GameBoardService._gameCycleInitialized) {
      this.initializeGameCycle().catch(error => {
        logger.error('Failed to initialize game cycle', {
          errorMessage: error.message,
          errorStack: error.stack
        });
      });
      GameBoardService._gameCycleInitialized = true;
    }
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
    // Ensure game cycle is started only once
    if (this.gameLoopInitialized) {
      return;
    }

    this.gameLoopInitialized = true;

    try {
      // Start the game cycle
      await this.startGameCycle();
    } catch (error) {
      logger.error('Game cycle initialization failed', {
        errorMessage: error.message,
        errorStack: error.stack
      });
      this.gameLoopInitialized = false;
    }
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
      countdown: 5,  
      activeBets: []
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
          countdown: 5,  
          activeBets: []
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

    // Place bets for each player
    this.gameState.players = this.gameState.players.map(player => {
      try {
        // Use placeBet for each player
        const placedBet = betTrackingService.placeBet({
          userId: player.userId,
          betAmount: player.betAmount,
          gameSessionId: this.gameState.gameId
        });
        return placedBet;
      } catch (error) {
        logger.error('BET_PLACEMENT_ERROR', {
          userId: player.userId,
          errorMessage: error.message
        });
        return null;
      }
    }).filter(bet => bet !== null);

    return new Promise((resolve) => {
      this.countdownInterval = setInterval(() => {
        // Decrease countdown
        this.gameState.countdown--;

        // When countdown reaches 0, activate bets and resolve
        if (this.gameState.countdown <= 0) {
          clearInterval(this.countdownInterval);
          
          // Activate prepared bets
          betTrackingService.activateBets(this.gameState);
          
          resolve();
        }
      }, 1000);
    });
  }

  // Start flying phase with multiplier progression
  async runFlyingPhase() {
    // Set flying state
    this.gameState.status = 'flying';
    this.gameState.startTime = Date.now();

    // Start multiplier calculation
    return new Promise((resolve, reject) => {
      this.multiplierInterval = setInterval(() => {
        // Calculate multiplier
        const elapsedTime = Date.now() - this.gameState.startTime;
        
        // Use simulateMultiplierProgression instead of non-existent calculateMultiplier
        this.gameState.multiplier = gameUtils.simulateMultiplierProgression(
          this.gameState.multiplier, 
          this.gameState.crashPoint
        );

        // Check for crash
        if (this.gameState.multiplier >= this.gameState.crashPoint) {
          clearInterval(this.multiplierInterval);
          
          // Finalize bets that haven't been cashed out
          this.handleGameCrash();
          
          resolve();
        }
      }, 100);
    });
  }

  handleGameCrash() {
    this.gameState.status = 'crashed';

    // Finalize all active bets as expired
    this.gameState.players.forEach(bet => {
      betTrackingService.finalizeBet(bet.betId, 'expired', this.gameState.multiplier);
    });
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