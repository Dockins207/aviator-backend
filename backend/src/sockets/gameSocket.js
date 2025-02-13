import gameService from '../services/gameService.js';
import gameUtils from '../utils/gameUtils.js';
import betService from '../services/betService.js';
import logger from '../config/logger.js'; // Assuming logger is defined in this file

class GameSocket {
  constructor(io) {
    // Store the Socket.IO instance
    this.io = io;

    // Store bet service
    this.betService = betService;

    // Game state broadcast interval
    this.gameStateBroadcastInterval = null;

    // Initialize socket connection
    this.initializeSocket();
  }

  initializeSocket() {
    this.io.on('connection', (socket) => {
      console.log(`[GAME_SOCKET] New client connected: ${socket.id}`);

      socket.on('connect', () => {
        console.log(`[GAME_SOCKET] Client ${socket.id} fully connected`);
      });

      socket.on('disconnect', (reason) => {
        console.log(`[GAME_SOCKET] Client ${socket.id} disconnected. Reason: ${reason}`);
      });

      // Attach error handlers
      socket.on('error', (error) => {
        console.error(`[GAME_SOCKET] Error with client ${socket.id}:`, error);
      });
    });

    // Start game cycle with socket updates
    this.startGameCycleWithSocketUpdates();
  }

  startGameCycleWithSocketUpdates() {
    // Start game cycle
    gameService.startGameCycle();

    // Broadcast game states in real-time
    this.gameStateBroadcastInterval = setInterval(async () => {
      try {
        const currentGameState = gameService.getCurrentGameState();
        
        // Validate game state
        if (!currentGameState || !currentGameState.status) {
          return;
        }

        // Broadcast different states with additional error handling
        try {
          switch(currentGameState.status) {
            case 'betting':
              this.broadcastBettingPhase(currentGameState);
              break;
            case 'flying':
              await this.broadcastFlyingPhase(currentGameState);
              break;
            case 'crashed':
              this.broadcastCrashedPhase(currentGameState);
              break;
            default:
              logger.warn('[GAME_SOCKET] Unknown game state', { 
                status: currentGameState.status,
                gameState: JSON.stringify(currentGameState)
              });
          }
        } catch (broadcastError) {
          logger.error('[GAME_SOCKET] Error broadcasting specific game state', {
            status: currentGameState.status,
            errorMessage: broadcastError.message,
            errorStack: broadcastError.stack
          });
        }
      } catch (error) {
        logger.error('[GAME_SOCKET] Error retrieving or broadcasting game state:', {
          errorMessage: error.message,
          errorStack: error.stack
        });
      }
    }, 100); // Update every 100ms for smooth progression
  }

  startGameCycle() {
    this.startGameCycleWithSocketUpdates();
  }

  async broadcastBettingPhase(gameState) {
    try {
      // Broadcast betting phase 
      this.io.emit('gameStateUpdate', {
        status: 'betting',
        gameId: gameState.gameId || null,
        multiplier: 1.00,  // Always 1.00 in betting phase
        countdown: gameState.countdown,
        crashPoint: gameState.crashPoint ? gameState.crashPoint.toFixed(2) : '1.00',
        players: Array.isArray(gameState.players) ? gameState.players.length : 0,
        buttonState: {
          placeBet: true,    // Always enable place bet button
          cashOut: false,    // Disable cashout button
          nextAction: 'placeBet'
        },
        betPhaseDetails: {
          remainingTime: gameState.countdown,
          startTime: gameState.startTime || Date.now()
        }
      });
    } catch (error) {
      // Silently handle any broadcasting errors
      console.error('Error in broadcastBettingPhase', error);
    }
  }

