import { Sequelize, Op } from 'sequelize';
import crypto from 'crypto';
import ChatMessage from '../models/ChatMessage.js';
import logger from '../config/logger.js';
import pool from '../config/database.js';
import chatRedisService from '../redis-services/chatRedisService.js';

// Ensure a default group chat exists
async function ensureDefaultGroupChat() {
  try {
    // Find a system user to use as sender_id for the default group chat
    const userQuery = 'SELECT user_id FROM users LIMIT 1';
    const userResult = await pool.query(userQuery);
    
    if (userResult.rows.length === 0) {
      logger.error('NO_SYSTEM_USER_FOUND', { message: 'Cannot create default group chat without a system user' });
      return;
    }

    const systemUserId = userResult.rows[0].user_id;

    const query = `
      INSERT INTO group_chats (sender_id, message, name)
      VALUES ($1, $2, $3)
      ON CONFLICT DO NOTHING
    `;
    await pool.query(query, [
      systemUserId, 
      'Welcome to the main group chat!', 
      'Main Group'
    ]);
  } catch (error) {
    logger.error('DEFAULT_GROUP_CHAT_CREATION_ERROR', { error: error.message });
  }
}

class ChatService {
  constructor() {
    // Ensure default group chat exists when service is initialized
    ensureDefaultGroupChat();
  }

  // Generate a unique message integrity hash
  generateMessageIntegrityHash(messageData) {
    // Ensure all required fields exist and are strings
    const sanitizedData = {
      id: messageData.id || crypto.randomUUID(),
      sender_id: messageData.sender_id || '',
      message: messageData.message || '',
      timestamp: Date.now().toString()
    };

    const hashInput = JSON.stringify(sanitizedData);

    return crypto
      .createHash('sha256')
      .update(hashInput)
      .digest('hex');
  }

  // Check for message duplication across recent messages
  async checkMessageDuplication(messageData) {
    try {
      // Generate integrity hash
      const integrityHash = this.generateMessageIntegrityHash(messageData);
      
      // Check recent messages in database within last hour using pool query
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const query = `
        SELECT COUNT(*) as duplicate_count 
        FROM group_chats 
        WHERE 
          sender_id = $1 AND 
          message = $2 AND 
          created_at > $3 AND
          integrity_hash = $4
      `;
      const result = await pool.query(query, [
        messageData.sender_id, 
        messageData.message, 
        oneHourAgo,
        integrityHash
      ]);

      return result.rows[0].duplicate_count > 0;
    } catch (error) {
      logger.error('MESSAGE_DUPLICATION_CHECK_ERROR', { 
        error: error.message, 
        messageData 
      });
      return false;
    }
  }

  // Add this method to validate and prepare message data
  prepareMessageData(messageData) {
    // Ensure messageData is an object
    if (!messageData || typeof messageData !== 'object') {
      logger.error('INVALID_MESSAGE_DATA', { 
        message: 'Message data must be an object', 
        receivedType: typeof messageData,
        receivedValue: messageData 
      });
      throw new Error('Invalid message data');
    }

    // Validate required fields
    const { id, message, sender_id } = messageData;

    // Ensure all required fields are present and valid
    if (!id || typeof id !== 'string') {
      logger.error('MISSING_MESSAGE_ID', { messageData });
      throw new Error('Message must have a valid ID');
    }

    if (!message || typeof message !== 'string') {
      logger.error('INVALID_MESSAGE_CONTENT', { messageData });
      throw new Error('Message content must be a non-empty string');
    }

    // Ensure senderId is present (optional, but recommended)
    if (!sender_id || typeof sender_id !== 'string') {
      logger.error('INVALID_SENDER_ID', { messageData });
      throw new Error('Sender ID must be a string');
    }

    // Prepare a standardized message object
    return {
      id: id,
      content: message.trim(),
      senderId: sender_id,
      timestamp: new Date().toISOString()
    };
  }

