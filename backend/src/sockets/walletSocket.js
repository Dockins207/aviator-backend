import { Server } from 'socket.io';
import { WalletRepository } from '../repositories/walletRepository.js';
import logger from '../config/logger.js';
import jwt from 'jsonwebtoken'; // Import jwt

class WalletSocket {
  constructor(io) {
    this.io = io;
    this.walletNamespace = io.of('/wallet');
    this.setupListeners();
  }

  setupListeners() {
    this.walletNamespace.on('connection', async (socket) => {
      socket.on('authenticate', async (token) => {
        try {
          // Verify and decode the token
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          
          // Attach user information to the socket
          socket.user = {
            id: decoded.user_id,
            username: decoded.username,
            role: decoded.role
          };

          // Immediately fetch and emit wallet balance
          await this.emitUserWalletBalance(socket.user.id);

          // Acknowledge successful connection and balance fetch
          socket.emit('wallet:connected', { 
            status: 'success', 
            message: 'Wallet socket connected and balance fetched',
            userId: socket.user.id
          });
        } catch (error) {
          logger.warn('Socket authentication failed', {
            errorMessage: error.message
          });
          socket.emit('error', { 
            code: 'AUTH_FAILED', 
            message: 'Authentication failed' 
          });
          socket.disconnect(true);
        }
      });

      // Wallet Balance Endpoints
      socket.on('wallet:get_balance', async () => {
        if (!socket.user) {
          socket.emit('error', { 
            code: 'NOT_AUTHENTICATED', 
            message: 'User not authenticated' 
          });
          return;
        }
        await this.emitUserWalletBalance(socket.user.id);
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
            amount, 
            description
          );

          // Emit successful deposit event
          socket.emit('wallet:deposit:success', {
            status: 'success',
            amount: depositResult.amount,
            balance: depositResult.newBalance,
            transactionId: depositResult.transactionId,
            timestamp: new Date().toISOString()
          });

          // Broadcast updated balance to the user
          await this.emitUserWalletBalance(socket.user.id);
        } catch (error) {
          logger.error('Wallet deposit failed', {
            userId: socket.user.id,
            errorMessage: error.message
          });

          socket.emit('wallet:deposit:error', {
            code: 'DEPOSIT_FAILED',
            message: error.message
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
          logger.error('Wallet withdrawal failed', {
            userId: socket.user.id,
            errorMessage: error.message
          });

          socket.emit('wallet:withdraw:error', {
            code: 'WITHDRAW_FAILED',
            message: error.message
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
          logger.error('Wallet transaction history fetch failed', {
            userId: socket.user.id,
            errorMessage: error.message
          });

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

          logger.info('Manual wallet balance refresh requested', {
            userId: socket.user.id,
            requestTimestamp: refreshData.timestamp,
            requestId: refreshData.requestId
          });

          // Fetch and emit the latest balance
          await this.emitUserWalletBalance(socket.user.id, {
            requestId: refreshData.requestId,
            requestTimestamp: refreshData.timestamp
          });
        } catch (refreshError) {
          logger.error('Wallet balance refresh failed', {
            userId: socket.user.id,
            errorMessage: refreshError.message
          });
          
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
            logger.warn('Periodic balance refresh failed', {
              userId: socket.user.id,
              errorMessage: refreshError.message
            });
          }
        }
      }, 60000); // Refresh every minute

      // Clean up interval on disconnect
      socket.on('disconnect', () => {
        clearInterval(balanceRefreshInterval);
      });
    });
  }

  async emitUserWalletBalance(userId) {
    try {
      // Add a 0.5-second delay before emitting balance
      await new Promise(resolve => setTimeout(resolve, 500));

      // Fetch the latest wallet balance
      const wallet = await WalletRepository.getWalletByUserId(userId);
      
      if (wallet) {
        // Broadcast balance update to all sockets for this user
        this.walletNamespace.to(userId).emit('wallet:balance_update', {
          userId: userId,
          balance: wallet.balance,
          formattedBalance: `KSH ${wallet.balance.toFixed(2)}`,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      logger.error('Failed to emit wallet balance', {
        userId,
        errorMessage: error.message
      });
    }
  }

  async broadcastWalletUpdate(userId, transactionType, transactionDetails) {
    try {
      // Add a 0.5-second delay before emitting update
      await new Promise(resolve => setTimeout(resolve, 500));

      // Fetch the latest wallet balance
      const wallet = await WalletRepository.getWalletByUserId(userId);
      
      if (wallet) {
        // Broadcast transaction and balance update
        this.walletNamespace.to(userId).emit('wallet:transaction_update', {
          userId: userId,
          transactionType: transactionType,
          transactionDetails: transactionDetails,
          balance: wallet.balance,
          formattedBalance: `KSH ${wallet.balance.toFixed(2)}`,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      logger.error('Failed to broadcast wallet update', {
        userId,
        transactionType,
        errorMessage: error.message
      });
    }
  }

  async validateToken(token, userId) {
    try {
      // Implement token validation logic
      // This should check if the token is valid and belongs to the specified user
      // You might want to use your existing JWT verification method
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      return decoded.userId === userId;
    } catch (error) {
      logger.warn('Token validation failed', {
        userId,
        errorMessage: error.message
      });
      return false;
    }
  }

  async trackWalletEvent(userId, eventType, amount, description) {
    try {
      const eventData = {
        userId: userId,
        eventType: eventType,
        amount: parseFloat(amount),
        description: description,
        timestamp: new Date().toISOString()
      };

      // Emit the event to the user's socket
      this.walletNamespace.to(userId).emit('wallet:event', eventData);
      
      // Optionally, broadcast the updated balance
      await this.broadcastWalletUpdate(userId, eventType, eventData);
    } catch (error) {
      logger.error('Error tracking wallet event', { 
        userId, 
        eventType,
        errorMessage: error.message 
      });
    }
  }

  async broadcastGlobalWalletUpdates() {
    try {
      const wallets = await WalletRepository.getAllUserWallets();
      
      wallets.forEach(wallet => {
        const updateData = {
          userId: wallet.userId,
          balance: parseFloat(wallet.balance),
          currency: wallet.currency,
          updatedAt: new Date().toISOString()
        };

        this.walletNamespace.to(wallet.userId).emit('wallet:global_update', updateData);
      });
    } catch (error) {
      logger.error('Error broadcasting global wallet updates', { 
        errorMessage: error.message 
      });
    }
  }

  // Broadcast wallet update to specific user
  async broadcastWalletUpdate(userId, walletUpdatePayload) {
    try {
      // Find all socket connections for this user
      const userSockets = await this.findUserSockets(userId);

      if (userSockets.length === 0) {
        logger.warn('NO_ACTIVE_SOCKET_FOR_USER', { userId });
        return;
      }

      // Emit wallet update to all user's socket connections
      userSockets.forEach(socketId => {
        this.walletNamespace.to(socketId).emit('wallet:balance_updated', walletUpdatePayload);
      });

      logger.info('WALLET_UPDATE_BROADCASTED', { 
        userId, 
        socketCount: userSockets.length 
      });
    } catch (error) {
      logger.error('WALLET_BROADCAST_ERROR', {
        userId,
        errorMessage: error.message,
        errorStack: error.stack
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
