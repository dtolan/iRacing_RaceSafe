import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// File-based Logger for Windows Service
// ============================================================================

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LoggerConfig {
  logDir: string;
  maxLogAgeDays: number;
  consoleOutput: boolean;
}

const DEFAULT_CONFIG: LoggerConfig = {
  logDir: path.join(process.env.APPDATA || os.homedir(), 'RaceSafe', 'logs'),
  maxLogAgeDays: 7,
  consoleOutput: true, // Set to false when running as service
};

let config: LoggerConfig = { ...DEFAULT_CONFIG };
let currentLogFile: string | null = null;
let logStream: fs.WriteStream | null = null;

/**
 * Initialize the logger
 */
export function initLogger(options: Partial<LoggerConfig> = {}): void {
  config = { ...DEFAULT_CONFIG, ...options };

  // Ensure log directory exists
  if (!fs.existsSync(config.logDir)) {
    fs.mkdirSync(config.logDir, { recursive: true });
  }

  // Clean old logs
  cleanOldLogs();

  // Open today's log file
  openLogFile();
}

/**
 * Configure whether to output to console
 */
export function setConsoleOutput(enabled: boolean): void {
  config.consoleOutput = enabled;
}

/**
 * Get the current log file path (for today)
 */
function getLogFilePath(): string {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(config.logDir, `racesafe-${today}.log`);
}

/**
 * Open or rotate log file if needed
 */
function openLogFile(): void {
  const newLogFile = getLogFilePath();

  // If same file, keep using it
  if (newLogFile === currentLogFile && logStream) {
    return;
  }

  // Close old stream
  if (logStream) {
    logStream.end();
  }

  // Open new stream
  currentLogFile = newLogFile;
  logStream = fs.createWriteStream(currentLogFile, { flags: 'a' });
}

/**
 * Clean logs older than maxLogAgeDays
 */
function cleanOldLogs(): void {
  try {
    const files = fs.readdirSync(config.logDir);
    const now = Date.now();
    const maxAge = config.maxLogAgeDays * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (!file.startsWith('racesafe-') || !file.endsWith('.log')) continue;

      const filePath = path.join(config.logDir, file);
      const stat = fs.statSync(filePath);

      if (now - stat.mtime.getTime() > maxAge) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (e) {
    // Ignore cleanup errors
  }
}

/**
 * Format a log message
 */
function formatMessage(level: LogLevel, message: string, data?: any): string {
  const timestamp = new Date().toISOString();
  let formatted = `[${timestamp}] [${level}] ${message}`;

  if (data !== undefined) {
    if (typeof data === 'object') {
      formatted += ' ' + JSON.stringify(data);
    } else {
      formatted += ' ' + String(data);
    }
  }

  return formatted;
}

/**
 * Write a log entry
 */
function writeLog(level: LogLevel, message: string, data?: any): void {
  // Ensure log file is current (handles day rollover)
  openLogFile();

  const formatted = formatMessage(level, message, data);

  // Write to file
  if (logStream) {
    logStream.write(formatted + '\n');
  }

  // Write to console if enabled
  if (config.consoleOutput) {
    const consoleMethod = level === 'ERROR' ? console.error :
                          level === 'WARN' ? console.warn :
                          console.log;
    consoleMethod(formatted);
  }
}

// ============================================================================
// Public Logging Functions
// ============================================================================

export function debug(message: string, data?: any): void {
  writeLog('DEBUG', message, data);
}

export function info(message: string, data?: any): void {
  writeLog('INFO', message, data);
}

export function warn(message: string, data?: any): void {
  writeLog('WARN', message, data);
}

export function error(message: string, data?: any): void {
  writeLog('ERROR', message, data);
}

/**
 * Log with color formatting for console (passes through to file without colors)
 */
export function logColored(message: string, colorCode: string = ''): void {
  // Ensure log file is current
  openLogFile();

  const timestamp = new Date().toISOString();
  const plainMessage = `[${timestamp}] [INFO] ${message}`;

  // Write plain text to file
  if (logStream) {
    logStream.write(plainMessage + '\n');
  }

  // Write colored text to console if enabled
  if (config.consoleOutput) {
    if (colorCode) {
      console.log(`${colorCode}${message}\x1b[0m`);
    } else {
      console.log(message);
    }
  }
}

/**
 * Close the logger (call on shutdown)
 */
export function closeLogger(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
    currentLogFile = null;
  }
}

// Default export for convenience
export default {
  init: initLogger,
  setConsoleOutput,
  debug,
  info,
  warn,
  error,
  logColored,
  close: closeLogger,
};
