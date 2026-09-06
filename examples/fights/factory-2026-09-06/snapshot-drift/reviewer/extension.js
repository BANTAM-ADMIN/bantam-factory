// Reviewer-only suffix appended to the untouched starter for gauge qualification.
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.version !== 1 || !Array.isArray(manifest.files)) throw Error('invalid manifest');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error('invalid entry');
    validatePath(entry.path);
    if (seen.has(entry.path) || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isInteger(entry.mode)
      || entry.mode < 0 || entry.mode > 511) throw Error('invalid entry fields');
    seen.add(entry.path);
  }
}
export function verifyManifest(root, manifest) {
  validateRoot(root); validateManifest(manifest);
  const result = {ok:true,unchanged:[],changed:[],missing:[],unsafe:[]};
  for (const entry of [...manifest.files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const current = inspect(root, entry.path);
    if (current.kind !== 'file') { result[current.kind].push(entry.path); continue; }
    const reasons = [];
    if (current.sha256 !== entry.sha256 || current.size !== entry.size) reasons.push('content');
    if (current.mode !== entry.mode) reasons.push('mode');
    if (reasons.length) result.changed.push({path:entry.path,reasons});
    else result.unchanged.push(entry.path);
  }
  result.ok = !result.changed.length && !result.missing.length && !result.unsafe.length;
  return result;
}
const { fileURLToPath } = await import('node:url');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [verb, root, ...args] = process.argv.slice(2); let result;
    if (verb === 'create' && root) result = createManifest(root,args);
    else if (verb === 'verify' && root && args.length === 1) {
      result = verifyManifest(root,JSON.parse(fs.readFileSync(args[0],'utf8')));
      if (!result.ok) process.exitCode = 1;
    } else throw Error('usage: snapshot.js create ROOT [PATH ...] | verify ROOT MANIFEST_FILE');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 2; }
}
