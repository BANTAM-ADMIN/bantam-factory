import { jevSessionFor } from './jev/commands.js';
import { loadJevConfig } from './jev/config.js';
import { endpointKey, localModelEndpoint } from './image-gpu.js';
import { createJevEngine } from './jev/engine.js';

// Detection never starts or wakes a backend. An idle sidecar is not a selected
// chat model; only an already-awake configured engine can be adopted on launch.
export async function discoverRunningDiffusionGemma({ config = loadJevConfig(), engine = createJevEngine(config), fetchImpl = fetch } = {}) {
  try {
    if (config.engine.mode === 'unconfigured' || (await engine.status()).state !== 'awake') return null;
    const apiUrl = `${endpointKey(config.endpoint)}/v1`;
    const response = await fetchImpl(`${apiUrl}/models`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const card = (await response.json()).data?.find(m => m.id === config.servedModel);
    if (!card) return null;
    return { apiUrl, models: [card.id], dialect: 'diffusiongemma', contextTokens: card.max_model_len };
  } catch { return null; }
}

export function primaryCoordinatorFor(model) {
  const { service, config } = jevSessionFor(model);
  if (config.engine.mode === 'unconfigured') throw Error('Set up DiffusionGemma first with :jev setup');
  if (endpointKey(model.apiUrl) !== endpointKey(config.endpoint)) throw Error('The DiffusionGemma primary endpoint must match your Jev configuration');
  let closed = false;
  let prepared = false;
  return {
    run: async work => {
      if (closed) throw Error('DiffusionGemma primary session has ended');
      if (!prepared && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.endpoint).hostname)) {
        await (await import('./gpu-handoff.js')).ensureGpuHandoff('http://127.0.0.1:8085');
      }
      prepared = true;
      if (closed) throw Error('DiffusionGemma primary session has ended');
      return service.runPrimary(work);
    },
    choose: request => {
      if (closed) throw Error('DiffusionGemma primary session has ended');
      return service.choose(request);
    },
    release: async () => { closed = true; await service.releasePrimary(); },
  };
}

export async function selectDiffusionGemma(model, { out = () => {} } = {}) {
  const config = loadJevConfig();
  if (config.engine.mode === 'unconfigured') throw Error('Set up DiffusionGemma first with :jev setup');
  await model.releasePrimary?.();
  const previous = { codex: model.codex, effort: model.codexEffort, apiMode: model.apiMode,
    endpoint: model.endpoint, apiUrl: model.apiUrl, name: model.modelName, key: model.apiKey,
    dialect: model.apiDialect, deepseek: model.deepseek, profile: model.profileName };
  const local = localModelEndpoint(model);
  const localEngine = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.endpoint).hostname);
  if (localEngine) {
    // A first-time Codex user may have no native endpoint yet. The broker still
    // needs to coordinate this engine with ComfyUI on a single local GPU.
    await (await import('./gpu-handoff.js')).ensureGpuHandoff(local && !model.diffusionGemma ? local : 'http://127.0.0.1:8085');
  }
  model.switchToApi({ url: `${endpointKey(config.endpoint)}/v1`, model: config.servedModel, dialect: 'diffusiongemma' });
  out('Loading DiffusionGemma for chat and light work…\n');
  try {
    await model.ensureDiffusionGemma();
    if (!(await model.health())) throw Error('DiffusionGemma did not become healthy');
    out(`Now using DiffusionGemma · ${model.contextWindowTokens} tokens · chat + Jev\n`);
    return true;
  } catch (error) {
    await model.releasePrimary();
    if (previous.codex) model.switchToCodex({ model: previous.name, effort: previous.effort });
    else if (previous.apiMode) model.switchToApi({ url: previous.apiUrl, model: previous.name, key: previous.key, dialect: previous.dialect, deepseek: previous.deepseek });
    else model.switchTo(previous.endpoint, { profile: previous.profile });
    throw error;
  }
}
