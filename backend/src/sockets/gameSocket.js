import gameService from '../services/gameService.js';
import gameUtils from '../utils/gameUtils.js';

class GameSocket {
  constructor(io) {
    // Store the Socket.IO instance
    this.io = io;

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
    this.gameStateBroadcastInterval = setInterval(() => {
      try {
        const currentGameState = gameService.getCurrentGameState();
        
        // Broadcast different states
        switch(currentGameState.status) {
          case 'betting':
            this.broadcastBettingPhase(currentGameState);
            break;
          case 'flying':
            this.broadcastFlyingPhase(currentGameState);
            break;
          case 'crashed':
            this.broadcastCrashedPhase(currentGameState);
            break;
        }
      } catch (error) {
        console.error('[GAME_SOCKET] Error broadcasting game state:', error);
      }
    }, 100); // Update every 100ms for smooth progression
  }

  startGameCycle() {
    this.startGameCycleWithSocketUpdates();
  }

  broadcastBettingPhase(gameState) {
    // Broadcast betting phase with enhanced details
    this.io.emit('gameStateUpdate', {
      status: 'betting',
      gameId: gameState.gameId,
      multiplier: 1.00,  // Always 1.00 in betting phase
      countdown: gameState.countdown,
      crashPoint: gameState.crashPoint.toFixed(2),
      players: gameState.players.length,
      betPhaseDetails: {
        remainingTime: gameState.countdown,
        startTime: Date.now()
      }
    });
  }

  broadcastFlyingPhase(gameState) {
    // Broadcast flying phase with enhanced details
    this.io.emit('gameStateUpdate', {
      status: 'flying',
      gameId: gameState.gameId,
      multiplier: gameState.multiplier.toFixed(2),
      countdown: 0,  // No countdown in flying phase
      crashPoint: gameState.crashPoint.toFixed(2),
      players: gameState.players.length,
      flyingPhaseDetails: {
        startTime: gameState.startTime,
        elapsedTime: Date.now() - gameState.startTime
      }
    });
  }

  broadcastCrashedPhase(gameState) {
    // Broadcast crashed phase with enhanced details
    this.io.emit('gameStateUpdate', {
      status: 'crashed',
      gameId: gameState.gameId,
      multiplier: gameState.multiplier.toFixed(2),
      countdown: 0,  // No countdown in crashed phase
      crashPoint: gameState.crashPoint.toFixed(2),
      players: gameState.players.length,
      crashDetails: {
        crashMultiplier: `@${gameState.crashPoint.toFixed(2)}x`,
        gameDuration: Date.now() - gameState.startTime
      }
    });
  }

  calculatePlayerResult(player, crashPoint) {
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
  }
}

export default GameSocket;
