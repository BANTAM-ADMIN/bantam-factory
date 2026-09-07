// BANTAM-owned setup state only. Never changes OS home or provider credentials.
import os from 'node:os';
import path from 'node:path';

export function bantamConfigDirectory(home, configured = process.env.BANTAM_CONFIG_DIR) {
  if (home !== undefined) return path.join(home, '.bantam');
  if (configured === undefined) return path.join(os.homedir(), '.bantam');
  if (typeof configured !== 'string' || !path.isAbsolute(configured)
    || /[\x00-\x1f\x7f]/.test(configured) || path.resolve(configured) === path.parse(configured).root) {
    throw new Error('BANTAM_CONFIG_DIR must be an absolute, non-root directory without control characters.');
  }
  return path.resolve(configured);
}
