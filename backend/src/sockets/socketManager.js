// Socket.IO instance manager
class SocketManager {
  constructor() {
    this.io = null;
  }

  initialize(io) {
    this.io = io;
  }

  getIO() {
    if (!this.io) {
      throw new Error('Socket.IO not initialized');
    }
    return this.io;
  }
}

export default new SocketManager();
