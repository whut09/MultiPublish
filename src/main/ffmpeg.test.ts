import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {ffmpegCandidates,resolveFfmpegBinary} from './ffmpeg';

test('packaged Windows app resolves the single external ffmpeg resource first',()=>{
  const resourcesPath=path.join('D:','Program Files','MultiPublish','resources');
  const expected=path.normalize(path.join(resourcesPath,'ffmpeg','ffmpeg.exe'));
  const candidates=ffmpegCandidates({resourcesPath,appPath:path.join(resourcesPath,'app.asar'),importedPath:path.join(resourcesPath,'app.asar','dist-electron','main','ffmpeg.exe'),cwd:'F:/repo'});
  assert.equal(candidates[0],expected);
  assert.equal(resolveFfmpegBinary({resourcesPath,exists:candidate=>candidate===expected}),expected);
});

test('invalid bundled path is ignored when packaged binary exists',()=>{
  const resourcesPath=path.join('D:','Program Files','MultiPublish','resources');
  const expected=path.normalize(path.join(resourcesPath,'ffmpeg','ffmpeg.exe'));
  const invalid=path.normalize(path.join(resourcesPath,'app.asar.unpacked','dist-electron','main','ffmpeg.exe'));
  const binary=resolveFfmpegBinary({resourcesPath,importedPath:invalid,exists:candidate=>candidate===expected});
  assert.equal(binary,expected);
});

test('error lists every checked location',()=>{
  assert.throws(()=>resolveFfmpegBinary({resourcesPath:'X:/resources',cwd:'X:/repo',exists:()=>false}),/已检查/);
});
