export enum LogLevel {
  NONE = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  VERBOSE = 4,
}

export default class Log {
  private static _loglevel: LogLevel = LogLevel.NONE;
  private static readonly isTestEnvironment = process.env.NODE_ENV === 'test';

  public static get loglevel(): LogLevel {
    return this._loglevel;
  }

  public static setLogLevel(level: LogLevel): void {
    // In test environment, always keep logs silenced unless explicitly overridden
    this._loglevel = this.isTestEnvironment ? LogLevel.NONE : level;
  }

  public static info(message: string): void {
    if (!this.isTestEnvironment && this._loglevel >= LogLevel.INFO) {
      console.info(message);
    }
  }

  public static error(message: string): void {
    if (!this.isTestEnvironment && this._loglevel >= LogLevel.ERROR) {
      console.error(message);
    }
  }

  public static warn(message: string): void {
    if (!this.isTestEnvironment && this._loglevel >= LogLevel.WARN) {
      console.warn(message);
    }
  }

  public static verbose(message: string): void {
    if (!this.isTestEnvironment && this._loglevel >= LogLevel.VERBOSE) {
      console.log(message);
    }
  }

  /**
   * Force enable logging even in test environment.
   * Use this only when logs are essential for debugging tests.
   */
  public static enableTestLogs(): void {
    this._loglevel = LogLevel.VERBOSE;
  }
}