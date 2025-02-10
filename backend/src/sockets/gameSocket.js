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
      logger.info('New client connected:', socket.id);

      // Handle player joining the game
      socket.on('join_game', this.handlePlayerJoin.bind(this, socket));

      // Handle player betting
      socket.on('place_bet', this.handlePlayerBet.bind(this, socket));

      // Handle player cashing out
      socket.on('cash_out', this.handlePlayerCashOut.bind(this, socket));

      // Disconnect handling
      socket.on('disconnect', () => {
        logger.info('Client disconnected:', socket.id);
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
    }, 100); // Update every 100ms for smooth progression
  }

  broadcastBettingPhase(gameState) {
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
  }

  broadcastFlyingPhase(gameState) {
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
  }

  broadcastCrashedPhase(gameState) {
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
