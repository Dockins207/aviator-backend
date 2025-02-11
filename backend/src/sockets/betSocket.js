import betService from '../services/betService.js';
import gameService from '../services/gameService.js';

class BetSocket {
  constructor(io) {
    this.io = io;
  }

  initialize() {
    this.io.on('connection', (socket) => {
      console.log(`[BET_SOCKET] New client connected: ${socket.id}`);

      // Place bet
      socket.on('placeBet', (betData, callback) => {
        console.log(`[BET_SOCKET] Bet placement attempt by ${socket.id}`);
        try {
          const result = betService.placeBet({
            amount: betData.amount,
            user: socket.id  // Use socket ID as default user
          });

          // Broadcast bet placement to all clients
          this.io.emit('betPlaced', {
            betId: result.betId,
            amount: betData.amount,
            user: socket.id
          });

          callback(result);
        } catch (error) {
          console.error(`[BET_SOCKET] Bet placement error for ${socket.id}:`, error.message);
          callback({ 
            success: false, 
            message: error.message 
          });
        }
      });

      // Cashout bet
      socket.on('cashoutBet', (cashoutData, callback) => {
        console.log(`[BET_SOCKET] Bet cashout attempt by ${socket.id}`);
        try {
          const result = betService.cashoutBet({
            betId: cashoutData.betId
          });

          // Broadcast cashout to all clients
          this.io.emit('betCashedOut', {
            betId: cashoutData.betId,
            winnings: result.winnings,
            multiplier: result.multiplier
          });

          callback(result);
        } catch (error) {
          console.error(`[BET_SOCKET] Bet cashout error for ${socket.id}:`, error.message);
          callback({ 
            success: false, 
            message: error.message 
          });
        }
      });

      socket.on('disconnect', () => {
        console.log(`[BET_SOCKET] Client disconnected: ${socket.id}`);
      });
    });
  }
}

export default (io) => {
  const betSocket = new BetSocket(io);
  betSocket.initialize();
};
