import gameService from '../services/gameService.js';
import gameUtils from '../utils/gameUtils.js';
import BetService from '../services/betService.js';
import logger from '../config/logger.js';
import { authService } from '../services/authService.js';
import { validateToken } from '../utils/authUtils.js';
import jwt from 'jsonwebtoken';
import { EventEmitter } from 'events';

class GameSocket {
  constructor(io) {
    this.io = io;
    this.betService = new BetService();
    this.gameStateBroadcastInterval = null;
    // Track the last logged game ID to prevent multiple logs
    this.lastLoggedGameId = null;
    // Flag to track if active bets error has been logged
    this.hasLoggedActiveBetsError = false;
    // Flag to track if no active bets error has been logged in this game cycle
    this.hasLoggedNoActiveBetsError = false;
    // Flag to track if active bets have been logged in this game cycle
    this.hasLoggedActiveBetsSummary = false;
    this._lastBroadcastState = null;

    this.initializeSocket();
    this.setupGameStateListeners();
  }

  initializeSocket() {
    this.io.on('connection', async (socket) => {
      try {
        // Get token from handshake auth or query
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        
        if (!token) {
          logger.warn('No token provided for socket connection');
          socket.disconnect();
          return;
        }

        // Validate token
        const decoded = await this.validateToken(socket, token);
        if (!decoded) {
          logger.warn('Invalid token for socket connection');
          socket.disconnect();
          return;
        }

        logger.info(`User ${decoded.userId} connected to game socket`);
      } catch (authError) {
        logger.error('Socket authentication failed', {
          reason: authError.message
        });
        socket.disconnect(true);
      }

      socket.on('error', (error) => {
        logger.error('Socket connection error', {
          socketId: socket.id,
          reason: error.message
        });
      });

      socket.on('disconnect', () => {
        // No logging or actions needed
      });
    });

    this.startGameCycleWithSocketUpdates();
  }

  async validateToken(socket, token) {
    try {
      // Use shared token validation
      const decoded = await validateToken(token);
      
      // Get user profile
      try {
        const userId = parseInt(decoded.userId, 10);
        if (isNaN(userId)) {
          throw new Error(`Invalid user ID: "${decoded.userId}"`);
        }
        const user = await authService.getUserProfile(userId);
        socket.user = user;
      } catch (profileError) {
        logger.warn('User profile fetch failed, using token data', {
          userId: decoded.userId,
          error: profileError.message
        });
        // Create minimal user object from token
        socket.user = {
          user_id: decoded.userId,
          username: decoded.username || 'Guest User',
          role: decoded.role || 'user',
          is_active: true
        };
      }
      
      return decoded;
    } catch (error) {
      logger.error('Token validation failed', {
        reason: error.message
      });
      return null;
    }
  }

  startGameCycle() {
    this.hasLoggedActiveBetsError = false;
    this.hasLoggedNoActiveBetsError = false;
    this.hasLoggedActiveBetsSummary = false;
    this.startGameCycleWithSocketUpdates();
  }

