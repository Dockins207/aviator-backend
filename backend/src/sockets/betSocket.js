import betService from '../services/betService.js';
import logger from '../config/logger.js';
import { validateToken, normalizePhoneNumber } from '../utils/authUtils.js';
import { UserRepository } from '../repositories/userRepository.js';
import dotenv from 'dotenv';

// Load environment variables explicitly
dotenv.config({ path: '../../.env' });
dotenv.config();

class BetSocket {
  constructor(io) {
    this.io = io;
  }

  // Authentication method to verify JWT token
  async authenticateUser(token) {
    try {
      // Use shared token validation
      const decoded = await validateToken(token);
      
      // Get normalized phone number
      const normalizedPhoneNumber = normalizePhoneNumber(decoded.phone_number);
      
      logger.debug('AUTHENTICATION_ATTEMPT', {
        decodedPhoneNumber: decoded.phone_number,
        normalizedPhoneNumber: normalizedPhoneNumber,
        decodedUserId: decoded.user_id,
        decodedUsername: decoded.username
      });

      // Find user with normalized phone number
      const user = await UserRepository.findByPhoneNumber(normalizedPhoneNumber);
      
      if (!user) {
        logger.error('USER_NOT_FOUND', {
          phoneNumber: normalizedPhoneNumber,
          decodedUserId: decoded.user_id,
          decodedUsername: decoded.username,
          timestamp: new Date().toISOString()
        });
        throw new Error('User not found');
      }

      // Additional verification
      if (user.userId !== decoded.user_id) {
        logger.warn('USER_ID_MISMATCH', {
          tokenUserId: decoded.user_id,
          databaseUserId: user.userId,
          phoneNumber: normalizedPhoneNumber
        });
      }

      return user;
    } catch (error) {
      logger.error('SOCKET_AUTHENTICATION_ERROR', {
        errorMessage: error.message,
        errorStack: error.stack,
        tokenProvided: !!token,
        tokenLength: token ? token.length : 0,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  initialize() {
    this.io.on('connection', async (socket) => {
      // Log new socket connection
      logger.info('SOCKET_CONNECTION', {
        socketId: socket.id,
        connectionTime: new Date().toISOString()
      });

      // Bet placement event
      socket.on('placeBet', async (payload, callback) => {
        const logContext = {
          socketId: socket.id,
          timestamp: new Date().toISOString()
        };

        try {
          // Validate payload structure
          if (!payload || !payload.token || !payload.amount) {
            logger.warn('BET_PLACEMENT_INVALID_PAYLOAD', {
              ...logContext,
              reason: 'Missing token or amount'
            });
            return callback({
              success: false,
              message: 'Invalid bet details: token and amount are required'
            });
          }

          // Authenticate user
          const authenticatedUser = await this.authenticateUser(payload.token);

          // Validate bet amount range
          const MIN_BET_AMOUNT = 10;
          const MAX_BET_AMOUNT = 10000;
          if (payload.amount < MIN_BET_AMOUNT || payload.amount > MAX_BET_AMOUNT) {
            logger.warn('BET_PLACEMENT_AMOUNT_OUT_OF_RANGE', {
              ...logContext,
              amount: payload.amount,
              minAmount: MIN_BET_AMOUNT,
              maxAmount: MAX_BET_AMOUNT
            });
            return callback({
              success: false,
              message: `Bet amount must be between ${MIN_BET_AMOUNT} and ${MAX_BET_AMOUNT}`
            });
          }

          // Validate optional auto-cashout multiplier
          let autoCashoutMultiplier = null;
          if (payload.autoCashoutMultiplier !== undefined) {
            const parsedMultiplier = parseFloat(payload.autoCashoutMultiplier);
            if (isNaN(parsedMultiplier) || parsedMultiplier <= 1) {
              logger.warn('BET_PLACEMENT_INVALID_AUTOCASHOUT', {
                ...logContext,
                providedMultiplier: payload.autoCashoutMultiplier
              });
              return callback({
                success: false,
                message: 'Invalid auto-cashout multiplier. Must be a number greater than 1.'
              });
            }
            autoCashoutMultiplier = parsedMultiplier;
          }

          // Prepare bet details
          const betDetails = {
            userId: authenticatedUser.userId,
            amount: payload.amount,
            autoCashoutMultiplier: autoCashoutMultiplier
          };

          // Log additional context
          logContext.userId = authenticatedUser.userId;
          logContext.amount = payload.amount;
          logContext.autoCashoutMultiplier = autoCashoutMultiplier;

          // Place bet
          const result = await betService.placeBet(betDetails);

          // Log successful bet placement
          logger.info('BET_PLACEMENT_SOCKET_SUCCESS', logContext);

          // Acknowledge bet placement
          callback({
            success: true,
            message: 'Bet placed successfully',
            betDetails: result
          });

          // Broadcast bet placement to all clients
          this.io.emit('betPlaced', {
            userId: authenticatedUser.userId,
            amount: payload.amount,
            autoCashoutMultiplier: autoCashoutMultiplier
          });

        } catch (error) {
          // Log bet placement error
          logger.error('BET_PLACEMENT_SOCKET_ERROR', {
            ...logContext,
            errorMessage: error.message,
            errorStack: error.stack
          });

          callback({
            success: false,
            message: error.message || 'Bet placement failed'
          });
        }
      });

      // Cashout event
      socket.on('cashout', async (betData, callback) => {
        const logContext = {
          socketId: socket.id,
          userId: socket.userId || 'unknown',
          timestamp: new Date().toISOString(),
          betId: betData.betId,
          multiplier: betData.multiplier
        };

        try {
          logger.info('CASHOUT_SOCKET_ATTEMPT', logContext);

          if (!betData || !betData.betId || !betData.multiplier) {
            logger.warn('CASHOUT_INVALID_DATA', {
              ...logContext,
              reason: 'Missing bet ID or multiplier'
            });
            return callback({
              success: false,
              message: 'Invalid cashout details'
            });
          }

          const result = await betService.processCashout(
            betData.betId, 
            betData.multiplier
          );

          logger.info('CASHOUT_SOCKET_SUCCESS', {
            ...logContext,
            cashoutAmount: result.cashoutAmount,
            autoCashoutTriggered: result.autoCashoutTriggered
          });

          callback({
            success: true,
            message: result.message,
            details: result
          });

          this.io.emit('betCashout', {
            betId: betData.betId,
            multiplier: betData.multiplier,
            autoCashoutTriggered: result.autoCashoutTriggered
          });

        } catch (error) {
          logger.error('CASHOUT_SOCKET_ERROR', {
            ...logContext,
            errorMessage: error.message,
            errorStack: error.stack
          });

          callback({
            success: false,
            message: error.message || 'Cashout failed'
          });
        }
      });

      socket.on('disconnect', () => {
        logger.info('SOCKET_DISCONNECTION', {
          socketId: socket.id,
          disconnectionTime: new Date().toISOString()
        });
      });
    });
  }
}

export default (io) => {
  const betSocket = new BetSocket(io);
  betSocket.initialize();
};
