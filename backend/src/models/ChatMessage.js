import { pool } from '../config/database.js';
import logger from '../config/logger.js';
import crypto from 'crypto';

class ChatMessage {
  static async create(messageData) {
    const { 
      id = crypto.randomUUID(),
      sender_id, 
      message, 
      name = 'default_group',
      integrity_hash = null
    } = messageData;
    
    const query = `
      INSERT INTO group_chats 
      (id, sender_id, message, name, integrity_hash) 
      VALUES ($1, $2, $3, $4, $5) 
      RETURNING *
    `;
    
    try {
      const result = await pool.query(query, [
        id,
        sender_id, 
        message, 
        name,
        integrity_hash
      ]);
      
      // Ensure we return the full message object
      return result.rows[0];
    } catch (error) {
      logger.error('CHAT_MESSAGE_CREATE_ERROR', {
        error: error.message,
        messageData,
        errorStack: error.stack
      });
      throw error;
    }
  }

  static async findAll(options = {}) {
    const { 
      limit = 50, 
      offset = 0,
      order = 'DESC'
    } = options;
    
    const query = `
      SELECT 
        gc.*, 
        u.username as sender_username, 
        u.profile_picture as sender_profile_picture
      FROM group_chats gc
      LEFT JOIN users u ON gc.sender_id = u.id
      ORDER BY gc.created_at ${order}
      LIMIT $1 OFFSET $2
    `;
    
    try {
      const result = await pool.query(query, [
        limit, 
        offset
      ]);
      
      return result.rows;
    } catch (error) {
      logger.error('CHAT_MESSAGES_FETCH_ERROR', { 
        error: error.message, 
        options 
      });
      throw error;
    }
  }

  static async getMessageCount() {
    const query = `
      SELECT COUNT(*) as message_count 
      FROM group_chats
    `;
    
    try {
      const result = await pool.query(query);
      return parseInt(result.rows[0].message_count, 10);
    } catch (error) {
      logger.error('CHAT_MESSAGE_COUNT_ERROR', { 
        error: error.message 
      });
      throw error;
    }
  }
}

export default ChatMessage;
