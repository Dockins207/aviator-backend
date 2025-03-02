import BetService from '../services/betService.js';
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
    this.betMonitoringIntervals = {}; // Store monitoring intervals
    this.currentGameSessionId = null;
    this.gameRepository = new GameRepository();
    this.betService = new BetService(); // Initialize BetService
    // Using static RedisService methods, no need for instance
    this.playerBetRepository = new PlayerBetRepository(); // Initialize PlayerBetRepository
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

  /**
   * Check if a bet is ready for cashout and notify the user
   * @param {string} userId - User ID
   * @param {string} betReferenceId - Bet reference ID
   * @returns {Promise<boolean>} - Whether the bet is ready for cashout
   */
  async checkBetReadinessForCashout(userId, betReferenceId) {
    try {
      // Get current game session
      const gameSessionId = await this.gameRepository.getCurrentActiveGameSession();
      if (!gameSessionId) {
        logger.warn('NO_ACTIVE_GAME_SESSION_FOR_BET_CHECK', {
          service: 'aviator-backend',
          userId,
          betReferenceId,
          timestamp: new Date().toISOString()
        });
        return false;
      }

      // Get the actual bet ID from the reference ID
      const actualBetId = this.betService.getActualBetId(betReferenceId, userId);
      if (!actualBetId) {
        logger.warn('INVALID_BET_REFERENCE_FOR_READINESS_CHECK', {
          service: 'aviator-backend',
          userId,
          betReferenceId,
          timestamp: new Date().toISOString()
        });
        return false;
      }

      // Get bet details from Redis first, then fallback to database
      const redisBets = await RedisService.retrieveActiveBets(gameSessionId);
      const betDetails = redisBets.find(bet => bet.bet_id === actualBetId || bet.betId === actualBetId) || 
                        await PlayerBetRepository.findBetById(actualBetId);
      
      if (!betDetails) {
        logger.warn('BET_NOT_FOUND_FOR_READINESS_CHECK', {
          service: 'aviator-backend',
          userId,
          betReferenceId,
          actualBetId,
          gameSessionId,
          timestamp: new Date().toISOString()
        });
        return false;
      }

      // Normalize bet details
      const normalizedBet = {
        betId: betReferenceId, // Use the reference ID for client communication
        actualBetId, // Keep track of the actual ID internally
        betAmount: betDetails.bet_amount || betDetails.betAmount,
        betType: betDetails.bet_type || betDetails.betType,
        autoCashoutMultiplier: betDetails.autocashout_multiplier || betDetails.autoCashoutMultiplier
      };

      // Check if this is an auto-cashout bet
      const isAutoCashout = normalizedBet.betType === 'auto' && normalizedBet.autoCashoutMultiplier > 1;

      // Get current multiplier from Redis
      const currentMultiplier = await RedisService.getCurrentMultiplier();
      
      // Get current game state
      const gameState = await RedisService.getGameState();
      
      // For auto bets, check if multiplier threshold is reached
      // For manual bets, check if game is in progress
      const isManualBetReady = normalizedBet.betType === 'manual';
      
      // Check if bet is ready for cashout (either auto or manual)
      if ((isAutoCashout && currentMultiplier >= normalizedBet.autoCashoutMultiplier) || isManualBetReady) {
        // Generate a secure cashout token
        const cashoutToken = crypto.randomBytes(16).toString('hex');
        
        // Store token in Redis with short expiry (30 seconds)
        const tokenKey = `cashout_token:${betReferenceId}`;
        await RedisService.setWithExpiry(tokenKey, cashoutToken, 30);
        
        // Find user's socket
        const userSocket = Object.values(this.io.sockets.sockets).find(s => s.userId === userId);

        if (userSocket) {
          // Send cashout activation to client
          userSocket.emit('activateCashout', { 
            token: cashoutToken,
            betId: normalizedBet.betId // Send the reference ID to the client
          });

          logger.info('CASHOUT_ACTIVATION_SENT', {
            service: 'aviator-backend',
            userId,
            betReferenceId: normalizedBet.betId,
            actualBetId: normalizedBet.actualBetId,
            betType: normalizedBet.betType,
            autoCashoutMultiplier: normalizedBet.autoCashoutMultiplier,
            isManualBet: !isAutoCashout,
            socketId: userSocket.id,
            timestamp: new Date().toISOString()
          });
        } else {
          logger.warn('USER_SOCKET_NOT_FOUND', {
            service: 'aviator-backend',
            userId,
            betReferenceId: normalizedBet.betId,
            actualBetId: normalizedBet.actualBetId,
            gameSessionId,
            timestamp: new Date().toISOString()
          });
        }

        return true;
      }

      return false;
    } catch (error) {
      logger.error('BET_READINESS_CHECK_ERROR', {
        service: 'aviator-backend',
        userId,
        betReferenceId,
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      return false;
    }
  }

  /**
   * Handle bet cashout
   * @param {Object} socket - Socket.io socket
   * @param {Object} data - Cashout data
   * @returns {Promise<Object>} - Cashout result
   */
  async handleCashout(socket, data) {
    try {
      // Validate required parameters
      if (!socket.userId || !data || !data.betId || !data.cashoutMultiplier) {
        logger.warn('INVALID_PARAMETERS_FOR_CASHOUT', {
          service: 'aviator-backend',
          socketId: socket.id,
          userId: socket.userId,
          data: JSON.stringify(data),
          timestamp: new Date().toISOString()
        });
        return { success: false, error: 'Invalid parameters for cashout' };
      }

      const { betId, cashoutMultiplier, token } = data;

      // Validate multiplier
      if (isNaN(cashoutMultiplier) || cashoutMultiplier <= 1) {
        logger.warn('INVALID_CASHOUT_MULTIPLIER', {
          service: 'aviator-backend',
          userId: socket.userId,
          betReferenceId: betId, // This is a reference ID, not the actual bet ID
          cashoutMultiplier,
          timestamp: new Date().toISOString()
        });
        return { success: false, error: 'Multiplier must be greater than 1' };
      }

      // Validate token if provided
      if (token) {
        const tokenKey = `cashout_token:${betId}`;
        const storedToken = await RedisService.get(tokenKey);
        
        if (!storedToken || storedToken !== token) {
          logger.warn('INVALID_CASHOUT_TOKEN', {
            service: 'aviator-backend',
            userId: socket.userId,
            betReferenceId: betId,
            timestamp: new Date().toISOString()
          });
          return { success: false, error: 'Invalid or expired cashout token' };
        }
        
        // Delete the token after use
        await RedisService.del(tokenKey);
      }

      // Process cashout
      const result = await this.betService.processCashout({
        userId: socket.userId,
        betId, // This is a reference ID, not the actual bet ID
        cashoutMultiplier
      });

      if (!result.success) {
        logger.warn('CASHOUT_FAILED', {
          service: 'aviator-backend',
          userId: socket.userId,
          betReferenceId: betId, // This is a reference ID, not the actual bet ID
          cashoutMultiplier,
          error: result.error,
          timestamp: new Date().toISOString()
        });
        return result;
      }

      // Stop monitoring this bet
      this.stopBetReadinessMonitoring(socket.userId, betId);

      // Log successful cashout
      logger.info('CASHOUT_SUCCESSFUL', {
        service: 'aviator-backend',
        userId: socket.userId,
        betReferenceId: betId, // This is a reference ID, not the actual bet ID
        cashoutMultiplier,
        payoutAmount: result.payoutAmount,
        timestamp: new Date().toISOString()
      });

      return result; // The result already contains the reference ID instead of the actual bet ID
    } catch (error) {
      logger.error('CASHOUT_ERROR', {
        service: 'aviator-backend',
        userId: socket.userId,
        betId: data?.betId,
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      return { success: false, error: 'An error occurred during cashout' };
    }
  }

  /**
   * Start monitoring for bet readiness for cashout
   * @param {string} userId - User ID
   * @param {string} betReferenceId - Bet reference ID
   * @returns {void}
   */
  startBetReadinessMonitoring(userId, betReferenceId) {
    const monitoringKey = `${userId}-${betReferenceId}`;
    
    // Check if already monitoring this bet
    if (this.betMonitoringIntervals[monitoringKey]) {
      logger.info('ALREADY_MONITORING_BET', {
        service: 'aviator-backend',
        userId,
        betReferenceId,
        monitoringKey,
        timestamp: new Date().toISOString()
      });
      return;
    }

    logger.info('STARTING_BET_READINESS_MONITORING', {
      service: 'aviator-backend',
      userId,
      betReferenceId,
      monitoringKey,
      timestamp: new Date().toISOString()
    });

    // Set up interval to check bet readiness every 5 seconds
    this.betMonitoringIntervals[monitoringKey] = setInterval(async () => {
      const isReady = await this.checkBetReadinessForCashout(userId, betReferenceId);
      
      // If the bet is ready for cashout, stop monitoring
      if (isReady) {
        this.stopBetReadinessMonitoring(userId, betReferenceId);
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Stop monitoring for bet readiness for cashout
   * @param {string} userId - User ID
   * @param {string} betReferenceId - Bet reference ID
   * @returns {void}
   */
  stopBetReadinessMonitoring(userId, betReferenceId) {
    const monitoringKey = `${userId}-${betReferenceId}`;
    
    if (this.betMonitoringIntervals[monitoringKey]) {
      clearInterval(this.betMonitoringIntervals[monitoringKey]);
      delete this.betMonitoringIntervals[monitoringKey];
      
      logger.info('STOPPED_BET_READINESS_MONITORING', {
        service: 'aviator-backend',
        userId,
        betReferenceId,
        monitoringKey,
        timestamp: new Date().toISOString()
      });
    }
  }

  async handlePlaceBet(socket, data) {
    try {
      // Log the received data for debugging
      logger.debug('PLACE_BET_PAYLOAD', {
        service: 'aviator-backend',
        userId: socket.userId,
        payload: JSON.stringify(data)
      });

      // Validate required parameters
      if (!socket.userId || !data) {
        logger.warn('INVALID_PARAMETERS_FOR_BET_PLACEMENT', {
          service: 'aviator-backend',
          socketId: socket.id,
          userId: socket.userId,
          data,
          timestamp: new Date().toISOString()
        });
        return { success: false, error: 'Invalid parameters for bet placement' };
      }

      // Extract and validate bet parameters
      // The frontend is sending amount directly in the payload
      const betAmount = data.amount; 
      const betType = data.betType || 'manual';
      const autoCashoutMultiplier = data.autoCashoutMultiplier;
      
      // Validate bet amount
      if (!betAmount || isNaN(betAmount) || betAmount <= 0) {
        logger.warn('INVALID_BET_AMOUNT', {
          service: 'aviator-backend',
          userId: socket.userId,
          betAmount,
          timestamp: new Date().toISOString()
        });
        return { success: false, error: 'Invalid bet amount' };
      }

      // Validate bet type
      if (!betType || !['manual', 'auto'].includes(betType)) {
        logger.warn('INVALID_BET_TYPE', {
          service: 'aviator-backend',
          userId: socket.userId,
          betType,
          timestamp: new Date().toISOString()
        });
        return { success: false, error: 'Invalid bet type' };
      }

      // Validate auto-cashout multiplier for auto bets
      if (betType === 'auto' && (!autoCashoutMultiplier || autoCashoutMultiplier <= 1)) {
        logger.warn('INVALID_AUTO_CASHOUT_MULTIPLIER', {
          service: 'aviator-backend',
          userId: socket.userId,
          autoCashoutMultiplier,
          timestamp: new Date().toISOString()
        });
        return { success: false, error: 'Auto-cashout multiplier must be greater than 1' };
      }

      // Get current game session
      const gameSessionId = await this.gameRepository.getCurrentActiveGameSession();
      if (!gameSessionId) {
        logger.warn('NO_ACTIVE_GAME_SESSION_FOR_BET', {
          service: 'aviator-backend',
          userId: socket.userId,
          timestamp: new Date().toISOString()
        });
        return { success: false, error: 'No active game session available' };
      }

      // Place the bet
      const result = await this.betService.placeBet({
        userId: socket.userId,
        betAmount,
        betType,
        autoCashoutMultiplier,
        gameSessionId
      });

      if (!result.success) {
        logger.warn('BET_PLACEMENT_FAILED', {
          service: 'aviator-backend',
          userId: socket.userId,
          betAmount,
          betType,
          autoCashoutMultiplier,
          gameSessionId,
          error: result.error,
          timestamp: new Date().toISOString()
        });
        return result;
      }

      // Log successful bet placement
      logger.info('BET_PLACED_SUCCESSFULLY', {
        service: 'aviator-backend',
        userId: socket.userId,
        betReferenceId: result.betId, // This is now a reference ID, not the actual bet ID
        betAmount,
        betType,
        autoCashoutMultiplier,
        gameSessionId,
        timestamp: new Date().toISOString()
      });

      return result; // The result already contains the reference ID instead of the actual bet ID
    } catch (error) {
      logger.error('BET_PLACEMENT_ERROR', {
        service: 'aviator-backend',
        userId: socket.userId,
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      return { success: false, error: 'An error occurred while placing your bet' };
    }
  }

  /**
   * Publish game state to Redis
   * @param {Object} gameState - Game state to publish
   */
  async publishGameState(gameState) {
    try {
      const gameStateString = JSON.stringify(gameState);
      await RedisService.publish('game_state_channel', gameStateString);
      
      // Also store the current state in Redis for new connections
      await RedisService.setGameState('current', gameState);
      
      logger.info('GAME_STATE_PUBLISHED', {
        service: 'aviator-backend',
        gameState,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('GAME_STATE_PUBLISH_ERROR', {
        service: 'aviator-backend',
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Set up listener for game state changes
   * Activates pending bets when game state changes to 'in_progress'
   */
  async setupGameStateListener() {
    try {
      // Subscribe to game state channel
      const subscriber = await RedisService.subscribe('game_state_channel', async (message) => {
        try {
          // Parse the game state
          const gameState = JSON.parse(message);
          
          logger.info('GAME_STATE_CHANGE_DETECTED', {
            service: 'aviator-backend',
            gameState,
            timestamp: new Date().toISOString()
          });
          
          // If game state is 'in_progress', activate pending bets
          if (gameState && gameState.state === 'in_progress') {
            logger.info('ACTIVATING_PENDING_BETS', {
              service: 'aviator-backend',
              gameSessionId: gameState.gameSessionId,
              timestamp: new Date().toISOString()
            });
            
            // Activate pending bets
            const activationResult = await this.playerBetRepository.activatePendingBets();
            
            logger.info('PENDING_BETS_ACTIVATED', {
              service: 'aviator-backend',
              result: activationResult,
              timestamp: new Date().toISOString()
            });
            
            // Broadcast to all clients that bets are now active
            this.io.emit('bets_activated', {
              gameSessionId: gameState.gameSessionId,
              timestamp: new Date().toISOString()
            });
          }
        } catch (error) {
          logger.error('GAME_STATE_PROCESSING_ERROR', {
            service: 'aviator-backend',
            error: error.message,
            errorStack: error.stack,
            timestamp: new Date().toISOString()
          });
        }
      });
      
      logger.info('GAME_STATE_LISTENER_SETUP', {
        service: 'aviator-backend',
        timestamp: new Date().toISOString()
      });
      
      return subscriber;
    } catch (error) {
      logger.error('GAME_STATE_LISTENER_SETUP_ERROR', {
        service: 'aviator-backend',
        error: error.message,
        errorStack: error.stack,
        timestamp: new Date().toISOString()
      });
      throw error;
    }
  }

  async start() {
    try {
      // Initialize game session
      await this.initializeGameSession();
      
      // Set up socket event handlers
      this.initialize();
      
      // Set up game state listener
      await this.setupGameStateListener();
      
      logger.info('BET_SOCKET_STARTED', {
        gameSessionId: this.currentGameSessionId
      });
    } catch (error) {
      logger.error('BET_SOCKET_START_ERROR', {
        errorMessage: error.message
      });
    }
  }

  initialize() {
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token;
        
        if (!token) {
          return next(new Error('Authentication token is required'));
        }
        
        try {
          // Validate and decode the token
          const decoded = await validateToken(token);
          
          if (!decoded || !decoded.user_id) {
            return next(new Error('Invalid authentication token'));
          }
          
          // Store user ID in socket for later use
          socket.userId = decoded.user_id;
          
          // Get user details
          const user = await UserRepository.findById(decoded.user_id);
          
          if (!user) {
            return next(new Error('User not found'));
          }
          
          // Store user details in socket
          socket.user = user;
          
          next();
        } catch (error) {
          logger.error('Socket auth error:', error);
          return next(new Error('Authentication error'));
        }
      } catch (error) {
        logger.error('Socket connection error:', error);
        return next(new Error('Authentication error'));
      }
    });

    this.io.on('connection', (socket) => {
      logger.info('SOCKET_CONNECTED', {
        userId: socket.userId,
        socketId: socket.id
      });

      this.setupGameStateListener(socket);

      socket.on('placeBet', (payload, callback) => this.handlePlaceBet(socket, payload, callback));
      
      socket.on('cashout', (payload, callback) => this.handleCashout(socket, payload, callback));
      
      socket.on('disconnect', () => {
        logger.info('SOCKET_DISCONNECTED', {
          userId: socket.userId,
          socketId: socket.id
        });
      });
    });
  }

  setupGameStateListener(socket) {
    RedisService.subscribe('game_state_channel', async (message) => {
      try {
        const gameState = JSON.parse(message);
        
        if (gameState.status === 'in_progress') {
          logger.info('GAME_STATE_IN_PROGRESS', {
            service: 'aviator-backend',
            gameState,
            timestamp: new Date().toISOString()
          });
          
          await PlayerBetRepository.activatePendingBets();
        }
        
        socket.emit('gameStateUpdate', gameState);
      } catch (error) {
        logger.error('GAME_STATE_PROCESSING_ERROR', {
          service: 'aviator-backend',
          error: error.message,
          errorStack: error.stack,
          timestamp: new Date().toISOString()
        });
      }
    });
  }
}

export default BetSocket;
