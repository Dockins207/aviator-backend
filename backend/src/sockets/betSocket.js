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
   * This is the primary method that determines cashout readiness
   */
  async checkBetReadinessForCashout(userId, betReferenceId) {
    try {
      logger.info('CHECKING_BET_READINESS', {
        service: 'aviator-backend',
        userId,
        betReferenceId,
        timestamp: new Date().toISOString()
      });
      
      // DEBUGGING - Always enable cashout in development (comment out in production)
      if (process.env.NODE_ENV === 'development') {
        logger.info('DEVELOPMENT MODE: FORCE-ENABLING CASHOUT', {
          userId, 
          betReferenceId
        });
        
        // Generate a secure cashout token
        const cashoutToken = crypto.randomBytes(16).toString('hex');
        
        // Store token in Redis with short expiry (30 seconds)
        try {
          const tokenKey = `cashout_token:${betReferenceId}`;
          await RedisService.setWithExpiry(tokenKey, cashoutToken, 30);
        } catch (redisError) {
          logger.warn('Redis token storage error - continuing anyway', {
            error: redisError.message
          });
          // Continue execution despite Redis error
        }
        
        // Get all connected sockets
        const allSockets = Object.values(this.io.sockets.sockets);
        logger.info('ALL_CONNECTED_SOCKETS', {
          count: allSockets.length,
          socketIds: allSockets.map(s => s.id).slice(0, 10), // Show first 10 for brevity
          userIds: allSockets.map(s => s.userId).slice(0, 10) // Show first 10
        });
        
        // Find sockets for this user
        const userSockets = allSockets.filter(s => s.userId === userId);
        logger.info('USER_SOCKETS_FOUND', {
          userId,
          socketCount: userSockets.length,
          socketIds: userSockets.map(s => s.id)
        });
        
        // Send to all user's sockets individually
        for (const socket of userSockets) {
          logger.info('EMITTING_DIRECT_TO_SOCKET', { socketId: socket.id });
          
          socket.emit('activateCashout', { 
            token: cashoutToken, 
            betId: betReferenceId 
          });
        }
        
        // Also broadcast to specific room as backup
        logger.info('BROADCASTING_TO_USER_ROOM', { userId });
        this.io.to(`user:${userId}`).emit('activateCashout', { 
          token: cashoutToken, 
          betId: betReferenceId 
        });
        
        // DEVELOPMENT: Also broadcast to all sockets for testing
        logger.info('DEVELOPMENT_BROADCAST_TO_ALL', { betReferenceId });
        this.io.emit('activateCashout', { 
          token: cashoutToken, 
          betId: betReferenceId,
          debugInfo: 'BROADCAST_TO_ALL' 
        });
        
        return true;
      }
      
      // Regular production code flow continues below
      // Use database function via betService to check if bet can be cashed out
      const cashoutStatus = await this.betService.canCashoutBet(betReferenceId, userId);
      
      // Force cashout availability for testing if needed
      // const cashoutStatus = { can_cashout: true };
      
      if (!cashoutStatus.can_cashout) {
        logger.debug('BET_NOT_READY_FOR_CASHOUT', {
          service: 'aviator-backend',
          userId,
          betReferenceId,
          reason: cashoutStatus.reason,
          timestamp: new Date().toISOString()
        });
        return false;
      }

      // Get the actual bet ID from the reference ID
      const actualBetId = this.betService.getActualBetId(betReferenceId, userId);
      if (!actualBetId) {
        logger.warn('INVALID_BET_REFERENCE', { betReferenceId, userId });
        return false;
      }
      
      // Get bet details
      const betDetails = await PlayerBetRepository.findBetById(actualBetId);
      if (!betDetails) {
        logger.warn('BET_NOT_FOUND', { actualBetId });
        return false;
      }

      // Generate a secure cashout token
      const cashoutToken = crypto.randomBytes(16).toString('hex');
      
      // Store token in Redis with short expiry (30 seconds)
      const tokenKey = `cashout_token:${betReferenceId}`;
      await RedisService.setWithExpiry(tokenKey, cashoutToken, 30);
      
      // Find user's socket - try both methods to ensure it works
      // Method 1: Find by direct matching of userId
      const userSockets = Object.values(this.io.sockets.sockets).filter(s => s.userId === userId);
      
      logger.info('FOUND_USER_SOCKETS', {
        service: 'aviator-backend',
        userId,
        betReferenceId,
        numSockets: userSockets.length,
        socketIds: userSockets.map(s => s.id),
        timestamp: new Date().toISOString()
      });

      if (userSockets.length > 0) {
        // Send cashout activation to all user sockets
        for (const socket of userSockets) {
          logger.info('SENDING_CASHOUT_ACTIVATION', {
            service: 'aviator-backend',
            userId,
            betReferenceId,
            socketId: socket.id,
            timestamp: new Date().toISOString()
          });
          
          // Send direct to socket
          socket.emit('activateCashout', { 
            token: cashoutToken,
            betId: betReferenceId
          });
        }
        
        // Also broadcast to all sockets in user's room as a fallback
        this.io.to(`user:${userId}`).emit('activateCashout', {
          token: cashoutToken,
          betId: betReferenceId
        });
        
        // Broadcast to all sockets as a last resort (only for development/debugging)
        if (process.env.NODE_ENV === 'development') {
          this.io.emit('activateCashout', {
            token: cashoutToken,
            betId: betReferenceId
          });
        }

        logger.info('CASHOUT_ACTIVATION_SENT', {
          service: 'aviator-backend',
          userId,
          betReferenceId,
          actualBetId,
          socketIds: userSockets.map(s => s.id),
          timestamp: new Date().toISOString()
        });
        
        return true;
      } else {
        logger.warn('USER_SOCKET_NOT_FOUND', { 
          userId, 
          betReferenceId,
          socketCount: Object.values(this.io.sockets.sockets).length
        });
        
        // Fall back to broadcasting to all sockets as a last resort
        this.io.emit('activateCashout', {
          token: cashoutToken,
          betId: betReferenceId
        });
        
        logger.info('FALLBACK_BROADCAST_SENT', {
          service: 'aviator-backend',
          userId,
          betReferenceId,
          timestamp: new Date().toISOString()
        });
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
      // Basic parameter validation
      if (!socket.userId || !data || !data.betId) {
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

      // Get current multiplier if not provided
      const effectiveMultiplier = cashoutMultiplier || await RedisService.getCurrentMultiplier();
      
      // Proceed with cashout - all validation happens in the database function
      const result = await this.betService.processCashout({
        userId: socket.userId,
        betId,
        cashoutMultiplier: effectiveMultiplier
      });

      // Stop monitoring this bet
      this.stopBetReadinessMonitoring(socket.userId, betId);

      if (!result.success) {
        logger.warn('CASHOUT_FAILED', {
          service: 'aviator-backend',
          userId: socket.userId,
          betReferenceId: betId,
          cashoutMultiplier: effectiveMultiplier,
          error: result.error,
          timestamp: new Date().toISOString()
        });
      } else {
        logger.info('CASHOUT_SUCCESSFUL', {
          service: 'aviator-backend',
          userId: socket.userId,
          betReferenceId: betId,
          cashoutMultiplier: effectiveMultiplier,
          payoutAmount: result.payoutAmount,
          newBalance: result.newBalance,
          timestamp: new Date().toISOString()
        });
      }

      return result;
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
      const betAmount = data.amount; 
      const betType = data.autoCashoutMultiplier ? 'auto_cashout' : 'manual_cashout';
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
      if (!betType || !['manual_cashout', 'auto_cashout', 'full_auto'].includes(betType)) {
        logger.warn('INVALID_BET_TYPE', {
          service: 'aviator-backend',
          userId: socket.userId,
          betType,
          timestamp: new Date().toISOString()
        });
        return { success: false, error: 'Invalid bet type' };
      }

      // Validate auto-cashout multiplier for auto bets
      if (betType === 'auto_cashout' && (!autoCashoutMultiplier || autoCashoutMultiplier <= 1)) {
        logger.warn('INVALID_AUTO_CASHOUT_MULTIPLIER', {
          service: 'aviator-backend',
          userId: socket.userId,
          autoCashoutMultiplier,
          timestamp: new Date().toISOString()
        });
        return { success: false, error: 'Auto-cashout multiplier must be greater than 1' };
      }

      // REMOVE THE GAME SESSION CHECK - Allow bets without an active session
      // Place the bet without requiring a game session
      const result = await this.betService.placeBet({
        userId: socket.userId,
        betAmount,
        betType,
        autoCashoutMultiplier
      });

      if (!result.success) {
        logger.warn('BET_PLACEMENT_FAILED', {
          service: 'aviator-backend',
          userId: socket.userId,
          betAmount,
          betType,
          autoCashoutMultiplier,
          error: result.error,
          timestamp: new Date().toISOString()
        });
        return result;
      }

      // Log successful bet placement
      logger.info('BET_PLACED_SUCCESSFULLY', {
        service: 'aviator-backend',
        userId: socket.userId,
        betReferenceId: result.betId,
        betAmount,
        betType,
        autoCashoutMultiplier,
        timestamp: new Date().toISOString()
      });

      return result;
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

      this.setupSocketGameStateListener(socket); // Renamed to avoid confusion

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

  // Rename this method to avoid confusion with the class-level method
  setupSocketGameStateListener(socket) {
    RedisService.subscribe('game_state_channel', async (message) => {
      try {
        const gameState = JSON.parse(message);
        
        // Emit game state update to the client
        socket.emit('gameStateUpdate', gameState);
        
        // If game state is in progress, check for user's bets that might be ready for cashout
        if (gameState.status === 'in_progress' && socket.userId) {
          logger.debug('CHECKING_ACTIVE_BETS_FOR_USER', {
            userId: socket.userId,
            gameState: gameState.status
          });
          
          // Get user's active bets and check each one for cashout readiness
          const userActiveBets = await PlayerBetRepository.getActiveBetsByUser(socket.userId);
          logger.debug(`Found ${userActiveBets.length} active bets for user ${socket.userId}`);
          
          // Immediately check for cashout readiness on game start
          if (userActiveBets.length > 0) {
            // For each active bet, translate to reference ID and check readiness
            for (const bet of userActiveBets) {
              // Get reference ID from actual bet ID
              const betReferenceId = this.betService.getBetReferenceId(bet.bet_id) ||
                                    this.betService.generateBetReference(bet.bet_id, socket.userId);
              
              logger.debug(`Checking cashout readiness for bet ${betReferenceId} (actual: ${bet.bet_id})`);
              
              // Check if bet is ready for cashout
              await this.checkBetReadinessForCashout(socket.userId, betReferenceId);
            }
            
            // Also set up periodic checks for these bets
            userActiveBets.forEach(bet => {
              const betReferenceId = this.betService.getBetReferenceId(bet.bet_id) ||
                                    this.betService.generateBetReference(bet.bet_id, socket.userId);
              
              this.startBetReadinessMonitoring(socket.userId, betReferenceId);
            });
          }
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
    
    // Add direct listener for bet placement to start monitoring immediately
    socket.on('betPlaced', async (data, callback) => {
      if (data && data.betId && socket.userId) {
        logger.debug('STARTING_MONITORING_AFTER_BET_PLACED', {
          userId: socket.userId,
          betId: data.betId
        });
        
        // Start monitoring this bet for cashout readiness
        this.startBetReadinessMonitoring(socket.userId, data.betId);
      }
    });
  }
}

export default BetSocket;
