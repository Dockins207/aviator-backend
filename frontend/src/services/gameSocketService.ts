import { io, Socket } from 'socket.io-client';

// Define types for game state and actions
export interface Player {
  id: string;
  betAmount?: number;
  cashOutPoint?: number;
  potentialWinnings?: number;
  result?: {
    status: 'won' | 'lost';
    winnings: number;
  };
}

export interface GameState {
  status: 'betting' | 'flying' | 'crashed';
  gameId: string;
  countdown?: number;
  crashPoint?: string;
  multiplier?: string;
  startTime?: number;
  players: Player[];
}

class GameSocketService {
  private socket: Socket | null = null;
  private baseUrl: string;

  constructor() {
    // Use environment variable or default to backend's address
    this.baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';
  }

  // Connect to WebSocket
  connect() {
    if (!this.socket) {
      this.socket = io(this.baseUrl, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
      });

      // Log connection events
      this.socket.on('connect', () => {
        console.log('Connected to game socket');
      });

      this.socket.on('disconnect', (reason) => {
        console.log('Disconnected from game socket:', reason);
      });
    }

    return this.socket;
  }

  // Disconnect from WebSocket
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  // Join game
  joinGame(playerData: Partial<Player>) {
    this.socket?.emit('join_game', playerData);
  }

  // Place bet
  placeBet(betData: { betAmount: number }) {
    this.socket?.emit('place_bet', betData);
  }

  // Cash out
  cashOut() {
    this.socket?.emit('cash_out');
  }

  // Listen for game state updates
  onGameStateUpdate(callback: (gameState: GameState) => void) {
    this.socket?.on('game_state', callback);
  }

  // Listen for join game response
  onJoinGameResponse(callback: (response: { success: boolean; message: string }) => void) {
    this.socket?.on('join_game_success', (data) => callback({ success: true, message: data.message }));
    this.socket?.on('join_game_error', (data) => callback({ success: false, message: data.message }));
  }

  // Listen for bet placement response
  onBetPlacementResponse(callback: (response: { success: boolean; message: string }) => void) {
    this.socket?.on('place_bet_success', (data) => callback({ success: true, message: data.message }));
    this.socket?.on('place_bet_error', (data) => callback({ success: false, message: data.message }));
  }

  // Listen for cash out response
  onCashOutResponse(callback: (response: { success: boolean; message: string }) => void) {
    this.socket?.on('cash_out_success', (data) => callback({ success: true, message: data.message }));
    this.socket?.on('cash_out_error', (data) => callback({ success: false, message: data.message }));
  }
}

export default new GameSocketService();