  async saveMessage(currentUserId, messageData) {
    try {
      // Validate sender and receiver
      if (messageData.sender_id !== currentUserId) {
        throw new Error('Unauthorized message sender');
      }

      // Check for message duplication
      const isDuplicate = await this.checkMessageDuplication(messageData);
      
      if (isDuplicate) {
        logger.warn('DUPLICATE_MESSAGE_PREVENTED', {
          sender: messageData.sender_id,
          receiver: messageData.receiver_id
        });
        return null;
      }

      // Save group chat message
      const savedMessageId = await this.saveGroupChatMessage(messageData);
      
      // Validate message before caching and publishing
      if (savedMessageId) {
        // Cache in Redis (background, non-blocking)
        await chatRedisService.cacheMessage({
          id: savedMessageId,
          ...messageData
        }).catch(err => logger.warn('REDIS_CACHE_FAILED', { error: err.message }));
        
        // Publish real-time event (background, non-blocking)
        await chatRedisService.publishMessage({
          id: savedMessageId,
          ...messageData
        })
          .catch(err => logger.warn('REDIS_PUBLISH_FAILED', { error: err.message }));
      }
      
      return savedMessageId;
    } catch (error) {
      logger.error('CHAT_MESSAGE_SAVE_ERROR', { 
        error: error.message, 
        messageData 
      });
      throw error;
    }
  }

  async saveGroupChatMessage(messageData) {
    try {
      // Validate and prepare message data
      const preparedMessage = this.prepareMessageData(messageData);

      // Log the prepared message for debugging
      logger.info('PREPARED_GROUP_MESSAGE', { preparedMessage });

      // Prepare payload for ChatMessage.create
      const chatMessagePayload = {
        id: preparedMessage.id,
        sender_id: preparedMessage.senderId,
        message: preparedMessage.content,
        name: 'default_group', // Default group name
        integrity_hash: crypto.createHash('sha256')
          .update(preparedMessage.content)
          .digest('hex')
      };

      // Save message using updated ChatMessage model
      const savedMessage = await ChatMessage.create(chatMessagePayload);

      return savedMessage;
    } catch (error) {
      logger.error('GROUP_MESSAGE_SAVE_ERROR', {
        errorMessage: error.message,
        originalMessageData: messageData,
        errorStack: error.stack
      });
      throw error;
    }
  }

  async getMessages(currentUserId, options = {}) {
    const { 
      limit = 50, 
      offset = 0
    } = options;
    
    try {
      // Validate authentication
      if (!currentUserId) {
        throw new Error('User not authenticated');
      }

      // First, try to get cached messages from Redis
      const cachedMessages = await chatRedisService.getCachedMessages(currentUserId, 'group');
      
      if (cachedMessages && cachedMessages.length > 0) {
        return cachedMessages;
      }
      
      // If no cached messages, fetch from PostgreSQL
      const messages = await ChatMessage.findAll({
        limit,
        offset
      });
      
      // Cache fetched messages in background
      if (messages && messages.length > 0) {
        // Cache each message 
        for (const message of messages) {
          await chatRedisService.cacheMessage({
            ...message,
            sender_id: currentUserId,
            receiver_id: 'group'
          }).catch(err => logger.warn('REDIS_CACHE_MESSAGE_FAILED', { error: err.message }));
        }
      }
      
      return messages;
    } catch (error) {
      logger.error('CHAT_MESSAGES_FETCH_ERROR', { 
        error: error.message, 
        options 
      });
      throw error;
    }
  }

