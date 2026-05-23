import chalk, { ChalkInstance } from 'chalk'
import { inspect } from 'node:util'

import {
  IConfigLogger,
  ILogger,
  ITraceInfo,
  LOG_LEVEL_TO_METHOD,
  type LogLevel,
  LoggerLevel,
  type LoggerLevelValue,
} from './interfaces.js'

interface IInternalTraceInfo {
  traceId: string
  spanId: string
  spanParent?: string
  apiName?: string
}
interface IInternalConfigLogger extends IConfigLogger {
  trace?: IInternalTraceInfo
}

export interface ILoggerLevelConfig {
  rank: LoggerLevelValue
  chalk: ChalkInstance
  log: string
}

const levelsConfig: { [key: string]: ILoggerLevelConfig } = {
  DEBUG: { rank: LoggerLevel.DEBUG, chalk: chalk.gray, log: 'DEBUG' },
  INFO: { rank: LoggerLevel.INFO, chalk: chalk.green, log: 'INFO' },
  WARN: { rank: LoggerLevel.WARN, chalk: chalk.yellow, log: 'WARN' },
  ERROR: { rank: LoggerLevel.ERROR, chalk: chalk.red, log: 'ERROR' },
  FATAL: { rank: LoggerLevel.FATAL, chalk: chalk.red, log: 'FATAL' },
}

const logLevelMap: Record<string, LogLevel> = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  FATAL: 'CRITICAL',
}

const getRandomHexStringId = (strlen: number): string => {
  return `0x${[...Array<number>(strlen)]
    .map(() => {
      return Math.floor(Math.random() * 16).toString(16)
    })
    .join('')}`
}

export class Logger implements ILogger {
  protected readonly minLevel: number = LoggerLevel.INFO
  protected readonly traceInfo?: IInternalTraceInfo
  protected readonly printTraceInfo: boolean = true
  protected readonly printExtraData: boolean = true
  protected readonly maxExtraDataLength: number = 0
  protected readonly name: string
  protected readonly persistentLogAttributes: Record<string, unknown> = {}

  // AWS Powertools LoggerInterface requires 'trace' property
  public trace = (input: string | object, ...extraInput: (string | Error | object)[]): void => {
    this.debug(input, ...extraInput)
  }

  constructor(nameOrOptions: string | IConfigLogger, options?: IConfigLogger) {
    // Support both old API (name, options) and new API (options object with serviceName)
    let config: IConfigLogger
    if (typeof nameOrOptions === 'string') {
      this.name = nameOrOptions.replaceAll(' ', '_')
      config = options ?? {}
    } else {
      config = nameOrOptions
      this.name = (config.serviceName ?? 'Logger').replaceAll(' ', '_')
    }

    const level = (config.minLevel ?? 'info').toUpperCase()
    const loggerLevel = levelsConfig[level]
    if (loggerLevel) {
      this.minLevel = loggerLevel.rank
    }
    if (config.trace) {
      this.traceInfo = {
        traceId: config.trace.traceId ?? getRandomHexStringId(32),
        spanId: (config.trace as IInternalTraceInfo).spanId ?? getRandomHexStringId(32),
        ...(config.trace.spanParent && { spanParent: config.trace.spanParent }),
        ...(config.trace.apiName && { apiName: config.trace.apiName }),
      }
    }
    this.printTraceInfo = config.printTraceInfo ?? true
    this.printExtraData = config.printExtraData ?? true
    this.maxExtraDataLength = config.maxExtraDataLength ?? 0
  }

  public getByLevel(
    level: LoggerLevelValue,
  ): (input: string | object, ...extraInput: (string | Error | object)[]) => void {
    const methodName = LOG_LEVEL_TO_METHOD[level]
    const retVal = methodName ? (this as Record<string, unknown>)[methodName] : undefined
    if (typeof retVal === 'function') {
      return (retVal as (...args: unknown[]) => void).bind(this)
    }
    return this.debug.bind(this)
  }

  public getTraceContext(): ITraceInfo | undefined {
    return this.traceInfo
  }

