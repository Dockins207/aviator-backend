const socketIo = require('socket.io');
const gameService = require('../services/gameService');

class GameSocket {
  constructor(server) {
    this.io = socketIo(server, {
      cors: {
        origin: "*", // Adjust this in production
        methods: ["GET", "POST"]
      }
    });

    this.setupListeners();
  }

  setupListeners() {
    this.io.on('connection', (socket) => {
      console.log('New client connected');

      // Send initial game state
      socket.emit('gameState', gameService.getGameState());

      // Betting events
      socket.on('placeBet', (data) => {
        try {
          gameService.placeBet(socket.userId, data.betAmount);
          this.io.emit('betPlaced', { userId: socket.userId, betAmount: data.betAmount });
        } catch (error) {
          socket.emit('error', { message: error.message });
        }
      });

      // Cashout events
      socket.on('cashOut', (data) => {
        try {
          const winnings = gameService.cashOut(socket.userId, data.multiplier);
          socket.emit('cashOutSuccess', { winnings });
        } catch (error) {
          socket.emit('error', { message: error.message });
        }
      });

      socket.on('disconnect', () => {
        console.log('Client disconnected');
      });
    });

    // Broadcast game updates
    setInterval(() => {
      const gameState = gameService.getGameState();
      this.io.emit('gameUpdate', gameState);
    }, 100);
  }

  startGame() {
    gameService.startGame();
    this.io.emit('gameStarted');
  }
}

module.exports = GameSocket;
