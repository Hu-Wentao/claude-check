export const WEBRTC_POLICY = 'disable_non_proxied_udp';

const CONTROLLABLE = new Set(['controllable_by_this_extension', 'controlled_by_this_extension']);

export interface PolicyRead {
  ok: boolean;
  value: string;
  levelOfControl: string;
  error?: string;
}

type WebrtcPolicyValue = `${chrome.privacy.IPHandlingPolicy}`;

function setting(): chrome.types.ChromeSetting<WebrtcPolicyValue> | null {
  const network = chrome.privacy?.network as
    | { webRTCIPHandlingPolicy?: chrome.types.ChromeSetting<WebrtcPolicyValue> }
    | undefined;
  return network?.webRTCIPHandlingPolicy ?? null;
}

export async function readWebrtcPolicy(): Promise<PolicyRead> {
  const item = setting();
  if (!item) return { ok: false, value: '', levelOfControl: '', error: 'missing' };
  try {
    const got = await item.get({});
    return { ok: true, value: String(got.value ?? ''), levelOfControl: got.levelOfControl };
  } catch (err) {
    return { ok: false, value: '', levelOfControl: '', error: String(err) };
  }
}

export async function setWebrtcPolicy(): Promise<PolicyRead> {
  const item = setting();
  if (!item) return { ok: false, value: '', levelOfControl: '', error: 'missing' };
  const current = await readWebrtcPolicy();
  if (!current.ok) return current;
  if (!CONTROLLABLE.has(current.levelOfControl)) {
    return { ok: false, value: current.value, levelOfControl: current.levelOfControl, error: 'not-controllable' };
  }
  await item.set({ value: WEBRTC_POLICY });
  return readWebrtcPolicy();
}

export async function clearWebrtcPolicy(): Promise<PolicyRead & { removed: boolean }> {
  const item = setting();
  let removed = false;
  if (item) {
    try {
      await item.clear({});
    } catch {
      /* clear is still attempted before dropping the permission */
    }
  }
  try {
    removed = await chrome.permissions.remove({ permissions: ['privacy'] });
  } catch {
    removed = false;
  }
  const after = await readWebrtcPolicy();
  return { ...after, removed };
}
