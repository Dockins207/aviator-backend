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

          // COMPREHENSIVE Bet Data Logging
          logger.warn('INCOMING_BET_DATA_DIAGNOSTIC', {
            fullBetData: JSON.stringify(betData),
            betDataKeys: Object.keys(betData),
            socketUserId: socket.user.user_id,
            socketUsername: socket.user.username,
            socketId: socket.id
          });

          // STRICT Bet Data Validation
          const { amount: betAmount, autoCashoutEnabled, autoCashoutMultiplier } = betData;

          // Log and remove unexpected fields
          const unexpectedFields = Object.keys(betData).filter(
            key => !['amount', 'autoCashoutEnabled', 'autoCashoutMultiplier'].includes(key)
          );

          if (unexpectedFields.length > 0) {
            logger.warn('UNEXPECTED_BET_DATA_FIELDS', {
              context: 'placeBet',
              unexpectedFields,
              socketId: socket.id,
              userId: socket.user.user_id
            });
          }

          // Validate bet amount
          if (typeof betAmount !== 'number' || isNaN(betAmount) || betAmount <= 0) {
            logger.error('INVALID_BET_AMOUNT', {
              context: 'placeBet',
              betAmount,
              socketId: socket.id,
              userId: socket.user.user_id
            });
            return callback({
              success: false,
              message: 'SECURITY_VIOLATION_INVALID_BET_AMOUNT',
              type: 'error'
            });
          }

          // Check maximum bet limit with comprehensive validation
          const MAX_BET_AMOUNT = 10000;  // Configurable limit
          if (betAmount > MAX_BET_AMOUNT) {
            logger.error('SOCKET_BET_PLACEMENT_AMOUNT_LIMIT_EXCEEDED', {
              context: 'placeBet',
              betAmount,
              maxBetAmount: MAX_BET_AMOUNT,
              userId: socket.user.user_id,
              socketId: socket.id
            });
            return callback({
              success: false,
              message: `SECURITY_VIOLATION_BET_AMOUNT_LIMIT_EXCEEDED: Maximum bet is ${MAX_BET_AMOUNT}`,
              type: 'error',
              details: {
                originalAmount: betAmount,
                maxBetAmount: MAX_BET_AMOUNT
              }
            });
          }

          // Comprehensive user context logging
          logger.info('SOCKET_BET_PLACEMENT_USER_CONTEXT', {
            userId: socket.user.user_id,
            username: socket.user.username,
            socketId: socket.id,
            userRoles: socket.user.roles
          });

          // Place bet with complete user context
          const result = await this.betService.placeBet({
            amount: betAmount,
            autoCashoutEnabled,
            autoCashoutMultiplier
          }, { 
            socket: socket  // Provide full socket context
          });

          // Simplified success notification
          this.io.emit('bet:placed', {
            betId: result.betId,
            amount: betAmount
          });

          // Concise, user-friendly callback
          callback({
            success: true,
            message: 'Bet placed',
            betId: result.betId
          });
        } catch (error) {
          // Simplified error handling with ultra-short messages
          const errorMessages = {
            'INSUFFICIENT_FUNDS': 'Low balance',
            'BET_LIMIT_EXCEEDED': 'Bet too high',
            'GAME_NOT_ACTIVE': 'Game paused',
            'default': 'Bet failed'
          };

          const userFriendlyMessage = errorMessages[error.code] || errorMessages['default'];

          // Broadcast bet placement error
          this.io.emit('bet:error', {
            message: userFriendlyMessage,
            code: error.code || 'ERROR'
          });

          // Simplified error notification
          callback({ 
            success: false, 
            message: userFriendlyMessage,
            code: error.code || 'ERROR'
          });
        }
      });

      // Cashout handling
      socket.on('cashout', async (cashoutData) => {
        try {
          // Retrieve active bets for cashout
          const activeBetsForCashout = await this.betService.getActiveBetsForCashout(
            cashoutData.gameSessionId, 
            socket.user.user_id
          );

          // If no active bets, return early
          if (activeBetsForCashout.length === 0) {
            return this.sendErrorResponse(socket, {
              message: 'No active bets available for cashout',
              code: 'NO_ACTIVE_BETS'
            });
          }

          // Find the specific bet to cashout if betId is provided
          const betToCashout = cashoutData.betId 
            ? activeBetsForCashout.find(bet => bet.id === cashoutData.betId)
            : activeBetsForCashout[0];

          if (!betToCashout) {
            return this.sendErrorResponse(socket, {
              message: 'Specified bet not found or not active',
              code: 'BET_NOT_FOUND'
            });
          }

          // Robust multiplier extraction
          const rawMultiplier = cashoutData?.multiplier ?? 
                                cashoutData?.cashoutMultiplier ?? 
                                1.00;

          // Validate and parse multiplier
          const cashoutMultiplier = Number(rawMultiplier);
          if (isNaN(cashoutMultiplier) || cashoutMultiplier <= 1.00) {
            return this.sendErrorResponse(socket, {
              message: 'Invalid cashout multiplier',
              code: 'INVALID_MULTIPLIER'
            });
          }

          // Log cashout attempt
          logger.info('CASHOUT_ATTEMPT', {
            userId: socket.user.user_id,
            betId: betToCashout.id,
            socketId: socket.id
          });

          // Simplified cashout result processing
          const cashoutResult = await this.betService.processCashout(
            betToCashout, 
            cashoutMultiplier, 
            socket.user.user_id
          );

          // Ultra-concise success notification
          this.io.emit('cashout:success', {
            betId: betToCashout.id,
            amount: cashoutResult.amount
          });

          // Concise callback
          callback({
            success: true,
            message: 'Cashed out'
          });
        } catch (error) {
          // Ultra-short error messages for cashout
          const errorMessages = {
            'NO_ACTIVE_BETS': 'No bets',
            'CASHOUT_DISABLED': 'Cashout locked',
            'MULTIPLIER_TOO_LOW': 'Multiplier low',
            'GAME_ENDED': 'Game over',
            'default': 'Cashout failed'
          };

          const userFriendlyMessage = errorMessages[error.code] || errorMessages['default'];

          // Broadcast cashout error
          this.io.emit('cashout:error', {
            message: userFriendlyMessage,
            code: error.code || 'ERROR'
          });

          // Concise error callback
          callback({
            success: false,
            message: userFriendlyMessage
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
