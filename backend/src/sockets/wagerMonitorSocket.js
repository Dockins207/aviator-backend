import logger from '../config/logger.js';
import wagerMonitorService from '../services/wagerMonitorService.js';
import socketAuthMiddleware from '../middleware/socketAuthMiddleware.js';

// Tracking variable to log only once per game session
let lastLoggedGameId = null;

export default function wagerMonitorSocket(io) {
  const wagerNamespace = io.of('/wager-monitor');

  // Apply socket authentication middleware
  wagerNamespace.use(socketAuthMiddleware);

  // Socket connection handler
  wagerNamespace.on('connection', async (socket) => {
    // Log socket connection immediately
    logger.info('SOCKET_CONNECTED', {
      timestamp: new Date().toISOString(),
      socketId: socket.id,
      userId: socket.user?.user_id,
      username: socket.user?.username,
      authData: socket.handshake.auth
    });

    const userId = socket.user?.user_id;
    const username = socket.user?.username;

    if (!userId || !username) {
      logger.error('Wager Monitor Socket Connection Failed', {
        reason: 'No valid user ID or username',
        socketUser: socket.user ? Object.keys(socket.user) : 'No socket user',
        socketId: socket.id
      });
      socket.disconnect(true);
      return;
    }

    // Event: Place a new bet
    socket.on('place_bet', async (betData, callback) => {
      // Log raw bet data immediately
      logger.warn('RAW_BET_DATA_RECEIVED', {
        timestamp: new Date().toISOString(),
        socketId: socket.id,
        userId: socket.user?.user_id,
        username: socket.user?.username,
        rawBetData: betData,
        socketAuthData: socket.handshake.auth,
        hasSocketUser: !!socket.user
      });

      try {
        // Log validated socket auth
        logger.info('SOCKET_AUTH_VALID', {
          timestamp: new Date().toISOString(),
          socketId: socket.id,
          userId,
          username
        });

        // Validate bet data
        if (!betData.gameId || !betData.betAmount) {
          logger.error('INVALID_BET_DATA', {
            timestamp: new Date().toISOString(),
            socketId: socket.id,
            userId,
            betData
          });
          throw new Error('Invalid bet data');
        }

        const wager = await wagerMonitorService.placeBet(
          userId,
          betData.gameId,
          betData.betAmount,
          username
        );

        // Log successful bet placement
        logger.info('BET_PLACED_SUCCESS', {
          timestamp: new Date().toISOString(),
          socketId: socket.id,
          userId,
          username,
          betAmount: wager.betAmount,
          gameId: wager.gameId
        });

        // Broadcast only raw bet data
        wagerNamespace.emit('bet_placed', { 
          userId,  
          username,
          betAmount: wager.betAmount,
          gameId: wager.gameId
        });

        // Callback with minimal data
        callback({ 
          success: true, 
          userId,  
          betAmount: wager.betAmount,
          gameId: wager.gameId
        });
      } catch (error) {
        // Log error with full context
        logger.error('BET_PLACEMENT_FAILED', {
          timestamp: new Date().toISOString(),
          socketId: socket.id,
          userId: socket.user?.user_id,
          username: socket.user?.username,
          error: error.message,
          errorStack: error.stack,
          betData
        });

        logger.error('Bet placement failed', { 
          userId,  
          username,
          error: error.message 
        });
        callback({ 
          success: false, 
          userId,  
          error: error.message 
        });
      }
    });

    // Event: Cashout bet
    socket.on('cashout_bet', async (cashoutData, callback) => {
      try {
        const updatedWager = await wagerMonitorService.cashoutBet(
          cashoutData.wagerId, 
          cashoutData.cashoutPoint,
          cashoutData.multiplier
        );

        // Broadcast only raw cashout data
        wagerNamespace.emit('bet_cashout', { 
          userId,  
          username,
          betAmount: updatedWager.betAmount,
          cashoutAmount: updatedWager.cashoutAmount,
          cashoutPoint: updatedWager.cashoutPoint
        });

        // Callback with minimal data
        callback({ 
          success: true, 
          userId,  
          betAmount: updatedWager.betAmount,
          cashoutAmount: updatedWager.cashoutAmount,
          cashoutPoint: updatedWager.cashoutPoint
        });
      } catch (error) {
        logger.error('Bet cashout failed', { 
          userId,  
          username,
          error: error.message 
        });
        callback({ 
          success: false, 
          userId,  
          error: error.message 
        });
      }
    });

    // Event: Get active wagers for the user
    socket.on('get_active_wagers', async (_, callback) => {
      try {
        const activeWagers = await wagerMonitorService.getUserActiveWagers(userId);
        
        // Transform wagers to raw data
        const rawWagers = activeWagers.map(wager => ({
          username,
          betAmount: wager.betAmount,
          gameId: wager.gameId
        }));

        callback({ 
          success: true, 
          wagers: rawWagers 
        });
      } catch (error) {
        logger.error('Retrieving active wagers failed', { 
          username,
          error: error.message 
        });
        callback({ 
          success: false, 
          error: error.message 
        });
      }
    });

    // Event: Get live bets across all users
    socket.on('get_live_bets', async (_, callback) => {
      try {
        // Retrieve all active wagers
        const activeWagers = await wagerMonitorService.getUserActiveWagers();

        // Transform to raw bet data, including username
        const liveBets = activeWagers.map(wager => ({
          username: wager.username || 'Unknown Player',
          betAmount: wager.betAmount,
          gameId: wager.gameId
        }));

        // Log only once per unique game session
        if (liveBets.length > 0 && liveBets[0].gameId !== lastLoggedGameId) {
          lastLoggedGameId = liveBets[0].gameId;
          logger.info('Live Bets Retrieved', {
            totalBets: liveBets.length,
            usernames: liveBets.map(bet => bet.username),
            gameId: lastLoggedGameId
          });
        }

        callback({ 
          success: true, 
          liveBets 
        });
      } catch (error) {
        logger.error('Retrieving live bets failed', { 
          error: error.message 
        });
        callback({ 
          success: false, 
          error: error.message 
        });
      }
    });

    // Event: Handle individual wager crash
    socket.on('handle_wager_crash', async (crashData, callback) => {
      try {
        const crashedWager = await wagerMonitorService.handleGameCrash(
          crashData.wagerId
        );

        // Broadcast only raw crash data
        wagerNamespace.emit('wager_crashed', { 
          username,
          betAmount: crashedWager.betAmount,
          gameId: crashedWager.gameId
        });

        callback({ 
          success: true, 
          betAmount: crashedWager.betAmount,
          gameId: crashedWager.gameId
        });
      } catch (error) {
        logger.error('Wager crash handling failed', { 
          username,
          error: error.message 
        });
        callback({ 
          success: false, 
          error: error.message 
        });
      }
    });

    // Optional: Periodic cleanup of old wagers
    const cleanupInterval = setInterval(() => {
      wagerMonitorService.cleanupWagers();
    }, 30 * 60 * 1000); // Every 30 minutes

    // Cleanup on disconnect
    socket.on('disconnect', () => {
      clearInterval(cleanupInterval);
    });
  });
}
