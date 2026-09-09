import type { BridgeConfig } from "./config.js";
import { DshClient } from "./dsh-client.js";
import { RemoteDshClient } from "./remote-client.js";

export function createDshClient(config: BridgeConfig) {
  return config.protocol === "legacy"
    ? new DshClient(config.hostUrl, config.requestTimeoutMs)
    : new RemoteDshClient(config.hostUrl, config.requestTimeoutMs, config.hostToken, undefined, config.hostCookie);
}