  async broadcastFlyingPhase(gameState) {
    try {
      // Safely get active bets or use an empty array
      let activeBets = [];
      if (this.betService && typeof this.betService.getActiveBets === 'function') {
        try {
          const rawActiveBets = await this.betService.getActiveBets();
          activeBets = Array.isArray(rawActiveBets) ? rawActiveBets : [];
        } catch (betError) {
          logger.warn('[GAME_SOCKET] Error fetching active bets', {
            errorMessage: betError.message,
            errorStack: betError.stack
          });
        }
      }

      // Safely get players count, defaulting to 0 if undefined
      const playerCount = Array.isArray(gameState.players) ? gameState.players.length : 0;

      // Broadcast flying phase with button state control and active bets
      this.io.emit('gameStateUpdate', {
        status: 'flying',
        gameId: gameState.gameId || null,
        multiplier: gameState.multiplier ? gameState.multiplier.toFixed(2) : '1.00',
        countdown: 0,  // No countdown in flying phase
        crashPoint: gameState.crashPoint ? gameState.crashPoint.toFixed(2) : '1.00',
        players: playerCount,
        buttonState: {
          placeBet: false,   // Disable place bet button
          cashOut: activeBets.length > 0,  // Enable cashout only if active bets exist
          nextAction: activeBets.length > 0 ? 'cashOut' : null
        },
        activeBets: activeBets.map(bet => ({
          id: bet.id || null,
          amount: bet.amount || 0,
          user: bet.user || null
        })),
        flyingPhaseDetails: {
          startTime: gameState.startTime || Date.now(),
          elapsedTime: Date.now() - (gameState.startTime || Date.now())
        }
      });
    } catch (error) {
      logger.error('[GAME_SOCKET] Error in broadcastFlyingPhase', {
        errorMessage: error.message,
        errorStack: error.stack,
        gameState: JSON.stringify(gameState)
      });
    }
  }

  broadcastCrashedPhase(gameState) {
    try {
      // Safely get players count, defaulting to 0 if undefined
      const playerCount = Array.isArray(gameState.players) ? gameState.players.length : 0;

      // Broadcast crashed phase with button state control
      this.io.emit('gameStateUpdate', {
        status: 'crashed',
        gameId: gameState.gameId || null,
        multiplier: gameState.multiplier ? gameState.multiplier.toFixed(2) : '1.00',
        countdown: 0,  // No countdown in crashed phase
        crashPoint: gameState.crashPoint ? gameState.crashPoint.toFixed(2) : '1.00',
        players: playerCount,
        buttonState: {
          placeBet: true,    // Always enable place bet button
          cashOut: false,    // Disable cashout button
          nextAction: 'placeBet'
        },
        crashDetails: {
          crashMultiplier: `@${gameState.crashPoint ? gameState.crashPoint.toFixed(2) : '1.00'}x`,
          gameDuration: Date.now() - (gameState.startTime || Date.now())
        }
      });
    } catch (error) {
      logger.error('[GAME_SOCKET] Error in broadcastCrashedPhase', {
        errorMessage: error.message,
        errorStack: error.stack,
        gameState: JSON.stringify(gameState)
      });
    }
  }

  /**
   * Broadcast when a bet is activated for cashout
   * @param {Object} bet - Bet that has been activated
   */
  broadcastBetActivation(bet) {
    try {
      this.io.emit('betActivated', {
        betId: bet.id,
        amount: bet.amount,
        user: bet.user,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('[GAME_SOCKET] Error in broadcastBetActivation', {
        errorMessage: error.message,
        errorStack: error.stack,
        bet: JSON.stringify(bet)
      });
    }
  }

  calculatePlayerResult(player, crashPoint) {
    try {
      // Determine if player won or lost based on cash out point
      if (player.cashOutPoint && player.cashOutPoint < crashPoint) {
        return {
          status: 'won',
          winnings: Number((player.betAmount * player.cashOutPoint).toFixed(2))
        };
      } else {
        return {
          status: 'lost',
          winnings: 0
        };
      }
    } catch (error) {
      logger.error('[GAME_SOCKET] Error in calculatePlayerResult', {
        errorMessage: error.message,
        errorStack: error.stack,
        player: JSON.stringify(player),
        crashPoint: crashPoint
      });
    }
  }
}

export default GameSocket;
