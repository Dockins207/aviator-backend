import betService from '../services/betService.js';
import gameService from '../services/gameService.js';
import socketAuthMiddleware from '../middleware/socketAuthMiddleware.js';
import logger from '../config/logger.js'; 

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
            amount
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
            betDataType: typeof betAmount,
            betDataValue: betAmount
          }, { 
            user: socket.user,  // Pass socket user in the req object
            socket: socket  // Optional: pass socket for additional context
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
      socket.on('cashout', async (cashoutData) => {
        try {
          // Comprehensive logging of entire cashout data
          logger.warn('CASHOUT_EVENT_RECEIVED', {
            fullCashoutData: JSON.stringify(cashoutData),
            dataType: typeof cashoutData,
            keys: Object.keys(cashoutData || {})
          });

          // Robust multiplier extraction
          const rawMultiplier = cashoutData?.multiplier ?? 
                                cashoutData?.cashoutMultiplier ?? 
                                cashoutData;

          // Detailed logging of multiplier
          logger.warn('MULTIPLIER_EXTRACTION', {
            rawMultiplier,
            type: typeof rawMultiplier,
            isObject: rawMultiplier instanceof Object,
            stringValue: String(rawMultiplier)
          });

          // Robust multiplier parsing
          const cashoutMultiplier = (() => {
            if (typeof rawMultiplier === 'number') {
              return rawMultiplier;
            }

            if (typeof rawMultiplier === 'string') {
              const parsedMultiplier = parseFloat(rawMultiplier);
              if (!isNaN(parsedMultiplier)) {
                return parsedMultiplier;
              }
            }

            // Throw error with detailed context
            throw new Error(`Invalid multiplier: type=${typeof rawMultiplier}, value=${rawMultiplier}`);
          })();

          // Enhanced multiplier validation
          if (cashoutMultiplier <= 1) {
            throw new Error('Cashout multiplier must be greater than 1');
          }

          // Comprehensive logging of cashout request
          logger.info('CASHOUT_REQUEST_PROCESSING', {
            userId: socket.user.id,
            rawMultiplier: cashoutData.multiplier,
            processedMultiplier: cashoutMultiplier,
            inputType: typeof cashoutData.multiplier,
            socketId: socket.id
          });

          // Securely retrieve bet for cashout
          const { cashoutToken, betDetails } = await this.betService.retrieveBetForCashout({
            userId: socket.user.id,
            cashoutMultiplier
          });

          // Log bet details before cashout
          logger.info('CASHOUT_BET_DETAILS', {
            betId: betDetails.betId,
            betAmount: betDetails.betAmount,
            userId: socket.user.id
          });

          // Perform cashout using the secure token
          const cashoutResult = await this.betService.cashoutBet({
            cashoutToken,
            cashoutMultiplier
          });

          // Log successful cashout
          logger.info('CASHOUT_SUCCESS', {
            userId: socket.user.id,
            betId: betDetails.betId,
            cashoutMultiplier,
            payout: cashoutResult.payout,
            socketId: socket.id
          });

          // Broadcast cashout event (without exposing sensitive details)
          this.io.emit('betCashedOut', {
            userId: socket.user.id,
            cashoutMultiplier,
            payout: cashoutResult.payout
          });

          // Successful cashout callback
          // callback({
          //   success: true,
          //   message: 'Bet cashed out successfully!',
          //   type: 'success',
          //   details: {
          //     payout: cashoutResult.payout,
          //     cashoutMultiplier
          //   }
          // });
        } catch (error) {
          // Comprehensive error handling and logging
          logger.error('CASHOUT_ERROR', {
            errorMessage: error.message,
            stack: error.stack,
            userId: socket.user?.id,
            rawInput: cashoutData.multiplier,
            socketId: socket.id
          });

          // callback({
          //   success: false,
          //   message: error.message || 'Cashout failed',
          //   type: 'error',
          //   details: {
          //     rawMultiplier: cashoutData.multiplier
          //   }
          // });
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