  async getGroupChatMessages(options = {}) {
    const { 
      limit = 50, 
      offset = 0,
      timeframe = 'all',
      groupId = 'default_group'
    } = options;
    
    try {
      // Construct base query
      const query = `
        SELECT 
          gc.*, 
          u.username as sender_username, 
          u.profile_picture as sender_profile_picture
        FROM group_chats gc
        LEFT JOIN users u ON gc.sender_id = u.user_id
        WHERE 1=1
      `;

      const queryParams = [];
      let paramIndex = 1;

      // Add timeframe filtering if not 'all'
      if (timeframe !== 'all') {
        const timePeriod = {
          'today': `AND gc.created_at >= CURRENT_DATE`,
          'last_week': `AND gc.created_at >= CURRENT_DATE - INTERVAL '7 days'`,
          'last_month': `AND gc.created_at >= CURRENT_DATE - INTERVAL '30 days'`
        };

        if (timePeriod[timeframe]) {
          query += ` ${timePeriod[timeframe]}`;
        }
      }

      // Add order and pagination
      query += ` 
        ORDER BY gc.created_at DESC 
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      queryParams.push(limit, offset);

      // Execute query
      const result = await pool.query(query, queryParams);
      
      return result.rows;
    } catch (error) {
      logger.error('GROUP_CHAT_MESSAGES_FETCH_ERROR', { 
        error: error.message, 
        options 
      });
      throw error;
    }
  }

  async markMessagesAsRead(currentUserId, senderId, receiverId) {
    try {
      // Validate authentication and authorization
      if (!currentUserId) {
        throw new Error('User not authenticated');
      }

      // Ensure current user is either sender or receiver
      if (currentUserId !== senderId && currentUserId !== receiverId) {
        throw new Error('Unauthorized message read operation');
      }

      const updatedMessages = await ChatMessage.updateStatus(senderId, receiverId);
      
      // Invalidate Redis cache for this conversation
      await chatRedisService.clearConversationCache(senderId, receiverId);
      
      return updatedMessages;
    } catch (error) {
      logger.error('CHAT_MARK_READ_ERROR', { 
        error: error.message, 
        currentUserId,
        senderId, 
        receiverId 
      });
      throw error;
    }
  }

  async getUserConversations(currentUserId) {
    try {
      // Validate authentication
      if (!currentUserId) {
        throw new Error('User not authenticated');
      }

      const query = `
        SELECT DISTINCT 
          CASE 
            WHEN sender_id = $1 THEN receiver_id 
            ELSE sender_id 
          END AS conversation_partner_id,
          MAX(created_at) AS last_message_time,
          (
            SELECT message 
            FROM chat_messages cm2 
            WHERE 
              (cm2.sender_id = $1 AND cm2.receiver_id = conversation_partner_id) 
              OR 
              (cm2.receiver_id = $1 AND cm2.sender_id = conversation_partner_id)
            ORDER BY created_at DESC 
            LIMIT 1
          ) AS last_message
        FROM chat_messages cm
        WHERE sender_id = $1 OR receiver_id = $1
        GROUP BY conversation_partner_id
        ORDER BY last_message_time DESC
      `;
      
      const result = await pool.query(query, [currentUserId]);
      
      // Fetch additional user details for conversations
      const conversationsWithUserDetails = await Promise.all(
        result.rows.map(async (conversation) => {
          const partnerDetails = await getUserById(conversation.conversation_partner_id);
          return {
            ...conversation,
            partner: partnerDetails
          };
        })
      );
      
      return conversationsWithUserDetails;
    } catch (error) {
      logger.error('GET_USER_CONVERSATIONS_ERROR', { 
        error: error.message, 
        userId: currentUserId 
      });
      throw error;
    }
  }

  async getConversationMessages(currentUserId, receiverId, options = {}) {
    const { limit = 50, offset = 0 } = options;
    
    try {
      // Validate authentication and authorization
      if (!currentUserId) {
        throw new Error('User not authenticated');
      }

      // Validate receiver exists
      const receiverExists = await checkUserExists(receiverId);
      if (!receiverExists) {
        throw new Error('Receiver user does not exist');
      }

      const query = `
        SELECT * FROM chat_messages 
        WHERE 
          (sender_id = $1 AND receiver_id = $2) 
          OR 
          (sender_id = $2 AND receiver_id = $1)
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4
      `;
      
      const result = await pool.query(query, [
        currentUserId, 
        receiverId, 
        limit, 
        offset
      ]);
      
      return result.rows;
    } catch (error) {
      logger.error('GET_CONVERSATION_MESSAGES_ERROR', { 
        error: error.message, 
        currentUserId,
        receiverId 
      });
      throw error;
    }
  }

  async getGroupConversationMessages(groupId, options = {}) {
    const { limit = 50, offset = 0 } = options;
    
    try {
      // Fetch messages from PostgreSQL
      const messages = await ChatMessage.findAll({
        where: {
          group_id: groupId
        },
        limit,
        offset
      });
      
      return messages;
    } catch (error) {
      logger.error('GET_GROUP_CONVERSATION_MESSAGES_ERROR', { 
        error: error.message, 
        groupId 
      });
      throw error;
    }
  }

  async getRecentGroupMessages(groupId, hours = 24) {
    try {
      // Fetch recent messages from PostgreSQL
      const messages = await ChatMessage.getRecentMessages(groupId, hours);
      
      return messages;
    } catch (error) {
      logger.error('GET_RECENT_GROUP_MESSAGES_ERROR', { 
        error: error.message, 
        groupId 
      });
      throw error;
    }
  }
}

export default new ChatService();
