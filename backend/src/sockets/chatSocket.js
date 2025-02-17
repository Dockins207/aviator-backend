import logger from '../config/logger.js';
import crypto from 'crypto';

export default function chatSocket(io) {
  const chatNamespace = io.of('/chat');

  chatNamespace.on('connection', (socket) => {
    socket.on('sendMessage', (message) => {
      // Generate unique message ID and version to prevent hydration
      const messageId = crypto.randomBytes(16).toString('hex');
      const messageVersion = Date.now();

      // Broadcast message to all connected chat clients with additional metadata
      chatNamespace.emit('newMessage', {
        id: messageId,
        version: messageVersion,
        userId: socket.id,
        text: message.text,
        timestamp: Date.now(),
        integrity: crypto.createHash('sha256').update(message.text).digest('hex')
      });
    });

    socket.on('disconnect', () => {
    });
  });
}
