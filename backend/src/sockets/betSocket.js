import betService from '../services/betService.js';
import logger from '../config/logger.js';
import { validateToken, normalizePhoneNumber } from '../utils/authUtils.js';
import { UserRepository } from '../repositories/userRepository.js';
import PlayerBetRepository from '../repositories/playerBetRepository.js';
import GameRepository from '../repositories/gameRepository.js';
import RedisService from '../services/redisService.js';
import dotenv from 'dotenv';
import crypto from 'crypto';

// Load environment variables explicitly
dotenv.config({ path: '../../.env' });
dotenv.config();

class BetSocket {
  constructor(io) {
    this.io = io;
    this.cashoutTokens = new Map(); // Store cashout tokens
    this.betReadinessInterval = null;
    this.currentGameSessionId = null;
    this.gameRepository = new GameRepository();
  }

  async initializeGameSession() {
    try {
      // Fetch the current active game session
      this.currentGameSessionId = await this.gameRepository.getCurrentActiveGameSession();
      
      logger.info('GAME_SESSION_INITIALIZED', {
        gameSessionId: this.currentGameSessionId
      });
    } catch (error) {
      logger.error('GAME_SESSION_INITIALIZATION_ERROR', {
        errorMessage: error.message
      });
      throw error;
    }
  }

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

  generateCashoutToken(betId, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    
    // Store token with bet details
    this.cashoutTokens.set(token, {
      betId,
      userId,
      createdAt: Date.now()
    });

    return token;
  }

