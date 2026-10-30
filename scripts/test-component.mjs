// SPDX-License-Identifier: MIT
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const buildArg = process.argv[2];
if (!buildArg || process.argv.length !== 3) throw Error('Usage: test-component.mjs BUILD_DIRECTORY');
const build = fs.realpathSync(buildArg), bin = path.join(build, 'bin');
const probes = [
    ['nexus_user-device-association',6309], ['nexus_user-audio',334], ['nexus_windows-account-metadata',1713],
    ['nexus_game-relaunch',64], ['nexus_game-relaunch-search', 116], ['nexus_async-provider-contract',116], ['nexus_system_device_id', 332], ['nexus_async-schedule', 16],
    ['nexus_async-completion-lifetime', 2805], ['nexus_taskqueue-teardown', 20],
    ['nexus_taskqueue-close', 1137], ['nexus_taskqueue-contract', 1374],
    ['nexus_package-identity', 15], ['nexus_package-legacy', 139], ['nexus_package-chunks', 312],
    ['nexus_package-content',332], ['nexus_package-monitors', 362], ['nexus_package-progress-bytes', 115],
    ['nexus_package-selection', 750],
    ['nexus_gamesave-sync', 283], ['nexus_gamesave-transfer', 263], ['nexus_gamesave-files', 25],
    ['nexus_gamesave-file-paths', 55],
    ['nexus_game-invitations', 56, ['--component']],
];
const binaries = ['xgameruntime.dll', 'test_xgameruntime.exe', 'test_nexus_configuration.exe', 'test_nexus_timer.exe', 'test_nexus_save.exe', 'test_nexus_user.exe', 'test_nexus_async_identity.exe', 'nexus_user-privilege.exe', 'nexus_auth-metadata.exe', 'nexus_store-entitlements.exe', 'nexus_runtime-init.exe', ...probes.map(([name]) => name + '.exe')];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const snapshot = () => Object.fromEntries(binaries.map(name => [name, hash(path.join(bin, name))]));
const before = snapshot(); // Refuse incomplete or tests-disabled builds before creating a prefix.
const root = fs.mkdtempSync(path.join(build, 'nexus-component-test-'));
fs.chmodSync(root, 0o700);
const prefix = path.join(root, 'pfx');
const env = {...process.env, WINEPREFIX: prefix, WINEARCH: 'win64', WINEDEBUG: '-all',
    WINEDLLOVERRIDES: 'winemenubuilder.exe=d;mscoree,mshtml=d;xgameruntime=n'};
for (const key of Object.keys(env)) {
    if (/^(XODUS_|XUSER_|NEXUS_|XGAMERUNTIME_|GTEST_|STEAM_COMPAT_|SteamAppId$|SteamGameId$|WINEDLLPATH$)/.test(key)) delete env[key];
}
const proof = {schema: 1, scope: 'xgameruntime-component', completeRuntime: false,
    realGameTest: false, stableApproved: false, binaries: before, results: []};
