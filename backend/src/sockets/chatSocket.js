import logger from '../config/logger.js';

export default function chatSocket(io) {
  const chatNamespace = io.of('/chat');

  chatNamespace.on('connection', (socket) => {
    logger.info('New chat client connected');

    socket.on('sendMessage', (message) => {
      logger.info(`Chat message received: ${JSON.stringify(message)}`);
      
      // Broadcast message to all connected chat clients
      chatNamespace.emit('newMessage', {
        userId: socket.id,
        text: message.text,
        timestamp: Date.now()
      });
    });

    socket.on('disconnect', () => {
      logger.info('Chat client disconnected');
    });
  });
}