  // AWS Powertools LoggerInterface methods - with proper signatures
  public debug(input: string | object, ...extraInput: (string | Error | object)[]): void {
    const message = typeof input === 'string' ? input : JSON.stringify(input)
    const extraData = extraInput.length > 0 ? (extraInput[0] as object) : undefined
    this.log(levelsConfig['DEBUG'], message, extraData)
  }

  public info(input: string | object, ...extraInput: (string | Error | object)[]): void {
    const message = typeof input === 'string' ? input : JSON.stringify(input)
    const extraData = extraInput.length > 0 ? (extraInput[0] as object) : undefined
    this.log(levelsConfig['INFO'], message, extraData)
  }

  public warn(input: string | object, ...extraInput: (string | Error | object)[]): void {
    const message = typeof input === 'string' ? input : JSON.stringify(input)
    const extraData = extraInput.length > 0 ? (extraInput[0] as object) : undefined
    this.log(levelsConfig['WARN'], message, extraData)
  }

  public error(input: string | object, ...extraInput: (string | Error | object)[]): void {
    const message = typeof input === 'string' ? input : JSON.stringify(input)
    const extraData = extraInput.length > 0 ? (extraInput[0] as object) : undefined
    this.log(levelsConfig['ERROR'], message, extraData)
  }

  public fatal(input: string | object, ...extraInput: (string | Error | object)[]): void {
    const message = typeof input === 'string' ? input : JSON.stringify(input)
    const extraData = extraInput.length > 0 ? (extraInput[0] as object) : undefined
    this.log(levelsConfig['FATAL'], message, extraData)
  }

  public critical(input: string | object, ...extraInput: (string | Error | object)[]): void {
    this.fatal(input, ...extraInput)
  }

  public complete(message: string, extraData?: object): void {
    this.log(levelsConfig['INFO'], message, extraData, true)
  }

  public addContext(_context: unknown): void {}

  // Legacy method for backward compatibility
  public child(name: string, options?: IConfigLogger): ILogger {
    return this.createChild({ serviceName: name, ...options })
  }

  // AWS Powertools LoggerInterface methods
  public getLevelName(): 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'TRACE' | 'SILENT' | 'CRITICAL' {
    const levelName = Object.keys(levelsConfig).find((key) => {
      const config = levelsConfig[key]
      return config && config.rank === this.minLevel
    })
    const mapped = logLevelMap[levelName ?? 'INFO']
    return (mapped ?? 'INFO') as 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'TRACE' | 'SILENT' | 'CRITICAL'
  }

  public setLevel(level: LogLevel): void {
    const levelUpper = level.toUpperCase()
    const loggerLevel = levelsConfig[levelUpper]
    if (loggerLevel) {
      ;(this as unknown as { minLevel: number }).minLevel = loggerLevel.rank
    } else {
      ;(this as unknown as { minLevel: number }).minLevel = LoggerLevel.INFO
    }
  }

  public createChild(options?: { serviceName?: string; logLevel?: LogLevel }): ILogger {
    const levelName = this.getLevelName()
    const traceId = this.traceInfo?.traceId ?? getRandomHexStringId(32)
    const spanId = getRandomHexStringId(32)
    const serviceName = options?.serviceName ?? this.name
    const logLevel = options?.logLevel?.toLowerCase() ?? levelName.toLowerCase()
    const newOptions: IInternalConfigLogger = {
      minLevel: logLevel,
      trace: {
        traceId,
        spanId,
        ...(this.traceInfo?.spanId && { spanParent: this.traceInfo.spanId }),
        ...(this.traceInfo?.apiName && { apiName: this.traceInfo.apiName }),
      },
      printTraceInfo: this.printTraceInfo,
      printExtraData: this.printExtraData,
      maxExtraDataLength: this.maxExtraDataLength,
      serviceName,
    }

    return this.newLogger(serviceName, newOptions)
  }

  public appendKeys(keys: Record<string, unknown>): void {
    Object.assign(this.persistentLogAttributes, keys)
  }