  startGameCycleWithSocketUpdates() {
    gameService.startGameCycle();

    this.gameStateBroadcastInterval = setInterval(async () => {
      try {
        const currentGameState = gameService.getCurrentGameState();
        
        if (!currentGameState || !currentGameState.status) {
          return;
        }

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
            throw new Error(`Invalid game state: ${currentGameState.status}`)
        }
      } catch (error) {
        logger.error('Game state broadcast error', {
          reason: error.message
        });
      }
    }, 100);
  }

  setupGameStateListeners() {
    try {
      gameService.on('stateChange', (stateUpdate) => {
        this.broadcastGameState(stateUpdate);
      });
    } catch (error) {
      logger.error('GAME_STATE_LISTENER_SETUP_ERROR', {
        error: error.message
      });
    }
  }

  broadcastGameState(stateUpdate) {
    try {
      const formattedState = this.formatGameState(stateUpdate);
      // Broadcast to all connected clients
      this.io.emit('gameStateUpdate', formattedState);
    } catch (error) {
      logger.error('GAME_STATE_BROADCAST_ERROR', {
        gameId: stateUpdate?.gameId,
        error: error.message
      });
    }
  }

  formatGameState(state) {
    try {
      return {
        gameId: state.gameId,
        status: state.status,
        multiplier: parseFloat(state.multiplier || 1.00).toFixed(2),
        timestamp: Date.now(),
        ...(state.countdown && { countdown: state.countdown }),
        ...(state.status === 'crashed' && {
          crashPoint: parseFloat(state.crashPoint).toFixed(2),
          finalMultiplier: parseFloat(state.multiplier).toFixed(2)
        })
      };
    } catch (error) {
      logger.error('STATE_FORMAT_ERROR', {
        state: JSON.stringify(state),
        error: error.message
      });
      throw error;
    }
  }

  async broadcastBettingPhase(gameState) {
    try {
      this.io.emit('gameStateUpdate', {
        status: 'betting',
        gameId: gameState.gameId || null,
        multiplier: 1.00,  
        countdown: gameState.countdown,
        crashPoint: gameState.crashPoint ? gameState.crashPoint.toFixed(2) : '1.00',
        players: Array.isArray(gameState.players) ? gameState.players.length : 0,
        buttonState: {
          placeBet: true,    
          cashOut: false,    
          nextAction: 'placeBet'
        },
        betPhaseDetails: {
          remainingTime: gameState.countdown,
          startTime: gameState.startTime || Date.now()
        }
      });
    } catch (error) {
      logger.error('Error in broadcastBettingPhase', {
        errorMessage: error.message,
        errorStack: error.stack
      });
    }
  }

  async broadcastFlyingPhase(gameState) {
    try {
      const playerCount = Array.isArray(gameState.players) ? gameState.players.length : 0;

      // Get all sockets and their active bets
      const sockets = await this.io.fetchSockets();
      for (const socket of sockets) {
        const userId = socket.user?.user_id;
        if (!userId) continue;

        // Check if user has active bets, handle case where activeBets might be undefined
        const userActiveBets = gameState.activeBets ? gameState.activeBets.filter(bet => bet.userId === userId) : [];
        const hasActiveBets = userActiveBets.length > 0;

        // If user has active bets, emit betReadyForCashout for each bet
        if (hasActiveBets) {
          userActiveBets.forEach(bet => {
            socket.emit('betReadyForCashout', { betId: bet.id });
          });
        }

        // Send personalized game state update to each user
        socket.emit('gameStateUpdate', {
          status: 'flying',
          gameId: gameState.gameId || null,
          multiplier: Number(gameState.multiplier).toFixed(2), // Ensure consistent number formatting
          timestamp: Date.now(),
          players: playerCount,
          buttonState: {
            placeBet: false,   
            cashOut: hasActiveBets,
            nextAction: hasActiveBets ? 'cashout' : null
          }
        });
      }
    } catch (error) {
      logger.error('Error in broadcastFlyingPhase', {
        gameId: gameState?.gameId,
        errorMessage: error.message,
        errorStack: error.stack
      });
    }
  }

  async broadcastCrashedPhase(gameState) {
    try {
      const playerCount = Array.isArray(gameState.players) ? gameState.players.length : 0;

      // Broadcast crashed state to all clients with disabled cashout button
      this.io.emit('gameStateUpdate', {
        status: 'crashed',
        gameId: gameState.gameId || null,
        multiplier: gameState.crashPoint ? gameState.crashPoint.toFixed(2) : '1.00',
        countdown: gameState.countdown || 5,
        crashPoint: gameState.crashPoint ? gameState.crashPoint.toFixed(2) : '1.00',
        players: playerCount,
        buttonState: {
          placeBet: false,
          cashOut: false,  // Disable cashout button on crash
          nextAction: null
        }
      });
    } catch (error) {
      logger.error('Error in broadcastCrashedPhase', {
        errorMessage: error.message,
        errorStack: error.stack
      });
    }
  }

  broadcastBetActivation(bet) {
    try {
      this.io.emit('betActivated', {
        betId: bet.id,
        amount: bet.amount,
        user: bet.user,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Error in broadcastBetActivation', {
        errorMessage: error.message,
        errorStack: error.stack
      });
    }
  }

  calculatePlayerResult(player, crashPoint) {
    try {
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
      logger.error('Error in calculatePlayerResult', {
        errorMessage: error.message,
        errorStack: error.stack
      });
    }
  }

  // Broadcast game crash to all connected clients
  broadcastGameCrash(gameData) {
    try {
      logger.info('Broadcasting game crash', {
        gameId: gameData.gameId,
        crashPoint: gameData.crashPoint
      });

      // Broadcast to all connected clients
      this.io.emit('game_crash', {
        gameId: gameData.gameId,
        crashPoint: gameData.crashPoint,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error('Error broadcasting game crash', {
        errorMessage: error.message,
        errorStack: error.stack
      });
    }
  }
}

export default GameSocket;
