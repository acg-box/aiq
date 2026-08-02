import type { AiqRepository } from './types.ts';
import { classifyDataProvenance } from './provenance.ts';

export type PublicReadState<T> =
  | { state: 'synthetic'; data: T }
  | { state: 'published'; data: T }
  | { state: 'mixed'; data: T }
  | { state: 'empty'; data: T }
  | { state: 'unavailable'; data: T; detail: string };

export async function readPublicData<T>(
  repository: AiqRepository,
  read: () => Promise<T>,
  emptyValue: T,
  isEmpty: (value: T) => boolean,
  syntheticValues: (value: T) => readonly (boolean | null | undefined)[],
): Promise<PublicReadState<T>> {
  try {
    const data = await read();
    if (repository.mode === 'live' && isEmpty(data)) {
      return { state: 'empty', data };
    }
    if (repository.mode === 'synthetic') return { state: 'synthetic', data };
    const provenance = classifyDataProvenance(syntheticValues(data));
    return { state: provenance === 'unavailable' ? 'empty' : provenance, data };
  } catch (error) {
    return {
      state: 'unavailable',
      data: emptyValue,
      detail: error instanceof Error ? error.message : 'The public data read failed.',
    };
  }
}

export type PublicValueState<T> =
  | { state: 'synthetic'; data: T }
  | { state: 'published'; data: T }
  | { state: 'mixed'; data: T }
  | { state: 'empty'; data: T }
  | { state: 'unavailable'; detail: string };

export async function readPublicValue<T>(
  repository: AiqRepository,
  read: () => Promise<T>,
  syntheticValues: (value: T) => readonly (boolean | null | undefined)[],
): Promise<PublicValueState<T>> {
  try {
    const data = await read();
    if (repository.mode === 'synthetic') return { state: 'synthetic', data };
    const provenance = classifyDataProvenance(syntheticValues(data));
    return { state: provenance === 'unavailable' ? 'empty' : provenance, data };
  } catch (error) {
    return {
      state: 'unavailable',
      detail: error instanceof Error ? error.message : 'The public data read failed.',
    };
  }
}
