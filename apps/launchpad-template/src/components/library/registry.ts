import { entries as backgrounds } from './backgrounds';
import { entries as motion } from './motion';
import { entries as text } from './text';
import { entries as three } from './three';
import type { LibraryEntry } from './types';

/** Every effect of the visual library. Ids are unique (checked by the tests). */
export const LIBRARY: readonly LibraryEntry[] = [...backgrounds, ...text, ...motion, ...three];
