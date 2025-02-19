import winston from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import { pool } from './database.js';

// Log tracking to prevent duplicate logs
const _logTracker = {
  socketAuth: new Set(),
  betPlacement: new Set(),
  gameEvents: new Map(),
  connectionEvents: new Set(),
  redisMetrics: {
    lastLoggedTotalBets: 0,
    lastLoggedTimestamp: 0
  }
};

// Custom log filtering and deduplication logic
const logFilter = winston.format((info, opts) => {
  const { message, level, service } = info;

  // Remove gameMultiplier from log metadata
  if (info.gameMultiplier !== undefined) {
    delete info.gameMultiplier;
  }

  // Simplify headers by removing full authorization token
  if (info.headers) {
    try {
      const parsedHeaders = typeof info.headers === 'string' 
        ? JSON.parse(info.headers) 
        : info.headers;

      // If authorization header exists, replace with a truncated version
      if (parsedHeaders.authorization) {
        const tokenParts = parsedHeaders.authorization.split('.');
        if (tokenParts.length === 3) {
          // Keep first 10 and last 10 characters of the token
          parsedHeaders.authorization = `Bearer ${tokenParts[0].slice(0, 10)}...${tokenParts[2].slice(-10)}`;
        }
      }

      // Reduce other headers to minimal set
      const minimalHeaders = {
        host: parsedHeaders.host,
        'content-type': parsedHeaders['content-type'],
        authorization: parsedHeaders.authorization
      };

      info.headers = JSON.stringify(minimalHeaders);
    } catch (error) {
      // If parsing fails, just remove the headers
      delete info.headers;
    }
  }

  // Simplify log messages for bet and cashout-related events
  const simplifiableLogMessages = [
    '[BET_REQUEST]', 
    '[BET_REQUEST_DETAILS]', 
    '[BET_PLACEMENT_REQUEST]',
    '[BET_PLACEMENT_SUCCESS]',
    'BET_ADDED_TO_BETTING_STATE',
    'BET_PLACED',
    '[CASHOUT_REQUEST]',
    '[CASHOUT_REQUEST_DETAILS]',
    'CASHOUT_REQUEST_DETAILS'
  ];

  if (simplifiableLogMessages.includes(message)) {
    // Reduce log verbosity to bare minimum
    const simplifiedInfo = {
      service: info.service,
      // Handle both bet and cashout scenarios
      amount: info.amount || (info.body ? JSON.parse(info.body || '{}').amount : undefined),
      multiplier: info.multiplier || (info.body ? JSON.parse(info.body || '{}').multiplier : undefined),
      userId: info.userId || (info.decodedUser ? JSON.parse(info.decodedUser).user_id : undefined)
    };

    // Only keep non-undefined values
    Object.keys(simplifiedInfo).forEach(key => 
      simplifiedInfo[key] === undefined && delete simplifiedInfo[key]
    );

    // For specific log types, further reduce information
    switch(message) {
      case 'BET_ADDED_TO_BETTING_STATE':
        simplifiedInfo.betId = info.betId;
        break;
      case 'BET_PLACED':
        simplifiedInfo.gameId = info.gameId;
        break;
      case '[BET_PLACEMENT_SUCCESS]':
        simplifiedInfo.betId = info.betId;
        break;
      case 'CASHOUT_REQUEST_DETAILS':
        simplifiedInfo.multiplier = info.multiplier;
        break;
    }

    return { ...info, ...simplifiedInfo };
  }

  // Prevent duplicate socket authentication logs
  if (message === 'SOCKET_AUTHENTICATION') {
    const authKey = `${info.userId}-${info.socketId}`;
    if (_logTracker.socketAuth.has(authKey)) {
      return false;
    }
    _logTracker.socketAuth.add(authKey);
  }

  // Prevent duplicate bet placement logs
  if (message === 'BET_PLACED') {
    const betKey = `${info.userId}-${info.betAmount}-${info.gameId}`;
    if (_logTracker.betPlacement.has(betKey)) {
      return false;
    }
    _logTracker.betPlacement.add(betKey);
  }

  // Reduce frequency of repetitive game and system logs
  const repetitiveEvents = [
    'TOTAL_BET_AMOUNT_BREAKDOWN', 
    'BETS_COLLECTED_IN_BETTING_STATE', 
    'ACTIVE_BETS_PUSHED_TO_REDIS',
    'BETS_READY_FOR_CASHOUT'
  ];

  if (repetitiveEvents.includes(message)) {
    const now = Date.now();
    const lastLogTime = _logTracker.gameEvents.get(message) || 0;
    
    // Only log these events every 30 seconds
    if (now - lastLogTime < 30000) {
      return false;
    }
    
    // Update last log time
    _logTracker.gameEvents.set(message, now);
  }

  // Optimize Redis metrics logging
  if (message === 'REDIS_BET_METRICS') {
    const { totalBetsReceived } = info;
    const now = Date.now();
    
    // Only log if total bets changed or 2 minutes have passed
    const shouldLog = 
      totalBetsReceived !== _logTracker.redisMetrics.lastLoggedTotalBets ||
      now - _logTracker.redisMetrics.lastLoggedTimestamp > 120000;

    if (shouldLog) {
      _logTracker.redisMetrics.lastLoggedTotalBets = totalBetsReceived;
      _logTracker.redisMetrics.lastLoggedTimestamp = now;
      return info;
    }
    return false;
  }

  // Prevent duplicate connection logs
  const connectionEvents = ['Database connection established', 'Redis connection established'];
  if (connectionEvents.includes(message)) {
    const connectionKey = `${message}-${info.host || info.url}`;
    if (_logTracker.connectionEvents.has(connectionKey)) {
      return false;
    }
    _logTracker.connectionEvents.add(connectionKey);
  }

  return info;
});

