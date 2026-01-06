declare module 'iracing-sdk-js' {
  import { EventEmitter } from 'events';

  interface InitOptions {
    telemetryUpdateInterval?: number;
    sessionInfoUpdateInterval?: number;
    sessionInfoParser?: (sessionInfo: string) => any;
  }

  interface IRacingSDK extends EventEmitter {
    telemetry: any;
    telemetryDescription: any;
    sessionInfo: any;
    Consts: any;
    camControls: any;
    playbackControls: any;
    execCmd(msgId: number, arg1?: number, arg2?: number, arg3?: number): void;
    reloadTextures(): void;
    reloadTexture(carIdx: number): void;
    execChatCmd(cmd: string, arg?: number): void;
    execChatMacro(num: number): void;
    execPitCmd(cmd: string, arg?: number): void;
    execTelemetryCmd(cmd: string): void;
  }

  export function init(opts?: InitOptions): IRacingSDK;
  export function getInstance(): IRacingSDK;
}
