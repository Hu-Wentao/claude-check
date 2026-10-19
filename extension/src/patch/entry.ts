import { install, type PatchConfig } from './install';

interface SlotGlobal {
  __slcCfg?: PatchConfig;
}

const cfg = (globalThis as SlotGlobal).__slcCfg;
install(globalThis as unknown as Parameters<typeof install>[0], cfg);
