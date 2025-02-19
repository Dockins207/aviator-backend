import express from 'express';
import chatController from '../controllers/chatController.js';
import groupChatController from '../controllers/chatController.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = express.Router();

// Get user's conversations
router.get('/conversations', 
  authMiddleware, 
  chatController.getUserConversations
);

// Get messages for a specific conversation
router.get('/messages/:receiverId', 
  authMiddleware, 
  chatController.getConversationMessages
);

// Send a new message
router.post('/messages', 
  authMiddleware, 
  chatController.sendMessage
);

// Mark messages as read
router.patch('/messages/read', 
  authMiddleware, 
  chatController.markMessagesAsRead
);

// Get all group chat messages
router.get('/group-messages', 
  authMiddleware, 
  groupChatController.getGroupMessages
);

// Get recent group chat messages
router.get('/group-messages/recent', 
  authMiddleware, 
  groupChatController.getRecentGroupMessages
);

// Send a new group message
router.post('/group-messages', 
  authMiddleware, 
  groupChatController.sendGroupMessage
);

export default router;
