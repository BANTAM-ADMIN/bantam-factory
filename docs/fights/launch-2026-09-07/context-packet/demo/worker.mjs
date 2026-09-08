import {packContext} from './api.mjs';
self.onmessage = ({data}) => {
  const id = data?.id;
  try {
    if (!Array.isArray(data?.sections) || data.sections.length > 8
        || data.sections.some(s => typeof s?.text !== 'string' || s.text.length > 4000)
        || !Number.isSafeInteger(data.maxBytes) || data.maxBytes < 0 || data.maxBytes > 16384)
      throw Error('Keep this demo to eight sections, 4,000 characters each and a 16 KiB budget.');
    self.postMessage({id, result: packContext(data.sections, data.maxBytes)});
  } catch (error) { self.postMessage({id, error: String(error.message)}); }
};
