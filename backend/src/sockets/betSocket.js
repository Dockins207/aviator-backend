import betService from '../services/betService.js';
import gameService from '../services/gameService.js';
import socketAuthMiddleware from '../middleware/socketAuthMiddleware.js';
import logger from '../config/logger.js'; 

class BetSocket {
  constructor(io) {
    this.io = io;
    this.betService = betService;
    this.gameService = gameService;
  }

  initialize() {
    // Apply authentication middleware to all socket connections
    this.io.use(socketAuthMiddleware);

    this.io.on('connection', async (socket) => {
      try {
        // Send current game state to newly connected client
        const currentState = this.gameService.getCurrentGameState();
        if (currentState) {
          socket.emit('gameStateUpdate', {
            gameId: currentState.gameId,
            status: currentState.status,
            multiplier: currentState.multiplier,
            timestamp: Date.now()
          });
        }

        // Define bet amount limits
        const MIN_BET_AMOUNT = 10;  // Minimum bet amount
        const MAX_BET_AMOUNT = 10000;  // Maximum bet amount

        // Place bet
        socket.on('placeBet', async (betData, callback) => {
          try {
            // ABSOLUTE Authentication Validation
            if (!socket.user || !socket.user.user_id) {
              logger.error('SOCKET_BET_PLACEMENT_AUTH_FAILURE', {
                context: 'placeBet',
                details: 'No authenticated user or missing user_id',
                socketId: socket.id
              });
              return callback({
                success: false,
                message: 'SECURITY_VIOLATION_AUTHENTICATION_REQUIRED',
                type: 'error'
              });
            }

            // Validate bet amount
            if (betData.amount < MIN_BET_AMOUNT || betData.amount > MAX_BET_AMOUNT) {
              return callback({
                success: false,
                message: `Bet amount must be between ${MIN_BET_AMOUNT} and ${MAX_BET_AMOUNT}`,
                type: 'error'
              });
            }

            // Place the bet using bet service
            const result = await this.betService.placeBet({
              ...betData,
              userId: socket.user.user_id
            });

            callback(result);
          } catch (error) {
            logger.error('BET_PLACEMENT_ERROR', {
              error: error.message,
              socketId: socket.id,
              userId: socket.user?.user_id
            });

            callback({
              success: false,
              message: error.message || 'Bet placement failed',
              type: 'error'
            });
          }
        });

        // Additional socket event handlers can be added here
      } catch (error) {
        logger.error('SOCKET_CONNECTION_ERROR', {
          error: error.message,
          socketId: socket.id
        });
        socket.disconnect(true);
      }
    });
  }
}

export default (io) => {
  const betSocket = new BetSocket(io);
  betSocket.initialize();
};
