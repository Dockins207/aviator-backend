import logger from '../config/logger.js';

export default function chatSocket(io) {
  const chatNamespace = io.of('/chat');

  chatNamespace.on('connection', (socket) => {
    console.log(`[CHAT_SOCKET] New client connected: ${socket.id}`);

    socket.on('sendMessage', (message) => {
      console.log(`[CHAT_SOCKET] Message received from ${socket.id}`);
      
      // Broadcast message to all connected chat clients
      chatNamespace.emit('newMessage', {
        userId: socket.id,
        text: message.text,
        timestamp: Date.now()
      });
    });

    socket.on('disconnect', () => {
      console.log(`[CHAT_SOCKET] Client disconnected: ${socket.id}`);
    });
  });
}
