const logger = {
  info: (message) => {
    // Commented out to reduce verbosity
    // console.log(`[INFO] ${new Date().toISOString()}: ${message}`);
  },
  error: (message) => {
    console.error(`[ERROR] ${new Date().toISOString()}: ${message}`);
  },
  warn: (message) => {
    // Commented out to reduce verbosity
    // console.warn(`[WARN] ${new Date().toISOString()}: ${message}`);
  },
  debug: (message) => {
    // Completely disabled debug logging
    // if (process.env.NODE_ENV === 'development') {
    //   console.debug(`[DEBUG] ${new Date().toISOString()}: ${message}`);
    // }
  }
};

export default logger;
