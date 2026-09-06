import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assert, fs, path, fixture, cli, grade } from '../grader-support.mjs';
const workspace = path.resolve(process.argv[2]);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const entry = (name,bytes,mode=0o640) => ({path:name,sha256:sha(bytes),size:Buffer.byteLength(bytes),mode});
const clean = paths => ({ok:true,unchanged:paths,changed:[],missing:[],unsafe:[]});
await grade('snapshot-drift', async check => {
  const { createManifest: create, verifyManifest: verify } = await import(pathToFileURL(path.join(workspace,'snapshot.js')));
  const root = fixture('snapshot-grade-');
  const put = (name,bytes,mode=0o640) => {
    const file = path.join(root,name); fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,bytes); fs.chmodSync(file,mode);
  };
  try {
    await check('builder-bytes-order-and-empty', () => {
      const names = ['z雪\t\n.bin','A/file.bin','a.txt'];
      const bytes = Buffer.from([0,255,13,10,128]);
      for (const name of names) put(name,bytes);
      assert.deepEqual(create(root,names),{version:1,files:[...names].sort().map(name => entry(name,bytes))});
      assert.deepEqual(create(root,[]),{version:1,files:[]});
      assert.deepEqual(verify(root,{version:1,files:[]}),clean([]));
    });
    await check('all-drift-categories-and-source-binding', () => {
      for (const name of ['keep','content','mode','both','gone','link','directory','parent/child']) put(name,'old');
      const names = ['mode','keep','gone','directory','content','both','link','parent/child'];
      const manifest = {version:1,files:names.map(name => entry(name,'old'))};
      const saved = JSON.stringify(manifest);
      put('content','new'); fs.chmodSync(path.join(root,'mode'),0o600); put('both','NEW',0o600);
      fs.unlinkSync(path.join(root,'gone'));
      fs.unlinkSync(path.join(root,'link')); fs.symlinkSync('keep',path.join(root,'link'));
      fs.unlinkSync(path.join(root,'directory')); fs.mkdirSync(path.join(root,'directory'));
      fs.rmSync(path.join(root,'parent'),{recursive:true}); put('parent','not a directory');
      put('unselected','irrelevant');
      assert.deepEqual(verify(root,manifest),{ok:false,unchanged:['keep'],
        changed:[{path:'both',reasons:['content','mode']},{path:'content',reasons:['content']},{path:'mode',reasons:['mode']}],
        missing:['gone'],unsafe:['directory','link','parent/child']});
      assert.equal(JSON.stringify(manifest),saved,'manifest must not be modified');
      assert.equal(fs.readFileSync(path.join(root,'content'),'utf8'),'new','selected file must not be modified');
      assert.deepEqual(verify(root,{version:1,files:[entry('keep','old')]}),clean(['keep']));
      const wrongSize = {...entry('keep','old'),size:999};
      assert.deepEqual(verify(root,{version:1,files:[wrongSize]}).changed,[{path:'keep',reasons:['content']}]);
    });
    await check('non-symlink-components-and-missing-ancestors', () => {
      put('real/child','safe'); fs.symlinkSync('real',path.join(root,'alias'));
      fs.symlinkSync('absent',path.join(root,'dangling'));
      assert.deepEqual(verify(root,{version:1,files:[entry('no-parent/child',''),entry('dangling',''),entry('alias/child','safe')]}),
        {ok:false,unchanged:[],changed:[],missing:['no-parent/child'],unsafe:['alias/child','dangling']});
      for (const name of ['alias/child','dangling','directory','no-parent/child']) assert.throws(() => create(root,[name]));
      const aliasRoot = path.join(root,'root-link'); fs.symlinkSync(root,aliasRoot);
      assert.throws(() => create(aliasRoot,[])); assert.throws(() => verify(aliasRoot,{version:1,files:[]}));
    });
    await check('manifest-and-selection-validation', () => {
      const good = entry('keep','old');
      for (const selected of ['', '/etc/passwd','../keep','./keep','a//b','a/','a/../b','a\\b','x\0y']) {
        assert.throws(() => create(root,[selected]));
        assert.throws(() => verify(root,{version:1,files:[{...good,path:selected}]}));
      }
      assert.throws(() => create(root,['keep','keep']));
      for (const manifest of [null,[],{}, {version:2,files:[]},{version:1,files:{}},
        {version:1,files:[null]}, {version:1,files:[good,good]},
        ...[{sha256:'A'.repeat(64)},{sha256:'0'.repeat(63)},{size:-1},{size:1.5},
          {size:Number.MAX_SAFE_INTEGER+1},{mode:-1},{mode:512},{mode:1.5},{mode:'420'}]
          .map(change => ({version:1,files:[{...good,...change}]}))]) assert.throws(() => verify(root,manifest));
      assert.deepEqual(verify(root,{version:1,files:[{...good,extra:true}],extra:'ignored'}),clean(['keep']));
    });
    await check('cli-create-verify-drift-and-errors', () => {
      put('cli-file','abc');
      const report = cli(workspace,'snapshot.js',['create',root,'cli-file']);
      assert.equal(report.status,0,report.stderr); assert.equal(report.stderr,''); assert.ok(report.stdout.endsWith('\n'));
      assert.deepEqual(JSON.parse(report.stdout),{version:1,files:[entry('cli-file','abc')]});
      const file = path.join(root,'manifest.json'); fs.writeFileSync(file,report.stdout);
      const stable = cli(workspace,'snapshot.js',['verify',root,file]);
      assert.equal(stable.status,0,stable.stderr); assert.equal(stable.stderr,''); assert.deepEqual(JSON.parse(stable.stdout),clean(['cli-file']));
      put('cli-file','changed');
      const drift = cli(workspace,'snapshot.js',['verify',root,file]);
      assert.equal(drift.status,1,drift.stderr); assert.equal(drift.stderr,'');
      assert.deepEqual(JSON.parse(drift.stdout),{ok:false,unchanged:[],changed:[{path:'cli-file',reasons:['content']}],missing:[],unsafe:[]});
      fs.writeFileSync(file,'not JSON');
      for (const args of [[],['bogus',root],['verify',root,file],['verify',root,file,'extra'],['create',root,'../bad'],['verify',root,path.join(root,'missing-manifest')]]) {
        const result = cli(workspace,'snapshot.js',args); assert.equal(result.status,2);
        assert.equal(result.stdout,''); assert.ok(result.stderr.trim());
      }
    });
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
