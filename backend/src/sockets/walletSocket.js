import { Server } from 'socket.io';
import { WalletRepository } from '../repositories/walletRepository.js';
import logger from '../config/logger.js';
import { authService } from '../services/authService.js';

class WalletSocket {
  constructor(io) {
    this.io = io;
    this.walletNamespace = io.of('/wallet');
    this.setupListeners();
  }

  setupListeners() {
    this.walletNamespace.use(async (socket, next) => {
      try {
        // Get token from handshake auth or query
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        
        if (!token) {
          return next(new Error('Authentication error: No token provided'));
        }

        // Validate token
        const user = await this.verifyUserToken(token);
        if (!user) {
          return next(new Error('Authentication failed'));
        }

        // Attach user information to the socket
        socket.user = user;
        next();
      } catch (error) {
        return next(new Error('Authentication failed'));
      }
    });

    this.walletNamespace.on('connection', async (socket) => {
      // Immediately fetch and emit wallet balance
      await this.emitUserWalletBalance(socket.user.id);

      // Acknowledge successful connection and balance fetch
      socket.emit('wallet:connected', { 
        status: 'success', 
        message: 'Wallet socket connected and balance fetched',
        userId: socket.user.id
      });

      // Wallet Balance Endpoints
      socket.on('wallet:get_balance', async () => {
        if (!socket.user) {
          socket.emit('error', { 
            message: 'Authentication required',
            code: 'UNAUTHORIZED'
          });
          return;
        }

        try {
          const walletData = await this.emitUserWalletBalance(socket.user.id);
          socket.emit('wallet:balance', walletData);
        } catch (error) {
          socket.emit('error', {
            message: 'Failed to retrieve wallet balance',
            code: 'WALLET_RETRIEVAL_ERROR'
          });
        }
      });

      // Real-time transaction tracking
      socket.on('wallet:track_transactions', async (options = {}) => {
        if (!socket.user) {
          socket.emit('error', { 
            message: 'Authentication required',
            code: 'UNAUTHORIZED'
          });
          return;
        }

        try {
          const { limit = 10, offset = 0 } = options;
          const transactions = await WalletRepository.getTransactionHistory(
            socket.user.id, 
            limit, 
            offset
          );

          socket.emit('wallet:transactions', {
            userId: socket.user.id,
            transactions,
            timestamp: new Date().toISOString()
          });
        } catch (error) {
          socket.emit('error', {
            message: 'Failed to retrieve transaction history',
            code: 'TRANSACTION_RETRIEVAL_ERROR'
          });
        }
      });

      // Deposit Funds Endpoint
      socket.on('wallet:deposit', async (depositData) => {
        if (!socket.user) {
          socket.emit('wallet:deposit:error', { 
            code: 'NOT_AUTHENTICATED', 
            message: 'User not authenticated' 
          });
          return;
        }

        try {
          const { amount, description = 'Manual Deposit' } = depositData;
          
          // Validate amount
          if (!amount || amount <= 0) {
            throw new Error('Invalid deposit amount');
          }

          // Perform deposit
          const depositResult = await WalletRepository.deposit(
            socket.user.id, 
            null, // Let repository find wallet
            amount, 
            description,
            'manual',
            'KSH'
          );

          // Immediate socket event for deposit success
          this.walletNamespace.to(socket.user.id).emit('wallet:update', {
            userId: socket.user.id,
            walletId: depositResult.walletId,
            balance: depositResult.newBalance,
            transactionType: 'deposit',
            amount: amount,
            description: description,
            timestamp: new Date().toISOString()
          });

          // Optional: Confirm deposit to the initiating socket
          socket.emit('wallet:deposit:success', {
            status: 'success',
            amount: amount,
            balance: depositResult.newBalance,
            transactionId: depositResult.transactionId,
            timestamp: new Date().toISOString()
          });

        } catch (error) {
          socket.emit('wallet:deposit:error', {
            status: 'error',
            message: error.message,
            timestamp: new Date().toISOString()
          });
        }
      });

      // Withdraw Funds Endpoint
      socket.on('wallet:withdraw', async (withdrawData) => {
        if (!socket.user) {
          socket.emit('wallet:withdraw:error', { 
            code: 'NOT_AUTHENTICATED', 
            message: 'User not authenticated' 
          });
          return;
        }

        try {
          const { amount, description = 'Manual Withdrawal' } = withdrawData;
          
          // Validate amount
          if (!amount || amount <= 0) {
            throw new Error('Invalid withdrawal amount');
          }

          // Perform withdrawal
          const withdrawResult = await WalletRepository.withdraw(
            socket.user.id, 
            amount, 
            description
          );

          // Emit successful withdrawal event
          socket.emit('wallet:withdraw:success', {
            status: 'success',
            amount: withdrawResult.amount,
            balance: withdrawResult.newBalance,
            transactionId: withdrawResult.transactionId,
            timestamp: new Date().toISOString()
          });

          // Broadcast updated balance to the user
          await this.emitUserWalletBalance(socket.user.id);
        } catch (error) {
          socket.emit('wallet:withdraw:error', {
            code: 'WITHDRAW_FAILED',
            message: error.message
          });
        }
      });

      // Bet Placement Endpoint
      socket.on('wallet:place_bet', async (betData) => {
        if (!socket.user) {
          socket.emit('wallet:bet:error', { 
            code: 'NOT_AUTHENTICATED', 
            message: 'User not authenticated' 
          });
          return;
        }

        try {
          const { amount, gameId } = betData;
          
          // Validate bet amount
          if (!amount || amount <= 0) {
            throw new Error('Invalid bet amount');
          }

          // Perform bet placement
          const betResult = await WalletRepository.deposit(
            socket.user.id, 
            null, // Let repository find wallet
            -amount, // Negative amount for bet
            `Bet Placement for Game ${gameId}`,
            'game_bet',
            'KSH'
          );

          // Immediate socket event for bet placement
          this.walletNamespace.to(socket.user.id).emit('wallet:update', {
            userId: socket.user.id,
            walletId: betResult.walletId,
            balance: betResult.newBalance,
            transactionType: 'bet',
            amount: amount,
            gameId: gameId,
            timestamp: new Date().toISOString()
          });

          // Confirm bet placement to the initiating socket
          socket.emit('wallet:bet:success', {
            status: 'success',
            amount: amount,
            balance: betResult.newBalance,
            gameId: gameId,
            transactionId: betResult.transactionId,
            timestamp: new Date().toISOString()
          });

        } catch (error) {
          socket.emit('wallet:bet:error', {
            status: 'error',
            message: error.message,
            gameId: betData.gameId,
            timestamp: new Date().toISOString()
          });
        }
      });

      // Cashout Endpoint
      socket.on('wallet:cashout', async (cashoutData) => {
        if (!socket.user) {
          socket.emit('wallet:cashout:error', { 
            code: 'NOT_AUTHENTICATED', 
            message: 'User not authenticated' 
          });
          return;
        }

        try {
          const { amount, gameId } = cashoutData;
          
          // Validate cashout amount
          if (!amount || amount <= 0) {
            throw new Error('Invalid cashout amount');
          }

          // Perform cashout
          const cashoutResult = await WalletRepository.deposit(
            socket.user.id, 
            null, // Let repository find wallet
            amount, 
            `Game Cashout for Game ${gameId}`,
            'game_cashout',
            'KSH'
          );

          // Immediate socket event for cashout
          this.walletNamespace.to(socket.user.id).emit('wallet:update', {
            userId: socket.user.id,
            walletId: cashoutResult.walletId,
            balance: cashoutResult.newBalance,
            transactionType: 'cashout',
            amount: amount,
            gameId: gameId,
            timestamp: new Date().toISOString()
          });

          // Confirm cashout to the initiating socket
          socket.emit('wallet:cashout:success', {
            status: 'success',
            amount: amount,
            balance: cashoutResult.newBalance,
            gameId: gameId,
            transactionId: cashoutResult.transactionId,
            timestamp: new Date().toISOString()
          });

        } catch (error) {
          socket.emit('wallet:cashout:error', {
            status: 'error',
            message: error.message,
            gameId: cashoutData.gameId,
            timestamp: new Date().toISOString()
          });
        }
      });

      // Transaction History Endpoint
      socket.on('wallet:get_transactions', async (queryParams = {}) => {
        if (!socket.user) {
          socket.emit('wallet:transactions:error', { 
            code: 'NOT_AUTHENTICATED', 
            message: 'User not authenticated' 
          });
          return;
        }

        try {
          const { 
            limit = 50, 
            offset = 0, 
            type = null,  // Optional: filter by transaction type
            startDate = null,  // Optional: filter by date range
            endDate = null 
          } = queryParams;

          const transactions = await WalletRepository.getTransactionHistory(
            socket.user.id, 
            limit, 
            offset,
            type,
            startDate,
            endDate
          );

          socket.emit('wallet:transactions', {
            status: 'success',
            transactions: transactions,
            total: transactions.length,
            limit,
            offset
          });
        } catch (error) {
          socket.emit('wallet:transactions:error', {
            code: 'TRANSACTIONS_FETCH_FAILED',
            message: error.message
          });
        }
      });

      // Wallet Refresh Endpoint
      socket.on('wallet:refresh', async (refreshData = {}) => {
        if (!socket.user) {
          socket.emit('error', { 
            code: 'NOT_AUTHENTICATED', 
            message: 'User not authenticated' 
          });
          return;
        }

        try {
          // Validate refresh request
          if (refreshData.userId && refreshData.userId !== socket.user.id) {
            throw new Error('Unauthorized balance refresh');
          }

          // Fetch and emit the latest balance
          await this.emitUserWalletBalance(socket.user.id, {
            requestId: refreshData.requestId,
            requestTimestamp: refreshData.timestamp
          });
        } catch (refreshError) {
          socket.emit('wallet:balance:error', {
            status: 'error',
            message: 'Balance refresh failed',
            requestId: refreshData.requestId
          });
        }
      });

      // Error and Disconnect Handlers
      socket.on('error', (error) => {
        logger.error('Wallet Socket connection error', {
          socketId: socket.id,
          reason: error.message
        });
      });

      socket.on('disconnect', (reason) => {
        logger.info('Wallet Socket disconnected', {
          socketId: socket.id,
          reason: reason
        });
      });

      // Periodic Balance Refresh
      const balanceRefreshInterval = setInterval(async () => {
        if (socket.user) {
          try {
            await this.emitUserWalletBalance(socket.user.id);
          } catch (refreshError) {
          }
        }
      }, 60000); // Refresh every minute

      // Clean up interval on disconnect
      socket.on('disconnect', () => {
        clearInterval(balanceRefreshInterval);
      });
    });
  }

