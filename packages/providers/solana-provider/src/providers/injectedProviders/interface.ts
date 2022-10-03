import type { SafeEventEmitter } from "@toruslabs/openlogin-jrpc";
import { RequestArguments } from "@web3auth-mpc/base";

export interface InjectedProvider extends SafeEventEmitter {
  request<T>(args: RequestArguments): Promise<T>;
}
