import betService from '../services/betService.js';
import gameService from '../services/gameService.js';
import socketAuthMiddleware from '../middleware/socketAuthMiddleware.js';

class BetSocket {
  constructor(io) {
    this.io = io;
    this.betService = betService; // Use the imported instance directly
  }

  initialize() {
    // Apply authentication middleware to all socket connections
    this.io.use(socketAuthMiddleware);

    this.io.on('connection', (socket) => {
      // Define bet amount limits
      const MIN_BET_AMOUNT = 10;  // Minimum bet amount
      const MAX_BET_AMOUNT = 10000;  // Maximum bet amount

      // Place bet
      socket.on('placeBet', async (betData, callback) => {
        try {
          // Validate socket authentication
          if (!socket.user) {
            throw new Error('User not authenticated');
          }

          const { 
            amount, 
            gameSessionId 
          } = betData;

          // Validate bet amount
          const betAmount = Number(amount);
          if (isNaN(betAmount) || betAmount <= 0) {
            return callback({
              success: false,
              message: 'Invalid bet amount',
              type: 'error'
            });
          }

          // Check maximum bet limit
          const MAX_BET_AMOUNT = 10000;  // Adjust as needed
          if (betAmount > MAX_BET_AMOUNT) {
            return callback({
              success: false,
              message: `Bet amount too high. Maximum bet is ${MAX_BET_AMOUNT}`,
              type: 'error',
              details: {
                originalAmount: betAmount,
                maxBetAmount: MAX_BET_AMOUNT
              }
            });
          }

          const result = await this.betService.placeBet({
            userId: socket.user.id,  // Include user ID
            amount: betAmount,
            gameSessionId: gameSessionId || gameService.getCurrentGameState().gameId,
            betDataType: typeof betAmount,
            betDataValue: betAmount
          });

          // Broadcast bet placement to all clients
          this.io.emit('betPlaced', {
            betId: result.betId,
            amount: betAmount,
            userId: socket.user.id,
            gameSessionId: result.gameSessionId
          });

          // Detailed callback with success response
          callback({
            success: true,
            message: 'Bet placed successfully!',
            type: 'success',
            betId: result.betId,
            amount: betAmount,
            gameSessionId: result.gameSessionId
          });
        } catch (error) {
          // Detailed error callback
          callback({ 
            success: false, 
            message: error.message || 'Bet placement failed',
            type: 'error'
          });
        }
      });

      // Cashout bet
      socket.on('cashoutBet', async (cashoutData, callback) => {
        try {
          // Strict user authentication validation
          if (!socket.user || !socket.user.id) {
            return callback({
              success: false,
              message: 'User authentication failed',
              type: 'error',
              details: {
                reason: 'Missing or invalid user ID'
              }
            });
          }

          // Explicitly extract and validate user ID
          const userId = socket.user.id;
          if (!userId) {
            return callback({
              success: false,
              message: 'User ID is a mandatory parameter',
              type: 'error',
              details: {
                socketUser: socket.user
              }
            });
          }

          // Get current game state
          const currentGameState = gameService.getCurrentGameState();

          // Additional validation for game state
          if (currentGameState.status !== 'flying') {
            return callback({
              success: false,
              message: 'Cashout is only allowed during the flying state',
              type: 'error',
              details: {
                currentGameStatus: currentGameState.status,
                userId: userId
              }
            });
          }

          // Determine the bet ID and current multiplier
          const betId = 
            cashoutData.betId || 
            cashoutData.bet_id || 
            cashoutData.id;

          const currentMultiplier = currentGameState.currentMultiplier;

          // Validate required parameters
          if (!betId) {
            return callback({
              success: false,
              message: 'Invalid or missing bet ID',
              type: 'error',
              details: {
                originalData: cashoutData,
                userId: userId
              }
            });
          }

          // Validate bet amount
          const betAmount = cashoutData.betAmount || cashoutData.bet_amount;
          if (!betAmount || betAmount <= 0) {
            return callback({
              success: false,
              message: 'Invalid or missing bet amount',
              type: 'error',
              details: {
                originalData: cashoutData,
                userId: userId
              }
            });
          }

          // Attempt to cashout the bet
          const result = await this.betService.cashoutBet({
            betId: betId,
            userId: userId,  // Explicitly pass user ID
            currentMultiplier: currentMultiplier,
            betAmount: betAmount
          });

          // Broadcast bet cashout to all clients
          this.io.emit('betCashout', {
            betId: betId,
            user: userId,
            multiplier: result.currentMultiplier,
            payoutAmount: result.payoutAmount,
            originalBetAmount: result.originalBetAmount,
            gameStatus: result.gameStatus
          });

          // Detailed callback with success response
          callback({
            success: true,
            message: 'Bet cashed out successfully!',
            type: 'success',
            betId: betId,
            userId: userId,
            multiplier: result.currentMultiplier,
            payoutAmount: result.payoutAmount,
            originalBetAmount: result.originalBetAmount,
            gameStatus: result.gameStatus
          });
        } catch (error) {
          // Detailed error callback
          callback({ 
            success: false, 
            message: error.message || 'Bet cashout failed',
            type: 'error',
            details: {
              betId: betId,
              userId: socket.user?.id,
              currentGameStatus: currentGameState?.status
            }
          });
        }
      });

      socket.on('disconnect', () => {
      });
    });
  }
}

export default (io) => {
  const betSocket = new BetSocket(io);
  betSocket.initialize();
};
