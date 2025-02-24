import { v4 as uuidv4 } from 'uuid'; 
import gameUtils from '../utils/gameUtils.js';
import gameConfig from '../config/gameConfig.js';
import GameRepository from '../repositories/gameRepository.js';
import RedisRepository from '../redis-services/redisRepository.js';
import GameSessionRepository from '../repositories/gameSessionRepository.js'; 
import logger from '../config/logger.js';
import betTrackingService from '../redis-services/betTrackingService.js'; 
import statsService from './statsService.js';
import cacheService from '../redis-services/cacheService.js';
import notificationService from '../services/notificationService.js';
import socketService from '../services/socketService.js';
import gameReportingService from '../services/gameReportingService.js';

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
        statsService.resetStatsOnGameCrash();
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
      statsService.resetStatsOnGameCrash();
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
        
        // Create a database game session
        const gameSession = await GameRepository.createGameSession('aviator', 'in_progress');
        
        // Initialize game state
        this.gameState = {
          gameId: gameSession.game_session_id,  // Use database game session ID
          status: 'betting',
          startTime: Date.now(),
          multiplier: 1.00,
          crashPoint: this.generateCrashPoint(),
          players: [],  
          countdown: 5,  
          activeBets: []
        };

        // Log initial game state
        logger.info('GAME_STATE_INITIALIZED', {
          service: 'aviator-backend',
          gameId: this.gameState.gameId,
          status: this.gameState.status,
          timestamp: new Date().toISOString()
        });

        // Betting phase
        await this.runBettingPhase();

        // Flying phase
        try {
          await this.runFlyingPhase();
        } catch (flyingError) {
          logger.error('Error during flying phase', {
            errorMessage: flyingError.message,
            errorStack: flyingError.stack
          });
          
          // Reset stats on game crash
          statsService.resetStatsOnGameCrash();
        }

        // Crashed state pause
        this.gameState.state = 'crashed';
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

      // Reset stats on game crash
      statsService.resetStatsOnGameCrash();
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
    try {
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
        this.countdownInterval = setInterval(async () => {
          // Decrease countdown
          this.gameState.countdown--;

          // When countdown reaches 0, activate all bets and resolve
          if (this.gameState.countdown <= 0) {
            clearInterval(this.countdownInterval);
            
            try {
              // Activate both placed and queued bets
              const activationResults = await betTrackingService.bulkActivateAllBets(this.gameState.gameId);
              
              logger.info('BETS_ACTIVATED', {
                gameId: this.gameState.gameId,
                totalBets: activationResults.successCount + activationResults.failedCount,
                successCount: activationResults.successCount,
                failedCount: activationResults.failedCount,
                processingTime: activationResults.processingTime
              });

              // Update game state with activated bets
              this.gameState.activeBets = activationResults.successfulBetIds;
            } catch (error) {
              logger.error('BET_ACTIVATION_ERROR', {
                gameId: this.gameState.gameId,
                error: error.message,
                stack: error.stack
              });
            }
            
            resolve();
          }
        }, 1000);
      });
    } catch (error) {
      logger.error('BETTING_PHASE_ERROR', {
        gameId: this.gameState.gameId,
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
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
    // Capture the exact crash point
    const crashMultiplier = Number(this.gameState.multiplier.toFixed(2));
    const crashPoint = Number(this.gameState.crashPoint.toFixed(2));

    // Update game state to crashed
    this.gameState.status = 'crashed';
    this.gameState.crashMultiplier = crashMultiplier;
    this.gameState.crashTimestamp = new Date().toISOString();

    // Finalize all active bets as expired
    this.gameState.players.forEach(bet => {
      betTrackingService.finalizeBet(bet.betId, 'expired', crashMultiplier);
    });

    statsService.resetStatsOnGameCrash();

    // Broadcast crash event with precise multiplier
    if (socketService) {
      socketService.broadcastGameStateChange({
        gameId: this.gameState.gameId,
        state: 'crashed',
        crashMultiplier: crashMultiplier,
        crashPoint: crashPoint,
        timestamp: this.gameState.crashTimestamp
      }, true);
    }

    // Log crash details
    logger.warn('GAME_CRASHED', {
      gameId: this.gameState.gameId,
      crashMultiplier: crashMultiplier,
      crashPoint: crashPoint,
      timestamp: this.gameState.crashTimestamp,
      totalPlayers: this.gameState.players.length
    });

    return {
      gameId: this.gameState.gameId,
      crashMultiplier: crashMultiplier,
      crashPoint: crashPoint,
      timestamp: this.gameState.crashTimestamp
    };
  }

  // Get current game state
  getCurrentGameState() {
    // Validate game state
    if (!this.gameState) {
      logger.error('INVALID_GAME_STATE', {
        service: 'aviator-backend',
        error: 'Game state is undefined',
        timestamp: new Date().toISOString()
      });
      throw new GameStateError('Game state is undefined');
    }

    // Only log when the game state actually changes
    if (!this._lastStateValue || this._lastStateValue !== this.gameState.status) {
      logger.debug('GAME_STATE_CHANGED', {
        service: 'aviator-backend',
        previousState: this._lastStateValue || 'none',
        newState: this.gameState.status,
        gameId: this.gameState.gameId,
        timestamp: new Date().toISOString()
      });

      this._lastStateValue = this.gameState.status;
    }

    const gameState = {
      ...this.gameState,
      state: this.gameState.status, // Add state field for backward compatibility
      timestamp: new Date().toISOString()
    };

    return gameState;
  }

  // Get current game session details
  getCurrentGameSession() {
    try {
      if (!this.gameState || !this.gameState.gameId) {
        return null;
      }

      return {
        id: this.gameState.gameId,
        status: this.gameState.status,
        multiplier: this.gameState.multiplier,
        startTime: this.gameState.startTime,
        crashPoint: this.gameState.crashPoint
      };
    } catch (error) {
      logger.error('Error getting current game session', {
        error: error.message,
        stack: error.stack
      });
      return null;
    }
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
   * Transition game to flying phase with comprehensive bet activation
   * @param {Object} gameState - Current game state
   * @returns {Object} Game transition result
   */
  async transitionToFlyingPhase(gameState) {
    try {
      // Log game state transition
      logger.info('Transitioning to Flying Phase', {
        gameId: gameState.gameId,
        timestamp: new Date().toISOString()
      });

      // Validate game state
      if (!gameState || !gameState.gameId) {
        throw new Error('Invalid game state for transition');
      }

      // Process queued bets before activation
      const queuedBets = await betTrackingService.getQueuedBets(gameState.gameId);
      
      // Validate and filter queued bets for transfer
      const validatedQueuedBets = await Promise.all(
        queuedBets.map(bet => 
          betTrackingService.validateQueuedBetTransfer(bet, gameState.gameId)
        )
      );

      const transferableBets = validatedQueuedBets
        .filter(result => result.isValid)
        .map(result => ({
          ...result.betDetails,
          status: betTrackingService.BET_STATES.PLACED  // Ensure correct status for activation
        }));

      // Log queued bet validation results
      logger.info('Queued Bet Transfer Validation', {
        totalQueuedBets: queuedBets.length,
        validBets: transferableBets.length,
        gameId: gameState.gameId
      });

      // Attempt bulk bet activation with validated queued bets
      const bulkActivationResult = await betTrackingService.activateBets(
        gameState, 
        transferableBets  // Pass validated bets
      );

      // Handle activation results
      if (bulkActivationResult.error) {
        // Primary bulk activation failed, attempt fallback
        logger.warn('Bulk Bet Activation Failed, Initiating Fallback', {
          gameId: gameState.gameId,
          errorMessage: bulkActivationResult.errorMessage
        });

        // Fallback to individual bet activation
        const fallbackResult = await betTrackingService.fallbackActivateBets(gameState);

        // Log fallback results
        logger.info('Fallback Bet Activation Results', {
          gameId: gameState.gameId,
          successCount: fallbackResult.activatedBets.length,
          failedBetIds: fallbackResult.failedBetIds
        });
      }

      // Update game state to flying
      const updatedGameState = await this.updateGameState(gameState.gameId, {
        status: 'flying',
        startMultiplier: 1.00,
        startedAt: new Date().toISOString()
      });

      // Remove successfully processed queued bets
      if (transferableBets.length > 0) {
        await betTrackingService.removeProcessedQueuedBets(
          transferableBets.map(bet => bet.id || bet.betId), 
          gameState.gameId
        );
      }

      return {
        success: true,
        gameState: updatedGameState,
        betActivation: bulkActivationResult,
        processedQueuedBets: transferableBets.length
      };
    } catch (error) {
      // Comprehensive error handling
      logger.error('Game Transition to Flying Phase Failed', {
        gameId: gameState.gameId,
        errorMessage: error.message,
        errorStack: error.stack
      });

      throw error;
    }
  }

  /**
   * Update game state with comprehensive management
   * @param {string} gameId - Unique game identifier
   * @param {Object} updates - State update details
   * @returns {Object} Updated game state
   */
  async updateGameState(gameId, updates) {
    try {
      // Validate input
      if (!gameId) {
        throw new Error('Game ID is required for state update');
      }

      // Prepare game state key
      const gameStateKey = `game:state:${gameId}`;
      const cacheCacheKey = `game:${gameId}`;

      // Attempt to retrieve current state from cache first
      let currentState = await cacheService.get(cacheCacheKey);

      // If not in cache, fetch from repository
      if (!currentState) {
        currentState = await this.redisRepository.getGameState(gameId) || {};
      }

      // Merge with existing state to preserve historical data
      const updatedState = {
        ...currentState,
        ...updates,
        lastUpdated: new Date().toISOString()
      };

      // Validate state transitions
      this.validateStateTransition(currentState.status, updatedState.status);

      // Atomic Redis update
      await this.redisRepository.updateGameState(gameStateKey, updatedState);

      // Update cache with new state
      await cacheService.set(cacheCacheKey, updatedState, 3600); // 1-hour cache

      // Log state update
      this.logger.info('Game State Updated', {
        gameId,
        previousStatus: currentState.status,
        newStatus: updatedState.status,
        updates
      });

      // Trigger any necessary side effects based on state change
      await this.handleStateChangeSideEffects(gameId, currentState, updatedState);

      return updatedState;
    } catch (error) {
      // Comprehensive error handling
      this.logger.error('Game State Update Failed', {
        gameId,
        errorMessage: error.message,
        errorStack: error.stack
      });

      throw error;
    }
  }

  /**
   * Validate state transition rules
   * @param {string} currentStatus - Current game status
   * @param {string} newStatus - Proposed new status
   */
  validateStateTransition(currentStatus, newStatus) {
    const VALID_TRANSITIONS = {
      'waiting': ['betting'],
      'betting': ['flying'],
      'flying': ['crashed', 'completed'],
      'crashed': ['waiting', 'betting'],
      'completed': ['waiting', 'betting']
    };

    if (!VALID_TRANSITIONS[currentStatus]?.includes(newStatus)) {
      throw new Error(`Invalid state transition from ${currentStatus} to ${newStatus}`);
    }
  }

  /**
   * Handle side effects of game state changes
   * @param {string} gameId - Game identifier
   * @param {Object} previousState - Previous game state
   * @param {Object} newState - New game state
   */
  async handleStateChangeSideEffects(gameId, previousState, newState) {
    switch (newState.status) {
      case 'betting':
        if (previousState.status === 'crashed') {
          // Process any queued bets from previous session
          const queuedBets = await betTrackingService.getQueuedBets();
          if (queuedBets && queuedBets.length > 0) {
            logger.info('PROCESSING_QUEUED_BETS', {
              gameId,
              queuedBetsCount: queuedBets.length
            });
            await betTrackingService.processQueuedBets(gameId);
          }
        }
        break;

      case 'flying':
        // Prepare for bet tracking and multiplier generation
        await betTrackingService.prepareBetsForTracking(gameId);
        break;
      
      case 'crashed':
        // Settle all active bets
        await betTrackingService.settleBets(gameId);
        break;
      
      case 'completed':
        // Final game cleanup and reporting
        await gameReportingService.generateGameReport(gameId);
        break;
    }
  }

  /**
   * Transition to betting state and activate placed bets
   * @param {string} gameSessionId - Current game session ID
   */
  async transitionToBettingState(gameSessionId) {
    try {
      // Update game state
      await this.redisRepository.updateGameState(gameSessionId, 'betting');
      
      // Activate any placed bets for this session
      await this.redisRepository.activatePlacedBets(gameSessionId);
      
      logger.info('Transitioned to betting state', {
        gameSessionId,
        state: 'betting',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to transition to betting state', {
        gameSessionId,
        error: error.message
      });
      throw error;
    }
  }

  // Transition to betting phase
  async transitionToBettingPhase() {
    try {
      const gameSessionId = await this.getCurrentGameSessionId();
      if (!gameSessionId) {
        throw new Error('No active game session found');
      }

      // Transition to betting state (this will also activate placed bets)
      await this.transitionToBettingState(gameSessionId);

      // Notify clients of state change
      this.io.emit('game:betting_phase', {
        gameSessionId,
        timestamp: new Date().toISOString()
      });

      logger.info('Game transitioned to betting phase', {
        gameSessionId,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Failed to transition to betting phase', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }
}

export default GameBoardService.getInstance();