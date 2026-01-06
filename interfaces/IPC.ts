export interface IPCEnvelope {
  v?: number;
  deviceId: string;
  processId: string;
  channel: string;
  op: string;
  payload: unknown;
  nonce: string;
  ts: number;
}

export interface IPCError {
  code: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface IPCResponse {
  nonce?: string;
  ts?: number;
  result?: unknown;
  error?: IPCError;
}

export interface IPCBridge {
  send: (envelope: IPCEnvelope) => IPCResponse | void;
  sendAsync?: (envelope: IPCEnvelope) => Promise<IPCResponse | void>;
  defaultDeviceId?: string;
  defaultProcessId?: string;
}
