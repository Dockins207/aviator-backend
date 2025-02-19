import logger from '../config/logger.js';
import chatService from '../services/chatService.js';
import crypto from 'crypto';
import socketAuthMiddleware from '../middleware/socketAuthMiddleware.js';

export default function chatSocket(io) {
  const groupChatNamespace = io.of('/group-chat');

  // Apply socket authentication middleware
  groupChatNamespace.use(socketAuthMiddleware);

  groupChatNamespace.on('connection', (socket) => {
    // Authenticate user (assumes socket middleware has set socket.user)
    const userId = socket.user?.id;

    // Add a safety check for userId
    if (!userId) {
      logger.error('Group Chat Socket Connection Failed', {
        socketId: socket.id,
        socketUser: socket.user,
        message: 'No valid user ID found'
      });
      socket.disconnect(true);
      return;
    }

    logger.info('Group Chat Socket Connected', {
      userId,
      socketId: socket.id
    });

    // Fetch recent messages
    socket.on('fetch_recent_messages', async (options, callback) => {
      try {
        const messages = await chatService.getGroupChatMessages({
          ...options,
          groupId: 'default_group',
          limit: options?.limit || 50,
          timeframe: options?.timeframe || 'all'
        });

        // More comprehensive message formatting
        const formattedMessages = messages.map(msg => ({
          id: msg.id,  // Include message ID
          sender: msg.sender_id,
          message: msg.message,
          media_url: msg.media_url,
          timestamp: msg.created_at || new Date().toISOString(),
          integrity: msg.integrity_hash || crypto.createHash('sha256')
            .update(msg.message)
            .digest('hex')
        }));

        // Log message retrieval
        logger.info('GROUP_MESSAGES_FETCHED', {
          userId,
          messageCount: formattedMessages.length
        });

        // Always send a response, even if messages array is empty
        callback({
          success: true,
          messages: formattedMessages,
          total: formattedMessages.length
        });

        // Broadcast to all connected clients
        groupChatNamespace.emit('group_messages', {
          messages: formattedMessages,
          total: formattedMessages.length
        });
      } catch (error) {
        logger.error('GROUP_CHAT_FETCH_RECENT_MESSAGES_ERROR', { 
          error: error.message, 
          userId,
          socketId: socket.id
        });

        // Send error back to the client
        callback({
          success: false,
          error: 'Failed to fetch recent messages',
          details: error.message,
          messages: []
        });
      }
    });

    // Send a new group message
    socket.on('send_group_message', async (messageData, callback) => {
      // Ensure callback is a function
      if (typeof callback !== 'function') {
        logger.error('INVALID_CALLBACK', {
          message: 'Callback must be a function',
          receivedType: typeof callback,
          receivedValue: callback
        });
        return;
      }

      try {
        // Validate input data
        if (!messageData || typeof messageData !== 'object') {
          logger.error('INVALID_MESSAGE_DATA', {
            message: 'Message data must be an object',
            receivedType: typeof messageData,
            receivedValue: messageData
          });
          return callback({ 
            error: true, 
            message: 'Invalid message data' 
          });
        }

        // Validate message content
        const { message } = messageData;
        if (!message || typeof message !== 'string') {
          logger.error('EMPTY_MESSAGE', {
            message: 'Message cannot be empty',
            messageData
          });
          return callback({ 
            error: true, 
            message: 'Message cannot be empty' 
          });
        }

        // Prepare message payload with additional safeguards
        const messagePayload = {
          id: crypto.randomUUID(), // Ensure unique ID
          sender_id: userId,
          message: message.trim(), // Trim whitespace
          name: 'default_group', // Explicit group name
          integrity_hash: crypto.createHash('sha256')
            .update(message.trim())
            .digest('hex')
        };

        // Save message using chat service
        const savedMessage = await chatService.saveGroupChatMessage(messagePayload);

        // Broadcast to all connected clients in the group chat
        const formattedMessage = {
          id: savedMessage.id,
          sender: savedMessage.sender_id,
          message: savedMessage.message,
          name: savedMessage.name,
          timestamp: savedMessage.created_at || new Date().toISOString(),
          integrity_hash: savedMessage.integrity_hash
        };

        // Log message creation
        logger.info('GROUP_MESSAGE_CREATED', {
          messageId: savedMessage.id,
          sender: userId,
          timestamp: formattedMessage.timestamp
        });

        // Emit to all clients in group chat
        groupChatNamespace.emit('group_message', formattedMessage);

        // Callback with saved message details
        callback({
          success: true,
          message: formattedMessage
        });
      } catch (error) {
        // Enhanced error logging
        logger.error('GROUP_CHAT_SEND_MESSAGE_ERROR', { 
          errorMessage: error.message, 
          errorStack: error.stack,
          userId,
          socketId: socket.id,
          messageData
        });

        // Comprehensive error callback
        callback({
          error: true,
          message: 'Failed to send message',
          details: error.message,
          code: error.code || 'UNKNOWN_ERROR'
        });
      }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      logger.info('Group Chat Socket Disconnected', {
        userId,
        socketId: socket.id
      });
    });
  });
}