// Create console and file transports with advanced formatting
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} ${level}: ${message} `;
    const metadataStr = Object.keys(metadata).length 
      ? JSON.stringify(metadata, null, 2) 
      : '';
    return msg + metadataStr;
  })
);

const fileTransport = new winston.transports.DailyRotateFile({
  filename: path.join(process.cwd(), 'logs', 'aviator-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d'
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    logFilter(),
    winston.format.json()
  ),
  defaultMeta: { service: 'aviator-backend' },
  transports: [
    new winston.transports.Console({
      format: consoleFormat
    }),
    fileTransport
  ],
  exceptionHandlers: [
    new winston.transports.File({ 
      filename: path.join(process.cwd(), 'logs', 'exceptions.log') 
    })
  ],
  rejectionHandlers: [
    new winston.transports.File({ 
      filename: path.join(process.cwd(), 'logs', 'rejections.log') 
    })
  ]
});

// Extend logger with additional methods
logger.serverInfo = (message, metadata = {}) => {
  logger.info(`[SERVER] ${message}`, metadata);
};

logger.serverError = (message, metadata = {}) => {
  logger.error(`[SERVER] ${message}`, metadata);
};

logger.databaseInfo = (message, metadata = {}) => {
  logger.info(`[DATABASE] ${message}`, metadata);
};

logger.databaseError = (message, metadata = {}) => {
  logger.error(`[DATABASE] ${message}`, metadata);
};

logger.redisInfo = (message, metadata = {}) => {
  logger.info(`[REDIS] ${message}`, metadata);
};

logger.redisError = (message, metadata = {}) => {
  logger.error(`[REDIS] ${message}`, metadata);
};

// Game-specific logging (minimal)
logger.gameInfo = (message, metadata = {}) => {
  // Use standard info level, but don't log anything
  return;
};

logger.gameError = (message, metadata = {}) => {
  // Use standard error level, but don't log anything
  return;
};

// User activity logging
logger.userActivity = async (userId, activityType, ipAddress = null, deviceInfo = null) => {
  // No console logs
  try {
    return null;
  } catch (error) {
    // Minimal error logging
    logger.error('Failed to log user activity', { 
      userId, 
      activityType
    });
  }
};

// Extend logger with a method to log unique events
logger.uniqueEvent = (eventType, metadata = {}) => {
  // Track and log only unique or significant events
  const uniqueEventTypes = [
    'BET_REQUEST', 
    'BET_PLACEMENT_REQUEST', 
    'BET_PLACED', 
    'BET_PLACEMENT_SUCCESS',
    'SOCKET_AUTHENTICATION',
    'GAME_SESSION_START',
    'GAME_SESSION_END'
  ];

  if (uniqueEventTypes.includes(eventType)) {
    logger.info(eventType, metadata);
  }
}

export default logger;
