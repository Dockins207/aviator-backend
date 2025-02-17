import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { pool } from './database.js';

// Custom log levels with game-specific logging
const logLevels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

// Custom colors for log levels
const logColors = {
  error: 'red',
  warn: 'yellow',
  info: 'blue',
  debug: 'gray'
};

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Create a custom logger with multiple transports
const logger = winston.createLogger({
  levels: logLevels,
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss.SSS'
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'aviator-backend' },
  transports: [
    // Console transport with custom formatting
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ 
          all: true,
          colors: logColors 
        }),
        winston.format.printf(({ timestamp, level, message, ...metadata }) => {
          let msg = `[${timestamp}] ${level}: ${message} `;
          
          // Add metadata if exists
          const metadataStr = Object.keys(metadata).length 
            ? JSON.stringify(metadata) 
            : '';
          
          return msg + metadataStr;
        })
      ),
      // Filter out unwanted logs
      filter: (logEntry) => logger.filterLogs(logEntry)
    }),
    
    // File transport for all logs
    new winston.transports.File({ 
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      level: 'debug',
      // Filter out unwanted logs
      filter: (logEntry) => logger.filterLogs(logEntry)
    }),
    
    // Separate error logs
    new winston.transports.File({ 
      filename: path.join(logsDir, 'error.log'), 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ]
});

// Filtering method to remove unwanted logs
logger.filterLogs = (logEntry) => {
  // Completely block any game-related logs
  const gameKeywords = [
    'Game', 'game', 'GAME_SOCKET', 'GameSocket', 
    'gameState', 'GameState', 'multiplier', 
    'crashPoint', 'betting', 'flying', 'cycle',
    'Incremented game metric'
  ];

  // Check if the log contains any game-related keywords
  const hasGameKeywords = gameKeywords.some(keyword => 
    (logEntry.message && logEntry.message.includes(keyword)) ||
    (logEntry.metadata && JSON.stringify(logEntry.metadata).includes(keyword))
  );

  // If game keywords are found, suppress the log
  if (hasGameKeywords) {
    return false;
  }

  // Default allowed contexts and messages
  const allowedContexts = [
    '[DATABASE]', 
    '[REDIS]',
    '[SERVER]'
  ];
  const allowedMessages = [
    'Database connection established successfully',
    'Closing database connection pool',
    'Redis connection established',
    'Running on ALL interfaces',
    'Port:',
    'Environment:',
    'Frontend URL:',
    'Network Interfaces:',
    'Accessible via:'
  ];

  // Check if the log should be allowed
  return allowedContexts.some(context => 
    (logEntry.message && logEntry.message.includes(context)) || 
    (logEntry.metadata && JSON.stringify(logEntry.metadata).includes(context))
  ) || allowedMessages.some(msg => 
    (logEntry.message && logEntry.message.includes(msg)) || 
    (logEntry.metadata && JSON.stringify(logEntry.metadata).includes(msg))
  );
};

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

export default logger;
