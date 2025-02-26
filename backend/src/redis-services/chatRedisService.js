import Redis from 'ioredis';
import logger from '../config/logger.js';
import schedule from 'node-schedule';

class ChatRedisService {
  constructor() {
    // Configure Redis with authentication
    this.redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || '2020',
      db: process.env.REDIS_CHAT_DB || 2, // Separate DB for chat
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      }
    });
    
    this.MAX_CACHED_MESSAGES = 100;
    this.CACHE_EXPIRATION_DAYS = 30; // Messages older than 30 days will be cleared
    
    // Error handling
    this.redis.on('error', (error) => {
      logger.error('CHAT_REDIS_ERROR', {
        service: 'chat-service',
        errorMessage: error.message,
        errorType: error.name
      });
    });

    this.redis.on('connect', () => {
      logger.info('CHAT_REDIS_CONNECTED', {
        service: 'chat-service',
        host: this.redis.options.host,
        port: this.redis.options.port
      });
    });
    
    // Schedule periodic cleanup
    this.scheduleDataCleanup();
    
    // On initialization, clear any existing chat data
    this.forceClearChatData().catch(error => {
      logger.error('INITIAL_CHAT_DATA_CLEAR_FAILED', { error: error.message });
    });
  }

  // Schedule periodic data cleanup
  scheduleDataCleanup() {
    // Run daily at midnight
    schedule.scheduleJob('0 0 * * *', async () => {
      try {
        await this.clearOldChatData();
        logger.info('REDIS_CHAT_DATA_CLEANUP_COMPLETED', {
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('REDIS_CHAT_DATA_CLEANUP_ERROR', {
          error: error.message
        });
      }
    });
  }

  // Comprehensive method to clear old chat data
  async clearOldChatData() {
    try {
      // Clear group messages older than 30 days
      const groupMessagesKey = 'chat:group_messages';
      const allGroupMessages = await this.redis.lrange(groupMessagesKey, 0, -1);
      
      const currentTime = Date.now();
      const filteredMessages = allGroupMessages.filter(msgStr => {
        const msg = JSON.parse(msgStr);
        const messageAge = currentTime - new Date(msg.timestamp).getTime();
        return messageAge <= this.CACHE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;
      });

      // Replace the list with filtered messages
      if (filteredMessages.length < allGroupMessages.length) {
        await this.redis.del(groupMessagesKey);
        if (filteredMessages.length > 0) {
          await this.redis.rpush(groupMessagesKey, ...filteredMessages);
        }

        logger.info('REDIS_GROUP_MESSAGES_CLEANED', {
          originalCount: allGroupMessages.length,
          remainingCount: filteredMessages.length
        });
      }

      // Find and clear old conversation keys
      const conversationKeys = await this.redis.keys('chat:conversation:*');
      
      for (const key of conversationKeys) {
        const messages = await this.redis.lrange(key, 0, -1);
        const filteredConvMessages = messages.filter(msgStr => {
          const msg = JSON.parse(msgStr);
          const messageAge = currentTime - new Date(msg.timestamp).getTime();
          return messageAge <= this.CACHE_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;
        });

        if (filteredConvMessages.length < messages.length) {
          await this.redis.del(key);
          if (filteredConvMessages.length > 0) {
            await this.redis.rpush(key, ...filteredConvMessages);
          }
        }
      }

      // Optional: Trim lists to max cached messages
      await this.trimCachedMessages();
    } catch (error) {
      logger.error('REDIS_CHAT_DATA_CLEANUP_DETAILED_ERROR', {
        error: error.message
      });
      throw error;
    }
  }

  // Trim cached messages to maximum allowed
  async trimCachedMessages() {
    try {
      const groupMessagesKey = 'chat:group_messages';
      await this.redis.ltrim(groupMessagesKey, 0, this.MAX_CACHED_MESSAGES - 1);

      const conversationKeys = await this.redis.keys('chat:conversation:*');
      for (const key of conversationKeys) {
        await this.redis.ltrim(key, 0, this.MAX_CACHED_MESSAGES - 1);
      }
    } catch (error) {
      logger.error('REDIS_MESSAGE_TRIM_ERROR', {
        error: error.message
      });
    }
  }

  // Manual method to clear all chat data
  async clearAllChatData() {
    try {
      const groupMessagesKey = 'chat:group_messages';
      const conversationKeys = await this.redis.keys('chat:conversation:*');
      
      // Delete group messages
      await this.redis.del(groupMessagesKey);
      
      // Delete all conversation keys
      if (conversationKeys.length > 0) {
        await this.redis.del(...conversationKeys);
      }

      logger.info('REDIS_ALL_CHAT_DATA_CLEARED', {
        groupMessagesCleared: 1,
        conversationKeysCleared: conversationKeys.length
      });
    } catch (error) {
      logger.error('REDIS_CLEAR_ALL_CHAT_DATA_ERROR', {
        error: error.message
      });
      throw error;
    }
  }

  // Cache recent messages
  async cacheMessage(message) {
    try {
      // Validate message timestamp
      const messageDate = new Date(message.timestamp || Date.now());
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - this.CACHE_EXPIRATION_DAYS);

      // Only cache recent messages
      if (messageDate > thirtyDaysAgo) {
        const key = message.receiver_id === 'group' 
          ? 'chat:group_messages' 
          : `chat:conversation:${message.sender_id}:${message.receiver_id}`;
        
        await this.redis.lpush(key, JSON.stringify(message));
        await this.redis.ltrim(key, 0, this.MAX_CACHED_MESSAGES - 1);
      }
    } catch (error) {
      logger.error('REDIS_CACHE_MESSAGE_ERROR', { 
        error: error.message, 
        message 
      });
    }
  }

  // Get cached messages for a conversation
  async getCachedMessages(senderId, receiverId = null) {
    try {
      let key;
      if (receiverId === 'group') {
        key = 'chat:group_messages';
      } else {
        key = `chat:conversation:${senderId}:${receiverId}`;
      }

      const cachedMessages = await this.redis.lrange(key, 0, this.MAX_CACHED_MESSAGES - 1);
      return cachedMessages.map(msg => JSON.parse(msg));
    } catch (error) {
      logger.error('REDIS_GET_CACHED_MESSAGES_ERROR', { 
        error: error.message, 
        senderId, 
        receiverId 
      });
      return [];
    }
  }

  // Publish real-time message event
  async publishMessage(message) {
    try {
      await this.redis.publish('chat_messages', JSON.stringify(message));
    } catch (error) {
      logger.error('REDIS_PUBLISH_MESSAGE_ERROR', { 
        error: error.message, 
        message 
      });
    }
  }

  // Clear old conversations from Redis
  async clearOldConversations() {
    try {
      // Get all keys matching the chat conversation pattern
      const keys = await this.redis.keys('chat:conversation:*');
      
      // Track conversations to be deleted
      const conversationsToDelete = [];

      // Check each conversation key
      for (const key of keys) {
        // Get the first (oldest) message in the conversation
        const oldestMessage = await this.redis.lindex(key, -1);
        
        if (oldestMessage) {
          const parsedMessage = JSON.parse(oldestMessage);
          const messageDate = new Date(parsedMessage.created_at);
          const thirtyDaysAgo = new Date();
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - this.CACHE_EXPIRATION_DAYS);

          // If the oldest message is older than 30 days, mark for deletion
          if (messageDate < thirtyDaysAgo) {
            conversationsToDelete.push(key);
          }
        }
      }

      // Delete old conversations
      if (conversationsToDelete.length > 0) {
        await this.redis.del(...conversationsToDelete);
        
        logger.info('REDIS_CLEAR_OLD_CONVERSATIONS', {
          deletedConversations: conversationsToDelete.length
        });
      }
    } catch (error) {
      logger.error('REDIS_CLEAR_OLD_CONVERSATIONS_ERROR', { 
        error: error.message 
      });
    }
  }

  // Clear conversation cache
  async clearConversationCache(senderId, receiverId) {
    try {
      // Delete cache for both conversation directions
      const key1 = `chat:conversation:${senderId}:${receiverId}`;
      const key2 = `chat:conversation:${receiverId}:${senderId}`;
      
      await this.redis.del(key1, key2);
      
      logger.info('REDIS_CONVERSATION_CACHE_CLEARED', {
        senderId, 
        receiverId
      });
    } catch (error) {
      logger.error('REDIS_CLEAR_CONVERSATION_CACHE_ERROR', { 
        error: error.message, 
        senderId, 
        receiverId 
      });
    }
  }

  // Schedule periodic cleanup of old conversations
  startConversationCleanupSchedule() {
    // Run cleanup every 24 hours
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    
    setInterval(() => {
      this.clearOldConversations();
    }, CLEANUP_INTERVAL);

    logger.info('REDIS_CONVERSATION_CLEANUP_SCHEDULED', {
      interval: `${CLEANUP_INTERVAL / 1000 / 60 / 60} hours`
    });
  }

  // Forceful immediate clear of all chat-related Redis data
  async forceClearChatData() {
    try {
      // Find and delete ALL keys related to chat
      const chatKeys = await this.redis.keys('chat:*');
      
      if (chatKeys.length > 0) {
        // Delete all matching keys
        await this.redis.del(...chatKeys);
        
        logger.warn('REDIS_CHAT_DATA_FORCEFULLY_CLEARED', {
          keysCleared: chatKeys.length,
          clearedKeys: chatKeys
        });
      }

      // Additional verification
      const remainingKeys = await this.redis.keys('chat:*');
      if (remainingKeys.length > 0) {
        logger.error('REDIS_CHAT_DATA_CLEAR_INCOMPLETE', {
          remainingKeys: remainingKeys
        });
      }
    } catch (error) {
      logger.error('REDIS_FORCE_CLEAR_CHAT_DATA_ERROR', {
        error: error.message
      });
      throw error;
    }
  }
}

export default new ChatRedisService();
