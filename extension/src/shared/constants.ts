/** Temporary MAIN-world slot. patch.js reads it and deletes it on the first line. */
export const SLOT_KEY = '__slcSlot9f3e2a7c';

export const SCRIPT_ID = 'slc-main';

export const STORAGE_KEY = 'slc-settings';

export const PATCH_FILE = 'injected/patch.js';

export const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'other',
] as const;
