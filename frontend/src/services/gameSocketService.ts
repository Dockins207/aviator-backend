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
  private backendUrls: string[];

  constructor() {
    // Ensure backend URL is set, throw an error if not
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://192.168.0.12:8000';
    if (!backendUrl) {
      throw new Error('NEXT_PUBLIC_BACKEND_URL is not set. Please configure the backend URL in your .env file.');
    }
    this.baseUrl = backendUrl;
    this.backendUrls = [
      this.baseUrl,
      'http://192.168.0.12:8000',
      'http://localhost:8000',
      'http://127.0.0.1:8000'
    ];

    // Log backend URLs for debugging
    console.group('[SOCKET] Backend URL Configuration');
    console.log('Selected Backend URL:', this.baseUrl);
    console.log('Fallback URLs:', this.backendUrls);
    console.log('Environment Backend URL:', process.env.NEXT_PUBLIC_BACKEND_URL);
    console.groupEnd();
  }

  // Connect to WebSocket
  connect(): Socket {
    // If socket already exists and is connected, return it
    if (this.socket && this.socket.connected) {
      console.log('[SOCKET] Reusing existing socket connection');
      return this.socket;
    }

    console.log('[SOCKET] Attempting to connect to:', this.baseUrl);

    // Create new socket connection
    this.socket = io(this.baseUrl, {
      transports: ['websocket', 'polling'],  // Add polling as fallback
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 10000,
      forceNew: true,  // Always create a new connection
      extraHeaders: {
        'X-Client-Timestamp': Date.now().toString(),
        'X-Client-Version': '1.0.0'
      }
    });

    // Enhanced connection logging
    this.socket.on('connect', () => {
      console.group('[SOCKET] Connection Established');
      console.log('Connected to:', this.baseUrl);
      console.log('Socket ID:', this.socket?.id);
      console.log('Connection Timestamp:', new Date().toISOString());
      console.groupEnd();
    });

    // Detailed connection error handling
    this.socket.on('connect_error', (error) => {
      console.error('[SOCKET] Connection Error:', {
        message: error.message,
        name: error.name
      });
    });

    // Connection timeout handling
    this.socket.on('connect_timeout', () => {
      console.error('[SOCKET] Connection Timeout');
    });

    return this.socket;
  }

  // Disconnect from WebSocket
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  // Ensure socket is connected before performing actions
  private ensureSocketConnected(): Socket {
    if (!this.socket) {
      this.connect();
    }
    return this.socket!;
  }

  // Join game
  joinGame(playerData: Partial<Player>) {
    const socket = this.ensureSocketConnected();
    console.group('[SOCKET] Join Game');
    console.log('Player Data:', JSON.stringify(playerData, null, 2));
    console.groupEnd();
    socket.emit('joinGame', playerData);
  }

  // Place bet
  placeBet(betData: { betAmount: number }) {
    const socket = this.ensureSocketConnected();
    console.group('[SOCKET] Place Bet');
    console.log('Bet Data:', JSON.stringify(betData, null, 2));
    console.groupEnd();
    socket.emit('placeBet', betData);
  }

  // Cash out
  cashOut() {
    const socket = this.ensureSocketConnected();
    console.group('[SOCKET] Cash Out');
    console.log('Cash Out Request');
    console.groupEnd();
    socket.emit('cashOut');
  }

  // Listen for game state updates
  onGameStateUpdate(callback: (gameState: GameState) => void) {
    const socket = this.ensureSocketConnected();
    socket.on('gameStateUpdate', (gameState: GameState) => {
      console.group('[SOCKET] Game State Update');
      console.log('Received Game State:', JSON.stringify(gameState, null, 2));
      console.log('Game Status:', gameState.status);
      console.log('Game ID:', gameState.gameId);
      console.log('Players Count:', gameState.players.length);
      console.log('Multiplier:', gameState.multiplier);
      console.log('Crash Point:', gameState.crashPoint);
      console.groupEnd();
      
      // Validate game state before calling callback
      if (this.validateGameState(gameState)) {
        callback(gameState);
      } else {
        console.warn('[SOCKET] Invalid game state received');
      }
    });
  }

  // Listen for join game response
  onJoinGameResponse(callback: (response: { success: boolean; message: string }) => void) {
    const socket = this.ensureSocketConnected();
    socket.on('joinGameResponse', (response) => {
      console.group('[SOCKET] Join Game Response');
      console.log('Success:', response.success);
      console.log('Message:', response.message);
      console.groupEnd();
      callback(response);
    });
  }

  // Listen for bet placement response
  onBetPlacementResponse(callback: (response: { success: boolean; message: string }) => void) {
    const socket = this.ensureSocketConnected();
    socket.on('betPlacementResponse', (response) => {
      console.group('[SOCKET] Bet Placement Response');
      console.log('Success:', response.success);
      console.log('Message:', response.message);
      console.groupEnd();
      callback(response);
    });
  }

  // Listen for cash out response
  onCashOutResponse(callback: (response: { success: boolean; message: string }) => void) {
    const socket = this.ensureSocketConnected();
    socket.on('cashOutResponse', (response) => {
      console.group('[SOCKET] Cash Out Response');
      console.log('Success:', response.success);
      console.log('Message:', response.message);
      console.groupEnd();
      callback(response);
    });
  }

  // Validate game state structure
  private validateGameState(gameState: GameState): boolean {
    const requiredFields = ['status', 'gameId'];
    return requiredFields.every(field => gameState.hasOwnProperty(field));
  }
}

export default new GameSocketService();
