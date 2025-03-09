import { v4 as uuidv4 } from 'uuid'; 
import gameUtils from '../utils/gameUtils.js';
import gameConfig from '../config/gameConfig.js';
import GameRepository from '../repositories/gameRepository.js';
import logger from '../config/logger.js';
import notificationService from '../services/notificationService.js';
import socketService from '../services/socketService.js';
import { EventEmitter } from 'events';

// Custom error classes
class GameStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameStateError';
  }
}

class GameBoardService extends EventEmitter {
  static _instance = null;
  static _gameCycleInitialized = false;

  constructor() {
    super(); // Initialize EventEmitter

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

  // REPLACE startGameCycle method
  async startGameCycle() {
    // Check if a cycle is already running
    if (this._cycleInProgress === true) {
      logger.warn('GAME_CYCLE_ALREADY_RUNNING', {
        service: 'aviator-backend'
      });
      return;
    }
    
    // Set flag to indicate cycle is in progress
    this._cycleInProgress = true;
    
    try {
      // Reset state and clear intervals
      this.resetGameState();
      
      // Use the enhanced method with locking instead
      const gameSession = await GameRepository.createGameSessionWithLock('aviator', 'betting');
      
      // Set game state
      this.gameState.gameId = gameSession.game_session_id;
      this.gameState.status = 'betting';
      this.gameState.crashPoint = this.generateCrashPoint();
      
      logger.info('NEW_GAME_CYCLE_STARTED', {
        service: 'aviator-backend',
        gameId: gameSession.game_session_id,
        initialStatus: 'betting',
        crashPoint: this.gameState.crashPoint
      });

      // 1. Run betting phase with countdown
      await this.runBettingPhase();
      
      // 2. Update database game session status to in_progress
      await GameRepository.updateGameSessionStatus(this.gameState.gameId, 'in_progress');
      
      // 3. Run flying phase (crash happens inside this phase)
      await this.runFlyingPhase();
      
      // 4. Run crashed phase to show results (3 seconds)
      await this.runCrashedPhase();
      
      // 5. Wait before starting next game (smooth transition)
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (error) {
      logger.error('GAME_CYCLE_FAILED', {
        service: 'aviator-backend',
        errorMessage: error.message,
        errorStack: error.stack
      });
    } finally {
      // Reset the cycle flag regardless of success/failure
      this._cycleInProgress = false;
      
      // Schedule next game cycle with a delay
      setTimeout(() => {
        this.startGameCycle();
      }, 1000);
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

  // REPLACE runBettingPhase method
  async runBettingPhase() {
    try {
      // Clear any existing countdown interval
      if (this.countdownInterval) {
        clearInterval(this.countdownInterval);
        this.countdownInterval = null;
      }
      
      // Reset and set betting state
      this.gameState.status = 'betting';
      this.gameState.countdown = 5;
      this.gameState.multiplier = 1.00; // Reset multiplier

      // Send initial state to clients
      socketService.broadcastGameStateChange({
        gameId: this.gameState.gameId,
        state: 'betting',
        countdown: 5,
        timestamp: new Date().toISOString()
      });

      return new Promise((resolve) => {
        let secondsLeft = 5;
        
        this.countdownInterval = setInterval(() => {
          secondsLeft--;
          this.gameState.countdown = secondsLeft;
          
          // Broadcast countdown update
          socketService.broadcastGameStateChange({
            gameId: this.gameState.gameId,
            state: 'betting',
            countdown: secondsLeft,
            timestamp: new Date().toISOString()
          });

          // When countdown reaches 0, resolve
          if (secondsLeft <= 0) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
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

  // REPLACE runFlyingPhase method
  async runFlyingPhase() {
    try {
      // Update game state to flying
      this.gameState.status = 'flying';
      this.gameState.startTime = Date.now();
      this.gameState.multiplier = 1.00;
      this.gameState.lastUpdateTime = Date.now();
      
      // Log initial state change (important)
      logger.info('GAME_FLYING_PHASE_STARTED', {
        gameId: this.gameState.gameId,
        initialMultiplier: 1.00
      });
      
      // Broadcast initial flying state
      this.updateGameStateAndNotify({
        status: 'flying',
        multiplier: 1.00
      });

      return new Promise((resolve) => {
        // Reduce the update frequency here if needed
        // 50ms is fine for smooth client updates, but we can log less frequently
        this.multiplierInterval = setInterval(() => {
          const currentTime = Date.now();
          const timeDiff = currentTime - this.gameState.lastUpdateTime;
          
          // Calculate smooth multiplier increment based on time difference
          const increment = (timeDiff / 1000) * 0.1; // 0.1 per second
          this.gameState.multiplier = parseFloat((this.gameState.multiplier + increment).toFixed(2));
          this.gameState.lastUpdateTime = currentTime;

          // REMOVE ALL MULTIPLIER LOGGING - do not log milestones at all
          // Simply update clients without any logging
          this.updateGameStateAndNotify({
            multiplier: this.gameState.multiplier
          });

          // Check for crash
          if (this.gameState.multiplier >= this.gameState.crashPoint) {
            clearInterval(this.multiplierInterval);
            this.multiplierInterval = null;
            this.handleGameCrash().then(resolve);
          }
        }, 50);
      });
    } catch (error) {
      logger.error('Error during flying phase', {
        gameId: this.gameState.gameId,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async runCrashedPhase() {
  try {
    // Set crashed state
    this.gameState.status = 'crashed';
    
    // Log at an appropriate level
    logger.info('GAME_CRASHED_PHASE', {
      gameId: this.gameState.gameId,
      crashPoint: this.gameState.multiplier.toFixed(2)
    });
    
    // Notify clients
    if (socketService) {
      socketService.broadcastGameStateChange({
        gameId: this.gameState.gameId,
        state: 'crashed',
        crashPoint: this.gameState.multiplier.toFixed(2),
        timestamp: new Date().toISOString()
      });
    }
    
    // Wait for display duration
    return new Promise(resolve => {
      // Wait 3 seconds in crashed state before continuing
      setTimeout(() => {
        resolve();
      }, 3000);
    });
  } catch (error) {
    logger.error('Error in runCrashedPhase', {
      service: 'aviator-backend',
      errorMessage: error.message,
      errorStack: error.stack
    });
    // Still resolve so the game cycle can continue
    return Promise.resolve();
  }
}

// Fix the handleGameCrash method to ensure accurate crash points are saved
async handleGameCrash() {
  // Validate game state
  if (!this.gameState || !this.gameState.gameId) {
    logger.error('INVALID_GAME_STATE_FOR_CRASH', {
      gameState: this.gameState,
      timestamp: new Date().toISOString()
    });
    return null;
  }

  try {
    // IMPORTANT: Use the CURRENT multiplier value as the crash point
    // NOT the predefined crashPoint value
    const finalMultiplier = parseFloat(this.gameState.multiplier.toFixed(2));
    
    // Log the crash point values to debug
    logger.info('CRASH_POINT_DEBUG', {
      gameId: this.gameState.gameId,
      currentMultiplier: finalMultiplier,
      original_crashPoint: this.gameState.crashPoint
    });
    
    // Update game state to crashed
    this.gameState.status = 'crashed';
    this.gameState.crashTimestamp = new Date().toISOString();
    
    // CRITICAL FIX: Directly update the database with the crash point
    const result = await GameRepository.markGameSessionComplete(
      this.gameState.gameId,
      finalMultiplier
    );
    
    // Double-check that the database update was successful
    const gameRepo = new GameRepository();
    const verifyResult = await gameRepo.pool.query(
      'SELECT crash_point FROM game_sessions WHERE game_session_id = $1',
      [this.gameState.gameId]
    );
    
    logger.info('CRASH_POINT_VERIFICATION', {
      gameId: this.gameState.gameId,
      savedCrashPoint: verifyResult.rows[0]?.crash_point,
      requestedCrashPoint: finalMultiplier
    });
    
    // Broadcast crash event with precise multiplier
    if (socketService) {
      socketService.broadcastGameStateChange({
        gameId: this.gameState.gameId,
        state: 'crashed',
        crashPoint: finalMultiplier,
        timestamp: this.gameState.crashTimestamp
      }, true);
    }
    
    return {
      gameId: this.gameState.gameId,
      crashPoint: finalMultiplier,
      timestamp: this.gameState.crashTimestamp
    };
  } catch (error) {
    logger.error('GAME_SESSION_COMPLETE_ERROR', {
      gameId: this.gameState.gameId,
      errorMessage: error.message,
      errorStack: error.stack
    });
    
    // FALLBACK: Try direct update if the repository method fails
    try {
      const finalMultiplier = parseFloat(this.gameState.multiplier.toFixed(2));
      const gameRepo = new GameRepository();
      await gameRepo.pool.query(
        `UPDATE game_sessions 
         SET status = 'completed', crash_point = $1, ended_at = CURRENT_TIMESTAMP 
         WHERE game_session_id = $2`,
        [finalMultiplier, this.gameState.gameId]
      );
    } catch (fallbackError) {
      logger.error('FALLBACK_UPDATE_FAILED', {
        gameId: this.gameState.gameId,
        errorMessage: fallbackError.message
      });
    }
    
    return null;
  }
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
      const queuedBets = await GameRepository.getQueuedBets(gameState.gameId);
      
      // Validate and filter queued bets for transfer
      const validatedQueuedBets = await Promise.all(
        queuedBets.map(bet => 
          GameRepository.validateQueuedBetTransfer(bet, gameState.gameId)
        )
      );

      const transferableBets = validatedQueuedBets
        .filter(result => result.isValid)
        .map(result => ({
          ...result.betDetails,
          status: 'placed'  // Ensure correct status for activation
        }));

      // Log queued bet validation results
      logger.info('Queued Bet Transfer Validation', {
        totalQueuedBets: queuedBets.length,
        validBets: transferableBets.length,
        gameId: gameState.gameId
      });

      // Attempt bulk bet activation with validated queued bets
      const bulkActivationResult = await GameRepository.activateBets(
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
        const fallbackResult = await GameRepository.fallbackActivateBets(gameState);

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
        await GameRepository.removeProcessedQueuedBets(
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
          const queuedBets = await GameRepository.getQueuedBets(gameId);
          if (queuedBets && queuedBets.length > 0) {
            logger.info('PROCESSING_QUEUED_BETS', {
              gameId,
              queuedBetsCount: queuedBets.length
            });
            await GameRepository.processQueuedBets(gameId);
          }
        }
        break;

      case 'flying':
        // Prepare for bet tracking and multiplier generation
        await GameRepository.prepareBetsForTracking(gameId);
        break;
      
      case 'crashed':
        // Settle all active bets
        await GameRepository.settleBets(gameId);
        break;
      
      case 'completed':
        // Final game cleanup
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

  // Replace the updateGameStateAndNotify method to reduce log frequency
  updateGameStateAndNotify(newState) {
    // Update the state
    this.gameState = {
      ...this.gameState,
      ...newState
    };

    const isSignificantChange = 
      newState.status || // Status changes are important
      newState.countdown === 5 || // Start of countdown
      newState.countdown === 0 || // End of countdown
      (newState.multiplier && Math.floor(newState.multiplier) > Math.floor(this.previousLoggedMultiplier || 0));

    // Emit state change event for local listeners (no logging)
    this.emit('stateChange', this.gameState);
    
    // Broadcast to clients via socketService but with minimal logging
    if (socketService) {
      // Only pass forceLog = true for significant events
      const forceLog = isSignificantChange;
      
      // Track the last logged multiplier value
      if (newState.multiplier && isSignificantChange) {
        this.previousLoggedMultiplier = newState.multiplier;
      }
      
      // Direct socket broadcast without additional logging
      socketService.broadcastGameStateChange({
        gameId: this.gameState.gameId,
        state: this.gameState.status,
        multiplier: this.gameState.multiplier,
        countdown: this.gameState.countdown,
        timestamp: new Date().toISOString(),
        ...newState
      }, forceLog);
    }
  }

  // Alias for backward compatibility 
  updateGameState(newState) {
    return this.updateGameStateAndNotify(newState);
  }
}

export default GameBoardService.getInstance();