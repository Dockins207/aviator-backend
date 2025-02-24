import gameService from '../services/gameService.js';
import gameUtils from '../utils/gameUtils.js';
import betService from '../services/betService.js';
import logger from '../config/logger.js';
import { authService } from '../services/authService.js';
import jwt from 'jsonwebtoken';

class GameSocket {
  constructor(io) {
    this.io = io;
    this.betService = betService;
    this.gameStateBroadcastInterval = null;
    // Track the last logged game ID to prevent multiple logs
    this.lastLoggedGameId = null;
    // Flag to track if active bets error has been logged
    this.hasLoggedActiveBetsError = false;
    // Flag to track if no active bets error has been logged in this game cycle
    this.hasLoggedNoActiveBetsError = false;
    // Flag to track if active bets have been logged in this game cycle
    this.hasLoggedActiveBetsSummary = false;

    this.initializeSocket();
  }

  initializeSocket() {
    this.io.on('connection', (socket) => {
      socket.on('authenticate', async (token) => {
        try {
          const user = await this.authenticateUser(token);
          socket.user = user;
        } catch (authError) {
          logger.error('Socket authentication failed', {
            reason: authError.message
          });
          socket.disconnect(true);
        }
      });

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

  async authenticateUser(token) {
    try {
      // Verify the JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET || '520274659b0b083575095c7f82961352a2bfa4d11c606b8e67c4d48d17be6237');
      
      // Get user profile using the decoded user ID
      const user = await authService.getUserProfile(decoded.userId);
      
      return user;
    } catch (error) {
      logger.error('User authentication failed', {
        reason: error.message
      });
      throw error;
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

      this.io.emit('gameStateUpdate', {
        status: 'flying',
        gameId: gameState.gameId || null,
        multiplier: gameState.multiplier ? gameState.multiplier.toFixed(2) : '1.00',
        countdown: 0,  
        crashPoint: gameState.crashPoint ? gameState.crashPoint.toFixed(2) : '1.00',
        players: playerCount,
        buttonState: {
          placeBet: false,   
          cashOut: false,  
          nextAction: null
        },
        flyingPhaseDetails: {
          startTime: gameState.startTime || Date.now(),
          elapsedTime: Date.now() - (gameState.startTime || Date.now())
        }
      });
    } catch (error) {
      logger.error('Error in broadcastFlyingPhase', {
        errorMessage: error.message,
        errorStack: error.stack
      });
    }
  }

  broadcastCrashedPhase(gameState) {
    try {
      const playerCount = Array.isArray(gameState.players) ? gameState.players.length : 0;

      this.io.emit('gameStateUpdate', {
        status: 'crashed',
        gameId: gameState.gameId || null,
        multiplier: gameState.multiplier ? gameState.multiplier.toFixed(2) : '1.00',
        countdown: 0,  
        crashPoint: gameState.crashPoint ? gameState.crashPoint.toFixed(2) : '1.00',
        players: playerCount,
        buttonState: {
          placeBet: true,    
          cashOut: false,    
          nextAction: 'placeBet'
        },
        crashDetails: {
          crashMultiplier: `@${gameState.crashPoint ? gameState.crashPoint.toFixed(2) : '1.00'}x`,
          gameDuration: Date.now() - (gameState.startTime || Date.now())
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