  async checkBetReadinessForCashout(userId, betId) {
    try {
      // Get current game session
      const gameSessionId = await this.gameRepository.getCurrentActiveGameSession();
      if (!gameSessionId) {
        logger.warn('NO_ACTIVE_GAME_SESSION_FOR_BET_CHECK', {
          userId,
          betId,
          timestamp: new Date().toISOString()
        });
        return false;
      }

      // Get bet details from Redis first, then fallback to database
      const redisBets = await RedisService.retrieveActiveBets(gameSessionId);
      const betDetails = redisBets.find(bet => bet.bet_id === betId) || 
                        await PlayerBetRepository.findBetById(betId);
      
      if (!betDetails) {
        logger.warn('BET_NOT_FOUND_FOR_CASHOUT_CHECK', {
          userId,
          betId,
          gameSessionId,
          timestamp: new Date().toISOString()
        });
        return false;
      }

      // Check if bet is active and hasn't been cashed out yet
      const isBetReadyForCashout = betDetails.status === 'active' && 
                                  !betDetails.cashout_multiplier && 
                                  !betDetails.payout_amount;

      if (isBetReadyForCashout) {
        // Determine if this is an auto-cashout bet
        const isAutoCashout = betDetails.betType === 'auto' && 
                             betDetails.autoCashoutMultiplier > 1;

        // Generate cashout token with detailed bet context
        const tokenContext = {
          betType: betDetails.betType,
          autoCashoutMultiplier: betDetails.autoCashoutMultiplier,
          betAmount: betDetails.bet_amount,
          isAutoCashout
        };
        const token = await betService.generateBetToken(betId, userId, tokenContext);

        logger.debug('BET_READY_FOR_CASHOUT', {
          userId,
          betId,
          betType: betDetails.betType,
          autoCashoutMultiplier: betDetails.autoCashoutMultiplier,
          timestamp: new Date().toISOString()
        });

        // Find the socket for this user
        const userSocket = Array.from(this.io.sockets.sockets.values())
          .find(socket => socket.userId === userId);

        if (userSocket) {
          // Send detailed cashout activation to client
          userSocket.emit('activateCashout', { 
            token,
            betId,
            betAmount: betDetails.bet_amount,
            betType: betDetails.betType,
            autoCashoutMultiplier: betDetails.autoCashoutMultiplier,
            isAutoCashout
          });

          logger.info('CASHOUT_ACTIVATION_SENT', {
            userId,
            betId,
            betType: betDetails.betType,
            autoCashoutMultiplier: betDetails.autoCashoutMultiplier,
            socketId: userSocket.id,
            timestamp: new Date().toISOString()
          });
        } else {
          logger.warn('USER_SOCKET_NOT_FOUND', {
            userId,
            betId,
            gameSessionId,
            timestamp: new Date().toISOString()
          });
        }

        return true;
      }

      return false;
    } catch (error) {
      logger.error('BET_READINESS_CHECK_ERROR', {
        userId,
        betId,
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      return false;
    }
  }

  async handleCashout(socket, data) {
    try {
      // Validate token and get bet details
      const { betId, additionalContext } = betService.validateBetToken(data.token, socket.userId);

      // Prepare cashout options
      const cashoutOptions = {
        userId: socket.userId,
        betId,
        // Support both manual and auto cashout
        cashoutMultiplier: data.cashoutMultiplier, // For manual cashout
        // For auto cashout, we'll rely on the stored multiplier in the bet details
      };

      // Process cashout
      const result = await betService.processCashout(cashoutOptions);

      // Emit success event to the client
      socket.emit('cashoutSuccess', {
        success: true,
        betId,
        winAmount: result.winAmount,
        cashoutMultiplier: result.cashoutMultiplier,
        betType: result.betType,
        originalAutoCashoutMultiplier: result.originalAutoCashoutMultiplier
      });

      // Optional: Broadcast cashout to other clients
      this.io.emit('cashoutBroadcast', {
        userId: socket.userId,
        betId,
        winAmount: result.winAmount,
        cashoutMultiplier: result.cashoutMultiplier,
        betType: result.betType
      });

    } catch (error) {
      logger.error('SOCKET_CASHOUT_ERROR', {
        userId: socket.userId,
        error: error.message,
        timestamp: new Date().toISOString()
      });

      // Emit error to the client
      socket.emit('cashoutError', {
        success: false,
        message: error.message
      });
    }
  }

  startBetReadinessMonitoring() {
    // Clear any existing interval
    if (this.betReadinessInterval) {
      clearInterval(this.betReadinessInterval);
    }

    this.betReadinessInterval = setInterval(async () => {
      try {
        // Always get fresh game session ID
        const gameSessionId = await this.gameRepository.getCurrentActiveGameSession();
        if (!gameSessionId) {
          logger.warn('NO_ACTIVE_GAME_SESSION_FOR_MONITORING', {
            timestamp: new Date().toISOString()
          });
          return;
        }

        // Get all active bets from Redis first
        const activeBets = await PlayerBetRepository.getActiveBetsForSession(gameSessionId);

        logger.debug('BET_READINESS_MONITORING', {
          totalActiveBets: activeBets.length
        });

        // Check each active bet for cashout readiness
        for (const bet of activeBets) {
          await this.checkBetReadinessForCashout(bet.userId, bet.betId);
        }
      } catch (error) {
        logger.error('BET_READINESS_MONITORING_ERROR', {
          error: error.message,
          errorStack: error.stack,
          timestamp: new Date().toISOString()
        });
      }
    }, 5000); // 5 seconds interval
  }

  stopBetReadinessMonitoring() {
    if (this.betReadinessInterval) {
      clearInterval(this.betReadinessInterval);
      this.betReadinessInterval = null;
      logger.info('BET_READINESS_MONITORING_STOPPED', {
        timestamp: new Date().toISOString()
      });
    }
  }

  initialize() {
    this.io.on('connection', async (socket) => {
      try {
        // Get token from handshake auth or query
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        
        if (!token) {
          logger.warn('No token provided for socket connection');
          socket.emit('error', { message: 'authentication_required' });
          socket.disconnect('authentication_required');
          return;
        }

        // Validate token
        const decoded = await validateToken(token);
        if (!decoded) {
          logger.warn('Invalid token for socket connection');
          socket.emit('error', { message: 'authentication_failed' });
          socket.disconnect('authentication_failed');
          return;
        }

        const userId = decoded.user_id;
        socket.userId = userId;

        logger.info(`User ${userId} connected to bet socket`);

        // Log new socket connection
        logger.info('SOCKET_CONNECTION', {
          socketId: socket.id,
          connectionTime: new Date().toISOString()
        });

        // Debug: Log all socket events
        socket.onAny((eventName, ...args) => {
          logger.debug('ALL_SOCKET_EVENTS', {
            eventName,
            userId: socket.userId,
            timestamp: new Date().toISOString(),
            socketId: socket.id,
            eventArgs: JSON.stringify(args)
          });
        });

        // Bet placement event
        socket.on('placeBet', async (payload) => {
          const logContext = {
            socketId: socket.id,
            timestamp: new Date().toISOString()
          };

          try {
            // Validate payload structure
            if (!payload || !payload.amount) {
              logger.warn('BET_PLACEMENT_INVALID_PAYLOAD', {
                ...logContext,
                reason: 'Missing amount'
              });
              socket.emit('betError', {
                message: 'Invalid bet details: amount is required'
              });
              return;
            }

            // Validate bet amount range
            const MIN_BET_AMOUNT = 10;
            const MAX_BET_AMOUNT = 50000;
            if (payload.amount < MIN_BET_AMOUNT || payload.amount > MAX_BET_AMOUNT) {
              logger.warn('BET_PLACEMENT_AMOUNT_OUT_OF_RANGE', {
                ...logContext,
                amount: payload.amount,
                minAmount: MIN_BET_AMOUNT,
                maxAmount: MAX_BET_AMOUNT
              });
              socket.emit('betError', {
                message: `Bet amount must be between ${MIN_BET_AMOUNT} and ${MAX_BET_AMOUNT}`
              });
              return;
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
                socket.emit('betError', {
                  message: 'Invalid auto-cashout multiplier. Must be a number greater than 1.'
                });
                return;
              }
              autoCashoutMultiplier = parsedMultiplier;
            }

            // Prepare bet details
            const betDetails = {
              userId: socket.userId,
              amount: payload.amount,
              autoCashoutMultiplier: autoCashoutMultiplier
            };

            // Log additional context
            logContext.userId = socket.userId;
            logContext.amount = payload.amount;
            logContext.autoCashoutMultiplier = autoCashoutMultiplier;

            // Place bet
            const result = await betService.processBetPlacement(betDetails);

            // Log successful bet placement
            logger.info('BET_PLACEMENT_SOCKET_SUCCESS', logContext);

            // Emit bet placed event
            socket.emit('betPlaced', {
              success: true,
              message: 'Bet placed successfully'
            });

            // Broadcast bet placement to all clients (without sensitive info)
            this.io.emit('betPlaced', {
              amount: payload.amount,
              autoCashoutMultiplier: autoCashoutMultiplier
            });

          } catch (error) {
            // Log bet placement error
            logger.error('BET_PLACEMENT_SOCKET_ERROR', {
              ...logContext,
              errorMessage: error.message
            });

            // Emit error to the user
            socket.emit('betError', {
              message: error.message || 'Bet placement failed'
            });
          }
        });

        // When a bet is ready for cashout
        socket.on('betReadyForCashout', async (data) => {
          try {
            // Aggressive logging for debugging
            logger.error('CASHOUT_TOKEN_DEBUG', {
              message: 'Attempting to generate cashout token',
              receivedData: JSON.stringify(data),
              socketUserId: socket.userId,
              socketId: socket.id,
              timestamp: new Date().toISOString()
            });

            if (!data || !data.betId) {
              logger.error('CASHOUT_TOKEN_GENERATION_FAILURE', {
                reason: 'Missing bet ID',
                receivedData: JSON.stringify(data),
                userId: socket.userId,
                timestamp: new Date().toISOString()
              });
              throw new Error('Bet ID is required for cashout token generation');
            }

            // Validate user context
            if (!socket.userId) {
              logger.error('CASHOUT_TOKEN_GENERATION_FAILURE', {
                reason: 'No user ID in socket context',
                socketDetails: {
                  id: socket.id,
                  connected: socket.connected,
                  rooms: Array.from(socket.rooms)
                },
                timestamp: new Date().toISOString()
              });
              throw new Error('User context is missing');
            }

            logger.error('CASHOUT_TOKEN_GENERATION_ATTEMPT', {
              userId: socket.userId,
              betId: data.betId,
              timestamp: new Date().toISOString(),
              socketId: socket.id
            });

            const token = await betService.generateBetToken(data.betId, socket.userId);
            
            logger.error('ACTIVATE_CASHOUT_TOKEN_GENERATED', {
              userId: socket.userId,
              betId: data.betId,
              tokenLength: token.length,
              tokenFirstChars: token.substring(0, 10),
              tokenLastChars: token.substring(token.length - 10),
              timestamp: new Date().toISOString(),
              socketId: socket.id
            });

            // Verify socket is connected before emitting
            if (!socket.connected) {
              logger.error('SOCKET_NOT_CONNECTED', {
                userId: socket.userId,
                betId: data.betId,
                socketId: socket.id,
                timestamp: new Date().toISOString()
              });
              throw new Error('Socket is not connected');
            }

            socket.emit('activateCashout', { 
              token,
              betId: data.betId 
            });

            logger.error('ACTIVATE_CASHOUT_TOKEN_SENT_TO_CLIENT', {
              userId: socket.userId,
              betId: data.betId,
              tokenSentTimestamp: new Date().toISOString(),
              socketId: socket.id
            });
          } catch (error) {
            logger.error('CASHOUT_TOKEN_GENERATION_CRITICAL_ERROR', {
              userId: socket.userId,
              betId: data?.betId,
              error: error.message,
              errorStack: error.stack,
              socketDetails: {
                id: socket.id,
                connected: socket.connected,
                rooms: Array.from(socket.rooms)
              },
              timestamp: new Date().toISOString()
            });
            
            socket.emit('cashoutError', {
              message: 'Failed to generate cashout token',
              details: error.message
            });
          }
        });

        // Handle cashout with token
        socket.on('cashout', async (data) => {
          await this.handleCashout(socket, data);
        });

        // Handle disconnect
        socket.on('disconnect', () => {
          logger.info(`User ${socket.userId} disconnected from bet socket`);
          logger.info('SOCKET_DISCONNECTION', {
            socketId: socket.id,
            disconnectionTime: new Date().toISOString()
          });
          this.stopBetReadinessMonitoring();
        });

        // Start bet readiness monitoring for this connection
        this.startBetReadinessMonitoring();

      } catch (error) {
        logger.error('Error in bet socket connection:', error);
        socket.disconnect();
      }
    });
  }
}

export default BetSocket;
