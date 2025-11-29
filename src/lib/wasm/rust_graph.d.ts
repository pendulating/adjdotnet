/* tslint:disable */
/* eslint-disable */
export class GraphMetrics {
  free(): void;
  [Symbol.dispose](): void;
  set_topology(source: Uint32Array, target: Uint32Array, node_count: number): void;
  get_component_ids(): Int32Array;
  get_connected_components(): number;
  constructor();
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_graphmetrics_free: (a: number, b: number) => void;
  readonly graphmetrics_get_component_ids: (a: number) => [number, number];
  readonly graphmetrics_get_connected_components: (a: number) => number;
  readonly graphmetrics_new: () => number;
  readonly graphmetrics_set_topology: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
