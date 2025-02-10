import { Server } from 'socket.io';
import gameService from '../services/gameService.js';
import gameUtils from '../utils/gameUtils.js';
import logger from '../config/logger.js';

class GameSocket {
  constructor(httpServer) {
    // Initialize Socket.IO server
    this.io = new Server(httpServer, {
      cors: {
        origin: process.env.FRONTEND_URL || '*',
        methods: ['GET', 'POST']
      }
    });

    // Game state broadcast interval
    this.gameStateBroadcastInterval = null;

    // Initialize socket connection
    this.initializeSocket();
  }

  initializeSocket() {
    this.io.on('connection', (socket) => {
      console.log(`[SOCKET] New client connected: ${socket.id}`);
      console.log(`[SOCKET] Connection details:`, {
        remoteAddress: socket.handshake.address,
        headers: socket.handshake.headers
      });

      // Log client connection events
      socket.on('connect', () => {
        console.log(`[SOCKET] Client ${socket.id} fully connected`);
      });

      socket.on('disconnect', (reason) => {
        console.log(`[SOCKET] Client ${socket.id} disconnected. Reason: ${reason}`);
      });

      // Attach error handlers
      socket.on('error', (error) => {
        console.error(`[SOCKET] Error with client ${socket.id}:`, error);
      });

      // Optional: Log any custom events
      socket.on('join_game', (data) => {
        console.log(`[GAME] Player joining game:`, data);
      });

      socket.on('place_bet', (data) => {
        console.log(`[GAME] Bet placed:`, data);
      });

      // Handle player joining the game
      socket.on('join_game', this.handlePlayerJoin.bind(this, socket));

      // Handle player betting
      socket.on('place_bet', this.handlePlayerBet.bind(this, socket));

      // Handle player cashing out
      socket.on('cash_out', this.handlePlayerCashOut.bind(this, socket));
    });

    // Log overall socket server setup
    console.log('[SOCKET] Socket server initialized');
    console.log('[SOCKET] CORS Configuration:', {
      origin: this.io.origins,
      methods: ['GET', 'POST']
    });

    // Start game cycle with socket updates
    this.startGameCycleWithSocketUpdates();
  }

  startGameCycleWithSocketUpdates() {
    console.log('[GAME] Starting game cycle with socket updates');
    
    // Start game cycle
    gameService.startGameCycle();

    // Broadcast game states in real-time
    this.gameStateBroadcastInterval = setInterval(() => {
      try {
        const currentGameState = gameService.getCurrentGameState();
        
        // Detailed logging of game state
        console.log('[GAME] Current Game State:', JSON.stringify({
          status: currentGameState.status,
          gameId: currentGameState.gameId,
          multiplier: currentGameState.multiplier,
          countdown: currentGameState.countdown,
          crashPoint: currentGameState.crashPoint,
          players: currentGameState.players.length
        }, null, 2));
        
        // Log number of connected clients
        const connectedClients = this.io.engine.clientsCount;
        console.log(`[SOCKET] Connected Clients: ${connectedClients}`);
        
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
          default:
            console.warn('[GAME] Unknown game state:', currentGameState.status);
        }
      } catch (error) {
        console.error('[GAME] Error in game state broadcast:', error);
      }
    }, 100); // Update every 100ms for smooth progression
  }

  startGameCycle() {
    this.startGameCycleWithSocketUpdates();
  }

  broadcastBettingPhase(gameState) {
    console.log('Broadcasting Betting Phase');
    try {
      this.io.emit('game_state', {
        status: 'betting',
        gameId: gameState.gameId,
        countdown: gameState.countdown,
        crashPoint: gameUtils.formatMultiplier(gameState.crashPoint),
        players: gameState.players.map(player => ({
          id: player.id,
          betAmount: player.betAmount
        }))
      });
    } catch (error) {
      console.error('Error broadcasting betting phase:', error);
    }
  }

  broadcastFlyingPhase(gameState) {
    console.log('Broadcasting Flying Phase');
    try {
      this.io.emit('game_state', {
        status: 'flying',
        gameId: gameState.gameId,
        multiplier: gameUtils.formatMultiplier(gameState.multiplier),
        startTime: gameState.startTime,
        players: gameState.players.map(player => ({
          id: player.id,
          betAmount: player.betAmount,
          potentialWinnings: this.calculatePotentialWinnings(player, gameState.multiplier)
        }))
      });
    } catch (error) {
      console.error('Error broadcasting flying phase:', error);
    }
  }

  broadcastCrashedPhase(gameState) {
    console.log('Broadcasting Crashed Phase');
    try {
      this.io.emit('game_state', {
        status: 'crashed',
        gameId: gameState.gameId,
        crashPoint: gameUtils.formatMultiplier(gameState.crashPoint),
        players: gameState.players.map(player => ({
          id: player.id,
          betAmount: player.betAmount,
          result: this.calculatePlayerResult(player, gameState.crashPoint)
        }))
      });
    } catch (error) {
      console.error('Error broadcasting crashed phase:', error);
    }
  }

  handlePlayerJoin(socket, playerData) {
    try {
      const player = {
        id: socket.id,
        ...playerData
      };
      gameService.addPlayer(player);
      socket.emit('join_game_success', { message: 'Successfully joined the game' });
    } catch (error) {
      logger.error('Error joining game:', error);
      socket.emit('join_game_error', { message: error.message });
    }
  }

  handlePlayerBet(socket, betData) {
    try {
      const bet = {
        playerId: socket.id,
        ...betData
      };
      gameService.placeBet(bet);
      socket.emit('place_bet_success', { message: 'Bet placed successfully' });
    } catch (error) {
      logger.error('Error placing bet:', error);
      socket.emit('place_bet_error', { message: error.message });
    }
  }

  handlePlayerCashOut(socket, cashOutData) {
    try {
      const cashOut = {
        playerId: socket.id,
        ...cashOutData
      };
      gameService.cashOut(cashOut);
      socket.emit('cash_out_success', { message: 'Cashed out successfully' });
    } catch (error) {
      logger.error('Error cashing out:', error);
      socket.emit('cash_out_error', { message: error.message });
    }
  }

  calculatePotentialWinnings(player, currentMultiplier) {
    // Calculate potential winnings based on current multiplier
    return Number((player.betAmount * currentMultiplier).toFixed(2));
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