  public appendPersistentKeys(keys: Record<string, unknown>): void {
    this.appendKeys(keys)
  }

  public removeKeys(keys: string[]): void {
    keys.forEach((key) => {
      delete this.persistentLogAttributes[key]
    })
  }

  // Stub implementations for other LoggerInterface methods
  public flushBuffer(): void {}
  public getLogEvent(): boolean {
    return false
  }
  public addMetadata(metadata: Record<string, unknown>): void {
    this.appendKeys(metadata)
  }
  public addMetadataKeysToLogs(_keys: string[]): void {}
  public removeMetadataKeysFromLogs(_keys: string[]): void {
    this.removeKeys(_keys)
  }
  public removeAllMetadataKeysFromLogs(): void {
    Object.keys(this.persistentLogAttributes).forEach((key) => {
      delete this.persistentLogAttributes[key]
    })
  }
  public refreshSampleRateCalculation(): void {}
  public getCorrelationIds(): Record<string, string> {
    return {}
  }
  public injectLambdaContext(
    _options?: unknown,
  ): (target: unknown, propertyKey: string | symbol, descriptor: PropertyDescriptor) => PropertyDescriptor {
    return (_target: unknown, _propertyKey: string | symbol, _descriptor: PropertyDescriptor) => _descriptor
  }
  public addPowertoolsMetadata(_metadata: Record<string, unknown>): void {}
  public removePowertoolsMetadata(_keys: string[]): void {}
  public removeAllPowertoolsMetadata(): void {}
  public getPersistentLogAttributes(): Record<string, unknown> {
    return { ...this.persistentLogAttributes }
  }
  public removePersistentLogAttributes(keys: string[]): void {
    this.removeKeys(keys)
  }
  public resetKeys(): void {
    Object.keys(this.persistentLogAttributes).forEach((key) => {
      delete this.persistentLogAttributes[key]
    })
  }
  public logEventIfEnabled(_event: unknown, _overwriteValue?: boolean): void {}
  public setCorrelationId(correlationId: string): void {
    this.appendKeys({ correlationId })
  }
  public setLogLevel(level: LogLevel): void {
    this.setLevel(level)
  }
  public setPersistentLogAttributes(attributes: Record<string, unknown>): void {
    this.appendKeys(attributes)
  }
  public shouldLogEvent(overwriteValue?: boolean): boolean {
    return overwriteValue ?? true
  }

  protected newLogger(name: string, newOptions: IConfigLogger): Logger {
    return new Logger(name, newOptions)
  }

  protected buildOutput(message: string, level: ILoggerLevelConfig, extraData?: object): string {
    let strMessage = message
    if (this.printTraceInfo && this.traceInfo?.traceId?.length) {
      strMessage += `\n\ttrace: ${JSON.stringify(this.traceInfo)}`
    }
    if (Object.keys(this.persistentLogAttributes).length > 0) {
      strMessage += `\n\tpersistentKeys: ${JSON.stringify(this.persistentLogAttributes)}`
    }
    if (this.printExtraData && extraData) {
      strMessage += `\n\textraData: ${inspect(extraData, {
        depth: null,
        compact: true,
      })
        .replaceAll('\n', '')
        .replaceAll('  ', '')}`
    }
    if (this.maxExtraDataLength > 0) {
      strMessage = strMessage.substring(0, this.maxExtraDataLength)
    }
    return `${new Date().toISOString()} ${level.log}\t${this.name}\t${strMessage}`
  }

  private log(pLevel: ILoggerLevelConfig | undefined, message: string, extraData?: object, pPrint = false): void {
    const level =
      pLevel ??
      ({
        rank: LoggerLevel.FATAL,
        chalk: chalk.red,
        log: 'UNDEFINED',
      } as ILoggerLevelConfig)
    const print = level.log === 'UNDEFINED' || pPrint

    if (!(print || level.rank <= this.minLevel)) {
      return
    }

    console.log(level.chalk(this.buildOutput(message, level, extraData)))
  }
}