let passed = false;
function execute(name, command, args, timeout = 60000, statuses = [0], options = {}) {
    const result = spawnSync(command, args, {env: {...env, ...options.env}, encoding: 'utf8', timeout, maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024});
    const output = (result.stdout || '') + (result.stderr || '');
    fs.writeFileSync(path.join(root, name + '.log'), output, {flag: 'wx', mode: 0o600});
    if (result.error || result.signal || !statuses.includes(result.status)) throw Error(name + ' failed; see ' + root);
    return output;
}
try {
    execute('wineboot', 'wineboot', ['--init']);
    // Replace only an entry in this newly created prefix. Never follow Wine's
    // default-prefix symlink back to an engine DLL or any user installation.
    const bytes=fs.readFileSync(path.join(bin,'xgameruntime.dll'));
    const machine=bytes.readUInt16LE(bytes.readUInt32LE(0x3c)+4);
    if(machine!==0x8664 && machine!==0x14c)throw Error('Unsupported component PE architecture');
    const directory=path.join(prefix,'drive_c/windows',machine===0x8664?'system32':'syswow64');
    if(!fs.realpathSync(directory).startsWith(prefix+path.sep))throw Error('Prefix system directory escapes test root');
    const staged=path.join(directory,'xgameruntime.dll'),temporary=staged+'.nexus-'+process.pid;
    fs.copyFileSync(path.join(bin,'xgameruntime.dll'),temporary,fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporary,staged);
    if(fs.lstatSync(staged).isSymbolicLink() || hash(staged)!==before['xgameruntime.dll'])throw Error('Candidate staging failed');
    proof.staged={machine,sha256:hash(staged)};

    const units = execute('unit', 'wine', [path.join(bin, 'test_xgameruntime.exe')], 120000);
    const match = units.match(/\[\s*PASSED\s*\]\s+(\d+) tests/);
    if (!match || Number(match[1]) < 77 || /\[\s*(SKIPPED|FAILED)\s*\]/.test(units))
        throw Error('Missing, skipped or failed C++ unit coverage');
    proof.results.push({name: 'cpp-unit', checks: Number(match[1]), failures: 0});
    const identities=execute('async-identity-unit','wine',[path.join(bin,'test_nexus_async_identity.exe')]);
    const identityMatch=identities.match(/\[\s*PASSED\s*\]\s+(\d+) tests/);
    if(!identityMatch || Number(identityMatch[1])<3 || /\[\s*(SKIPPED|FAILED)\s*\]/.test(identities))throw Error('Typed async identity regressions failed');
    proof.results.push({name:'async-identity-unit',checks:Number(identityMatch[1]),failures:0});
    const timers = execute('timer-unit', 'wine', [path.join(bin, 'test_nexus_timer.exe')]);
    const timerMatch = timers.match(/\[\s*PASSED\s*\]\s+(\d+) tests/);
    if (!timerMatch || Number(timerMatch[1]) < 2 || /\[\s*(SKIPPED|FAILED)\s*\]/.test(timers)) throw Error('Monotonic timer regressions failed');
    proof.results.push({name: 'timer-unit', checks: Number(timerMatch[1]), failures: 0});
    const saves = execute('save-unit', 'wine', [path.join(bin, 'test_nexus_save.exe')]);
    const saveMatch = saves.match(/\[\s*PASSED\s*\]\s+(\d+) tests/);
    if (!saveMatch || Number(saveMatch[1]) < 6 || /\[\s*(SKIPPED|FAILED)\s*\]/.test(saves)) throw Error('Synthetic save regressions failed');
    proof.results.push({name: 'save-unit', checks: Number(saveMatch[1]), failures: 0});
    const config = execute('configuration-unit', 'wine', [path.join(bin, 'test_nexus_configuration.exe')], 60000);
    const configMatch = config.match(/\[\s*PASSED\s*\]\s+(\d+) tests/);
    if (!configMatch || Number(configMatch[1]) < 9 || /\[\s*(SKIPPED|FAILED)\s*\]/.test(config)) throw Error('Configuration regressions failed');
    proof.results.push({name: 'configuration-unit', checks: Number(configMatch[1]), failures: 0});
    for (const mode of ['inline', 'retry', 'default']) {
        const output = execute('runtime-init-' + mode, 'wine', [path.join(bin, 'nexus_runtime-init.exe'), mode]);
        const summary = output.match(/CHECKS (\d+) FAILURES (\d+)/);
        if (!summary || Number(summary[1]) < 6 || Number(summary[2])) throw Error('Runtime initialization ABI failed: ' + mode);
        proof.results.push({name: 'runtime-init-' + mode, checks: Number(summary[1]), failures: 0});
    }
    for (const [name, minimum, args = []] of probes) {
        const output = execute(name, 'wine', [path.join(bin, name + '.exe'), ...args]);
        const summary = output.match(/(?:^|\n)(?:ASYNC PROVIDER |ASYNC |QUEUE |CHUNK METADATA )?CHECKS (\d+) FAILURES (\d+)/);
        if (!summary || Number(summary[1]) < minimum || Number(summary[2]) || /(?:^|\n)FAIL /.test(output))
            throw Error(name + ' lost required ABI coverage');
        proof.results.push({name, checks: Number(summary[1]), failures: 0});
        if(name==='nexus_package-selection')
        {
            const setup=execute(name+'-prepare','wine',[path.join(bin,name+'.exe'),'--prepare']);
            const fixture=setup.match(/(?:^|\n)SELECTION FIXTURE ([^\r\n]+\.exe)\r?(?:\n|$)/)?.[1];
            if(!fixture)throw Error('Missing private selection fixture');
            const traced={env:{WINEDEBUG:'-all,+file'},maxBuffer:16*1024*1024};
            const selected=execute(name+'-selected-opens','wine',[fixture,'--trace-select'],60000,[0],traced);
            const all=execute(name+'-all-opens','wine',[fixture,'--trace-all'],60000,[0],traced);
            const reads=(text,file)=>text.split('\n').filter(line=>line.includes('trace:file:CreateFileW')&&line.includes('GENERIC_READ')&&line.toLowerCase().includes(file));
            if(!reads(selected,'nx_selected_probe.bin').length)throw Error('Selected readability check was skipped');
            for(const file of ['nx_unused_probe.bin','nx_voice_probe.bin','nx_common_probe.bin'])
                if(reads(selected,file).length||!reads(all,file).length)throw Error('Selection-scoped file verification failed: '+file);
            proof.results.push({name:'selection-file-opens',checks:7,failures:0});
            const repeat=execute(name+'-repeat-missing','wine',[fixture,'--trace-repeat'],60000,[0],traced);
            const traceLines=repeat.split('\n');
            const marker=file=>traceLines.findIndex(line=>line.includes('trace:file:CreateFileW')&&line.includes('GENERIC_WRITE')&&line.includes(file));
            const begin=marker('nx_repeat_begin.marker'),end=marker('nx_repeat_end.marker');
            const bounded=begin>=0&&end>begin?traceLines.slice(begin+1,end).join('\n'):'';
            if(!bounded||!/CHECKS \d+ FAILURES 0/.test(repeat))throw Error('Missing repeated-incomplete contract');
            for(const file of ['nx_selected_probe.bin','nx_voice_probe.bin','nx_common_probe.bin'])
                if(reads(bounded,file).length)throw Error('Repeated missing-state check rescans readable content: '+file);
            if(!bounded.toLowerCase().includes('nx_common_probe.bin'))throw Error('Missing blocker was not actually rechecked');
            if(!reads(traceLines.slice(end+1).join('\n'),'nx_selected_probe.bin').length)
                throw Error('Restoring the blocker skipped the full readability check');
            proof.results.push({name:'repeated-incomplete-file-opens',checks:6,failures:0});
        }
        if(name==='nexus_windows-account-metadata')
        {
            const leave=execute('metadata-volatile-publication','wine',[path.join(bin,name+'.exe'),'--leave-volatile']);
            if(!/CHECKS 2 FAILURES 0/.test(leave))throw Error('Missing volatile publication proof');
            // Wine returns 1 when no server owns the lock. A successful wait
            // and fresh boot below still require complete server termination.
            execute('metadata-own-server-stop','wineserver',['-k'],10000,[0,1]);
            execute('metadata-own-server-drain','wineserver',['-w']);
            execute('metadata-own-server-restart','wineboot',['--init']);
            const empty=execute('metadata-volatile-after-restart','wine',[path.join(bin,name+'.exe'),'--empty-only']);
            if(!/CHECKS 1 FAILURES 0/.test(empty))throw Error('Identity persisted across server restart');
        }
        if(name==='nexus_gamesave-files') execute('save-child-drain','wineserver',['-w']);
    }
    // Keep the original fixture byte-identical. Repeated close/unload caught
    // a native timer executing code from an already unloaded runtime DLL.
    for(let iteration=0;iteration<12;iteration++) {
        const out=execute('package-close-unload-'+iteration,'wine',[path.join(bin,'nexus_package-progress-bytes.exe')]);
        const summaries=[...out.matchAll(/(?:^|\n)CHECKS (\d+) FAILURES (\d+)/g)];
        if(!summaries.some(x=>Number(x[1])>=115)||summaries.some(x=>Number(x[2])!==0)||/^FAIL /m.test(out))
            throw Error('Package close/unload lifetime regression');
    }
    proof.results.push({name:'package-close-unload-repeat',checks:12*115,failures:0});
    if (JSON.stringify(snapshot()) !== JSON.stringify(before)) throw Error('Component binaries changed during tests');
    if(hash(staged)!==before['xgameruntime.dll'])throw Error('Staged candidate changed');
    proof.unchanged = true;
    passed = true;
} finally {
    // Only this newly created prefix is in scope. Never stop another server.
    const stop = spawnSync('wineserver', ['-k'], {env, timeout: 10000, stdio: 'ignore'});
    const drain = spawnSync('wineserver', ['-w'], {env, timeout: 10000, stdio: 'ignore'});
    if (stop.error || drain.error || drain.status !== 0) { passed = false; proof.cleanupFailed = true; }
    proof.passed = passed;
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(proof, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    if (passed && fs.existsSync(prefix)) {
        if (fs.realpathSync(prefix) !== prefix || !fs.lstatSync(prefix).isDirectory()) throw Error('Unexpected test-prefix path');
        fs.rmSync(prefix, {recursive: true}); // Synthetic prefix created by this run, no accounts or real saves.
    }
    console.log('Component result: ' + path.join(root, 'results.json'));
}
if (!passed) throw Error('Component tests or cleanup failed');
console.log('C++ and raw ABI component tests passed. Full runtime and games remain unverified.');
