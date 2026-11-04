/** Opt-in isolated resource/core-module relocation test; never launches a desktop app. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { developmentToolDirectory, repositoryRoot } from './upscale-dev-support.mjs'

const hash = async (file) => { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex') }
const worker = `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Database} from './dist/store/db.js';
import {UpscaleService} from './dist/upscale/service.js';
const root=process.env.UPSCALER_VALIDATION_ROOT;
const input=path.join(root,'input.mp4'),output=path.join(root,'results');
const hash=async(file)=>{const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex')};
const db=Database.open(path.join(root,'test.db')),service=new UpscaleService(db);
const report={date:new Date().toISOString(),runtime:process.execPath,scope:'Relocated upscale modules/dependencies only, not a complete release bundle or GUI acceptance',redistributionReviewed:false,developerPathAvailable:process.env.PATH,explicitUpscaleOverride:process.env.MEDIAGRAB_UPSCALE_DIR??null};
try {
 const before=await hash(input),start=performance.now();
 report.capability=(await service.capabilities()).capability;
 assert.equal(report.capability.available,true,report.capability.reason);
 assert.equal(process.env.MEDIAGRAB_UPSCALE_DIR,undefined);
 for(const info of Object.values(report.capability.tools))assert.ok(info.path.startsWith(root+path.sep),'Dependency escaped relocated tree');
 const grant=await service.authorize(input,output);
 const task=await service.create({grant:grant.grant,fileName:'relocated-anime-2x.mp4'});
 for(;;){
   report.task=service.get(task.id);
   if(!['queued','running'].includes(report.task.status))break;
   if(performance.now()-start>120000){service.cancel(task.id);throw new Error('Relocation test exceeded two-minute short-fixture budget')}
   await new Promise(resolve=>setTimeout(resolve,50));
 }
 report.elapsedSeconds=(performance.now()-start)/1000;
 assert.equal(report.task.status,'succeeded',JSON.stringify(report.task.error));
 assert.equal(await hash(report.task.result.path),report.task.result.sha256);
 assert.equal(await hash(input),before);report.inputSha256=before;
} catch(error){report.failure=error instanceof Error?error.stack:String(error);throw error}
finally{
 await service.close();db.close();
 report.leftoverWorkDirs=(await readdir(output)).filter(name=>name.startsWith('.mediagrab-upscale-'));
 await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2)+'\\n');
 assert.deepEqual(report.leftoverWorkDirs,[]);
}
console.log(JSON.stringify(report,null,2));
`
async function noSymlinks(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, `External symlink in isolated test: ${entry.name}`)
    if (entry.isDirectory()) await noSymlinks(path.join(folder, entry.name))
  }
}
export async function main(args = process.argv.slice(2)) {
  args = args.filter((arg) => arg !== '--')
  if (args.length !== 2 || args[0] !== '--input' || !path.isAbsolute(args[1])) throw new Error('Usage: pnpm test:upscale:offline --input /absolute/path/to/short-AAC-or-silent.mp4')
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Only macOS Apple Silicon is supported')
  const source = await realpath(args[1]), before = await hash(source), tools = developmentToolDirectory()
  const node = process.env.UPSCALER_VALIDATION_NODE ?? path.join(repositoryRoot, 'apps/desktop/src-tauri/resources/core/node')
  if (!path.isAbsolute(node)) throw new Error('UPSCALER_VALIDATION_NODE must be an absolute path')
  await access(node)
  const parent = path.join(repositoryRoot, '.release-tools'); await mkdir(parent, { recursive: true })
  const root = await realpath(await mkdtemp(path.join(parent, 'upscale-relocation-')))
  const resources = path.join(root, 'MediaGrab.app/Contents/Resources/resources')
  const core = path.join(resources, 'core'), media = path.join(resources, 'media-tools'), target = path.join(media, 'darwin-arm64')
  await mkdir(core, { recursive: true }); await mkdir(target, { recursive: true }); await mkdir(path.join(root, 'results'))
  await copyFile(node, path.join(core, 'node'), constants.COPYFILE_FICLONE)
  await cp(tools, path.join(target, 'upscale'), { recursive: true, dereference: true })
  await copyFile(path.join(tools, 'ffmpeg'), path.join(target, 'ffmpeg')) // existing download-tool sibling for bundle lookup
  await cp(path.join(repositoryRoot, 'apps/server/dist'), path.join(core, 'dist'), { recursive: true, dereference: true })
  await writeFile(path.join(core, 'package.json'), '{"type":"module","private":true}\n')
  const shared = path.join(core, 'node_modules/@mediagrab/shared')
  await mkdir(shared, { recursive: true })
  await copyFile(path.join(repositoryRoot, 'packages/shared/package.json'), path.join(shared, 'package.json'))
  await cp(path.join(repositoryRoot, 'packages/shared/dist'), path.join(shared, 'dist'), { recursive: true, dereference: true })
  await cp(await realpath(path.join(repositoryRoot, 'apps/server/node_modules/zod')), path.join(core, 'node_modules/zod'), { recursive: true, dereference: true })
  await copyFile(source, path.join(root, 'input.mp4'))
  await writeFile(path.join(core, 'relocation-worker.mjs'), worker)
  await noSymlinks(resources)
  console.log(`Isolated module/resource tree (not a release .app): ${root}`)
  try {
    execFileSync(path.join(core, 'node'), [path.join(core, 'relocation-worker.mjs')], {
      cwd: core, stdio: 'inherit', timeout: 150000,
      env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', NODE_OPTIONS: undefined, NODE_PATH: undefined, MEDIAGRAB_UPSCALE_DIR: undefined, MEDIAGRAB_CORE_TOKEN: undefined, MEDIA_TOOLS_DIR: media, UPSCALER_VALIDATION_ROOT: root },
    })
    assert.equal(await hash(source), before, 'Original fixture must not change')
    const report = JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'))
    assert.equal(report.task.status, 'succeeded')
  } finally { console.log(`REPORT ${path.join(root, 'report.json')}`) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
