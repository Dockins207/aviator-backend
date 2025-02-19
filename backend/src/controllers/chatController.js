import groupChatService from '../services/chatService.js';
import logger from '../config/logger.js';
import { AuthorizationError, ValidationError } from '../utils/errorHandling.js';

class GroupChatController {
  async getGroupMessages(req, res) {
    try {
      const userId = req.user.id;
      const { limit, offset } = req.query;

      const messages = await groupChatService.getMessages({
        limit: parseInt(limit) || 50,
        offset: parseInt(offset) || 0
      });

      res.json(messages);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return res.status(401).json({ error: error.message });
      }
      
      logger.error('GET_GROUP_MESSAGES_ERROR', { 
        userId: req.user.id, 
        error: error.message 
      });
      res.status(500).json({ error: 'Failed to fetch group messages' });
    }
  }

  async sendGroupMessage(req, res) {
    try {
      const userId = req.user.id;
      const messageData = {
        sender_id: userId,
        message: req.body.message,
        media_url: req.body.media_url || null
      };

      const savedMessage = await groupChatService.sendMessage(userId, messageData);
      res.status(201).json(savedMessage);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return res.status(401).json({ error: error.message });
      }
      
      if (error instanceof ValidationError) {
        return res.status(400).json({ error: error.message });
      }
      
      logger.error('SEND_GROUP_MESSAGE_ERROR', { 
        userId: req.user.id, 
        error: error.message 
      });
      res.status(500).json({ error: 'Failed to send group message' });
    }
  }

  async getRecentGroupMessages(req, res) {
    try {
      const { hours } = req.query;
      const messages = await groupChatService.getRecentMessages(
        parseInt(hours) || 24
      );

      res.json(messages);
    } catch (error) {
      logger.error('GET_RECENT_GROUP_MESSAGES_ERROR', { 
        error: error.message 
      });
      res.status(500).json({ error: 'Failed to fetch recent group messages' });
    }
  }
}

export default new GroupChatController();