  async verifyUserToken(token) {
    // Use the authentication middleware to verify the token
    return await authService.verifyUserToken(token);
  }

  async emitUserWalletBalance(userId, options = {}) {
    try {
      // Fetch comprehensive wallet details
      const walletDetails = await WalletRepository.getWalletDetails(userId);

      // Emit wallet balance to the user's socket
      this.walletNamespace.to(userId).emit('wallet:balance', {
        userId,
        walletId: walletDetails.walletId,
        balance: walletDetails.balance,
        currency: walletDetails.currency,
        recentTransactions: walletDetails.recentTransactions,
        timestamp: new Date().toISOString(),
        requestId: options.requestId,
        requestTimestamp: options.requestTimestamp
      });

      logger.info('WALLET_BALANCE_EMITTED', {
        userId,
        balance: walletDetails.balance
      });

      return walletDetails;
    } catch (error) {
      logger.error('WALLET_BALANCE_EMISSION_ERROR', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  async getUserWalletBalance(userId) {
    // Implement wallet balance retrieval logic
    const walletRepository = await import('../repositories/walletRepository.js');
    return await walletRepository.default.getUserWalletBalance(userId);
  }

  // Emit wallet update to specific user
  emitWalletUpdate(payload) {
    try {
      // Validate payload
      if (!payload.userId) {
        return;
      }

      // Emit to the wallet namespace
      this.walletNamespace.to(payload.userId).emit('wallet:update', payload);
    } catch (error) {
    }
  }

  // Broadcast wallet update to specific user
  async broadcastWalletUpdate(userId, walletData) {
    try {
      // Find all sockets for this user in the wallet namespace
      const userSockets = await this.walletNamespace.fetchSockets();
      const matchingSockets = userSockets.filter(
        socket => socket.user && socket.user.id === userId
      );

      // Emit wallet update to all matching sockets
      matchingSockets.forEach(socket => {
        socket.emit('wallet:update', {
          userId: userId,
          balance: walletData.balance,
          transactions: walletData.transactions || [],
          timestamp: new Date().toISOString()
        });
      });

      logger.info('WALLET_BROADCAST', {
        userId,
        socketCount: matchingSockets.length
      });
    } catch (error) {
      logger.error('WALLET_BROADCAST_ERROR', {
        userId,
        error: error.message
      });
    }
  }

  // Helper method to find all socket connections for a user
  async findUserSockets(userId) {
    const sockets = await this.walletNamespace.fetchSockets();
    return sockets
      .filter(socket => socket.user && socket.user.id === userId)
      .map(socket => socket.id);
  }
}

export default WalletSocket;
